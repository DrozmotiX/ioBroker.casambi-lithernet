'use strict';

/*
 * Lithernet / Casambi MQTT protocol layer (pure, side-effect free => unit testable).
 *
 *   commands  ->  casambi/<gatewayId>/set/<suffix>   (we publish, gateway subscribes)
 *   feedback  <-  casambi/<gatewayId>/get/<suffix>   (gateway publishes, we receive)
 *
 * Topics are fixed and not remappable on the gateway, so all mapping lives here.
 * Payloads are JSON. Dimmer levels are raw 0-254 on the wire; conversion to/from
 * the configured display scale is delegated to lib/converter.js.
 */

const converter = require('./converter');

const ROOT = 'casambi';

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
		case 'control':
			if (leaf === 'level') {
				return {
					topic: buildSetTopic(gw, 'level'),
					payload: { level: converter.levelToRaw(value, cfg.levelScale), duration },
				};
			}
			return null; // control.duration is a parameter, not a command

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

		// 'devices' is monitoring only - the gateway exposes no per-device set topic
		default:
			return null;
	}
}

/**
 * Parse a feedback `get/...` message into a nested JSON tree shaped for
 * jsonExplorer.traverseJson (leaf keys match lib/state_attr.js).
 *
 * @param {string} topic - full MQTT topic
 * @param {object} payload - already JSON-parsed payload
 * @param {object} cfg - { gatewayId, levelScale }
 * @returns {object|null} nested tree (e.g. { scenes: { 1: { level: 50 } } }) or null
 */
function parseGet(topic, payload, cfg) {
	const parts = String(topic).split('/');
	// casambi / <id> / get / <suffix>
	if (parts.length < 4 || parts[0] !== ROOT || parts[2] !== 'get') {
		return null;
	}
	if (cfg && cfg.gatewayId != null && parts[1] !== String(cfg.gatewayId)) {
		return null; // ignore other gateways sharing the broker
	}
	if (!payload || typeof payload !== 'object') {
		return null;
	}
	const suffix = parts[3];
	const scale = cfg ? cfg.levelScale : 'percent';

	switch (suffix) {
		case 'scene_level': {
			if (payload.scene == null) {
				return null;
			}
			const node = {};
			if (payload.level != null) {
				node.level = converter.levelToDisplay(payload.level, scale);
			}
			if (payload.active != null) {
				node.active = !!payload.active;
			}
			return { scenes: { [payload.scene]: node } };
		}
		case 'scene_call': {
			if (payload.scene == null) {
				return null;
			}
			return { scenes: { [payload.scene]: { active: true } } };
		}
		case 'group_level': {
			if (payload.group == null) {
				return null;
			}
			const node = {};
			if (payload.level != null) {
				node.level = converter.levelToDisplay(payload.level, scale);
			}
			return { groups: { [payload.group]: node } };
		}
		case 'device_level':
		case 'level': {
			const id = payload.device != null ? payload.device : payload.id;
			if (id == null) {
				return null;
			}
			const node = {};
			if (payload.level != null) {
				node.level = converter.levelToDisplay(payload.level, scale);
			}
			if (payload.condition != null) {
				node.condition = Number(payload.condition);
			}
			return { devices: { [id]: node } };
		}
		case 'device_condition':
		case 'condition': {
			const id = payload.device != null ? payload.device : payload.id;
			if (id == null) {
				return null;
			}
			const cond = payload.condition != null ? payload.condition : payload.value;
			return { devices: { [id]: { condition: Number(cond) } } };
		}
		default:
			return null;
	}
}

module.exports = {
	ROOT,
	buildSetTopic,
	buildCommand,
	parseGet,
};
