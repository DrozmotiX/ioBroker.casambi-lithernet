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
		expect(cmd).to.deep.equal({
			topic: 'casambi/0/set/scene_level',
			payload: { scene: 3, level: 100, duration: 1000 },
		});
	});

	it('groups.<n>.level -> set/group_level', () => {
		const cmd = casambi.buildCommand({ channel: 'groups', index: 2, leaf: 'level' }, 50, cfgPercent);
		expect(cmd).to.deep.equal({
			topic: 'casambi/0/set/group_level',
			payload: { group: 2, level: 127, duration: 0 },
		});
	});

	it('sensors.lux / sensors.pir', () => {
		expect(casambi.buildCommand({ channel: 'sensors', index: null, leaf: 'lux' }, 320, cfgPercent)).to.deep.equal({
			topic: 'casambi/0/set/light_sensor',
			payload: { lux_level: 320 },
		});
		expect(
			casambi.buildCommand({ channel: 'sensors', index: null, leaf: 'pir' }, true, cfgPercent).payload,
		).to.deep.equal({
			pir_sensor: 1,
		});
	});

	it('buttons.<n> press/release fire only on truthy', () => {
		expect(
			casambi.buildCommand({ channel: 'buttons', index: 1, leaf: 'pressed' }, true, cfgPercent).topic,
		).to.equal('casambi/0/set/push_button_pressed');
		expect(casambi.buildCommand({ channel: 'buttons', index: 1, leaf: 'pressed' }, false, cfgPercent)).to.equal(
			null,
		);
	});

	it('devices / ungrouped are read-only (no command)', () => {
		expect(casambi.buildCommand({ channel: 'devices', index: 8, leaf: 'level' }, 50, cfgPercent)).to.equal(null);
		expect(casambi.buildCommand({ channel: 'ungrouped', index: null, leaf: 'level' }, 50, cfgPercent)).to.equal(
			null,
		);
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

	it('poll_scene/<N> -> scenes.<padded N> with active as boolean', () => {
		const tree = casambi.parseGet(
			'casambi/0/get/poll_scene/29',
			{ active: 1, level: 254, last_change: 55 },
			cfgPercent,
		);
		expect(tree).to.deep.equal({ scenes: { '029': { active: true, level: 100, last_change: 55 } } });
	});

	it('poll_scene placeholder slot (level 255, inactive) is skipped', () => {
		expect(
			casambi.parseGet('casambi/0/get/poll_scene/77', { active: 0, level: 255, last_change: 1 }, cfgPercent),
		).to.equal(null);
	});

	it('poll_scene at level 255 but ACTIVE is kept (never drop a recalled scene)', () => {
		const tree = casambi.parseGet(
			'casambi/0/get/poll_scene/12',
			{ active: 1, level: 255, last_change: 1 },
			cfgPercent,
		);
		expect(tree).to.have.nested.property('scenes.012.active', true);
	});

	it('poll_group/<N> -> groups.<padded N>', () => {
		const tree = casambi.parseGet(
			'casambi/0/get/poll_group/30',
			{ level: 127, last_level: 254, cct_level: 127, vertical: 127, last_change: 56 },
			cfgPercent,
		);
		expect(tree).to.deep.equal({
			groups: { '030': { level: 50, last_level: 100, cct_level: 127, vertical: 127, last_change: 56 } },
		});
	});

	it('poll_group placeholder slot (level 255) is skipped', () => {
		expect(casambi.parseGet('casambi/0/get/poll_group/88', { level: 255, last_change: 1 }, cfgPercent)).to.equal(
			null,
		);
	});

	it('poll_device/<N>/values -> devices.<padded N>, prunes zero colour fields', () => {
		const tree = casambi.parseGet(
			'casambi/0/get/poll_device/8/values',
			{
				scene: 0,
				level: 254,
				last_level: 254,
				cct_level: 0,
				red: 0,
				green: 0,
				blue: 0,
				white: 0,
				last_change: 55,
			},
			cfgPercent,
		);
		expect(tree.devices['008'].level).to.equal(100);
		expect(tree.devices['008'].scene).to.equal(0); // always kept (membership signal)
		expect(tree.devices['008']).to.not.have.property('red'); // pruned: zero colour field
		expect(tree.devices['008']).to.not.have.property('cct_level');
	});

	it('poll_device/<N>/values -> keeps colour fields when non-zero', () => {
		const tree = casambi.parseGet(
			'casambi/0/get/poll_device/8/values',
			{ scene: 0, level: 254, last_level: 254, cct_level: 200, red: 10, last_change: 55 },
			cfgPercent,
		);
		expect(tree.devices['008'].cct_level).to.equal(200);
		expect(tree.devices['008'].red).to.equal(10);
	});

	it('poll_device/<N>/values -> derives read-only on from level OR active scene', () => {
		const on = payload =>
			casambi.parseGet('casambi/0/get/poll_device/8/values', payload, cfgPercent).devices['008'].on;
		// dimmer driven by a scene: level + scene both set
		expect(on({ scene: 9, level: 254, last_change: 1 })).to.equal(true);
		// dimmer fully off: no scene, no level
		expect(on({ scene: 0, level: 0, last_change: 1 })).to.equal(false);
		// RELAY/SWITCH on: level stays 0 but it follows its control scene (verified live)
		expect(on({ scene: 103, level: 0, last_change: 1 })).to.equal(true);
		// dimmer dimmed by hand: no scene but level up
		expect(on({ scene: 0, level: 50, last_change: 1 })).to.equal(true);
		// propertys carries no level, so it must not get an `on` field
		const propTree = casambi.parseGet(
			'casambi/0/get/poll_device/8/propertys',
			{ online: 1, node_type: 3 },
			cfgPercent,
		);
		expect(propTree.devices['008']).to.not.have.property('on');
	});

	it('poll_device/<N>/propertys -> devices.<padded N>, prunes zero capability fields', () => {
		const tree = casambi.parseGet(
			'casambi/0/get/poll_device/9/propertys',
			{
				online: 1,
				node_type: 3,
				condition: 128,
				battery_level: 0,
				overheating: 0,
				general_failure: 0,
				last_change: 56,
			},
			cfgPercent,
		);
		expect(tree.devices['009'].online).to.equal(true);
		expect(tree.devices['009'].overheating).to.equal(false); // fault flag always kept
		expect(tree.devices['009'].condition).to.equal(128);
		expect(tree.devices['009'].node_type).to.equal(3);
		expect(tree.devices['009']).to.not.have.property('battery_level'); // pruned: zero
	});

	it('poll_device element_* sub-topics are NOT flattened into device states', () => {
		// button/dimmer module element topics must return null (handled by the sampler), otherwise
		// button_1..8 / dimmer_1..4 etc. would each become a raw state and explode the tree.
		expect(
			casambi.parseGet(
				'casambi/0/get/poll_device/23/element_button',
				{ button_1: 0, button_2: 0, button_8: 0 },
				cfgPercent,
			),
		).to.equal(null);
		expect(casambi.parseGet('casambi/0/get/poll_device/23/element_dimmer', { dimmer_1: 0 }, cfgPercent)).to.equal(
			null,
		);
	});

	it('poll_ungrouped -> ungrouped.*', () => {
		const tree = casambi.parseGet(
			'casambi/0/get/poll_ungrouped',
			{ level: 0, last_level: 238, last_change: 1 },
			cfgPercent,
		);
		expect(tree).to.deep.equal({ ungrouped: { level: 0, last_level: 94, last_change: 1 } });
	});

	it('ignores other gateway ids, non-get and unknown topics', () => {
		expect(casambi.parseGet('casambi/2/get/poll_scene/1', { level: 10 }, cfgPercent)).to.equal(null);
		expect(casambi.parseGet('casambi/0/set/scene_level', { scene: 1 }, cfgPercent)).to.equal(null);
		expect(casambi.parseGet('casambi/0/get/node_deleted', { device: 15 }, cfgPercent)).to.equal(null);
	});
});

describe('casambi index padding & device classification', () => {
	it('padIndex zero-pads to 3 digits', () => {
		expect(casambi.padIndex(7)).to.equal('007');
		expect(casambi.padIndex('21')).to.equal('021');
		expect(casambi.padIndex(100)).to.equal('100');
	});

	it('classifyDevice splits values/propertys with padded index', () => {
		expect(casambi.classifyDevice('casambi/0/get/poll_device/7/values', cfgPercent)).to.deep.equal({
			index: '007',
			kind: 'values',
		});
		expect(casambi.classifyDevice('casambi/0/get/poll_device/16/propertys', cfgPercent)).to.deep.equal({
			index: '016',
			kind: 'propertys',
		});
	});

	it('classifyDevice returns null for non-device, other-gateway or bad sub-kind', () => {
		expect(casambi.classifyDevice('casambi/0/get/poll_scene/5', cfgPercent)).to.equal(null);
		expect(casambi.classifyDevice('casambi/2/get/poll_device/7/values', cfgPercent)).to.equal(null);
		expect(casambi.classifyDevice('casambi/0/get/poll_device/7/foo', cfgPercent)).to.equal(null);
	});

	it('isNodeDeleted matches only the gateway node_deleted topic', () => {
		expect(casambi.isNodeDeleted('casambi/0/get/node_deleted', cfgPercent)).to.equal(true);
		expect(casambi.isNodeDeleted('casambi/0/get/node_deleted/', cfgPercent)).to.equal(true);
		expect(casambi.isNodeDeleted('casambi/0/get/poll_scene/1', cfgPercent)).to.equal(false);
		expect(casambi.isNodeDeleted('casambi/2/get/node_deleted', cfgPercent)).to.equal(false);
	});

	it('isPlaceholderLevelNode detects the 255 sentinel', () => {
		expect(casambi.isPlaceholderLevelNode({ level: 255 })).to.equal(true);
		expect(casambi.isPlaceholderLevelNode({ level: 254 })).to.equal(false);
		expect(casambi.isPlaceholderLevelNode({})).to.equal(false);
	});

	it('unhandledShape collapses indices and ignores known kinds / other gateways', () => {
		// Unknown kinds (the element_* family) yield a numeric-collapsed shape...
		expect(casambi.unhandledShape('casambi/0/get/element_button/3', cfgPercent)).to.equal('get/element_button/#');
		expect(casambi.unhandledShape('casambi/0/get/element_pushbutton/12/state', cfgPercent)).to.equal(
			'get/element_pushbutton/#/state',
		);
		// ...so every index in a family shares one shape (dedup key).
		expect(casambi.unhandledShape('casambi/0/get/element_button/9', cfgPercent)).to.equal(
			casambi.unhandledShape('casambi/0/get/element_button/250', cfgPercent),
		);
		// Known/handled kinds and other-gateway or non-feedback topics are ignored.
		expect(casambi.unhandledShape('casambi/0/get/poll_device/7/values', cfgPercent)).to.equal(null);
		expect(casambi.unhandledShape('casambi/0/get/poll_device/7/propertys', cfgPercent)).to.equal(null);
		expect(casambi.unhandledShape('casambi/0/get/node_deleted', cfgPercent)).to.equal(null);
		expect(casambi.unhandledShape('casambi/2/get/element_button/3', cfgPercent)).to.equal(null);
		expect(casambi.unhandledShape('casambi/0/set/level', cfgPercent)).to.equal(null);
	});

	it('unhandledShape samples poll_device element_* sub-topics (button/dimmer modules)', () => {
		// poll_device is a known kind, but its element_* sub-topics are unmapped -> sampled.
		expect(casambi.unhandledShape('casambi/0/get/poll_device/23/element_button', cfgPercent)).to.equal(
			'get/poll_device/#/element_button',
		);
		expect(casambi.unhandledShape('casambi/0/get/poll_device/23/element_pushbutton', cfgPercent)).to.equal(
			'get/poll_device/#/element_pushbutton',
		);
	});
});

describe('diffConfirmedReadback - confirmed-only device ack', () => {
	it('writes both fields when nothing confirmed yet', () => {
		expect(casambi.diffConfirmedReadback({ level: 100, on: true }, undefined)).to.deep.equal({
			level: 100,
			on: true,
		});
	});

	it('drops fields equal to the last confirmed value (no churn on steady re-poll)', () => {
		expect(casambi.diffConfirmedReadback({ level: 100, on: true }, { level: 100, on: true })).to.deep.equal({});
	});

	it('writes only the field that actually changed', () => {
		expect(casambi.diffConfirmedReadback({ level: 0, on: false }, { level: 100, on: true })).to.deep.equal({
			level: 0,
			on: false,
		});
	});

	it('after a command invalidates the snapshot, re-confirms even an unchanged value', () => {
		// deviceConfirmed[key] deleted on command -> confirmed is undefined -> value re-acked
		expect(casambi.diffConfirmedReadback({ on: true }, undefined)).to.deep.equal({ on: true });
	});

	it('ignores undefined pending fields (only level present)', () => {
		expect(casambi.diffConfirmedReadback({ level: 50 }, { level: 0, on: false })).to.deep.equal({ level: 50 });
	});
});

describe('settleReadback - command settle window', () => {
	const now = 1000;
	const expectOn = { on: true, until: 2000 };

	it('accepts any sample when no command is in flight', () => {
		expect(casambi.settleReadback({ on: false }, undefined, now)).to.equal('accept');
	});

	it('drops a pre-change re-poll that still contradicts the commanded ON', () => {
		expect(casambi.settleReadback({ on: false }, expectOn, now)).to.equal('drop');
	});

	it('accepts the sample once it reflects the commanded ON', () => {
		expect(casambi.settleReadback({ on: true }, expectOn, now)).to.equal('accept');
	});

	it('drops a stale ON while OFF was commanded', () => {
		expect(casambi.settleReadback({ on: true }, { on: false, until: 2000 }, now)).to.equal('drop');
	});

	it('accepts (reality wins) once the window has elapsed, even if still contradicting', () => {
		expect(casambi.settleReadback({ on: false }, expectOn, 2500)).to.equal('accept');
	});

	it('accepts a sample with no on field (level-only) during the window', () => {
		expect(casambi.settleReadback({ level: 50 }, expectOn, now)).to.equal('accept');
	});
});

describe('planDeviceLevels - override-then-zero off', () => {
	it('OFF while on (current>0) grabs at current level then 0', () => {
		expect(casambi.planDeviceLevels(0, 100)).to.deep.equal([100, 0]);
		expect(casambi.planDeviceLevels(0, 13)).to.deep.equal([13, 0]);
	});

	it('OFF when already off (current 0) sends a single 0 (no pointless grab)', () => {
		expect(casambi.planDeviceLevels(0, 0)).to.deep.equal([0]);
	});

	it('ON / dim to a non-zero target is a single recall (it overrides on its own)', () => {
		expect(casambi.planDeviceLevels(100, 0)).to.deep.equal([100]);
		expect(casambi.planDeviceLevels(50, 80)).to.deep.equal([50]);
	});
});
