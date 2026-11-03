import assert from 'node:assert/strict';
import test from 'node:test';

import { autoSupportProfileSettings } from '../autoSupport/parameterSizing';
import { getPresetById } from '../Settings/presets';
import { getSettings, runWithSettings, setSettings, subscribeToSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import type { SupportSettings } from '../Settings/types';

/** Live settings a user dialled in for hand-placed supports. */
function manualSettings(): SupportSettings {
    const defaults = createDefaultSettings();
    return {
        ...defaults,
        tip: { ...defaults.tip, contactDiameterMm: 0.9, coneAngleMode: 'locked' },
        shaft: { ...defaults.shaft, diameterMm: 2.2, routingAlgorithm: 'astar' },
        baseFlare: { ...defaults.baseFlare, enabled: true, diameterMm: 4 },
        joint: { ...defaults.joint, ballDiameterMm: 1.7 },
        grid: { ...defaults.grid, enabled: true },
        autoSupport: { ...defaults.autoSupport, sizingPreset: 'detail', areaPerSupportMm2: 7 },
    };
}

test('auto profile takes every Support Studio section from the tier preset', () => {
    const detail = getPresetById('detail');
    assert.ok(detail, 'the factory detail preset exists');
    const live = manualSettings();

    const profile = autoSupportProfileSettings(live, 'detail');

    assert.deepEqual(profile.tip, detail.settings.tip);
    assert.deepEqual(profile.roots, detail.settings.roots);
    assert.deepEqual(profile.baseFlare, detail.settings.baseFlare);
    assert.deepEqual(profile.joint, detail.settings.joint);
    assert.deepEqual(profile.meshToMesh, detail.settings.meshToMesh);
    assert.deepEqual(
        { ...profile.shaft, routingAlgorithm: undefined },
        { ...detail.settings.shaft, routingAlgorithm: undefined },
    );
});

test('manual-only edits do not reach the auto profile', () => {
    const live = manualSettings();

    const profile = autoSupportProfileSettings(live, 'detail');

    assert.notEqual(profile.tip.coneAngleMode, 'locked');
    assert.notEqual(profile.tip.contactDiameterMm, 0.9);
    assert.notEqual(profile.shaft.diameterMm, 2.2);
    assert.notEqual(profile.joint.ballDiameterMm, 1.7);
    assert.equal(live.tip.coneAngleMode, 'locked', 'the live settings are not written');
});

test('auto profile keeps the run policy and the live dev routing switch', () => {
    const live = manualSettings();

    const profile = autoSupportProfileSettings(live, 'detail');

    assert.deepEqual(profile.grid, live.grid);
    assert.deepEqual(profile.autoSupport, live.autoSupport);
    assert.deepEqual(profile.autoBracing, live.autoBracing);
    assert.equal(profile.shaft.routingAlgorithm, 'astar');
});

test('a tier that names no preset leaves the live settings as they are', () => {
    const live = manualSettings();

    assert.equal(autoSupportProfileSettings(live, 'deleted-preset'), live);
    assert.equal(autoSupportProfileSettings(live, null), live);
});

test('runWithSettings swaps the live settings for the call only, silently', () => {
    const before = getSettings();
    const swapped = manualSettings();
    let notified = 0;
    const unsubscribe = subscribeToSettings(() => { notified += 1; });
    try {
        const seen = runWithSettings(swapped, () => getSettings().tip.coneAngleMode);
        assert.equal(seen, 'locked');
        assert.equal(getSettings(), before);
        assert.throws(() => runWithSettings(swapped, () => { throw new Error('boom'); }), /boom/);
        assert.equal(getSettings(), before, 'restored after a throw too');
        assert.equal(notified, 0);
    } finally {
        unsubscribe();
        setSettings(before);
    }
});
