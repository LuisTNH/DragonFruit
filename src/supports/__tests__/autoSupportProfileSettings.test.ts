import assert from 'node:assert/strict';
import test from 'node:test';

import { activeSizingBand, autoSupportProfileSettings } from '../autoSupport/parameterSizing';
import { normalizeAutoSupportSettings, type AutoSupportSettings } from '../autoSupport/settings';
import { getAutoSupportPreset } from '../Settings/autoSupportPresets';
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

/** An auto-support block borrowing from the Support Studio preset `id`. */
function borrowing(id: string): AutoSupportSettings {
    return normalizeAutoSupportSettings({ sizingPreset: id, ownGeometry: false });
}

/** An auto-support block with its own profile. */
function ownProfile(patch: Partial<AutoSupportSettings> = {}): AutoSupportSettings {
    return normalizeAutoSupportSettings({
        ownGeometry: true,
        tipContactDiameterMm: 0.35,
        tipLengthMm: 3,
        tipPenetrationMm: 0.05,
        shaftDiameterMm: 1.2,
        rootDiameterMm: 2.6,
        rootDiskHeightMm: 0.4,
        rootConeHeightMm: 1.1,
        baseFlareEnabled: false,
        baseFlareDiameterMm: 2.8,
        baseFlareHeightMm: 1.3,
        ...patch,
    });
}

test('a borrowing block takes every Support Studio section from the tier preset', () => {
    const detail = getPresetById('detail');
    assert.ok(detail, 'the factory detail preset exists');

    const profile = autoSupportProfileSettings(manualSettings(), borrowing('detail'));

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

test('an own profile builds from its own keys, not from any Support Studio preset', () => {
    const profile = autoSupportProfileSettings(manualSettings(), ownProfile());

    assert.equal(profile.tip.type, createDefaultSettings().tip.type);
    assert.equal(profile.tip.contactDiameterMm, 0.35);
    assert.equal(profile.tip.lengthMm, 3);
    assert.equal(profile.tip.penetrationMm, 0.05);
    assert.equal(profile.tip.bodyDiameterMm, 1.2);
    assert.equal(profile.shaft.diameterMm, 1.2);
    assert.deepEqual(
        [profile.roots.diameterMm, profile.roots.diskHeightMm, profile.roots.coneHeightMm],
        [2.6, 0.4, 1.1],
    );
    assert.deepEqual(profile.baseFlare, { enabled: false, diameterMm: 2.8, heightMm: 1.3 });
    // What the block does not carry is the factory default, not the live manual value.
    assert.equal(profile.tip.coneAngleMode, createDefaultSettings().tip.coneAngleMode);
    assert.deepEqual(profile.joint, createDefaultSettings().joint);
});

test('manual-only edits reach neither kind of auto profile', () => {
    const live = manualSettings();

    for (const auto of [borrowing('detail'), ownProfile()]) {
        const profile = autoSupportProfileSettings(live, auto);
        assert.notEqual(profile.tip.coneAngleMode, 'locked');
        assert.notEqual(profile.tip.contactDiameterMm, 0.9);
        assert.notEqual(profile.shaft.diameterMm, 2.2);
        assert.notEqual(profile.joint.ballDiameterMm, 1.7);
    }
    assert.equal(live.tip.coneAngleMode, 'locked', 'the live settings are not written');
});

test('the profile carries the run block and keeps grid and the dev routing switch', () => {
    const live = manualSettings();
    const auto = ownProfile();

    const profile = autoSupportProfileSettings(live, auto);

    assert.equal(profile.autoSupport, auto);
    assert.deepEqual(profile.grid, live.grid);
    assert.deepEqual(profile.autoBracing, live.autoBracing);
    assert.equal(profile.shaft.routingAlgorithm, 'astar');
});

test('a borrowing tier that names no preset leaves the live sections as they are', () => {
    const live = manualSettings();

    const profile = autoSupportProfileSettings(live, borrowing('deleted-preset'));

    assert.equal(profile.tip, live.tip);
    assert.equal(profile.shaft, live.shaft);
});

test('the run band is the own profile when the block carries one', () => {
    const auto = ownProfile({ tipContactDiameterMm: 0.3, shaftDiameterMm: 0.9, rootDiameterMm: 1.8 });

    const band = runWithSettings(autoSupportProfileSettings(manualSettings(), auto), activeSizingBand);

    assert.equal(band.tipContactDiameterMm, 0.3);
    assert.equal(band.shaftDiameterMm, 0.9);
    assert.equal(band.rootDiameterMm, 1.8);
    assert.equal(band.tipLengthMm, 3);
});

test('the built-in presets carry their own profiles from the factory tiers', () => {
    const expectations = [
        ['light', 'detail'],
        ['medium', 'structure'],
        ['heavy', 'anchor'],
    ] as const;
    for (const [autoId, studioId] of expectations) {
        const auto = getAutoSupportPreset(autoId)!.settings;
        const studio = getPresetById(studioId)!.settings;
        assert.equal(auto.ownGeometry, true, autoId);
        assert.equal(auto.shaftDiameterMm, studio.shaft.diameterMm, autoId);
        assert.equal(auto.tipContactDiameterMm, studio.tip.contactDiameterMm, autoId);
        assert.equal(auto.rootDiameterMm, studio.roots.diameterMm, autoId);
        assert.equal(auto.baseFlareEnabled, studio.baseFlare.enabled, autoId);
        assert.equal(auto.baseFlareDiameterMm, studio.baseFlare.diameterMm, autoId);
        assert.equal(auto.baseFlareHeightMm, studio.baseFlare.heightMm, autoId);
    }
});

test('a block written before own profiles keeps borrowing', () => {
    const legacy = normalizeAutoSupportSettings({ sizingPreset: 'anchor', areaPerSupportMm2: 5 });

    assert.equal(legacy.ownGeometry, false);
    assert.equal(legacy.sizingPreset, 'anchor');
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
