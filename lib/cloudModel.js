'use strict';

/*
 * Pure transforms turning a Casambi cloud `network` object into the adapter's
 * structure. Keyed by unit UUID (stable across renumbering); deviceId is kept as
 * the join key for live MQTT (poll_device/<deviceId>). No I/O here - unit tested.
 *
 * Cloud shapes (verified live, fw 4.56 / network "Schmidt-Kierwang"):
 *   network.units[i]  = { deviceID, uuid, address, name, type, groupID, ... }
 *   network.scenes[i] = { sceneID, name, units: [{ unit: <deviceID>, state }] }
 */

/** @param {*} v - array or id-keyed object @returns {Array} values */
function toArray(v) {
	if (Array.isArray(v)) {
		return v;
	}
	if (v && typeof v === 'object') {
		return Object.values(v);
	}
	return [];
}

/**
 * Parse scenes: members are unit deviceIds; a single-member scene is a per-device
 * control scene (switching is scene-only on this gateway).
 *
 * @param {object} network - cloud network object
 * @returns {Array<{sceneId: number, name: string, members: number[], single: boolean}>} scenes
 */
function parseScenes(network) {
	return toArray(network && network.scenes).map(s => {
		const members = toArray(s.units)
			.map(u => u.unit)
			.filter(n => n != null);
		return { sceneId: s.sceneID, name: s.name, members, single: members.length === 1 };
	});
}

/**
 * For each device, the control scene = the single-member scene targeting only it.
 * If several exist, the lowest sceneId wins (deterministic).
 *
 * @param {Array<{sceneId: number, members: number[], single: boolean}>} scenes - parsed scenes
 * @returns {Object<number, number>} deviceId -> sceneId
 */
function controlSceneByDevice(scenes) {
	const out = {};
	for (const sc of scenes) {
		if (!sc.single) {
			continue;
		}
		const dev = sc.members[0];
		if (out[dev] == null || sc.sceneId < out[dev]) {
			out[dev] = sc.sceneId;
		}
	}
	return out;
}

/**
 * Parse the whole network into devices (by uuid) + scenes + a deviceId->uuid map.
 *
 * @param {object} network - cloud network object
 * @returns {{devices: Array, scenes: Array, deviceIdToUuid: Object<number,string>}} parsed model
 */
function parseNetwork(network) {
	const scenes = parseScenes(network);
	const ctrl = controlSceneByDevice(scenes);

	const devices = toArray(network && network.units).map(u => ({
		uuid: u.uuid,
		deviceId: u.deviceID,
		name: u.name,
		address: u.address,
		type: u.type,
		groupId: u.groupID,
		controlScene: ctrl[u.deviceID] != null ? ctrl[u.deviceID] : null,
	}));

	const deviceIdToUuid = {};
	for (const d of devices) {
		if (d.deviceId != null && d.uuid) {
			deviceIdToUuid[d.deviceId] = d.uuid;
		}
	}

	return { devices, scenes, deviceIdToUuid };
}

module.exports = { toArray, parseScenes, controlSceneByDevice, parseNetwork };
