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

// Payload fields that represent a dimming level and should be scaled to the display scale.
const LEVEL_FIELDS = new Set(['level', 'last_level']);
// Payload fields that are 0/1 flags and should surface as booleans.
const BOOL_FIELDS = new Set(['active', 'online', 'overheating', 'general_failure']);

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
			if (parts[4] == null) {
				return null;
			}
			return { scenes: { [parts[4]]: node } };
		case 'poll_group':
			if (parts[4] == null) {
				return null;
			}
			return { groups: { [parts[4]]: node } };
		case 'poll_device':
			// .../poll_device/<N>/values and .../propertys both flatten under devices.<N>
			if (parts[4] == null) {
				return null;
			}
			return { devices: { [parts[4]]: node } };
		// node_deleted is an event we don't map to a state for now
		default:
			return null;
	}
}

module.exports = {
	ROOT,
	buildSetTopic,
	buildCommand,
	parseGet,
	normalise,
};
