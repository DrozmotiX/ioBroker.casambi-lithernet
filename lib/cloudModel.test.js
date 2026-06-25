'use strict';

const { expect } = require('chai');
const model = require('./cloudModel');

// Trimmed real shape (network "Schmidt-Kierwang", fw 4.56).
const NETWORK = {
	units: [
		{ deviceID: 1, uuid: 'U-0001', address: '067c7a63fbca', name: 'Bad Spot 1', type: 21494, groupID: 0 },
		{ deviceID: 2, uuid: 'U-0002', address: '83a36c2ef72a', name: 'Bad Spot 2+3', type: 191, groupID: 0 },
		{ deviceID: 4, uuid: 'U-0004', address: '1927b7998e14', name: 'Tastermodul 1', type: 22063, groupID: 0 },
	],
	scenes: [
		{ sceneID: 1, name: 'Bad Spots', units: [{ unit: 1, state: 'ff' }, { unit: 2, state: 'ff' }] }, // multi
		{ sceneID: 10, name: '_BAD-spot1', units: [{ unit: 1, state: 'ff' }] }, // control for dev 1
		{ sceneID: 50, name: 'dup-single', units: [{ unit: 1, state: 'ff' }] }, // also single for dev 1 (higher id)
		{ sceneID: 99, name: '_dev2', units: [{ unit: 2, state: 'ff' }] }, // control for dev 2
	],
};

describe('cloudModel.parseNetwork', () => {
	const m = model.parseNetwork(NETWORK);

	it('maps units to devices keyed data (uuid + deviceId join)', () => {
		expect(m.devices).to.have.length(3);
		const d1 = m.devices.find((d) => d.deviceId === 1);
		expect(d1).to.include({ uuid: 'U-0001', name: 'Bad Spot 1', type: 21494, address: '067c7a63fbca' });
	});

	it('builds the deviceId -> uuid routing map for live MQTT', () => {
		expect(m.deviceIdToUuid).to.deep.equal({ 1: 'U-0001', 2: 'U-0002', 4: 'U-0004' });
	});

	it('derives controlScene = single-member scene, lowest sceneId wins', () => {
		expect(m.devices.find((d) => d.deviceId === 1).controlScene).to.equal(10); // not 50
		expect(m.devices.find((d) => d.deviceId === 2).controlScene).to.equal(99);
		expect(m.devices.find((d) => d.deviceId === 4).controlScene).to.equal(null); // no single scene
	});

	it('flags single vs multi member scenes', () => {
		const byId = Object.fromEntries(m.scenes.map((s) => [s.sceneId, s]));
		expect(byId[1].single).to.equal(false);
		expect(byId[1].members).to.deep.equal([1, 2]);
		expect(byId[10].single).to.equal(true);
	});

	it('tolerates id-keyed objects and missing scenes', () => {
		const m2 = model.parseNetwork({ units: { a: { deviceID: 7, uuid: 'U-7' } } });
		expect(m2.devices[0]).to.include({ deviceId: 7, uuid: 'U-7', controlScene: null });
		expect(m2.scenes).to.deep.equal([]);
	});
});
