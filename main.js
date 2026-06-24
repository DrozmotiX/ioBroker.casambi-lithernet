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
				seed.buttons[i] = { level: 0, pressed: false, released: false };
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
	}

	/**
	 * Handle a feedback message published by the gateway (get/...).
	 *
	 * @param {string} topic - full MQTT topic
	 * @param {object} payload - JSON-parsed payload
	 */
	async handleFeedback(topic, payload) {
		const tree = casambi.parseGet(topic, payload, this.cfg);
		if (!tree) {
			this.log.debug(`Unhandled feedback on ${topic}: ${JSON.stringify(payload)}`);
			return;
		}
		// Inject friendly names so jsonExplorer labels the scene/group/device channels.
		if (this.hasNames) {
			this.applyNames(tree);
		}
		await jsonExplorer.traverseJson(tree, '', this.hasNames, false, 0);
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
				if (map[index]) {
					tree[channel][index].name = map[index];
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
