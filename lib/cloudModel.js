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
 * For each device, all single-member scenes targeting only it (ascending sceneId).
 * 0 = uncontrollable over MQTT, >1 = ambiguous (both surfaced by coverage()).
 *
 * @param {Array<{sceneId: number, members: number[], single: boolean}>} scenes - parsed scenes
 * @returns {Object<number, number[]>} deviceId -> sorted sceneId[]
 */
function controlScenesByDevice(scenes) {
	const out = {};
	for (const sc of scenes) {
		if (!sc.single) {
			continue;
		}
		const dev = sc.members[0];
		(out[dev] = out[dev] || []).push(sc.sceneId);
	}
	for (const dev of Object.keys(out)) {
		out[dev].sort((a, b) => a - b);
	}
	return out;
}

/**
 * Scene-coverage diagnostics, scoped to actual *loads* (devices that are members of
 * at least one scene) - so button/sensor/gateway nodes (never scene members) are not
 * flagged. Used by the adapter to surface the per-device-scene setup health.
 *
 * @param {Array} devices - parsed devices (with controlScenes)
 * @param {Array<{members: number[]}>} scenes - parsed scenes
 * @returns {{none: Array, multiple: Array}} loads with no / multiple control scenes
 */
function coverage(devices, scenes) {
	const inAnyScene = new Set();
	for (const s of scenes) {
		for (const m of s.members) {
			inAnyScene.add(m);
		}
	}
	const loads = devices.filter(d => inAnyScene.has(d.deviceId));
	const none = loads
		.filter(d => !d.controlScenes || d.controlScenes.length === 0)
		.map(d => ({ deviceId: d.deviceId, name: d.name }));
	const multiple = loads
		.filter(d => d.controlScenes && d.controlScenes.length > 1)
		.map(d => ({ deviceId: d.deviceId, name: d.name, scenes: d.controlScenes }));
	return { none, multiple };
}

/**
 * Parse the whole network into devices (by uuid) + scenes + deviceId->uuid map +
 * scene-coverage diagnostics.
 *
 * @param {object} network - cloud network object
 * @returns {{devices: Array, scenes: Array, deviceIdToUuid: Object<number,string>, coverage: object}} model
 */
function parseNetwork(network) {
	const scenes = parseScenes(network);
	const ctrl = controlScenesByDevice(scenes);

	const devices = toArray(network && network.units).map(u => {
		const list = ctrl[u.deviceID] || [];
		return {
			uuid: u.uuid,
			deviceId: u.deviceID,
			name: u.name,
			address: u.address,
			type: u.type,
			groupId: u.groupID,
			controlScenes: list,
			controlScene: list.length ? list[0] : null,
		};
	});

	const deviceIdToUuid = {};
	for (const d of devices) {
		if (d.deviceId != null && d.uuid) {
			deviceIdToUuid[d.deviceId] = d.uuid;
		}
	}

	return { devices, scenes, deviceIdToUuid, coverage: coverage(devices, scenes) };
}

/**
 * Parse a build-range expression: "0-*" / "*" (all), "1-50", or "5" (exact).
 * Empty/invalid falls back to all.
 *
 * @param {*} expr - range string
 * @returns {{min: number, max: number}} inclusive bounds (max may be Infinity)
 */
function parseRange(expr) {
	const s = String(expr == null ? '' : expr).trim();
	if (!s || s === '*') {
		return { min: 0, max: Infinity };
	}
	const m = s.match(/^(\d+)\s*-\s*(\*|\d+)$/);
	if (m) {
		return { min: Number(m[1]), max: m[2] === '*' ? Infinity : Number(m[2]) };
	}
	if (/^\d+$/.test(s)) {
		return { min: Number(s), max: Number(s) };
	}
	return { min: 0, max: Infinity };
}

/**
 * @param {number} id - numeric id @param {{min: number, max: number}} range - bounds
 * @param range
 * @returns {boolean} whether id is within the inclusive range
 */
function inRange(id, range) {
	return id != null && id >= range.min && id <= range.max;
}

module.exports = { toArray, parseScenes, controlScenesByDevice, coverage, parseNetwork, parseRange, inRange };
