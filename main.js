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

/**
 * Turn a config name table ([{ id, name }, ...]) into an { "<id>": "<name>" } map,
 * skipping rows without a usable name.
 *
 * @param {Array<{id: *, name: string}>|undefined} rows - config table rows
 * @returns {Object<string, string>} index -> name map
 */
function buildNameMap(rows) {
	/** @type {Object<string, string>} */
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

		this.broker = /** @type {CasambiBroker|null} */ (null);
		this.cfg = /** @type {{gatewayId: string, defaultDuration: number, levelScale: string}} */ ({
			gatewayId: '0',
			defaultDuration: 0,
			levelScale: 'percent',
		});
		/** @type {{scenes: Object<string,string>, groups: Object<string,string>, devices: Object<string,string>}} */
		this.names = { scenes: {}, groups: {}, devices: {} };
		this.hasNames = false;
		// Padded indices of device slots known to be empty placeholders (node_type 0); their
		// values messages are ignored so phantom devices.<n> are not created.
		this.placeholderDevices = /** @type {Set<string>} */ (new Set());
		// Padded indices actually seen in gateway feedback this run, per channel - used by the
		// optional orphan cleanup to delete objects whose entity no longer exists.
		this.seen = {
			devices: /** @type {Set<string>} */ (new Set()),
			scenes: /** @type {Set<string>} */ (new Set()),
			groups: /** @type {Set<string>} */ (new Set()),
		};
		this.orphanTimer = /** @type {ioBroker.Timeout | undefined} */ (undefined);

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

		// Optional orphan cleanup: after enough time to capture a full poll cycle, delete
		// scene/group/device objects whose entity no longer exists on the gateway.
		if (this.config.removeOrphans) {
			const delayMs = Math.max(30, Number(this.config.orphanScanDelay) || 120) * 1000;
			this.orphanTimer = this.setTimeout(() => {
				this.orphanTimer = undefined;
				this.reconcileOrphans();
			}, delayMs);
			this.log.debug(`Orphan cleanup scheduled in ${delayMs / 1000}s.`);
		}
	}

	/**
	 * Handle a feedback message published by the gateway (get/...).
	 *
	 * @param {string} topic - full MQTT topic
	 * @param {object} payload - JSON-parsed payload
	 */
	async handleFeedback(topic, payload) {
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
		for (const channel of /** @type {Array<'devices'|'scenes'|'groups'>} */ (['devices', 'scenes', 'groups'])) {
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
	}

	/**
	 * Delete a device's object tree (used for empty/placeholder slots and node_deleted).
	 *
	 * @param {string} index - padded device index, e.g. "007"
	 * @returns {Promise<void>}
	 */
	async removeDeviceTree(index) {
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
			const channels = /** @type {Array<'devices'|'scenes'|'groups'>} */ (['devices', 'scenes', 'groups']);
			const removed = [];
			const handled = new Set();
			for (const fullId of Object.keys(objects)) {
				const rel = fullId.slice(prefix.length).split('.');
				const channel = /** @type {'devices'|'scenes'|'groups'} */ (rel[0]);
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
		const channels = /** @type {Array<'scenes'|'groups'|'devices'>} */ (['scenes', 'groups', 'devices']);
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
