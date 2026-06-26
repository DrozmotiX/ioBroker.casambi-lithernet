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

/**
 * Recognise a cloud device-control write: devices.<key>.level / .on (key = BLE address, no dots).
 *
 * @param {string} id - full state id
 * @returns {{key: string, leaf: string}|null} parsed control ref, or null
 */
function parseDeviceControl(id) {
	const rel = id.split('.').slice(2);
	if (rel.length === 3 && rel[0] === 'devices' && (rel[2] === 'level' || rel[2] === 'on')) {
		return { key: rel[1], leaf: rel[2] };
	}
	return null;
}

/**
 * Recognise a control-scene picker write: devices.<key>.controlSceneSelect (key = BLE address).
 *
 * @param {string} id - full state id
 * @returns {{key: string}|null} parsed ref, or null
 */
function parseControlSelect(id) {
	const rel = id.split('.').slice(2);
	if (rel.length === 3 && rel[0] === 'devices' && rel[2] === 'controlSceneSelect') {
		return { key: rel[1] };
	}
	return null;
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
		// Cloud catalog: deviceId -> device key (BLE address) to route live MQTT feedback onto the
		// address-keyed device tree; cloudScenes = padded scene keys the catalog built (for routing).
		this.deviceIdToKey = {};
		this.cloudScenes = new Set();
		// True once the cloud catalog has been built; gates MQTT so it doesn't build a parallel
		// (deviceId-keyed) tree. If the cloud fails, this stays false and MQTT discovery runs.
		this.cloudActive = false;
		// Distinct unknown feedback topic *shapes* already logged this run (numeric indices
		// collapsed to '#'), so a never-before-seen topic family (e.g. element_* battery/button
		// events) surfaces exactly one info line instead of flooding. Diagnostic aid for mapping
		// new gateway payloads; carries no behaviour.
		this.unhandledShapes = new Set();
		this.syncTimer = undefined;
		// device key (BLE address) -> control sceneId for every device with a RESOLVED control
		// scene (a lone single-member candidate, or the owner's manual pick). Those get writable
		// level/on that recall the scene; ambiguous devices stay read-only until assigned.
		this.deviceControlScene = {};
		// Last parsed+range-filtered cloud model, cached so a control-scene pick (controlSceneSelect)
		// can be applied live against the current catalog without a fresh cloud fetch.
		this.lastParsed = null;
		// Per-device readback debounce. The gateway emits a STALE-then-fresh level pair (~10ms
		// apart) on every scene recall, which - written verbatim - made devices.<key>.on flip
		// old->new in the UI. So device level/on readbacks are coalesced over a short window and
		// only the settled value is written, with ack:true (CONFIRMED from gateway data, never
		// assumed). deviceConfirmed = last value written per key; invalidated on a command so the
		// next real feedback re-confirms even if unchanged.
		this.deviceReadback = {}; // key -> { level?, on? } pending sample
		this.deviceReadbackTimers = {}; // key -> debounce timer
		this.deviceConfirmed = {}; // key -> { level?, on? } last confirmed (ack:true) value

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
			// Window (ms) over which per-device level/on readbacks are coalesced before the settled
			// value is written. Must comfortably exceed the gateway's stale->fresh pair gap (~10ms);
			// kept small so confirmed state is still near-instant. 0 disables (write each sample).
			readbackDebounceMs: Math.max(0, Number(this.config.readbackDebounceMs) || 300),
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

		// Cloud catalog (required source of truth for structure/names). Create the sync + coverage
		// states, build the tree, then schedule periodic re-sync. MQTT live mapping is the next step.
		if (this.config.cloudEnabled) {
			await this.ensureCloudState('info.lastSync', 'Last cloud sync', 'string', 'date', false);
			await this.ensureCloudState(
				'info.devicesWithoutControlScene',
				'Loads without a control scene',
				'string',
				'json',
				false,
			);
			await this.ensureCloudState(
				'info.devicesWithMultipleControlScenes',
				'Loads with multiple control scenes',
				'string',
				'json',
				false,
			);
			await this.ensureCloudState(
				'info.devicesNeedingControlScene',
				'Devices awaiting a control-scene assignment (JSON)',
				'string',
				'json',
				false,
			);
			await this.ensureCloudState('control.syncNow', 'Sync cloud now', 'boolean', 'button', true);
		}
		await this.bootstrapCloud();
		this.scheduleSync();

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
			this.log.warn(
				'Cloud is the required catalog source but is disabled - falling back to MQTT-only discovery.',
			);
			return;
		}
		const uuid = String(this.config.cloudUuid || '').trim();
		const password = this.config.cloudPassword || '';
		if (!uuid || !password) {
			this.log.error(
				'Cloud is enabled but the network UUID or password is missing - configure them in the Cloud tab.',
			);
			return;
		}
		try {
			this.log.info('Cloud: fetching network metadata...');
			const data = await cloud.fetchNetworkData(uuid, password);
			const parsed = cloudModel.parseNetwork(data.network);
			// Optional build-range filter (default "0-*" = all) to try a subset of ids.
			const devRange = cloudModel.parseRange(this.config.cloudDeviceRange);
			const scnRange = cloudModel.parseRange(this.config.cloudSceneRange);
			parsed.devices = parsed.devices.filter(d => cloudModel.inRange(d.deviceId, devRange));
			parsed.scenes = parsed.scenes.filter(s => cloudModel.inRange(s.sceneId, scnRange));
			parsed.coverage = cloudModel.coverage(parsed.devices, parsed.scenes);
			this.lastParsed = parsed; // for the admin Control-mapping selector
			await this.buildCloudTree(parsed);
			await this.reportCoverage(parsed.coverage);
			this.cloudActive = true;
			const stamp = new Date().toISOString();
			await this.setState('info.lastSync', stamp, true);
			this.log.info(
				`Cloud: synced ${parsed.devices.length} devices and ${parsed.scenes.length} scenes from network "${data.name}" at ${stamp}.`,
			);
		} catch (error) {
			this.log.error(`Cloud sync failed: ${error.message}`);
		}
	}

	/**
	 * Publish scene-coverage diagnostics (devices with no / multiple control scenes) to
	 * info states and the log, to troubleshoot the one-scene-per-device setup.
	 *
	 * @param {{none: Array, multiple: Array}} coverage - from cloudModel.parseNetwork
	 * @returns {Promise<void>}
	 */
	async reportCoverage(coverage) {
		await this.setState('info.devicesWithoutControlScene', JSON.stringify(coverage.none), true);
		await this.setState('info.devicesWithMultipleControlScenes', JSON.stringify(coverage.multiple), true);
		if (coverage.none.length) {
			this.log.warn(
				`Loads with NO control scene (uncontrollable - add a single-member scene): ${coverage.none
					.map(d => `${d.deviceId} "${d.name}"`)
					.join(', ')}`,
			);
		}
		if (coverage.multiple.length) {
			this.log.warn(
				`Loads with MULTIPLE control scenes (ambiguous): ${coverage.multiple
					.map(d => `${d.deviceId} "${d.name}" [${d.scenes.join('/')}]`)
					.join(', ')}`,
			);
		}
	}

	/**
	 * (Re)schedule the periodic cloud re-sync from the configured interval (minutes; 0 = off).
	 *
	 * @returns {void}
	 */
	scheduleSync() {
		if (this.syncTimer) {
			this.clearInterval(this.syncTimer);
			this.syncTimer = undefined;
		}
		const minutes = Math.max(0, Number(this.config.cloudSyncInterval) || 0);
		if (!this.config.cloudEnabled || minutes <= 0) {
			return;
		}
		this.syncTimer = this.setInterval(() => this.bootstrapCloud(), minutes * 60 * 1000);
		this.log.debug(`Cloud auto-sync scheduled every ${minutes} min.`);
	}

	/**
	 * Create the object tree from parsed cloud metadata: devices keyed by uuid (stable),
	 * scenes keyed by padded sceneId (matching the MQTT key for later live mapping).
	 *
	 * @param {{devices: Array, scenes: Array}} parsed - output of cloudModel.parseNetwork
	 * @returns {Promise<void>}
	 */
	async buildCloudTree(parsed) {
		this.deviceControlScene = {};
		this.deviceIdToKey = {};
		this.cloudScenes = new Set();
		// Device keys may change on a (re)build; drop any in-flight readback debounce state so it
		// can't write a stale value against the new tree, and re-confirm fresh from feedback.
		for (const timer of Object.values(this.deviceReadbackTimers)) {
			this.clearTimeout(timer);
		}
		this.deviceReadbackTimers = {};
		this.deviceReadback = {};
		this.deviceConfirmed = {};
		const builtKeys = new Set();
		const sceneName = {};
		for (const s of parsed.scenes) {
			sceneName[s.sceneId] = s.name;
		}
		// Owner's manual control-scene picks are PERSISTED in each ambiguous device's
		// controlSceneSelect state (survive restarts + cloud re-sync); read them back into a
		// deviceId->sceneId map. resolveControlScene validates each is a real candidate.
		const manualMap = await this.readManualAssignments(parsed.devices);
		for (const d of parsed.devices) {
			const key = d.address || d.uuid; // prefer the short, readable BLE address
			if (!key) {
				continue;
			}
			this.deviceIdToKey[d.deviceId] = key;
			builtKeys.add(key);
			const base = `devices.${key}`;
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
			// Per-device control is scene-only. Resolve THE control scene: the owner's manual pick
			// wins, else a lone single-member candidate auto-maps; a device with multiple candidates
			// and no manual pick stays read-only (unresolved) until assigned, and a device with none
			// is uncontrollable. Only resolved devices get writable level/on (a write recalls the
			// scene, see onStateChange). The value itself is the live MQTT readback (next step).
			const res = cloudModel.resolveControlScene(d, manualMap);
			const controllable = res.sceneId != null;
			if (controllable) {
				this.deviceControlScene[key] = res.sceneId;
			}
			// Always (re)write the resolved control scene - including null - so an unresolved or
			// re-assigned device clears the previous value. ensureCloudState skips null, so set it
			// explicitly after the object exists.
			await this.ensureCloudState(`${base}.controlScene`, 'Control scene', 'number', 'value', false);
			await this.setState(`${base}.controlScene`, { val: res.sceneId, ack: true });
			await this.ensureCloudState(`${base}.level`, 'Level', 'number', 'level.dimmer', controllable);
			await this.ensureCloudState(`${base}.on`, 'On', 'boolean', 'switch.light', controllable);
			// Keep write-ability in sync on re-sync (scene added/removed since last run).
			await this.extendObjectAsync(`${base}.level`, { common: { write: controllable } });
			await this.extendObjectAsync(`${base}.on`, { common: { write: controllable } });
			// Only AMBIGUOUS devices (several single-member scenes) need a manual choice, so they get
			// a writable picker state - the admin Objects view renders common.states as a dropdown of
			// the candidate scenes by name. Choosing one assigns control live (see onStateChange).
			// Non-ambiguous devices auto-map (or are uncontrollable), so any stale picker is removed.
			await this.syncControlSceneSelect(base, d, res, sceneName);
		}
		// Publish (and warn about) the devices still awaiting a manual control-scene pick.
		const needed = await this.publishNeeded(parsed);
		if (needed.length) {
			this.log.warn(
				`Control scene NOT set for ${needed.length} device(s) - they stay read-only until you pick one in the device's controlSceneSelect dropdown (Objects view). Details: ${JSON.stringify(needed)}`,
			);
		}
		for (const s of parsed.scenes) {
			const padded = casambi.padIndex(s.sceneId);
			this.cloudScenes.add(padded);
			const base = `scenes.${padded}`;
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
		// Remove stale device channels (e.g. old uuid-keyed ones after switching to address keys,
		// or devices removed from the network) so the tree matches the current catalog.
		try {
			const chans = await this.getForeignObjectsAsync(`${this.namespace}.devices.*`, 'channel');
			for (const id of Object.keys(chans || {})) {
				const key = id.split('.').pop();
				if (!builtKeys.has(key)) {
					await this.delForeignObjectAsync(id, { recursive: true });
					this.log.debug(`Removed stale device channel ${key}`);
				}
			}
		} catch (error) {
			this.log.debug(`device reconcile: ${error.message}`);
		}
		// One-time cleanup: remove legacy element_* leaf states (button_N/pushbutton_N/slider_N/
		// onoff_N/dimmer_N) that earlier versions flattened from element_* sub-topics before they
		// were filtered out in parseGet. They are no longer created; drop the orphans.
		try {
			const states = await this.getForeignObjectsAsync(`${this.namespace}.devices.*`, 'state');
			const elementLeaf = /\.(button|pushbutton|slider|onoff|dimmer)_\d+$/;
			let removed = 0;
			for (const id of Object.keys(states || {})) {
				if (elementLeaf.test(id)) {
					await this.delForeignObjectAsync(id);
					removed++;
				}
			}
			if (removed) {
				this.log.info(`Removed ${removed} legacy element_* state(s) (button/dimmer module fields).`);
			}
		} catch (error) {
			this.log.debug(`element-state cleanup: ${error.message}`);
		}
	}

	/**
	 * Read the owner's persisted control-scene picks from each device's controlSceneSelect state
	 * (value = chosen sceneId; the -1 sentinel / null means unassigned) into a deviceId->sceneId
	 * map. Survives restarts and cloud re-syncs without touching the adapter config.
	 *
	 * @param {Array<{deviceId: number, address: string, uuid: string}>} devices - parsed devices
	 * @returns {Promise<Object<number, number>>} deviceId -> chosen sceneId
	 */
	async readManualAssignments(devices) {
		const addrToDeviceId = {};
		for (const d of devices) {
			addrToDeviceId[d.address || d.uuid] = d.deviceId;
		}
		const map = {};
		let states = {};
		try {
			states = (await this.getStatesAsync(`${this.namespace}.devices.*.controlSceneSelect`)) || {};
		} catch (error) {
			this.log.debug(`readManualAssignments: ${error.message}`);
		}
		for (const [id, st] of Object.entries(states)) {
			const sceneId = st == null ? NaN : Number(st.val);
			if (!(sceneId > 0)) {
				continue; // -1 sentinel / null / cleared
			}
			const addr = id.split('.')[3]; // <ns>.<inst>.devices.<addr>.controlSceneSelect
			const deviceId = addrToDeviceId[addr];
			if (deviceId != null) {
				map[deviceId] = sceneId;
			}
		}
		return map;
	}

	/**
	 * Create/refresh the writable control-scene picker for an ambiguous device (admin renders
	 * common.states as a dropdown of its candidate scenes by name; -1 = unchosen). Removes the
	 * picker from a device that is no longer ambiguous.
	 *
	 * @param {string} base - devices.<address>
	 * @param {{controlScenes: number[]}} device - parsed device
	 * @param {{sceneId: number|null, status: string}} res - resolution from resolveControlScene
	 * @param {Object<number, string>} sceneName - sceneId -> name
	 * @returns {Promise<void>}
	 */
	async syncControlSceneSelect(base, device, res, sceneName) {
		const id = `${base}.controlSceneSelect`;
		const candidates = Array.isArray(device.controlScenes) ? device.controlScenes : [];
		if (candidates.length <= 1) {
			await this.delObjectAsync(id).catch(() => {});
			return;
		}
		const states = { '-1': '— choose a control scene —' };
		for (const sid of candidates) {
			states[String(sid)] = sceneName[sid] || `Scene ${sid}`;
		}
		await this.setObjectNotExistsAsync(id, {
			type: 'state',
			common: {
				name: 'Assign control scene',
				type: 'number',
				role: 'value',
				read: true,
				write: true,
				states,
				def: -1,
			},
			native: {},
		});
		await this.extendObjectAsync(id, { common: { states, write: true } });
		await this.setState(id, { val: res.status === 'manual' ? res.sceneId : -1, ack: true });
	}

	/**
	 * Publish the list of devices still awaiting a manual control-scene pick (ambiguous and not yet
	 * resolved) to info.devicesNeedingControlScene as JSON, and return it.
	 *
	 * @param {{devices: Array, scenes: Array}} parsed - parsed cloud model
	 * @returns {Promise<Array<object>>} the needed-action list
	 */
	async publishNeeded(parsed) {
		const sceneName = {};
		for (const s of parsed.scenes) {
			sceneName[s.sceneId] = s.name;
		}
		const needed = [];
		for (const d of parsed.devices) {
			const key = d.address || d.uuid;
			const candidates = Array.isArray(d.controlScenes) ? d.controlScenes : [];
			if (candidates.length > 1 && this.deviceControlScene[key] == null) {
				needed.push({
					device: d.name || `Device ${d.deviceId}`,
					deviceId: d.deviceId,
					address: key,
					candidates: candidates.map(sid => ({ sceneId: sid, name: sceneName[sid] || `Scene ${sid}` })),
				});
			}
		}
		await this.setState('info.devicesNeedingControlScene', JSON.stringify(needed), true);
		return needed;
	}

	/**
	 * Apply a control-scene pick made via a device's controlSceneSelect dropdown: validate the
	 * sceneId is one of the device's candidates, then update control routing, the controlScene
	 * state, level/on writability and the needs-action list - all live, no restart.
	 *
	 * @param {string} key - device address (tree key)
	 * @param {*} val - chosen sceneId (>0) or the -1/null clear sentinel
	 * @returns {Promise<void>}
	 */
	async applyControlSceneSelect(key, val) {
		const parsed = this.lastParsed;
		if (!parsed) {
			return;
		}
		const d = parsed.devices.find(x => (x.address || x.uuid) === key);
		if (!d) {
			return;
		}
		const candidates = Array.isArray(d.controlScenes) ? d.controlScenes : [];
		const num = Number(val);
		const sceneId = num > 0 && candidates.includes(num) ? num : null;
		const base = `devices.${key}`;
		if (sceneId != null) {
			this.deviceControlScene[key] = sceneId;
		} else {
			delete this.deviceControlScene[key];
		}
		await this.setState(`${base}.controlScene`, { val: sceneId, ack: true });
		await this.extendObjectAsync(`${base}.level`, { common: { write: sceneId != null } });
		await this.extendObjectAsync(`${base}.on`, { common: { write: sceneId != null } });
		await this.setState(`${base}.controlSceneSelect`, { val: sceneId != null ? sceneId : -1, ack: true });
		await this.publishNeeded(parsed);
		this.log.info(`Control scene for "${d.name}" (${key}) ${sceneId != null ? `set to ${sceneId}` : 'cleared'}.`);
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
	 * Log a one-shot info line for any gateway feedback topic we do not yet map (e.g. the
	 * `element_` family carrying battery + physical button events). Deduplicated by topic
	 * shape (numeric indices collapsed to '#') so an on-site button press or a battery lamp
	 * waking up surfaces a single clean line - no need to flip the whole instance to debug.
	 * Purely diagnostic: it never creates states or changes routing.
	 *
	 * @param {string} topic - full MQTT topic
	 * @param {object} payload - JSON-parsed payload
	 */
	sampleUnhandled(topic, payload) {
		const shape = casambi.unhandledShape(topic, this.cfg);
		if (!shape || this.unhandledShapes.has(shape)) {
			return;
		}
		this.unhandledShapes.add(shape);
		this.log.info(`Unhandled feedback shape ${shape} (e.g. ${topic}): ${JSON.stringify(payload)}`);
	}

	/**
	 * Route live MQTT feedback onto the cloud catalog (cloud mode): devices re-keyed by BLE
	 * address (deviceId->key), scenes by padded id; only known catalog entries are updated.
	 *
	 * @param {string} topic - MQTT topic
	 * @param {object} payload - JSON payload
	 * @returns {Promise<void>}
	 */
	async routeLiveFeedback(topic, payload) {
		const tree = casambi.parseGet(topic, payload, this.cfg);
		if (!tree) {
			this.sampleUnhandled(topic, payload);
			return;
		}
		const out = {};
		if (tree.devices) {
			const devs = {};
			for (const [padded, node] of Object.entries(tree.devices)) {
				const key = this.deviceIdToKey[parseInt(padded, 10)];
				if (!key) {
					continue;
				}
				// level/on carry per-device WRITABILITY decided at build/assign time. jsonExplorer
				// re-applies lib/state_attr (where `on` is write:false) on every traverse, which would
				// reset a controllable device's `on` back to read-only the first time it reports a live
				// value. So update their VALUES via setState (no common touched) and keep them out of
				// the jsonExplorer tree; only the dynamic read-only fields (health/colour) go through it.
				// Coalesced over readbackDebounceMs to drop the gateway's stale->fresh pair (see
				// queueDeviceReadback); the settled value is written as CONFIRMED (ack:true).
				const sample = {};
				if (node.level !== undefined) {
					sample.level = node.level;
					delete node.level;
				}
				if (node.on !== undefined) {
					sample.on = node.on;
					delete node.on;
				}
				if (sample.level !== undefined || sample.on !== undefined) {
					this.queueDeviceReadback(key, sample);
				}
				if (Object.keys(node).length) {
					devs[key] = node;
				}
			}
			if (Object.keys(devs).length) {
				out.devices = devs;
			}
		}
		if (tree.scenes) {
			const scn = {};
			for (const [padded, node] of Object.entries(tree.scenes)) {
				if (this.cloudScenes.has(padded)) {
					scn[padded] = node;
				}
			}
			if (Object.keys(scn).length) {
				out.scenes = scn;
			}
		}
		if (tree.broadcast) {
			out.broadcast = tree.broadcast;
		}
		if (tree.ungrouped) {
			out.ungrouped = tree.ungrouped;
		}
		if (Object.keys(out).length) {
			await jsonExplorer.traverseJson(out, '', false, false, 0);
		}
	}

	/**
	 * Queue a per-device level/on readback sample and (re)arm its debounce timer. Only the LAST
	 * sample in a burst is written (the gateway's stale-then-fresh recall pair collapses to the
	 * fresh value), so the UI no longer flips old->new on a switch. With the window at 0 the value
	 * is flushed immediately (legacy behaviour).
	 *
	 * @param {string} key - device key (BLE address)
	 * @param {{level?: number, on?: boolean}} sample - latest readback fields
	 * @returns {void}
	 */
	queueDeviceReadback(key, sample) {
		const pending = this.deviceReadback[key] || (this.deviceReadback[key] = {});
		Object.assign(pending, sample);
		const ms = this.cfg.readbackDebounceMs;
		if (!ms) {
			this.flushDeviceReadback(key);
			return;
		}
		if (this.deviceReadbackTimers[key]) {
			this.clearTimeout(this.deviceReadbackTimers[key]);
		}
		this.deviceReadbackTimers[key] = this.setTimeout(() => {
			delete this.deviceReadbackTimers[key];
			this.flushDeviceReadback(key);
		}, ms);
	}

	/**
	 * Flush a device's settled readback: write only the level/on fields that differ from the last
	 * CONFIRMED value, each with ack:true (confirmed from real gateway data, never assumed). A
	 * command invalidates deviceConfirmed[key] so the next feedback re-confirms even if unchanged.
	 *
	 * @param {string} key - device key (BLE address)
	 * @returns {void}
	 */
	flushDeviceReadback(key) {
		const pending = this.deviceReadback[key];
		delete this.deviceReadback[key];
		if (!pending) {
			return;
		}
		const changed = casambi.diffConfirmedReadback(pending, this.deviceConfirmed[key]);
		const confirmed = this.deviceConfirmed[key] || (this.deviceConfirmed[key] = {});
		for (const [field, val] of Object.entries(changed)) {
			confirmed[field] = val;
			this.setState(`devices.${key}.${field}`, { val, ack: true });
		}
	}

	/**
	 * Handle a feedback message published by the gateway (get/...).
	 *
	 * @param {string} topic - full MQTT topic
	 * @param {object} payload - JSON-parsed payload
	 */
	async handleFeedback(topic, payload) {
		// Cloud mode: route live MQTT feedback onto the address-keyed cloud catalog (devices by
		// BLE address via deviceId->key, scenes by padded id, broadcast/ungrouped as-is); only
		// known catalog entries are updated. If the cloud failed/disabled, fall through to the
		// legacy deviceId-keyed MQTT discovery.
		if (this.cloudActive) {
			await this.routeLiveFeedback(topic, payload);
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
			this.sampleUnhandled(topic, payload);
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
		if (!state || state.ack) {
			return;
		}
		// Manual cloud re-sync trigger (button).
		if (id.endsWith('.control.syncNow') && state.val) {
			this.log.info('Manual cloud sync requested.');
			this.bootstrapCloud().finally(() => this.setState(id, { val: false, ack: true }));
			return;
		}
		// Owner picked a control scene for an ambiguous device (Objects view dropdown) - apply live.
		const sel = parseControlSelect(id);
		if (sel) {
			this.applyControlSceneSelect(sel.key, state.val).catch(error =>
				this.log.warn(`Control-scene select for ${sel.key} failed: ${error.message}`),
			);
			return;
		}
		if (!this.broker) {
			return;
		}
		// Cloud device control: a writable device level/on (single-control-scene devices only)
		// recalls that device's control scene - there is no per-device set topic on the gateway.
		const dctl = parseDeviceControl(id);
		if (dctl) {
			const sceneId = this.deviceControlScene[dctl.key];
			if (sceneId == null) {
				return; // read-only device (no / multiple control scenes)
			}
			const maxLevel = this.cfg.levelScale === 'raw' ? 254 : 100;
			const level = dctl.leaf === 'on' ? (state.val ? maxLevel : 0) : Number(state.val);
			const command = casambi.buildCommand({ channel: 'scenes', index: sceneId, leaf: 'level' }, level, this.cfg);
			if (command) {
				this.broker.publish(command.topic, command.payload);
				// Do NOT optimistically ack: the requested value already shows (the user's own
				// ack:false write), and the gateway's poll_device readback confirms it (ack:true)
				// within ~1-2s. Invalidate the confirmed snapshot so that next readback re-stamps
				// ack:true even if the value is unchanged (e.g. commanding a load already in state).
				delete this.deviceConfirmed[dctl.key];
				this.log.debug(
					`Device ${dctl.key} ${dctl.leaf}=${state.val} -> recall scene ${sceneId} (awaiting confirm)`,
				);
			}
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
		// Ack only where the gateway gives no readback to confirm with: injected sensors and the
		// momentary virtual buttons have no get/* feedback, so they must self-ack. Controllable
		// channels (broadcast/scenes/groups) are confirmed by their poll_* feedback instead, so we
		// leave them ack:false until that lands - never assume the value took effect.
		if (parts.channel === 'sensors' || parts.channel === 'buttons') {
			this.setState(id, { val: state.val, ack: true });
		}
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
			if (this.syncTimer) {
				this.clearInterval(this.syncTimer);
				this.syncTimer = undefined;
			}
			for (const timer of Object.values(this.deviceReadbackTimers)) {
				this.clearTimeout(timer);
			}
			this.deviceReadbackTimers = {};
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
