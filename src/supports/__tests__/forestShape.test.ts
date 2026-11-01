import assert from 'node:assert/strict';
import test from 'node:test';

import { allowsModelToModelBridges, isTreeConvertibleOrigin } from '../autoSupport/forestShape';
import { createDefaultAutoSupportSettings, normalizeAutoSupportSettings } from '../autoSupport/settings';

test('model-to-model bridges stay on unless switched off', () => {
    assert.equal(allowsModelToModelBridges(undefined), true);
    assert.equal(allowsModelToModelBridges(createDefaultAutoSupportSettings()), true);
    assert.equal(allowsModelToModelBridges({ allowModelToModel: false }), false);
});

test('island trunks convert to trees only with preferTrees', () => {
    assert.equal(isTreeConvertibleOrigin('island', undefined), false);
    assert.equal(isTreeConvertibleOrigin('island', { preferTrees: true }), true);
    // The registry's own convertible origins are unaffected either way.
    assert.equal(isTreeConvertibleOrigin('overhang', { preferTrees: false }), true);
    assert.equal(isTreeConvertibleOrigin('stump', { preferTrees: true }), false);
});

test('both switches survive normalization with their defaults', () => {
    const defaults = normalizeAutoSupportSettings({});
    assert.equal(defaults.allowModelToModel, true);
    assert.equal(defaults.preferTrees, false);
    const set = normalizeAutoSupportSettings({ allowModelToModel: false, preferTrees: true });
    assert.equal(set.allowModelToModel, false);
    assert.equal(set.preferTrees, true);
});
