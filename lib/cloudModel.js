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
			// Auto control scene ONLY when the mapping is unambiguous (exactly one single-member
			// scene). With multiple candidates we no longer silently pick the lowest id - the owner
			// assigns one in the admin "Control mapping" tab (see resolveControlScene).
			controlScene: list.length === 1 ? list[0] : null,
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
 * Build the manual deviceId->sceneId map from the admin "Control mapping" rows. Only valid
 * single-member control scenes are kept: a single-member scene controls exactly one device, so
 * the chosen scene uniquely identifies its device (no separate device column needed). If two
 * rows pick different scenes for the SAME device, the last one wins.
 *
 * @param {Array<{sceneId: number, members: number[], single: boolean}>} scenes - parsed scenes
 * @param {Array<{scene: number|string}>} entries - config.controlSceneMap rows
 * @returns {Object<number, number>} deviceId -> chosen sceneId
 */
function manualMapFromConfig(scenes, entries) {
	const byId = {};
	for (const s of toArray(scenes)) {
		byId[s.sceneId] = s;
	}
	const out = {};
	for (const e of toArray(entries)) {
		const sceneId = e == null ? NaN : Number(e.scene);
		const s = byId[sceneId];
		if (s && s.single && s.members[0] != null) {
			out[s.members[0]] = sceneId;
		}
	}
	return out;
}

/**
 * Resolve a device's effective control scene. A valid manual pick (one of the device's own
 * single-member candidates) wins; otherwise a lone candidate auto-maps; multiple candidates with
 * no manual pick are 'unresolved' (device stays read-only until the owner assigns one); no
 * candidate at all is 'none' (uncontrollable over MQTT).
 *
 * @param {{deviceId: number, controlScenes: number[]}} device - parsed device
 * @param {Object<number, number>} [manualMap] - deviceId -> sceneId from manualMapFromConfig
 * @returns {{sceneId: number|null, status: 'manual'|'auto'|'unresolved'|'none'}} resolution
 */
function resolveControlScene(device, manualMap) {
	const candidates = Array.isArray(device.controlScenes) ? device.controlScenes : [];
	const manual = manualMap ? manualMap[device.deviceId] : undefined;
	if (manual != null && candidates.includes(manual)) {
		return { sceneId: manual, status: 'manual' };
	}
	if (candidates.length === 1) {
		return { sceneId: candidates[0], status: 'auto' };
	}
	if (candidates.length > 1) {
		return { sceneId: null, status: 'unresolved' };
	}
	return { sceneId: null, status: 'none' };
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

module.exports = {
	toArray,
	parseScenes,
	controlScenesByDevice,
	coverage,
	parseNetwork,
	manualMapFromConfig,
	resolveControlScene,
	parseRange,
	inRange,
};
