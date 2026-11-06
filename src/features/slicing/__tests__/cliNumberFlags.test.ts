import assert from 'node:assert/strict';
import test from 'node:test';

import { directionFlag, numberFlag } from '../../../../scripts/cli/numberFlags';

test('a number flag takes what it should', () => {
  assert.equal(numberFlag('lift-mm', '7', 0), 7);
  assert.equal(numberFlag('lift-mm', '0', 0), 0);
  assert.equal(numberFlag('support-only-below-mm', '0.5', 0, true), 0.5);
});

for (const value of ['abc', '', ' ', '1e999', 'NaN', '2mm', '-3']) {
  test(`a number flag refuses '${value}'`, () => {
    assert.throws(() => numberFlag('lift-mm', value, 0), /--lift-mm/);
  });
}

test('an exclusive minimum refuses the minimum', () => {
  assert.throws(() => numberFlag('px-mm', '0', 0, true), /--px-mm/);
});

test('a direction flag takes x,y,z and its extras', () => {
  assert.deepEqual(directionFlag('block-beyond', '0,1,0,2.4', 1), [0, 1, 0, 2.4]);
  assert.deepEqual(directionFlag('block-facing', '0,1,0', 1, 1), [0, 1, 0]);
  assert.deepEqual(directionFlag('block-facing', '0,1,0,45', 1, 1), [0, 1, 0, 45]);
});

for (const [value, extras, optional] of [
  ['abc', 1, 0],
  ['0,1', 1, 1],
  ['0,1,0', 1, 0],
  ['0,1,0,2,3', 1, 0],
  ['0,0,0,2', 1, 0],
  ['0,x,0,2', 1, 0],
  ['0,,0,2', 1, 0],
] as const) {
  test(`a direction flag refuses '${value}'`, () => {
    assert.throws(() => directionFlag('block-beyond', value, extras, optional), /--block-beyond/);
  });
}
