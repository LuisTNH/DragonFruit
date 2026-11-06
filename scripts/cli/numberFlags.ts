/**
 * Number flags that fail loudly. `parseFloat('abc')` is NaN, and a comparison with
 * NaN is false: a blocker built from it blocks nothing, and the run succeeds with
 * supports on the very faces the flag was meant to keep clear.
 */

/** A finite number at or above `min` (above it with `exclusive`). */
export function numberFlag(name: string, value: string, min: number, exclusive = false): number {
  const parsed = value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (exclusive && parsed === min)) {
    throw new Error(`--${name} takes a number ${exclusive ? 'above' : 'of at least'} ${min}, got '${value}'`);
  }
  return parsed;
}

/** `x,y,z` then `extras` further numbers, of which the last `optional` may be left out. */
export function directionFlag(name: string, value: string, extras = 0, optional = 0): number[] {
  const parts = value.split(',').map((part) => (part.trim() === '' ? NaN : Number(part)));
  const shape = extras === 0 ? 'x,y,z' : `x,y,z and ${extras} more`;
  if (parts.length < 3 + extras - optional || parts.length > 3 + extras || !parts.every(Number.isFinite)) {
    throw new Error(`--${name} takes ${shape}, got '${value}'`);
  }
  if (parts[0] === 0 && parts[1] === 0 && parts[2] === 0) {
    throw new Error(`--${name} needs a direction, got '${value}'`);
  }
  return parts;
}
