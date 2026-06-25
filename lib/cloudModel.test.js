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

	it('auto controlScene ONLY when unambiguous (single candidate); null when multiple', () => {
		expect(m.devices.find(d => d.deviceId === 1).controlScene).to.equal(null); // [10,50] ambiguous -> manual
		expect(m.devices.find(d => d.deviceId === 1).controlScenes).to.deep.equal([10, 50]);
		expect(m.devices.find(d => d.deviceId === 2).controlScene).to.equal(99); // lone candidate auto-maps
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

describe('cloudModel.resolveControlScene', () => {
	it('resolveControlScene: manual pick wins over a lone/ambiguous candidate', () => {
		const dev1 = { deviceId: 1, controlScenes: [10, 50] };
		expect(model.resolveControlScene(dev1, { 1: 50 })).to.deep.equal({ sceneId: 50, status: 'manual' });
		// a manual id that is NOT one of the device's candidates is ignored -> falls through
		expect(model.resolveControlScene(dev1, { 1: 999 })).to.deep.equal({ sceneId: null, status: 'unresolved' });
	});

	it('resolveControlScene: auto on lone candidate, unresolved on multiple, none on empty', () => {
		expect(model.resolveControlScene({ deviceId: 2, controlScenes: [99] })).to.deep.equal({
			sceneId: 99,
			status: 'auto',
		});
		expect(model.resolveControlScene({ deviceId: 1, controlScenes: [10, 50] })).to.deep.equal({
			sceneId: null,
			status: 'unresolved',
		});
		expect(model.resolveControlScene({ deviceId: 3, controlScenes: [] })).to.deep.equal({
			sceneId: null,
			status: 'none',
		});
	});
});

describe('cloudModel.parseRange / inRange', () => {
	it('parses ranges and defaults to all', () => {
		expect(model.parseRange('0-*')).to.deep.equal({ min: 0, max: Infinity });
		expect(model.parseRange('*')).to.deep.equal({ min: 0, max: Infinity });
		expect(model.parseRange('')).to.deep.equal({ min: 0, max: Infinity });
		expect(model.parseRange('1-50')).to.deep.equal({ min: 1, max: 50 });
		expect(model.parseRange('5')).to.deep.equal({ min: 5, max: 5 });
		expect(model.parseRange('garbage')).to.deep.equal({ min: 0, max: Infinity });
	});

	it('tests membership inclusively', () => {
		const r = model.parseRange('1-50');
		expect(model.inRange(1, r)).to.equal(true);
		expect(model.inRange(50, r)).to.equal(true);
		expect(model.inRange(0, r)).to.equal(false);
		expect(model.inRange(51, r)).to.equal(false);
		expect(model.inRange(99, model.parseRange('0-*'))).to.equal(true);
	});
});
