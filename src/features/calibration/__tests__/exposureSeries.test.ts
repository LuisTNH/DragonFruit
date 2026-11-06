import assert from 'node:assert/strict';
import test from 'node:test';
import type { MaterialProfile } from '@/features/profiles/profileStore';
import {
  buildExposureSeries,
  exposureSeriesBaseName,
  withNormalExposure,
} from '@/features/calibration/exposureSeries';

test('a series steps up from its start, rounded to hundredths', () => {
  assert.deepEqual(buildExposureSeries({ startSec: 1.5, stepSec: 0.25, count: 5 }), [1.5, 1.75, 2, 2.25, 2.5]);
  assert.deepEqual(buildExposureSeries({ startSec: 0.1, stepSec: 0.1, count: 3 }), [0.1, 0.2, 0.3]);
});

test('a series that cannot be printed is empty', () => {
  assert.deepEqual(buildExposureSeries({ startSec: 2, stepSec: 0.5, count: 1 }), []);
  assert.deepEqual(buildExposureSeries({ startSec: 2, stepSec: 0.5, count: 13 }), []);
  assert.deepEqual(buildExposureSeries({ startSec: 2, stepSec: 0, count: 4 }), []);
  assert.deepEqual(buildExposureSeries({ startSec: 0, stepSec: 0.5, count: 4 }), []);
  assert.deepEqual(buildExposureSeries({ startSec: 118, stepSec: 1, count: 4 }), []);
  assert.deepEqual(buildExposureSeries({ startSec: Number.NaN, stepSec: 1, count: 4 }), []);
});

test('each file is named for its exposure in whole milliseconds', () => {
  assert.equal(exposureSeriesBaseName('Cones', 2.25), 'Cones_exp2250ms');
  assert.equal(exposureSeriesBaseName('Plate 1', 0.3), 'Plate 1_exp300ms');
});

test('the exposure is set on the profile and on every format setting it holds', () => {
  const material = {
    id: 'm',
    name: 'Resin',
    normalExposureSec: 2,
    bottomExposureSec: 25,
    localSettingsByOutput: {
      ctb: { normalExposureSec: 2, bottomExposureSec: 25 },
      goo: { liftDistanceMm: 6 },
    },
  } as unknown as MaterialProfile;

  const next = withNormalExposure(material, 3.5, 'lumen');

  assert.equal(next.normalExposureSec, 3.5);
  assert.equal(next.bottomExposureSec, 25);
  assert.deepEqual(next.localSettingsByOutput, {
    ctb: { normalExposureSec: 3.5, bottomExposureSec: 25 },
    goo: { liftDistanceMm: 6, normalExposureSec: 3.5 },
    lumen: { normalExposureSec: 3.5 },
  });
  // The profile the user keeps is left as it was.
  assert.equal(material.normalExposureSec, 2);
  assert.equal(material.localSettingsByOutput?.ctb?.normalExposureSec, 2);
});

test('a step too fine for two distinct exposures gives no series', () => {
  assert.deepEqual(buildExposureSeries({ startSec: 1, stepSec: 0.001, count: 5 }), []);
  assert.deepEqual(buildExposureSeries({ startSec: 1, stepSec: 0.004, count: 12 }), []);
  assert.deepEqual(buildExposureSeries({ startSec: 119.996, stepSec: 0.001, count: 2 }), []);
  assert.deepEqual(buildExposureSeries({ startSec: 1, stepSec: 0.01, count: 3 }), [1, 1.01, 1.02]);
});
