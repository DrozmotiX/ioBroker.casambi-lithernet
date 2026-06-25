'use strict';

const { expect } = require('chai');
const model = require('./cloudModel');

// Trimmed real shape (network "Schmidt-Kierwang", fw 4.56).
const NETWORK = {
	units: [
		{ deviceID: 1, uuid: 'U-0001', address: '067c7a63fbca', name: 'Bad Spot 1', type: 21494, groupID: 0 },
		{ deviceID: 2, uuid: 'U-0002', address: '83a36c2ef72a', name: 'Bad Spot 2+3', type: 191, groupID: 0 },
		{ deviceID: 3, uuid: 'U-0003', address: 'a553629ad75f', name: 'No-scene load', type: 191, groupID: 0 },
		{ deviceID: 4, uuid: 'U-0004', address: '1927b7998e14', name: 'Tastermodul 1', type: 22063, groupID: 0 },
	],
	scenes: [
		{ sceneID: 1, name: 'Bad Spots', units: [{ unit: 1, state: 'ff' }, { unit: 2, state: 'ff' }, { unit: 3, state: 'ff' }] }, // multi (loads 1,2,3)
		{ sceneID: 10, name: '_BAD-spot1', units: [{ unit: 1, state: 'ff' }] }, // control for dev 1
		{ sceneID: 50, name: 'dup-single', units: [{ unit: 1, state: 'ff' }] }, // also single for dev 1 (higher id)
		{ sceneID: 99, name: '_dev2', units: [{ unit: 2, state: 'ff' }] }, // control for dev 2
	],
};

describe('cloudModel.parseNetwork', () => {
	const m = model.parseNetwork(NETWORK);

	it('maps units to devices keyed data (uuid + deviceId join)', () => {
		expect(m.devices).to.have.length(4);
		const d1 = m.devices.find(d => d.deviceId === 1);
		expect(d1).to.include({ uuid: 'U-0001', name: 'Bad Spot 1', type: 21494, address: '067c7a63fbca' });
	});

	it('builds the deviceId -> uuid routing map for live MQTT', () => {
		expect(m.deviceIdToUuid).to.deep.equal({ 1: 'U-0001', 2: 'U-0002', 3: 'U-0003', 4: 'U-0004' });
	});

	it('derives controlScene (lowest) + controlScenes (all single-member)', () => {
		expect(m.devices.find(d => d.deviceId === 1).controlScene).to.equal(10); // lowest of [10,50]
		expect(m.devices.find(d => d.deviceId === 1).controlScenes).to.deep.equal([10, 50]);
		expect(m.devices.find(d => d.deviceId === 2).controlScene).to.equal(99);
		expect(m.devices.find(d => d.deviceId === 3).controlScenes).to.deep.equal([]); // load, no single scene
		expect(m.devices.find(d => d.deviceId === 4).controlScene).to.equal(null); // not even a scene member
	});

	it('flags single vs multi member scenes', () => {
		const byId = Object.fromEntries(m.scenes.map(s => [s.sceneId, s]));
		expect(byId[1].single).to.equal(false);
		expect(byId[1].members).to.deep.equal([1, 2, 3]);
		expect(byId[10].single).to.equal(true);
	});

	it('coverage flags loads with no / multiple control scenes (ignores non-load nodes)', () => {
		// dev 3 is a scene member (load) but has no single-member scene -> "none"
		expect(m.coverage.none).to.deep.equal([{ deviceId: 3, name: 'No-scene load' }]);
		// dev 1 has two single-member scenes -> "multiple"
		expect(m.coverage.multiple).to.deep.equal([{ deviceId: 1, name: 'Bad Spot 1', scenes: [10, 50] }]);
		// dev 4 (Tastermodul, never a scene member) is NOT flagged
		expect(m.coverage.none.find(d => d.deviceId === 4)).to.equal(undefined);
	});

	it('tolerates id-keyed objects and missing scenes', () => {
		const m2 = model.parseNetwork({ units: { a: { deviceID: 7, uuid: 'U-7' } } });
		expect(m2.devices[0]).to.include({ deviceId: 7, uuid: 'U-7', controlScene: null });
		expect(m2.scenes).to.deep.equal([]);
		expect(m2.coverage).to.deep.equal({ none: [], multiple: [] });
	});
});
