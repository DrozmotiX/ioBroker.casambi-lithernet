'use strict';

/*
 * Lithernet / Casambi MQTT protocol layer (pure, side-effect free => unit testable).
 *
 *   commands  ->  casambi/<gatewayId>/set/<suffix>            (we publish, gateway subscribes)
 *   feedback  <-  casambi/<gatewayId>/get/poll_<type>[/idx]    (gateway publishes, we receive)
 *
 * Feedback topics & payloads were captured live from a REV2.5 gateway (firmware 4.56):
 *   get/poll_broadcast            {level,last_level,cct_level,vertical,last_change}
 *   get/poll_ungrouped            (same shape)
 *   get/poll_scene/<N>            {active,level,last_change}
 *   get/poll_group/<N>            {level,last_level,cct_level,vertical,last_change}
 *   get/poll_device/<N>/values    {scene,level,last_level,cct_level,red,green,blue,white,hue,sat,x,y,level_xy,vertical,last_change}
 *   get/poll_device/<N>/propertys {online,node_type,priority,scene_type,color_selector,color_balance,condition,ambient_temperatur,battery_level,overheating,general_failure,last_change}
 *   get/node_deleted/             {device}
 *
 * Levels on the wire are 0-254; conversion to/from the configured display scale is
 * delegated to lib/converter.js. Only dimming fields (level/last_level) are scaled.
 */

const converter = require('./converter');

const ROOT = 'casambi';

// Width that scene/group/device/button indices are zero-padded to in the object tree, so
// they sort naturally in admin (devices.001 .. devices.021, not 1,10,11,...,2). 3 digits
// covers the Casambi maximum of 255 units.
const INDEX_WIDTH = 3;

// Unconfigured scene/group slots report this 0xFF sentinel in `level` (confirmed live: real
// scenes cap at 254, padding slots read 255). Used to skip phantom placeholder slots.
const PLACEHOLDER_LEVEL = 255;

// Feedback `kind` segments (topic part [3], after get/) that parseGet recognises. Any other
// kind - e.g. the `element_*` family that carries battery + physical button events - is not yet
// mapped; sampleUnhandled() in main.js surfaces those once each so they can be added here.
const KNOWN_FEEDBACK_KINDS = new Set([
	'poll_broadcast',
	'poll_ungrouped',
	'poll_scene',
	'poll_group',
	'poll_device',
	'node_deleted',
]);

// Payload fields that represent a dimming level and should be scaled to the display scale.
const LEVEL_FIELDS = new Set(['level', 'last_level']);
// Payload fields that are 0/1 flags and should surface as booleans.
const BOOL_FIELDS = new Set(['active', 'online', 'overheating', 'general_failure']);

// Per-device VALUES fields created only when non-zero. A plain dimmer never carries
// colour/cct/vertical, so those states are not created until a device actually reports them
// (the tree auto-expands for colour/tunable fixtures). level/last_level/scene are always kept.
const DEVICE_OPTIONAL_ZERO = new Set([
	'cct_level',
	'red',
	'green',
	'blue',
	'white',
	'hue',
	'sat',
	'x',
	'y',
	'level_xy',
	'vertical',
]);
// Per-device PROPERTYS fields created only when non-zero (capability/health a plain dimmer lacks).
// online/node_type/condition + fault flags are always kept.
const PROPERTY_OPTIONAL_ZERO = new Set([
	'priority',
	'scene_type',
	'color_selector',
	'color_balance',
	'battery_level',
	'ambient_temperatur',
]);

/**
 * Zero-pad a scene/group/device/button index for use as an object-tree segment.
 *
 * @param {string|number} index - raw index from the topic/config
 * @returns {string} zero-padded index (e.g. 7 -> "007")
 */
function padIndex(index) {
	return String(index).padStart(INDEX_WIDTH, '0');
}

/**
 * True if a scene/group payload is an unconfigured placeholder slot (the gateway pads its
 * cyclic poll up to the configured count with empty slots reporting level 255).
 *
 * @param {object} payload - raw (unscaled) gateway payload
 * @returns {boolean} whether this is a placeholder slot to skip
 */
function isPlaceholderLevelNode(payload) {
	return !!payload && payload.level === PLACEHOLDER_LEVEL;
}

/**
 * Drop fields whose value is 0 when they are in the given optional set (capability gating).
 *
 * @param {object} node - normalised payload
 * @param {Set<string>} optional - fields to drop when 0
 * @returns {object} a new node without the zero-valued optional fields
 */
function pruneOptionalZeros(node, optional) {
	const out = {};
	for (const [key, value] of Object.entries(node)) {
		if (optional.has(key) && value === 0) {
			continue;
		}
		out[key] = value;
	}
	return out;
}

/**
 * Classify a poll_device topic into its padded index and sub-kind (values|propertys), for
 * the realness tracking in main.js. Returns null for non-device or other-gateway topics.
 *
 * @param {string} topic - full MQTT topic
 * @param {object} [cfg] - { gatewayId }
 * @returns {{index: string, kind: 'values'|'propertys'}|null} parsed device ref, or null
 */
function classifyDevice(topic, cfg) {
	const parts = String(topic).split('/');
	if (parts.length < 6 || parts[0] !== ROOT || parts[2] !== 'get' || parts[3] !== 'poll_device') {
		return null;
	}
	if (cfg && cfg.gatewayId != null && parts[1] !== String(cfg.gatewayId)) {
		return null;
	}
	const kind = parts[5];
	if (kind !== 'values' && kind !== 'propertys') {
		return null;
	}
	return { index: padIndex(parts[4]), kind };
}

/**
 * True if a topic is the gateway's node_deleted event for the configured gateway.
 *
 * @param {string} topic - full MQTT topic
 * @param {object} [cfg] - { gatewayId }
 * @returns {boolean} whether this is a node_deleted event
 */
function isNodeDeleted(topic, cfg) {
	const parts = String(topic).split('/');
	if (parts.length < 4 || parts[0] !== ROOT || parts[2] !== 'get') {
		return false;
	}
	if (cfg && cfg.gatewayId != null && parts[1] !== String(cfg.gatewayId)) {
		return false;
	}
	return parts[3] === 'node_deleted';
}

/**
 * Reduce a not-yet-mapped feedback topic to a stable dedup *shape*, or null if it is a known
 * (handled) kind, belongs to another gateway, or is not a feedback topic at all. Numeric path
 * segments (indices) collapse to '#' so every topic in a family shares one shape and logs once.
 *
 * @param {string} topic - full MQTT topic
 * @param {object} [cfg] - { gatewayId }
 * @returns {string|null} dedup shape (e.g. 'get/element_button/#') or null to ignore
 */
function unhandledShape(topic, cfg) {
	const parts = String(topic).split('/');
	if (parts.length < 4 || parts[0] !== ROOT || parts[2] !== 'get') {
		return null;
	}
	if (cfg && cfg.gatewayId != null && parts[1] !== String(cfg.gatewayId)) {
		return null;
	}
	if (KNOWN_FEEDBACK_KINDS.has(parts[3])) {
		return null;
	}
	return parts
		.slice(2)
		.map(part => (/^\d+$/.test(part) ? '#' : part))
		.join('/');
}

/**
 * Build a `set/...` command topic for a given gateway id.
 *
 * @param {string} gatewayId - the topic segment configured in the gateway UI
 * @param {string} suffix - command suffix, e.g. 'scene_level'
 * @returns {string} full MQTT topic
 */
function buildSetTopic(gatewayId, suffix) {
	return `${ROOT}/${gatewayId}/set/${suffix}`;
}

/**
 * Translate a writable state (parsed into its parts) into an MQTT command.
 *
 * @param {object} parts - { channel, index, leaf } derived from the state id
 * @param {*} value - the new state value (ack === false)
 * @param {object} cfg - { gatewayId, defaultDuration, levelScale }
 * @returns {{topic: string, payload: object}|null} command or null if not actionable
 */
function buildCommand(parts, value, cfg) {
	const { channel, index, leaf } = parts;
	const duration = Number(cfg.defaultDuration) || 0;
	const gw = cfg.gatewayId;

	switch (channel) {
		case 'broadcast':
			if (leaf === 'level') {
				return {
					topic: buildSetTopic(gw, 'level'),
					payload: { level: converter.levelToRaw(value, cfg.levelScale), duration },
				};
			}
			return null;

		case 'scenes':
			if (leaf === 'level' && index != null) {
				return {
					topic: buildSetTopic(gw, 'scene_level'),
					payload: { scene: index, level: converter.levelToRaw(value, cfg.levelScale), duration },
				};
			}
			return null;

		case 'groups':
			if (leaf === 'level' && index != null) {
				return {
					topic: buildSetTopic(gw, 'group_level'),
					payload: { group: index, level: converter.levelToRaw(value, cfg.levelScale), duration },
				};
			}
			return null;

		case 'sensors':
			if (leaf === 'lux') {
				return { topic: buildSetTopic(gw, 'light_sensor'), payload: { lux_level: Number(value) || 0 } };
			}
			if (leaf === 'pir') {
				return { topic: buildSetTopic(gw, 'pir_sensor'), payload: { pir_sensor: value ? 1 : 0 } };
			}
			return null;

		case 'buttons':
			if (index == null) {
				return null;
			}
			if (leaf === 'level') {
				return {
					topic: buildSetTopic(gw, 'button_level'),
					payload: { button: index, level: converter.levelToRaw(value, cfg.levelScale) },
				};
			}
			if (leaf === 'pressed' && value) {
				return { topic: buildSetTopic(gw, 'push_button_pressed'), payload: { button: index } };
			}
			if (leaf === 'released' && value) {
				return { topic: buildSetTopic(gw, 'push_button_released'), payload: { button: index } };
			}
			return null;

		// 'devices' and 'ungrouped' are monitoring only - the gateway exposes no per-device set topic
		default:
			return null;
	}
}

/**
 * Normalise a feedback payload: scale dimming levels and booleanise 0/1 flags.
 *
 * @param {object} payload - raw JSON payload from the gateway
 * @param {string} scale - 'percent' | 'raw'
 * @returns {object} a new object with normalised values
 */
function normalise(payload, scale) {
	const out = {};
	for (const [key, value] of Object.entries(payload)) {
		if (LEVEL_FIELDS.has(key) && typeof value === 'number') {
			out[key] = converter.levelToDisplay(value, scale);
		} else if (BOOL_FIELDS.has(key)) {
			out[key] = !!value;
		} else {
			out[key] = value;
		}
	}
	return out;
}

/**
 * Parse a feedback message into a nested JSON tree shaped for
 * jsonExplorer.traverseJson (leaf keys match lib/state_attr.js).
 *
 * @param {string} topic - full MQTT topic
 * @param {object} payload - already JSON-parsed payload
 * @param {object} cfg - { gatewayId, levelScale }
 * @returns {object|null} nested tree (e.g. { scenes: { 5: { level: 50, active: true } } }) or null
 */
function parseGet(topic, payload, cfg) {
	const parts = String(topic).split('/');
	// casambi / <id> / get / poll_<type> [ / <idx> [ / values|propertys ] ]
	if (parts.length < 4 || parts[0] !== ROOT || parts[2] !== 'get') {
		return null;
	}
	if (cfg && cfg.gatewayId != null && parts[1] !== String(cfg.gatewayId)) {
		return null; // ignore other gateways sharing the broker
	}
	if (!payload || typeof payload !== 'object') {
		return null;
	}
	const scale = cfg ? cfg.levelScale : 'percent';
	const kind = parts[3];
	const node = normalise(payload, scale);

	switch (kind) {
		case 'poll_broadcast':
			return { broadcast: node };
		case 'poll_ungrouped':
			return { ungrouped: node };
		case 'poll_scene':
			// Skip unconfigured placeholder slots (level 255 sentinel; a real scene maxes at
			// 254). An *active* scene is always real, so never drop one currently recalled.
			if (parts[4] == null || (isPlaceholderLevelNode(payload) && !payload.active)) {
				return null;
			}
			return { scenes: { [padIndex(parts[4])]: node } };
		case 'poll_group':
			if (parts[4] == null || isPlaceholderLevelNode(payload)) {
				return null; // unknown index or unconfigured placeholder slot
			}
			return { groups: { [padIndex(parts[4])]: node } };
		case 'poll_device': {
			// .../poll_device/<N>/values and .../propertys both flatten under devices.<N>;
			// optional zero-valued fields are pruned so a plain dimmer stays lean.
			if (parts[4] == null || parts[5] == null) {
				return null;
			}
			const optional = parts[5] === 'propertys' ? PROPERTY_OPTIONAL_ZERO : DEVICE_OPTIONAL_ZERO;
			const cleaned = pruneOptionalZeros(node, optional);
			// Derive a read-only on/off from the dimmer level (values sub-topic only), so each
			// real device exposes a boolean switch state alongside its level. The device has no
			// set topic, so this is monitoring only (consumed e.g. by oikos-connect SwitchCurrent).
			if (parts[5] === 'values' && typeof cleaned.level === 'number') {
				cleaned.on = cleaned.level > 0;
			}
			return { devices: { [padIndex(parts[4])]: cleaned } };
		}
		// node_deleted is handled in main.js (object removal), not mapped to a state here
		default:
			return null;
	}
}

module.exports = {
	ROOT,
	INDEX_WIDTH,
	buildSetTopic,
	buildCommand,
	parseGet,
	normalise,
	padIndex,
	classifyDevice,
	isNodeDeleted,
	isPlaceholderLevelNode,
	unhandledShape,
};
