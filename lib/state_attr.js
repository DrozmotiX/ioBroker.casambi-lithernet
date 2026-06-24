'use strict';

/*
 * Attribute lookup table consumed by iobroker-jsonexplorer.
 * Keys are the LEAF name of a state (the last segment of its id). jsonExplorer
 * looks up the leaf name here to build the `common` object (role/type/unit/write).
 * Because the lookup is by leaf name, the same leaf (e.g. `level`) shares one
 * definition across all parent channels (control / scenes / groups / devices).
 *
 * Level scaling (0-254 <-> %) is done in lib/converter.js before/after these
 * states are read or written, so no `modify` transform is needed here.
 */

const stateAttr = {
	level: {
		name: 'Level',
		type: 'number',
		role: 'level.dimmer',
		write: true,
	},
	duration: {
		name: 'Fade duration',
		type: 'number',
		unit: 'ms',
		role: 'value',
		write: true,
	},
	active: {
		name: 'Active',
		type: 'boolean',
		role: 'indicator',
		write: false,
	},
	condition: {
		name: 'Condition',
		type: 'number',
		role: 'value',
		write: false,
	},
	lux: {
		name: 'Light sensor level',
		type: 'number',
		unit: 'lx',
		role: 'value.brightness',
		write: true,
	},
	pir: {
		name: 'PIR sensor',
		type: 'boolean',
		role: 'switch',
		write: true,
	},
	pressed: {
		name: 'Button pressed',
		type: 'boolean',
		role: 'button',
		write: true,
	},
	released: {
		name: 'Button released',
		type: 'boolean',
		role: 'button',
		write: true,
	},
};

module.exports = stateAttr;
