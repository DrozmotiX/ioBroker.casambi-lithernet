'use strict';

const { expect } = require('chai');
const converter = require('./converter');
const casambi = require('./casambi');

const cfgPercent = { gatewayId: '0', defaultDuration: 0, levelScale: 'percent' };
const cfgRaw = { gatewayId: '0', defaultDuration: 1000, levelScale: 'raw' };

describe('converter - level scaling', () => {
	it('maps raw 0/127/254 to 0/50/100 % (display)', () => {
		expect(converter.levelToDisplay(0, 'percent')).to.equal(0);
		expect(converter.levelToDisplay(127, 'percent')).to.equal(50);
		expect(converter.levelToDisplay(254, 'percent')).to.equal(100);
	});

	it('clamps wire values above 254 (gateway reports up to 255)', () => {
		expect(converter.levelToDisplay(255, 'percent')).to.equal(100);
	});

	it('maps display % back to raw 0-254', () => {
		expect(converter.levelToRaw(0, 'percent')).to.equal(0);
		expect(converter.levelToRaw(50, 'percent')).to.equal(127);
		expect(converter.levelToRaw(100, 'percent')).to.equal(254);
	});

	it('passes raw scale through unchanged (clamped + rounded)', () => {
		expect(converter.levelToDisplay(200, 'raw')).to.equal(200);
		expect(converter.levelToRaw(999, 'raw')).to.equal(254);
	});
});

describe('casambi.buildCommand', () => {
	it('broadcast.level -> set/level (whole network)', () => {
		const cmd = casambi.buildCommand({ channel: 'broadcast', index: null, leaf: 'level' }, 100, cfgPercent);
		expect(cmd).to.deep.equal({ topic: 'casambi/0/set/level', payload: { level: 254, duration: 0 } });
	});

	it('scenes.<n>.level -> set/scene_level', () => {
		const cmd = casambi.buildCommand({ channel: 'scenes', index: 3, leaf: 'level' }, 100, cfgRaw);
		expect(cmd).to.deep.equal({ topic: 'casambi/0/set/scene_level', payload: { scene: 3, level: 100, duration: 1000 } });
	});

	it('groups.<n>.level -> set/group_level', () => {
		const cmd = casambi.buildCommand({ channel: 'groups', index: 2, leaf: 'level' }, 50, cfgPercent);
		expect(cmd).to.deep.equal({ topic: 'casambi/0/set/group_level', payload: { group: 2, level: 127, duration: 0 } });
	});

	it('sensors.lux / sensors.pir', () => {
		expect(casambi.buildCommand({ channel: 'sensors', index: null, leaf: 'lux' }, 320, cfgPercent)).to.deep.equal({
			topic: 'casambi/0/set/light_sensor',
			payload: { lux_level: 320 },
		});
		expect(casambi.buildCommand({ channel: 'sensors', index: null, leaf: 'pir' }, true, cfgPercent).payload).to.deep.equal({
			pir_sensor: 1,
		});
	});

	it('buttons.<n> press/release fire only on truthy', () => {
		expect(casambi.buildCommand({ channel: 'buttons', index: 1, leaf: 'pressed' }, true, cfgPercent).topic).to.equal(
			'casambi/0/set/push_button_pressed',
		);
		expect(casambi.buildCommand({ channel: 'buttons', index: 1, leaf: 'pressed' }, false, cfgPercent)).to.equal(null);
	});

	it('devices / ungrouped are read-only (no command)', () => {
		expect(casambi.buildCommand({ channel: 'devices', index: 8, leaf: 'level' }, 50, cfgPercent)).to.equal(null);
		expect(casambi.buildCommand({ channel: 'ungrouped', index: null, leaf: 'level' }, 50, cfgPercent)).to.equal(null);
	});
});

describe('casambi.parseGet (real REV2.5 / fw 4.56 payloads)', () => {
	it('poll_broadcast -> broadcast.* with scaled levels', () => {
		const tree = casambi.parseGet(
			'casambi/0/get/poll_broadcast',
			{ level: 0, last_level: 238, cct_level: 255, vertical: 127, last_change: 17315 },
			cfgPercent,
		);
		expect(tree).to.deep.equal({
			broadcast: { level: 0, last_level: 94, cct_level: 255, vertical: 127, last_change: 17315 },
		});
	});

	it('poll_scene/<N> -> scenes.<N> with active as boolean', () => {
		const tree = casambi.parseGet('casambi/0/get/poll_scene/29', { active: 1, level: 254, last_change: 55 }, cfgPercent);
		expect(tree).to.deep.equal({ scenes: { 29: { active: true, level: 100, last_change: 55 } } });
	});

	it('poll_group/<N> -> groups.<N>', () => {
		const tree = casambi.parseGet(
			'casambi/0/get/poll_group/30',
			{ level: 127, last_level: 254, cct_level: 127, vertical: 127, last_change: 56 },
			cfgPercent,
		);
		expect(tree).to.deep.equal({
			groups: { 30: { level: 50, last_level: 100, cct_level: 127, vertical: 127, last_change: 56 } },
		});
	});

	it('poll_device/<N>/values -> devices.<N> light values', () => {
		const tree = casambi.parseGet(
			'casambi/0/get/poll_device/8/values',
			{ scene: 0, level: 254, last_level: 254, cct_level: 0, red: 0, green: 0, blue: 0, white: 0, last_change: 55 },
			cfgPercent,
		);
		expect(tree.devices[8].level).to.equal(100);
		expect(tree.devices[8].scene).to.equal(0);
		expect(tree.devices[8].red).to.equal(0);
	});

	it('poll_device/<N>/propertys -> devices.<N> with online as boolean', () => {
		const tree = casambi.parseGet(
			'casambi/0/get/poll_device/9/propertys',
			{ online: 1, node_type: 3, condition: 128, battery_level: 0, overheating: 0, general_failure: 0, last_change: 56 },
			cfgPercent,
		);
		expect(tree.devices[9].online).to.equal(true);
		expect(tree.devices[9].overheating).to.equal(false);
		expect(tree.devices[9].condition).to.equal(128);
	});

	it('poll_ungrouped -> ungrouped.*', () => {
		const tree = casambi.parseGet('casambi/0/get/poll_ungrouped', { level: 0, last_level: 238, last_change: 1 }, cfgPercent);
		expect(tree).to.deep.equal({ ungrouped: { level: 0, last_level: 94, last_change: 1 } });
	});

	it('ignores other gateway ids, non-get and unknown topics', () => {
		expect(casambi.parseGet('casambi/2/get/poll_scene/1', { level: 10 }, cfgPercent)).to.equal(null);
		expect(casambi.parseGet('casambi/0/set/scene_level', { scene: 1 }, cfgPercent)).to.equal(null);
		expect(casambi.parseGet('casambi/0/get/node_deleted', { device: 15 }, cfgPercent)).to.equal(null);
	});
});
