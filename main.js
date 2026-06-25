'use strict';

/*
 * ioBroker.casambi-lithernet
 * Integrates a Lithernet Casambi gateway over MQTT. The adapter runs an embedded
 * MQTT broker (aedes); the gateway connects to it as a client and exchanges fixed
 * topics under casambi/<gatewayId>/{set,get}/...  Object creation follows the
 * DrozmotiX house style: iobroker-jsonexplorer + lib/state_attr.js.
 */

const utils = require('@iobroker/adapter-core');
const jsonExplorer = require('iobroker-jsonexplorer');
const stateAttr = require('./lib/state_attr.js');
const CasambiBroker = require('./lib/broker.js');
const casambi = require('./lib/casambi.js');
const cloud = require('./lib/cloud.js');
const cloudModel = require('./lib/cloudModel.js');

/**
 * Turn a config name table ([{ id, name }, ...]) into an { "<id>": "<name>" } map,
 * skipping rows without a usable name.
 *
 * @param {Array<{id: *, name: string}>|undefined} rows - config table rows
 * @returns {Object<string, string>} index -> name map
 */
function buildNameMap(rows) {
	const map = {};
	if (Array.isArray(rows)) {
		for (const row of rows) {
			if (row && row.id != null && typeof row.name === 'string' && row.name.trim()) {
				map[String(row.id)] = row.name.trim();
			}
		}
	}
	return map;
}

class CasambiLithernet extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	constructor(options) {
		super({
			...options,
			name: 'casambi-lithernet',
		});

		this.broker = null;
		this.cfg = {
			gatewayId: '0',
			defaultDuration: 0,
			levelScale: 'percent',
		};
		this.names = { scenes: {}, groups: {}, devices: {} };
		this.hasNames = false;
		// Padded indices of device slots known to be empty placeholders (node_type 0); their
		// values messages are ignored so phantom devices.<n> are not created.
		this.placeholderDevices = new Set();
		// Padded indices actually seen in gateway feedback this run, per channel - used by the
		// optional orphan cleanup to delete objects whose entity no longer exists.
		this.seen = {
			devices: new Set(),
			scenes: new Set(),
			groups: new Set(),
		};
		this.orphanTimer = undefined;
		// Device indices whose `level` has been forced read-only. Per-device control is impossible
		// over MQTT (no set topic), but `level` shares the writable control-channel leaf, so it is
		// overridden to write:false once per device. Cleared when a device's tree is removed.
		this.deviceLevelReadonly = new Set();
		// Cloud enrichment (optional): deviceId -> unit uuid, used to route live MQTT feedback
		// onto the uuid-keyed device tree built from the cloud (live routing = next step).
		this.deviceIdToUuid = {};

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));

		jsonExplorer.init(this, stateAttr);
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		await this.setState('info.connection', false, true);

		// One-time migration: remove any legacy unpadded scene/group/device/button objects
		// left by earlier versions before indices were zero-padded (devices.1 -> devices.001).
		await this.cleanupLegacyIndices();

		// Normalise configuration with safe defaults.
		const bind = this.config.bind || '0.0.0.0';
		const port = Number(this.config.port) || 3791;
		const gatewayId =
			this.config.gatewayId != null && this.config.gatewayId !== '' ? String(this.config.gatewayId) : '0';
		this.cfg = {
			gatewayId,
			defaultDuration: Number(this.config.defaultDuration) || 0,
			levelScale: this.config.levelScale === 'raw' ? 'raw' : 'percent',
		};

		// Friendly channel names from the "Names" config tab (index -> name).
		this.names = {
			scenes: buildNameMap(this.config.sceneNames),
			groups: buildNameMap(this.config.groupNames),
			devices: buildNameMap(this.config.deviceNames),
		};
		this.hasNames = Object.values(this.names).some(map => Object.keys(map).length > 0);

		// Seed the writable/input states so they exist before any feedback arrives:
		// network-wide broadcast level, injected sensors and virtual buttons.
		// (scenes/groups/devices are created from the gateway's poll_* feedback.)
		const seed = {
			broadcast: { level: 0 },
			sensors: { lux: 0, pir: false },
		};
		const buttonCount = Math.min(255, Math.max(0, Number(this.config.buttonCount) || 0));
		if (buttonCount > 0) {
			seed.buttons = {};
			for (let i = 0; i < buttonCount; i++) {
				seed.buttons[casambi.padIndex(i)] = { level: 0, pressed: false, released: false };
			}
		}
		await jsonExplorer.traverseJson(seed, '', false, false, 0);

		// Start the embedded MQTT broker.
		this.broker = new CasambiBroker(
			this,
			{ bind, port, username: this.config.username || '', password: this.config.password || '' },
			(topic, payload) => this.handleFeedback(topic, payload),
		);

		try {
			await this.broker.start();
		} catch (error) {
			this.broker = null;
			this.log.error(`Could not start MQTT broker on ${bind}:${port}: ${error.message}`);
			return;
		}

		// jsonExplorer auto-subscribes writable states; subscribe broadly to be safe.
		this.subscribeStates('*');
		this.log.info(
			`Ready - point the gateway's MQTT client at this host:${port}, topic prefix "casambi/${gatewayId}/" (no SSL).`,
		);

		// Optional cloud enrichment: build the named/structured object tree from the Casambi
		// cloud (key-free, own credentials). Mapping live MQTT values onto it is the next step.
		await this.bootstrapCloud();

		// Optional orphan cleanup: after enough time to capture a full poll cycle, delete
		// scene/group/device objects whose entity no longer exists on the gateway.
		if (this.config.removeOrphans && !this.config.cloudEnabled) {
			const delayMs = Math.max(30, Number(this.config.orphanScanDelay) || 120) * 1000;
			this.orphanTimer = this.setTimeout(() => {
				this.orphanTimer = undefined;
				this.reconcileOrphans();
			}, delayMs);
			this.log.debug(`Orphan cleanup scheduled in ${delayMs / 1000}s.`);
		}
	}

	/**
	 * Optional cloud enrichment: pull the network structure from the Casambi cloud
	 * (key-free, own credentials) and build the uuid-keyed device + scene tree.
	 *
	 * @returns {Promise<void>}
	 */
	async bootstrapCloud() {
		if (!this.config.cloudEnabled) {
			return;
		}
		const uuid = String(this.config.cloudUuid || '').trim();
		const password = this.config.cloudPassword || '';
		if (!uuid || !password) {
			this.log.warn('Cloud enrichment is enabled but the network UUID or password is missing - skipping.');
			return;
		}
		try {
			this.log.info('Cloud enrichment: fetching network metadata...');
			const data = await cloud.fetchNetworkData(uuid, password);
			const parsed = cloudModel.parseNetwork(data.network);
			this.deviceIdToUuid = parsed.deviceIdToUuid;
			await this.buildCloudTree(parsed);
			this.log.info(
				`Cloud enrichment: built ${parsed.devices.length} devices and ${parsed.scenes.length} scenes from network "${data.name}".`,
			);
		} catch (error) {
			this.log.error(`Cloud enrichment failed: ${error.message}`);
		}
	}

	/**
	 * Create the object tree from parsed cloud metadata: devices keyed by uuid (stable),
	 * scenes keyed by padded sceneId (matching the MQTT key for later live mapping).
	 *
	 * @param {{devices: Array, scenes: Array}} parsed - output of cloudModel.parseNetwork
	 * @returns {Promise<void>}
	 */
	async buildCloudTree(parsed) {
		for (const d of parsed.devices) {
			if (!d.uuid) {
				continue;
			}
			const base = `devices.${d.uuid}`;
			const name = d.name || `Device ${d.deviceId}`;
			await this.setObjectNotExistsAsync(base, {
				type: 'channel',
				common: { name },
				native: { deviceId: d.deviceId, uuid: d.uuid, address: d.address, type: d.type },
			});
			await this.extendObjectAsync(base, { common: { name } });
			await this.ensureCloudState(`${base}.deviceId`, 'Device ID', 'number', 'value', false, d.deviceId);
			await this.ensureCloudState(`${base}.address`, 'BLE address', 'string', 'info.address', false, d.address);
			await this.ensureCloudState(`${base}.type`, 'Fixture type', 'number', 'value', false, d.type);
			await this.ensureCloudState(
				`${base}.controlScene`,
				'Control scene',
				'number',
				'value',
				false,
				d.controlScene,
			);
			// Live values (read-only) - populated by MQTT in the next step.
			await this.ensureCloudState(`${base}.level`, 'Level', 'number', 'level.dimmer', false);
			await this.ensureCloudState(`${base}.on`, 'On', 'boolean', 'switch.light', false);
		}
		for (const s of parsed.scenes) {
			const base = `scenes.${casambi.padIndex(s.sceneId)}`;
			const name = s.name || `Scene ${s.sceneId}`;
			await this.setObjectNotExistsAsync(base, {
				type: 'channel',
				common: { name },
				native: { sceneId: s.sceneId },
			});
			await this.extendObjectAsync(base, { common: { name } });
			// Control: recall the scene (writable). Live `active` populated by MQTT next step.
			await this.ensureCloudState(`${base}.level`, 'Level', 'number', 'level.dimmer', true);
			await this.ensureCloudState(`${base}.active`, 'Active', 'boolean', 'indicator', false);
			await this.ensureCloudState(
				`${base}.members`,
				'Members (device IDs)',
				'string',
				'json',
				false,
				JSON.stringify(s.members),
			);
		}
	}

	/**
	 * Create a state object if missing and optionally set its value.
	 *
	 * @param {string} id - state id
	 * @param {string} name - display name
	 * @param {string} type - common.type
	 * @param {string} role - common.role
	 * @param {boolean} write - writable?
	 * @param {*} [val] - value to set (skipped if undefined/null)
	 * @returns {Promise<void>}
	 */
	async ensureCloudState(id, name, type, role, write, val) {
		await this.setObjectNotExistsAsync(id, {
			type: 'state',
			common: { name, type, role, read: true, write: !!write },
			native: {},
		});
		if (val !== undefined && val !== null) {
			await this.setState(id, { val, ack: true });
		}
	}

	/**
	 * Handle a feedback message published by the gateway (get/...).
	 *
	 * @param {string} topic - full MQTT topic
	 * @param {object} payload - JSON-parsed payload
	 */
	async handleFeedback(topic, payload) {
		// When cloud enrichment is on, the object tree is built from the cloud (uuid-keyed) and
		// routing live MQTT values onto it is the next step - so don't let MQTT build a parallel
		// (deviceId-keyed) tree in the meantime.
		if (this.config.cloudEnabled) {
			return;
		}

		// A deleted node: drop its object tree and remember it as a placeholder.
		if (casambi.isNodeDeleted(topic, this.cfg)) {
			if (payload && payload.device != null) {
				const index = casambi.padIndex(payload.device);
				this.placeholderDevices.add(index);
				await this.removeDeviceTree(index);
			}
			return;
		}

		// Device realness gating: only real devices (propertys.node_type != 0) get states.
		// Empty slots still emit values with stale junk - skip those so no phantom device is made.
		const device = casambi.classifyDevice(topic, this.cfg);
		if (device) {
			if (device.kind === 'propertys') {
				if (payload && payload.node_type === 0) {
					if (!this.placeholderDevices.has(device.index)) {
						this.placeholderDevices.add(device.index);
						await this.removeDeviceTree(device.index);
					}
					return;
				}
				// A real (or newly-populated) slot: clear any prior placeholder mark.
				this.placeholderDevices.delete(device.index);
			} else if (this.placeholderDevices.has(device.index)) {
				return; // values for a known-empty slot
			}
		}

		const tree = casambi.parseGet(topic, payload, this.cfg);
		if (!tree) {
			// Placeholder slots and unknown topics both land here; keep it quiet (use the
			// "log all incoming MQTT messages" toggle for raw traffic during debugging).
			this.log.silly(`Ignored feedback on ${topic}: ${JSON.stringify(payload)}`);
			return;
		}
		// Remember which scene/group/device indices actually exist (for orphan cleanup).
		for (const channel of ['devices', 'scenes', 'groups']) {
			if (tree[channel]) {
				for (const index of Object.keys(tree[channel])) {
					this.seen[channel].add(index);
				}
			}
		}

		// Inject friendly names so jsonExplorer labels the scene/group/device channels.
		if (this.hasNames) {
			this.applyNames(tree);
		}
		await jsonExplorer.traverseJson(tree, '', this.hasNames, false, 0);

		// Device states are monitoring-only: the gateway exposes no per-device set topic, so a
		// per-device `level` is never controllable. It shares the `level` leaf which is writable
		// for the control channels (broadcast/scenes/groups), so force the device copy read-only
		// once per device (when its values first create the state).
		if (tree.devices) {
			for (const [index, node] of Object.entries(tree.devices)) {
				if (node && node.level !== undefined && !this.deviceLevelReadonly.has(index)) {
					this.deviceLevelReadonly.add(index);
					await this.extendObjectAsync(`devices.${index}.level`, { common: { write: false } }).catch(error =>
						this.log.debug(`read-only fix devices.${index}.level: ${error.message}`),
					);
				}
			}
		}
	}

	/**
	 * Delete a device's object tree (used for empty/placeholder slots and node_deleted).
	 *
	 * @param {string} index - padded device index, e.g. "007"
	 * @returns {Promise<void>}
	 */
	async removeDeviceTree(index) {
		this.deviceLevelReadonly.delete(index);
		try {
			await this.delObjectAsync(`devices.${index}`, { recursive: true });
		} catch (error) {
			this.log.debug(`removeDeviceTree(${index}): ${error.message}`);
		}
	}

	/**
	 * Optional orphan cleanup (opt-in via config). After a full poll cycle has been captured,
	 * delete scene/group/device objects whose index was not seen in the gateway's feedback -
	 * i.e. the scene/group/device no longer exists. Mirrors the object-view reconcile pattern
	 * used in oikos-connect. Skipped if no feedback was received (gateway offline) so a dead
	 * connection can never wipe the tree.
	 *
	 * @returns {Promise<void>}
	 */
	async reconcileOrphans() {
		const seenTotal = this.seen.devices.size + this.seen.scenes.size + this.seen.groups.size;
		if (seenTotal === 0) {
			this.log.warn('Orphan cleanup skipped: no gateway feedback received yet (gateway offline?).');
			return;
		}
		try {
			const objects = await this.getAdapterObjectsAsync();
			const prefix = `${this.namespace}.`;
			const channels = ['devices', 'scenes', 'groups'];
			const removed = [];
			const handled = new Set();
			for (const fullId of Object.keys(objects)) {
				const rel = fullId.slice(prefix.length).split('.');
				const channel = rel[0];
				if (rel.length >= 2 && channels.includes(channel)) {
					const channelId = `${channel}.${rel[1]}`;
					if (!handled.has(channelId)) {
						handled.add(channelId);
						if (!this.seen[channel].has(rel[1])) {
							removed.push(channelId);
							await this.delObjectAsync(channelId, { recursive: true });
						}
					}
				}
			}
			if (removed.length) {
				this.log.info(
					`Orphan cleanup removed ${removed.length} object(s) no longer on the gateway: ${removed.join(', ')}`,
				);
			} else {
				this.log.debug('Orphan cleanup: nothing to remove.');
			}
		} catch (error) {
			this.log.warn(`Orphan cleanup failed: ${error.message}`);
		}
	}

	/**
	 * One-time cleanup of legacy unpadded scene/group/device/button objects created before
	 * indices were zero-padded. Removes e.g. devices.1 once devices.001 is in use.
	 *
	 * @returns {Promise<void>}
	 */
	async cleanupLegacyIndices() {
		try {
			const objects = await this.getAdapterObjectsAsync();
			const prefix = `${this.namespace}.`;
			const channels = ['devices', 'scenes', 'groups', 'buttons'];
			const removed = new Set();
			for (const fullId of Object.keys(objects)) {
				const rel = fullId.slice(prefix.length).split('.');
				if (
					rel.length >= 2 &&
					channels.includes(rel[0]) &&
					/^\d+$/.test(rel[1]) &&
					rel[1].length < casambi.INDEX_WIDTH
				) {
					const channelId = `${rel[0]}.${rel[1]}`;
					if (!removed.has(channelId)) {
						removed.add(channelId);
						await this.delObjectAsync(channelId, { recursive: true });
					}
				}
			}
			if (removed.size) {
				this.log.info(`Removed ${removed.size} legacy unpadded object(s) after index zero-padding migration.`);
			}
		} catch (error) {
			this.log.debug(`cleanupLegacyIndices: ${error.message}`);
		}
	}

	/**
	 * Add a `name` field to the scene/group/device nodes in a feedback tree, from the
	 * configured name maps. jsonExplorer (replaceName) then uses it as the channel name.
	 *
	 * @param {object} tree - parsed feedback tree (mutated in place)
	 */
	applyNames(tree) {
		const channels = ['scenes', 'groups', 'devices'];
		for (const channel of channels) {
			const map = this.names[channel];
			if (!tree[channel] || !map) {
				continue;
			}
			for (const index of Object.keys(tree[channel])) {
				// Tree keys are zero-padded ("007"); name-map keys come from config (raw "7").
				const name = map[index] || map[String(Number(index))];
				if (name) {
					tree[channel][index].name = name;
				}
			}
		}
	}

	/**
	 * Is called if a subscribed state changes. User commands (ack === false) are
	 * translated into MQTT commands and published to the gateway.
	 *
	 * @param {string} id - State ID
	 * @param {ioBroker.State | null | undefined} state - State object
	 */
	onStateChange(id, state) {
		if (!state || state.ack || !this.broker) {
			return;
		}
		const parts = this.parseStateId(id);
		if (!parts) {
			return;
		}
		const command = casambi.buildCommand(parts, state.val, this.cfg);
		if (!command) {
			this.log.debug(`No command mapping for ${id} (read-only or parameter)`);
			return;
		}
		this.broker.publish(command.topic, command.payload);
		// Optimistically acknowledge; the gateway also reports the actual value via get/*.
		this.setState(id, { val: state.val, ack: true });
	}

	/**
	 * Split a full state id into its addressing parts.
	 * e.g. casambi-lithernet.0.scenes.3.level -> { channel:'scenes', index:3, leaf:'level' }
	 *      casambi-lithernet.0.control.level  -> { channel:'control', index:null, leaf:'level' }
	 *
	 * @param {string} id - full state id
	 * @returns {{channel: string, index: number|null, leaf: string}|null} parsed parts, or null if not addressable
	 */
	parseStateId(id) {
		const rel = id.split('.').slice(2); // strip "casambi-lithernet.<instance>"
		if (rel.length < 2) {
			return null;
		}
		const channel = rel[0];
		if (rel.length === 2) {
			return { channel, index: null, leaf: rel[1] };
		}
		const index = Number(rel[1]);
		return { channel, index: Number.isNaN(index) ? null : index, leaf: rel[rel.length - 1] };
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback - Callback function
	 */
	async onUnload(callback) {
		try {
			if (this.orphanTimer) {
				this.clearTimeout(this.orphanTimer);
				this.orphanTimer = undefined;
			}
			if (this.broker) {
				await this.broker.stop();
				this.broker = null;
			}
			callback();
		} catch (error) {
			this.log.error(`Error during unloading: ${error.message}`);
			callback();
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	module.exports = options => new CasambiLithernet(options);
} else {
	// otherwise start the instance directly
	new CasambiLithernet();
}
