'use strict';

const net = require('net');
const aedes = require('aedes');

/*
 * Embedded MQTT broker (aedes). The Lithernet Casambi gateway is an MQTT *client*
 * that needs a broker to connect to, so this adapter provides one. The gateway is
 * pointed at <host>:<port> configured in the admin UI. SSL is not supported by the
 * gateway, so the listener is plain TCP - run it on a trusted network only.
 */
class CasambiBroker {
	/**
	 * @param {ioBroker.Adapter} adapter - adapter instance (for logging + info.connection)
	 * @param {object} options - { bind, port, username, password, logAllMessages }
	 * @param {(topic: string, payload: object) => void} onFeedback - handler for gateway get/* messages
	 */
	constructor(adapter, options, onFeedback) {
		this.adapter = adapter;
		this.options = options;
		this.onFeedback = onFeedback;
		this.aedes = null;
		this.server = null;
		this.clients = new Set();
	}

	/**
	 * Start the broker and begin listening. Resolves once the TCP server is up.
	 *
	 * @returns {Promise<void>}
	 */
	start() {
		return new Promise((resolve, reject) => {
			const aedesOptions = {};
			const { username, password } = this.options;
			if (username) {
				aedesOptions.authenticate = (client, user, pass, callback) => {
					const ok = user === username && (pass ? pass.toString() : '') === (password || '');
					if (ok) {
						callback(null, true);
					} else {
						const error = new Error('Authentication failed');
						// @ts-expect-error aedes augments the error with a CONNACK return code
						error.returnCode = 4;
						this.adapter.log.warn(`MQTT client rejected (bad credentials): ${client ? client.id : '?'}`);
						callback(error, false);
					}
				};
			}

			this.aedes = aedes.createBroker(aedesOptions);

			this.aedes.on('client', client => {
				this.clients.add(client.id);
				this.adapter.log.info(`Gateway connected: ${client.id}`);
				this.adapter.setState('info.connection', true, true);
			});

			this.aedes.on('clientDisconnect', client => {
				this.clients.delete(client.id);
				this.adapter.log.info(`Gateway disconnected: ${client.id}`);
				if (this.clients.size === 0) {
					this.adapter.setState('info.connection', false, true);
				}
			});

			this.aedes.on('clientError', (client, error) => {
				this.adapter.log.debug(`Client error ${client ? client.id : '?'}: ${error.message}`);
			});

			this.aedes.on('publish', (packet, client) => {
				// Broker-originated publishes (our own set/* commands and $SYS) have no client.
				if (!client || !packet || !packet.topic) {
					return;
				}
				const raw = packet.payload ? packet.payload.toString() : '';
				// Surface every incoming gateway message: always at debug, and at info
				// when "Log all incoming MQTT messages" is enabled.
				if (this.options.logAllMessages) {
					this.adapter.log.info(`MQTT in  ${packet.topic}  ${raw}`);
				} else {
					this.adapter.log.debug(`MQTT in  ${packet.topic}  ${raw}`);
				}
				let payload;
				try {
					payload = raw.length ? JSON.parse(raw) : {};
				} catch (error) {
					this.adapter.log.debug(`Ignoring non-JSON payload on ${packet.topic}: ${error.message}`);
					return;
				}
				try {
					this.onFeedback(packet.topic, payload);
				} catch (error) {
					this.adapter.log.error(`Feedback handler error for ${packet.topic}: ${error.message}`);
				}
			});

			this.server = net.createServer(this.aedes.handle);
			this.server.on('error', error => {
				this.adapter.log.error(`MQTT broker error: ${error.message}`);
				reject(error);
			});
			this.server.listen(this.options.port, this.options.bind, () => {
				this.adapter.log.info(`MQTT broker listening on ${this.options.bind}:${this.options.port}`);
				resolve();
			});
		});
	}

	/**
	 * Publish a JSON command to a gateway topic.
	 *
	 * @param {string} topic - full MQTT topic
	 * @param {object} payload - JSON-serialisable payload
	 */
	publish(topic, payload) {
		if (!this.aedes) {
			return;
		}
		/** @type {import('mqtt-packet').IPublishPacket} */
		const packet = {
			cmd: 'publish',
			topic,
			payload: Buffer.from(JSON.stringify(payload)),
			qos: 0,
			retain: false,
			dup: false,
		};
		this.aedes.publish(packet, error => {
			if (error) {
				this.adapter.log.warn(`Publish to ${topic} failed: ${error.message}`);
			} else {
				this.adapter.log.debug(`Published ${topic} ${JSON.stringify(payload)}`);
			}
		});
	}

	/**
	 * Stop the broker and close the TCP server. Always resolves.
	 *
	 * @returns {Promise<void>}
	 */
	stop() {
		return new Promise(resolve => {
			let settled = false;
			const finish = () => {
				if (settled) {
					return;
				}
				settled = true;
				resolve();
			};
			// Hard safety net: never let onUnload hang on broker shutdown, regardless
			// of any half-open sockets or aedes internals not calling back.
			const guard = setTimeout(finish, 2000);
			if (typeof guard.unref === 'function') {
				guard.unref();
			}

			// Force-destroy any lingering sockets first (incl. half-open TCP connections
			// that never completed the MQTT handshake) so server.close() can complete.
			// Bracket access: closeAllConnections (Node >= 18.2) may be absent from the
			// pinned @types/node Server typing.
			const closeAll = this.server && this.server['closeAllConnections'];
			if (typeof closeAll === 'function') {
				closeAll.call(this.server);
			}

			const closeServer = () => {
				if (this.server) {
					this.server.close(() => {
						clearTimeout(guard);
						finish();
					});
				} else {
					clearTimeout(guard);
					finish();
				}
			};

			// Close aedes first: it disconnects connected MQTT clients.
			if (this.aedes) {
				this.aedes.close(closeServer);
			} else {
				closeServer();
			}
		});
	}
}

module.exports = CasambiBroker;
