'use strict';

/*
 * Casambi cloud client — KEY-FREE metadata read via api.casambi.com.
 *
 * Uses the network's own credentials (UUID + network password), NOT the developer
 * REST API (door.casambi.com) which needs an X-Casambi-Key. Flow (verified against
 * casambi-bt and live):
 *   1. GET  /network/uuid/<uuid>      -> { id, uuid, name, ... }
 *   2. POST /network/<id>/session     { password, deviceName } -> { session, expires, ... }
 *   3. PUT  /network/<id>/            { formatVersion, deviceName, revision }  (+ X-Casambi-Session)
 *                                     -> { status, revision, network: {...} }
 * No Bluetooth: the UUID is obtained once (Casambi app iBeacon screen, or a one-time BLE scan).
 */

const https = require('https');

const HOST = 'api.casambi.com';
const DEVICE_NAME = 'ioBroker.casambi-lithernet';

/**
 * Minimal JSON-over-HTTPS request to the Casambi cloud.
 *
 * @param {string} method - HTTP method
 * @param {string} path - request path
 * @param {{headers?: object, body?: object|null, timeout?: number}} [opts] - options
 * @returns {Promise<{status: number, body: string}>} status code and raw body
 */
function request(method, path, opts) {
	const { headers = {}, body = null, timeout = 15000 } = opts || {};
	return new Promise((resolve, reject) => {
		const data = body ? JSON.stringify(body) : null;
		const req = https.request(
			{
				host: HOST,
				path,
				method,
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': DEVICE_NAME,
					...headers,
					...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
				},
				timeout,
			},
			res => {
				let d = '';
				res.on('data', c => (d += c));
				res.on('end', () => resolve({ status: res.statusCode || 0, body: d }));
			},
		);
		req.on('error', reject);
		req.on('timeout', function () {
			this.destroy(new Error('cloud request timeout'));
		});
		if (data) {
			req.write(data);
		}
		req.end();
	});
}

/**
 * Resolve a network UUID to its cloud network id (+ basic info). No auth needed.
 *
 * @param {string} uuid - network UUID (from the app iBeacon screen / BLE scan)
 * @returns {Promise<{id: string, uuid: string, name: string}>} network identity
 */
async function resolveNetworkId(uuid) {
	const r = await request('GET', `/network/uuid/${encodeURIComponent(uuid)}`);
	if (r.status !== 200) {
		throw new Error(`UUID lookup failed (HTTP ${r.status}) - check the network UUID`);
	}
	return JSON.parse(r.body);
}

/**
 * Create a session for a network using its password.
 *
 * @param {string} id - cloud network id
 * @param {string} password - network (admin) password
 * @returns {Promise<{session: string, expires?: number}>} session token info
 */
async function createSession(id, password) {
	const r = await request('POST', `/network/${id}/session`, { body: { password, deviceName: DEVICE_NAME } });
	if (r.status !== 200) {
		throw new Error(`Session failed (HTTP ${r.status}) - check the network password`);
	}
	const j = JSON.parse(r.body);
	if (!j.session) {
		throw new Error('Session response had no token');
	}
	return j;
}

/**
 * Fetch the full network configuration (units/scenes/groups/...).
 *
 * @param {string} id - cloud network id
 * @param {string} session - session token from createSession
 * @param {number} [revision] - last known revision (0 = full)
 * @returns {Promise<object>} the `network` object
 */
async function fetchNetwork(id, session, revision = 0) {
	const r = await request('PUT', `/network/${id}/`, {
		headers: { 'X-Casambi-Session': session },
		body: { formatVersion: 1, deviceName: DEVICE_NAME, revision },
	});
	if (r.status !== 200) {
		throw new Error(`Network fetch failed (HTTP ${r.status})`);
	}
	const j = JSON.parse(r.body);
	return j.network || j;
}

/**
 * High-level: UUID + password -> full network metadata, key-free.
 *
 * @param {string} uuid - network UUID
 * @param {string} password - network password
 * @returns {Promise<{id: string, uuid: string, name: string, network: object}>} identity + network
 */
async function fetchNetworkData(uuid, password) {
	const info = await resolveNetworkId(uuid);
	const sess = await createSession(info.id, password);
	const network = await fetchNetwork(info.id, sess.session);
	return { id: info.id, uuid: info.uuid, name: info.name, network };
}

module.exports = { HOST, DEVICE_NAME, request, resolveNetworkId, createSession, fetchNetwork, fetchNetworkData };
