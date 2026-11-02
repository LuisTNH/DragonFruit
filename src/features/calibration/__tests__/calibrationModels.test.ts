import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CALIBRATION_MODELS,
  calibrationModelUrl,
  fetchCalibrationModelFile,
  findCalibrationModel,
} from '@/features/calibration/calibrationModels';

test('every calibration model has a unique id and an STL file', () => {
  const ids = new Set(CALIBRATION_MODELS.map((model) => model.id));
  assert.equal(ids.size, CALIBRATION_MODELS.length);
  for (const model of CALIBRATION_MODELS) {
    assert.match(model.file, /^[a-z0-9-]+\.stl$/, model.id);
    assert.match(model.sourceUrl, /^https:\/\//, model.id);
  }
});

test('a model is looked up by id', () => {
  assert.equal(findCalibrationModel('ameralabs-town')?.name, 'AmeraLabs Town');
  assert.equal(findCalibrationModel('nope'), undefined);
});

test('the model file is fetched from the public folder and named after the file', async () => {
  const model = findCalibrationModel('siraya-tech-test-model')!;
  let requested = '';
  const fakeFetch = (async (url: string) => {
    requested = url;
    return new Response(new Uint8Array([1, 2, 3]));
  }) as unknown as typeof fetch;

  const file = await fetchCalibrationModelFile(model, fakeFetch);

  assert.equal(requested, calibrationModelUrl(model));
  assert.equal(requested, '/calibration-models/siraya-tech-test-model-v5.stl');
  assert.equal(file.name, 'siraya-tech-test-model-v5.stl');
  assert.equal(file.size, 3);
});

test('a missing file rejects instead of importing an error page', async () => {
  const model = findCalibrationModel('cones-of-calibration')!;
  const fakeFetch = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;

  await assert.rejects(fetchCalibrationModelFile(model, fakeFetch), /cones-of-calibration\.stl: HTTP 404/);
});
