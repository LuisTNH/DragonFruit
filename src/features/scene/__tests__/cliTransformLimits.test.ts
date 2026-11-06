import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_POSITION_MM, MAX_SCALE, MIN_SCALE, transformProblem } from '../../../../scripts/cli/transformLimits';

const vec = (x: number, y = x, z = x) => ({ x, y, z });
const fine = { position: vec(0), rotation: vec(0), scale: vec(1) };

test('an ordinary transform, a mirror and the exact limits pass', () => {
  assert.equal(transformProblem(fine), null);
  assert.equal(transformProblem({ ...fine, scale: vec(-1, 1, 1) }), null);
  assert.equal(transformProblem({ ...fine, position: vec(MAX_POSITION_MM) }), null);
  assert.equal(transformProblem({ ...fine, scale: vec(MIN_SCALE) }), null);
  assert.equal(transformProblem({ ...fine, scale: vec(-MAX_SCALE) }), null);
});

for (const [name, transform] of [
  ['scale 0', { ...fine, scale: vec(0) }],
  ['scale 0 on one axis', { ...fine, scale: vec(1, 0, 1) }],
  ['scale -0', { ...fine, scale: vec(-0) }],
  ['scale 1e300', { ...fine, scale: vec(1e300) }],
  ['scale 1e-120', { ...fine, scale: vec(1e-120) }],
  ['position 1e308', { ...fine, position: vec(1e308, 0, 0) }],
  ['rotation 1e300', { ...fine, rotation: vec(1e300) }],
  ['NaN', { ...fine, position: vec(Number.NaN) }],
  ['Infinity', { ...fine, scale: vec(Number.POSITIVE_INFINITY) }],
] as const) {
  test(`${name} is refused`, () => {
    assert.equal(typeof transformProblem(transform), 'string');
  });
}
