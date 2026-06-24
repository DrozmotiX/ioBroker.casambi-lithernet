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

	it('maps display % back to raw 0-254', () => {
		expect(converter.levelToRaw(0, 'percent')).to.equal(0);
		expect(converter.levelToRaw(50, 'percent')).to.equal(127);
		expect(converter.levelToRaw(100, 'percent')).to.equal(254);
	});

	it('passes raw scale through unchanged (clamped + rounded)', () => {
		expect(converter.levelToDisplay(200, 'raw')).to.equal(200);
		expect(converter.levelToRaw(200, 'raw')).to.equal(200);
		expect(converter.levelToRaw(999, 'raw')).to.equal(254);
		expect(converter.levelToRaw(-5, 'raw')).to.equal(0);
	});

	it('clamps out-of-range percent input', () => {
		expect(converter.levelToRaw(150, 'percent')).to.equal(254);
		expect(converter.levelToRaw(-10, 'percent')).to.equal(0);
	});
});

describe('casambi.buildSetTopic', () => {
	it('builds casambi/<id>/set/<suffix>', () => {
		expect(casambi.buildSetTopic('0', 'scene_level')).to.equal('casambi/0/set/scene_level');
		expect(casambi.buildSetTopic('lobby', 'level')).to.equal('casambi/lobby/set/level');
	});
});

describe('casambi.buildCommand', () => {
	it('control.level -> set/level with scaled level + duration', () => {
		const cmd = casambi.buildCommand({ channel: 'control', index: null, leaf: 'level' }, 50, cfgPercent);
		expect(cmd.topic).to.equal('casambi/0/set/level');
		expect(cmd.payload).to.deep.equal({ level: 127, duration: 0 });
	});

	it('scenes.<n>.level -> set/scene_level', () => {
		const cmd = casambi.buildCommand({ channel: 'scenes', index: 3, leaf: 'level' }, 100, cfgRaw);
		expect(cmd.topic).to.equal('casambi/0/set/scene_level');
		expect(cmd.payload).to.deep.equal({ scene: 3, level: 100, duration: 1000 });
	});

	it('groups.<n>.level -> set/group_level', () => {
		const cmd = casambi.buildCommand({ channel: 'groups', index: 2, leaf: 'level' }, 0, cfgPercent);
		expect(cmd.topic).to.equal('casambi/0/set/group_level');
		expect(cmd.payload).to.deep.equal({ group: 2, level: 0, duration: 0 });
	});

	it('sensors.lux -> set/light_sensor', () => {
		const cmd = casambi.buildCommand({ channel: 'sensors', index: null, leaf: 'lux' }, 320, cfgPercent);
		expect(cmd.topic).to.equal('casambi/0/set/light_sensor');
		expect(cmd.payload).to.deep.equal({ lux_level: 320 });
	});

	it('sensors.pir -> set/pir_sensor with 0/1', () => {
		expect(casambi.buildCommand({ channel: 'sensors', index: null, leaf: 'pir' }, true, cfgPercent).payload).to.deep.equal({
			pir_sensor: 1,
		});
		expect(casambi.buildCommand({ channel: 'sensors', index: null, leaf: 'pir' }, false, cfgPercent).payload).to.deep.equal({
			pir_sensor: 0,
		});
	});

	it('buttons.<n> -> level / pressed / released', () => {
		expect(casambi.buildCommand({ channel: 'buttons', index: 1, leaf: 'level' }, 100, cfgRaw).topic).to.equal(
			'casambi/0/set/button_level',
		);
		expect(casambi.buildCommand({ channel: 'buttons', index: 1, leaf: 'pressed' }, true, cfgPercent)).to.deep.equal({
			topic: 'casambi/0/set/push_button_pressed',
			payload: { button: 1 },
		});
		expect(casambi.buildCommand({ channel: 'buttons', index: 1, leaf: 'released' }, true, cfgPercent)).to.deep.equal({
			topic: 'casambi/0/set/push_button_released',
			payload: { button: 1 },
		});
	});

	it('button pressed/released only fire on truthy value', () => {
		expect(casambi.buildCommand({ channel: 'buttons', index: 1, leaf: 'pressed' }, false, cfgPercent)).to.equal(null);
	});

	it('returns null for read-only / parameter states', () => {
		expect(casambi.buildCommand({ channel: 'devices', index: 5, leaf: 'level' }, 50, cfgPercent)).to.equal(null);
		expect(casambi.buildCommand({ channel: 'control', index: null, leaf: 'duration' }, 500, cfgPercent)).to.equal(null);
	});
});

describe('casambi.parseGet', () => {
	it('parses scene_level with level + active', () => {
		const tree = casambi.parseGet('casambi/0/get/scene_level', { scene: 1, level: 254, active: true }, cfgPercent);
		expect(tree).to.deep.equal({ scenes: { 1: { level: 100, active: true } } });
	});

	it('parses group_level', () => {
		const tree = casambi.parseGet('casambi/0/get/group_level', { group: 4, level: 127 }, cfgPercent);
		expect(tree).to.deep.equal({ groups: { 4: { level: 50 } } });
	});

	it('parses device level + condition', () => {
		const tree = casambi.parseGet('casambi/0/get/device_level', { device: 7, level: 0, condition: 2 }, cfgPercent);
		expect(tree).to.deep.equal({ devices: { 7: { level: 0, condition: 2 } } });
	});

	it('parses scene_call as active=true', () => {
		const tree = casambi.parseGet('casambi/0/get/scene_call', { scene: 9 }, cfgPercent);
		expect(tree).to.deep.equal({ scenes: { 9: { active: true } } });
	});

	it('ignores messages from a different gateway id', () => {
		expect(casambi.parseGet('casambi/2/get/scene_level', { scene: 1, level: 10 }, cfgPercent)).to.equal(null);
	});

	it('ignores non-get and malformed topics', () => {
		expect(casambi.parseGet('casambi/0/set/scene_level', { scene: 1 }, cfgPercent)).to.equal(null);
		expect(casambi.parseGet('something/else', { scene: 1 }, cfgPercent)).to.equal(null);
		expect(casambi.parseGet('casambi/0/get/unknown', { foo: 1 }, cfgPercent)).to.equal(null);
	});
});
