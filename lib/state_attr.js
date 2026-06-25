'use strict';

/*
 * Attribute lookup table consumed by iobroker-jsonexplorer.
 * Keys are the LEAF name of a state (the last segment of its id). jsonExplorer
 * looks up the leaf name here to build the `common` object (role/type/unit/write).
 * Because the lookup is by leaf name, the same leaf (e.g. `level`) shares one
 * definition across all parent channels (broadcast / scenes / groups / devices).
 *
 * Level scaling (0-254 <-> %) is done in lib/casambi.js before these states are
 * read or written, so no `modify` transform is needed here.
 *
 * Leaf names mirror the gateway's real payload keys (captured from a REV2.5 / fw 4.56
 * gateway), including the gateway's own spellings (e.g. `propertys`, `ambient_temperatur`).
 */

const stateAttr = {
	// --- dimming / control ---
	level: { name: 'Level', type: 'number', role: 'level.dimmer', write: true },
	// Derived read-only on/off (level > 0), created only for devices.<n> (see lib/casambi.js).
	// Consumed e.g. by oikos-connect's SwitchCurrent overrule; the device itself has no set topic.
	on: { name: 'On', type: 'boolean', role: 'switch.light', write: false },
	last_level: { name: 'Last level', type: 'number', role: 'value', write: false },
	duration: { name: 'Fade duration', type: 'number', unit: 'ms', role: 'value', write: true },

	// --- scene ---
	active: { name: 'Active', type: 'boolean', role: 'indicator', write: false },

	// --- colour / tunable ---
	cct_level: { name: 'Colour temperature level', type: 'number', role: 'level.color.temperature', write: false },
	vertical: { name: 'Vertical', type: 'number', role: 'value', write: false },
	red: { name: 'Red', type: 'number', role: 'level.color.red', write: false },
	green: { name: 'Green', type: 'number', role: 'level.color.green', write: false },
	blue: { name: 'Blue', type: 'number', role: 'level.color.blue', write: false },
	white: { name: 'White', type: 'number', role: 'level.color.white', write: false },
	hue: { name: 'Hue', type: 'number', role: 'level.color.hue', write: false },
	sat: { name: 'Saturation', type: 'number', role: 'level.color.saturation', write: false },
	x: { name: 'Colour x', type: 'number', role: 'value', write: false },
	y: { name: 'Colour y', type: 'number', role: 'value', write: false },
	level_xy: { name: 'Level xy', type: 'number', role: 'value', write: false },

	// --- device properties / health ---
	online: { name: 'Online', type: 'boolean', role: 'indicator.reachable', write: false },
	condition: { name: 'Condition', type: 'number', role: 'value', write: false },
	battery_level: { name: 'Battery level', type: 'number', unit: '%', role: 'value.battery', write: false },
	overheating: { name: 'Overheating', type: 'boolean', role: 'indicator.alarm', write: false },
	general_failure: { name: 'General failure', type: 'boolean', role: 'indicator.maintenance', write: false },
	ambient_temperatur: { name: 'Ambient temperature', type: 'number', role: 'value.temperature', write: false },
	node_type: { name: 'Node type', type: 'number', role: 'value', write: false },
	priority: { name: 'Priority', type: 'number', role: 'value', write: false },
	scene_type: { name: 'Scene type', type: 'number', role: 'value', write: false },
	scene: { name: 'Scene', type: 'number', role: 'value', write: false },
	color_selector: { name: 'Colour selector', type: 'number', role: 'value', write: false },
	color_balance: { name: 'Colour balance', type: 'number', role: 'value', write: false },

	// --- bookkeeping ---
	last_change: { name: 'Last change', type: 'number', role: 'value', write: false },

	// Friendly channel name injected from config (used by jsonExplorer replaceName to
	// label the scene/group/device channel; blacklisted so it is NOT created as a state).
	name: { blacklist: true },

	// --- injected inputs ---
	lux: { name: 'Light sensor level', type: 'number', unit: 'lx', role: 'value.brightness', write: true },
	pir: { name: 'PIR sensor', type: 'boolean', role: 'switch', write: true },
	pressed: { name: 'Button pressed', type: 'boolean', role: 'button', write: true },
	released: { name: 'Button released', type: 'boolean', role: 'button', write: true },
};

module.exports = stateAttr;
