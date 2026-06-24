'use strict';

/*
 * Value transforms between the gateway's native units and the ioBroker states.
 * The Lithernet/Casambi gateway expresses dimmer levels as a raw 0-254 value.
 * Depending on the `levelScale` config we expose them either as 0-100 % (default,
 * idiomatic for the `level.dimmer` role) or unchanged as raw 0-254.
 */

const RAW_MAX = 254;

/**
 * Clamp a number into an inclusive range.
 *
 * @param {number} value - input value
 * @param {number} min - lower bound
 * @param {number} max - upper bound
 * @returns {number} clamped value
 */
function clamp(value, min, max) {
	const n = Number(value);
	if (Number.isNaN(n)) {
		return min;
	}
	return Math.min(max, Math.max(min, n));
}

/**
 * Convert a raw gateway level (0-254) into the configured display scale.
 *
 * @param {number} raw - raw level reported by the gateway (0-254)
 * @param {string} scale - 'percent' | 'raw'
 * @returns {number} level in the display scale
 */
function levelToDisplay(raw, scale) {
	const clamped = clamp(raw, 0, RAW_MAX);
	if (scale === 'raw') {
		return Math.round(clamped);
	}
	return Math.round((clamped / RAW_MAX) * 100);
}

/**
 * Convert a display level (0-100 % or raw) into the gateway's raw 0-254 value.
 *
 * @param {number} display - level in the display scale
 * @param {string} scale - 'percent' | 'raw'
 * @returns {number} raw level for the gateway (0-254)
 */
function levelToRaw(display, scale) {
	if (scale === 'raw') {
		return Math.round(clamp(display, 0, RAW_MAX));
	}
	return Math.round((clamp(display, 0, 100) / 100) * RAW_MAX);
}

module.exports = {
	RAW_MAX,
	clamp,
	levelToDisplay,
	levelToRaw,
};
