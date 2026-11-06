/**
 * Stress suite for separate manual / automatic support settings and the
 * auto-support presets' own support profile: 80 ordinary cases, 20 edge cases.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import * as THREE from 'three';

import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import {
    activeSizingBand,
    autoSupportProfileSettings,
    resolvedSizingBandsForRun,
    sizeParameters,
    withOwnProfileFromTier,
    smallIslandTipDiameterMm,
} from '../autoSupport/parameterSizing';
import {
    AUTO_SUPPORT_CONSTRAINTS,
    MIN_CONTACT_TIP_DIAMETER_MM,
    SIZING_BANDS,
    OWN_PROFILE_KEYS,
    createDefaultAutoSupportSettings,
    normalizeAutoSupportSettings,
    type AutoSupportSettings,
    type NumericAutoSupportSettingKey,
} from '../autoSupport/settings';
import type { CandidatePoint } from '../autoSupport/types';
import { runAutoPlace } from '../autoSupport/autoPlace';
import { runAutoPlaceInWorker } from '../autoSupport/autoPlaceWorkerClient';
import { createPreset, deletePreset, getPresetById, savePreset } from '../Settings/presets';
import {
    getSettings,
    runWithSettings,
    setSettings,
    updateAutoSupportSettings,
    updateBaseFlareProfile,
    updateShaftProfile,
    updateTipProfile,
} from '../Settings/state';
import { createDefaultSettings, type SupportSettings } from '../Settings/types';
import { decodeSupportSettingsHex } from '../Settings/supportSettingsCodec';
import { getSnapshot, resetKickstandsInState, resetStore } from '../state';
import type * as AutoSupportPresetStore from '../Settings/autoSupportPresets';
import { KNOBS_BY_SECTION, TOGGLES_BY_SECTION } from '@/components/controls/autoSupport/autoSupportPanelTabs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROFILE_NUMERIC_KEYS = [
    'tipContactDiameterMm',
    'tipLengthMm',
    'tipPenetrationMm',
    'shaftDiameterMm',
    'rootDiameterMm',
    'rootDiskHeightMm',
    'rootConeHeightMm',
    'baseFlareDiameterMm',
    'baseFlareHeightMm',
] as const satisfies readonly NumericAutoSupportSettingKey[];

/** Run `fn` and put the live settings back afterwards, whatever it changed. */
function preservingLive<T>(fn: () => T): T {
    const before = getSettings();
    try {
        return fn();
    } finally {
        setSettings(before);
    }
}

async function preservingLiveAsync<T>(fn: () => Promise<T>): Promise<T> {
    const before = getSettings();
    try {
        return await fn();
    } finally {
        setSettings(before);
    }
}

/** An own-profile block over the defaults. */
function own(patch: Partial<AutoSupportSettings> = {}): AutoSupportSettings {
    return normalizeAutoSupportSettings({ ownGeometry: true, ...patch });
}

/** A borrowing block naming `id`. */
function borrow(id: string, patch: Partial<AutoSupportSettings> = {}): AutoSupportSettings {
    return normalizeAutoSupportSettings({ ownGeometry: false, sizingPreset: id, ...patch });
}

/** Live settings dialled in for hand-placed supports, far from every auto value. */
function manualLive(): SupportSettings {
    const d = createDefaultSettings();
    return {
        ...d,
        tip: { ...d.tip, contactDiameterMm: 1.9, lengthMm: 7, penetrationMm: 0.6, coneAngleMode: 'locked', diskThicknessMm: 0.4 },
        shaft: { ...d.shaft, diameterMm: 4.2, secondaryDiameterMm: 4.2, routingAlgorithm: 'astar', maxAngleDeg: 33 },
        roots: { ...d.roots, diameterMm: 9, diskHeightMm: 3, coneHeightMm: 6, neckDiameterMm: 4 },
        baseFlare: { enabled: false, diameterMm: 9, heightMm: 5 },
        joint: { ...d.joint, ballDiameterMm: 3.3 },
        grid: { ...d.grid, enabled: true, spacingMm: 2.5 },
    };
}

function candidate(over: Partial<CandidatePoint> = {}): CandidatePoint {
    return {
        id: 'c',
        tipPos: { x: 0, y: 0, z: 10 },
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: 'm',
        source: 'voxel',
        islandAreaMm2: 0.1,
        zHeight: 10,
        priority: 0,
        ...over,
    };
}

/** A flat square ceiling `half` mm from the centre in each direction, at height `z`. */
function flatCeiling(z: number, half = 6, id = 'o0'): DetectedIsland {
    const voxels: Array<{ x: number; y: number; z: number }> = [];
    for (let x = -half; x <= half; x += 0.5) {
        for (let y = -half; y <= half; y += 0.5) voxels.push({ x, y, z });
    }
    return {
        id,
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, z),
        baseZ: z,
        maxZ: z + 4,
        areaMm2: (2 * half) ** 2,
        overhangAngleDeg: 0,
        surfaceNormal: { x: 0, y: 0, z: -1 },
        contactVoxels: footprintFromPoints(voxels),
    };
}

type Trunk = {
    rootId: string;
    baseDiameterMm: number;
    settingsCodeHex?: string;
    contactCone: { profile: { type: string; contactDiameterMm: number; lengthMm: number; penetrationMm: number } };
};
type Root = { diameter: number; diskHeight: number; coneHeight: number };

/** Run the in-process auto placement on a fresh store with `auto` as the live block. */
function placeWith(auto: Partial<AutoSupportSettings>, islands = [flatCeiling(8)], live?: SupportSettings) {
    resetStore();
    resetKickstandsInState();
    if (live) setSettings(live);
    updateAutoSupportSettings(auto);
    const result = runAutoPlace(islands, 'm', getSettings().autoSupport);
    const snap = getSnapshot() as unknown as { trunks: Record<string, Trunk>; roots: Record<string, Root> };
    const trunks = Object.values(snap.trunks);
    return { result, trunks, roots: snap.roots };
}

const near = (actual: number, expected: number, rel = 0.15) =>
    Math.abs(actual - expected) <= Math.abs(expected) * rel + 1e-9;

// Fresh preset-store instances (the store reads storage once, at load).
const require = createRequire(import.meta.url);
const STORE_PATH = require.resolve('../Settings/autoSupportPresets.ts');
type Store = typeof AutoSupportPresetStore;

function freshStore(seed: Record<string, string> = {}): { store: Store; storage: Map<string, string> } {
    const storage = new Map<string, string>(Object.entries(seed));
    const stub: Storage = {
        get length() { return storage.size; },
        key: (i: number) => [...storage.keys()][i] ?? null,
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => { storage.set(k, String(v)); },
        removeItem: (k: string) => { storage.delete(k); },
        clear: () => { storage.clear(); },
    };
    Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
    delete require.cache[STORE_PATH];
    return { store: require(STORE_PATH) as Store, storage };
}

function dropStorage() {
    delete (globalThis as { localStorage?: unknown }).localStorage;
}

// ===========================================================================
// NORMAL CASES (80)
// ===========================================================================

// --- A. Normalisation (20) -------------------------------------------------

for (const key of PROFILE_NUMERIC_KEYS) {
    test(`N-A ${key}: an in-range value on the step survives normalisation`, () => {
        const c = AUTO_SUPPORT_CONSTRAINTS[key];
        const value = Number((c.min + c.step * 3).toFixed(4));
        assert.equal(normalizeAutoSupportSettings({ [key]: value })[key], value);
    });
}

for (const key of PROFILE_NUMERIC_KEYS) {
    test(`N-A ${key}: the default is the factory structure profile or flare default`, () => {
        assert.equal(createDefaultAutoSupportSettings()[key], AUTO_SUPPORT_CONSTRAINTS[key].defaultValue);
    });
}

test('N-A an unknown key is dropped by normalisation', () => {
    const n = normalizeAutoSupportSettings({ futureKey: 1 } as never) as unknown as Record<string, unknown>;
    assert.equal(Object.hasOwn(n, 'futureKey'), false);
});

test('N-A ownGeometry true survives normalisation, default is false', () => {
    assert.equal(normalizeAutoSupportSettings({ ownGeometry: true }).ownGeometry, true);
    assert.equal(createDefaultAutoSupportSettings().ownGeometry, false);
});

// --- B. Profile builder (15) -------------------------------------------------

test('N-B own profile: tip fields map one to one', () => {
    const p = autoSupportProfileSettings(manualLive(), own({ tipContactDiameterMm: 0.31, tipLengthMm: 3.3, tipPenetrationMm: 0.07 }));
    assert.deepEqual([p.tip.contactDiameterMm, p.tip.lengthMm, p.tip.penetrationMm], [0.31, 3.3, 0.07]);
});

test('N-B own profile: shaft, secondary shaft and cone body follow the shaft diameter', () => {
    const p = autoSupportProfileSettings(manualLive(), own({ shaftDiameterMm: 1.35 }));
    assert.deepEqual([p.shaft.diameterMm, p.shaft.secondaryDiameterMm, p.tip.bodyDiameterMm], [1.35, 1.35, 1.35]);
});

test('N-B own profile: roots map one to one', () => {
    const p = autoSupportProfileSettings(manualLive(), own({ rootDiameterMm: 2.7, rootDiskHeightMm: 0.6, rootConeHeightMm: 1.4 }));
    assert.deepEqual([p.roots.diameterMm, p.roots.diskHeightMm, p.roots.coneHeightMm], [2.7, 0.6, 1.4]);
});

test('N-B own profile: base flare maps one to one', () => {
    const p = autoSupportProfileSettings(manualLive(), own({ baseFlareEnabled: true, baseFlareDiameterMm: 3.4, baseFlareHeightMm: 1.1 }));
    assert.deepEqual(p.baseFlare, { enabled: true, diameterMm: 3.4, heightMm: 1.1 });
});

test('N-B own profile: unexposed tip fields are factory defaults, not the manual ones', () => {
    const p = autoSupportProfileSettings(manualLive(), own());
    const d = createDefaultSettings();
    assert.equal(p.tip.coneAngleMode, d.tip.coneAngleMode);
    assert.equal(p.tip.diskThicknessMm, d.tip.diskThicknessMm);
});

test('N-B own profile: shaft max angle and roots neck are factory defaults', () => {
    const p = autoSupportProfileSettings(manualLive(), own());
    const d = createDefaultSettings();
    assert.equal(p.shaft.maxAngleDeg, d.shaft.maxAngleDeg);
    assert.equal(p.roots.neckDiameterMm, d.roots.neckDiameterMm);
});

test('N-B own profile: joint and mesh-to-mesh are factory defaults', () => {
    const p = autoSupportProfileSettings(manualLive(), own());
    assert.deepEqual(p.joint, createDefaultSettings().joint);
    assert.deepEqual(p.meshToMesh, createDefaultSettings().meshToMesh);
});

for (const id of ['detail', 'structure', 'anchor'] as const) {
    test(`N-B borrowing ${id}: tip, shaft, roots and flare are the Studio preset's`, () => {
        const studio = getPresetById(id)!.settings;
        const p = autoSupportProfileSettings(manualLive(), borrow(id));
        assert.equal(p.tip.contactDiameterMm, studio.tip.contactDiameterMm);
        assert.equal(p.shaft.diameterMm, studio.shaft.diameterMm);
        assert.deepEqual(p.roots, studio.roots);
        assert.deepEqual(p.baseFlare, studio.baseFlare);
    });
}

test('N-B borrowing a user-made Studio preset uses its numbers', () => {
    preservingLive(() => {
        updateShaftProfile({ diameterMm: 1.75 });
        const created = createPreset('stress custom');
        try {
            const p = autoSupportProfileSettings(manualLive(), borrow(created.id));
            assert.equal(p.shaft.diameterMm, 1.75);
        } finally {
            deletePreset(created.id);
        }
    });
});

test('N-B both kinds keep grid, auto bracing and the live routing switch', () => {
    const live = manualLive();
    for (const auto of [own(), borrow('detail')]) {
        const p = autoSupportProfileSettings(live, auto);
        assert.deepEqual(p.grid, live.grid);
        assert.deepEqual(p.autoBracing, live.autoBracing);
        assert.equal(p.shaft.routingAlgorithm, 'astar');
    }
});

test('N-B own profile: the standoff limit is the factory default, whatever the manual one', () => {
    const live = { ...manualLive(), tip: { ...manualLive().tip, maxStandoffMm: 0.3 } };
    assert.equal(autoSupportProfileSettings(live, own()).tip.maxStandoffMm, createDefaultSettings().tip.maxStandoffMm);
});

test('N-B borrowing: joint and mesh-to-mesh are the Studio preset\'s', () => {
    const studio = getPresetById('structure')!.settings;
    const p = autoSupportProfileSettings(manualLive(), borrow('structure'));
    assert.deepEqual(p.joint, studio.joint);
    assert.deepEqual(p.meshToMesh, studio.meshToMesh);
});

test('N-B the profile never writes the live settings object', () => {
    const live = manualLive();
    const snapshot = JSON.stringify(live);
    autoSupportProfileSettings(live, own({ shaftDiameterMm: 0.5 }));
    autoSupportProfileSettings(live, borrow('anchor'));
    assert.equal(JSON.stringify(live), snapshot);
});

// --- C. Sizing band (15) ----------------------------------------------------

for (const shaft of [0.6, 0.8, 1.0, 1.4, 2.0]) {
    test(`N-C own shaft ${shaft} mm sizes a low small candidate at that shaft`, () => {
        preservingLive(() => {
            updateAutoSupportSettings(own({ shaftDiameterMm: shaft }));
            const sized = sizeParameters(candidate({ zHeight: 5 }));
            assert.ok(near(sized.shaftDiameterMm!, shaft, 0.05), `got ${sized.shaftDiameterMm}`);
        });
    });
}

test('N-C own tip contact is the flat-ceiling contact', () => {
    preservingLive(() => {
        updateAutoSupportSettings(own({ tipContactDiameterMm: 0.45, shaftDiameterMm: 1.0 }));
        assert.equal(sizeParameters(candidate()).tipContactDiameterMm, 0.45);
    });
});

test('N-C own tip contact is floored at 30% of the shaft', () => {
    preservingLive(() => {
        updateAutoSupportSettings(own({ tipContactDiameterMm: 0.22, shaftDiameterMm: 2.0 }));
        assert.ok(sizeParameters(candidate({ zHeight: 5 })).tipContactDiameterMm! >= 0.6 - 1e-9);
    });
});

test('N-C own tip length and penetration ride flat', () => {
    preservingLive(() => {
        updateAutoSupportSettings(own({ tipLengthMm: 4.2, tipPenetrationMm: 0.12 }));
        const sized = sizeParameters(candidate({ zHeight: 30 }));
        assert.deepEqual([sized.tipLengthMm, sized.tipPenetrationMm], [4.2, 0.12]);
    });
});

test('N-C own root disk and cone heights ride flat', () => {
    preservingLive(() => {
        updateAutoSupportSettings(own({ rootDiskHeightMm: 0.8, rootConeHeightMm: 1.6 }));
        const sized = sizeParameters(candidate());
        assert.deepEqual([sized.rootsDiskHeightMm, sized.rootsConeHeightMm], [0.8, 1.6]);
    });
});

test('N-C own root diameter is the band root without model context', () => {
    preservingLive(() => {
        updateAutoSupportSettings(own({ rootDiameterMm: 2.8 }));
        assert.equal(sizeParameters(candidate()).rootsDiameterMm, 2.8);
    });
});

test('N-C size scale multiplies an own shaft', () => {
    preservingLive(() => {
        updateAutoSupportSettings(own({ shaftDiameterMm: 1.0 }));
        const one = sizeParameters(candidate({ zHeight: 5 }), 1).shaftDiameterMm!;
        const two = sizeParameters(candidate({ zHeight: 5 }), 1.5).shaftDiameterMm!;
        assert.ok(near(two, one * 1.5, 0.01));
    });
});

test('N-C a steep own-profile candidate gets a smaller contact than a flat one', () => {
    preservingLive(() => {
        updateAutoSupportSettings(own({ tipContactDiameterMm: 0.5, shaftDiameterMm: 0.8 }));
        const flat = sizeParameters(candidate()).tipContactDiameterMm!;
        const steep = sizeParameters(candidate({ tipNormal: { x: 0.8, y: 0, z: -0.6 } })).tipContactDiameterMm!;
        assert.ok(steep < flat);
    });
});

test('N-C a borrowing block sizes from its Studio preset band', () => {
    preservingLive(() => {
        updateAutoSupportSettings(borrow('anchor'));
        assert.equal(activeSizingBand().shaftDiameterMm, getPresetById('anchor')!.settings.shaft.diameterMm);
    });
});

test('N-C own and borrowing bands differ when their numbers do', () => {
    preservingLive(() => {
        updateAutoSupportSettings(own({ shaftDiameterMm: 1.85 }));
        const ownBand = activeSizingBand().shaftDiameterMm;
        updateAutoSupportSettings(borrow('detail'));
        assert.notEqual(activeSizingBand().shaftDiameterMm, ownBand);
    });
});

test('N-C resolvedSizingBandsForRun still resolves the three analytic tiers', () => {
    const bands = resolvedSizingBandsForRun('structure');
    assert.deepEqual(Object.keys(bands).sort(), ['anchor', 'detail', 'structure']);
});

// --- D. Preset store (15) -----------------------------------------------------

test('N-D the three built-ins carry their own profiles', () => {
    preservingLive(() => {
        const { store } = freshStore();
        assert.ok(store.getAutoSupportPresets().every((p) => p.settings.ownGeometry === true));
        dropStorage();
    });
});

test('N-D Light / Medium / Heavy shafts are 0.8 / 1.0 / 1.4 mm', () => {
    preservingLive(() => {
        const { store } = freshStore();
        assert.deepEqual(['light', 'medium', 'heavy'].map((id) => store.getAutoSupportPreset(id)!.settings.shaftDiameterMm), [0.8, 1.0, 1.4]);
        dropStorage();
    });
});

test('N-D activating Heavy puts its profile in the live block', () => {
    preservingLive(() => {
        const { store } = freshStore();
        store.setActiveAutoSupportPreset('heavy');
        assert.equal(getSettings().autoSupport.ownGeometry, true);
        assert.equal(getSettings().autoSupport.shaftDiameterMm, 1.4);
        dropStorage();
    });
});

test('N-D activating a built-in does not touch the manual Studio sections', () => {
    preservingLive(() => {
        setSettings(manualLive());
        const { store } = freshStore();
        store.setActiveAutoSupportPreset('light');
        assert.equal(getSettings().shaft.diameterMm, 4.2);
        assert.equal(getSettings().tip.contactDiameterMm, 1.9);
        dropStorage();
    });
});

test('N-D a duplicate of Medium copies its profile and is editable', () => {
    preservingLive(() => {
        const { store } = freshStore();
        const copy = store.duplicateAutoSupportPreset('medium')!;
        assert.equal(copy.isBuiltIn, false);
        assert.equal(copy.settings.ownGeometry, true);
        assert.equal(copy.settings.shaftDiameterMm, 1.0);
        dropStorage();
    });
});

test('N-D saving a profile edit on a custom preset persists it', () => {
    preservingLive(() => {
        const { store, storage } = freshStore();
        const copy = store.duplicateAutoSupportPreset('medium')!;
        store.setActiveAutoSupportPreset(copy.id);
        updateAutoSupportSettings({ shaftDiameterMm: 1.25 });
        store.saveAutoSupportPreset(copy.id);
        assert.equal(store.getAutoSupportPreset(copy.id)!.settings.shaftDiameterMm, 1.25);
        assert.ok(storage.get('auto-support-presets-v1')!.includes('1.25'));
        dropStorage();
    });
});

test('N-D a profile edit marks the active preset dirty', () => {
    preservingLive(() => {
        const { store } = freshStore();
        const copy = store.duplicateAutoSupportPreset('medium')!;
        store.setActiveAutoSupportPreset(copy.id);
        assert.equal(store.isAutoSupportPresetDirty(), false);
        updateAutoSupportSettings({ rootDiameterMm: 3.1 });
        assert.equal(store.isAutoSupportPresetDirty(), true);
        dropStorage();
    });
});

test('N-D toggling Own Profile marks the preset dirty', () => {
    preservingLive(() => {
        const { store } = freshStore();
        const copy = store.duplicateAutoSupportPreset('light')!;
        store.setActiveAutoSupportPreset(copy.id);
        updateAutoSupportSettings({ ownGeometry: false });
        assert.equal(store.isAutoSupportPresetDirty(), true);
        dropStorage();
    });
});

test('N-D a base flare edit marks the preset dirty', () => {
    preservingLive(() => {
        const { store } = freshStore();
        const copy = store.duplicateAutoSupportPreset('light')!;
        store.setActiveAutoSupportPreset(copy.id);
        updateAutoSupportSettings({ baseFlareEnabled: false });
        assert.equal(store.isAutoSupportPresetDirty(), true);
        dropStorage();
    });
});

test('N-D Reset reverts a profile edit to the saved preset', () => {
    preservingLive(() => {
        const { store } = freshStore();
        const copy = store.duplicateAutoSupportPreset('heavy')!;
        store.setActiveAutoSupportPreset(copy.id);
        updateAutoSupportSettings({ shaftDiameterMm: 2.5 });
        store.resetToActivePreset();
        assert.equal(getSettings().autoSupport.shaftDiameterMm, 1.4);
        dropStorage();
    });
});

test('N-D a built-in refuses a profile save', () => {
    preservingLive(() => {
        const { store } = freshStore();
        store.setActiveAutoSupportPreset('medium');
        updateAutoSupportSettings({ shaftDiameterMm: 3 });
        store.saveAutoSupportPreset('medium');
        assert.equal(store.getAutoSupportPreset('medium')!.settings.shaftDiameterMm, 1.0);
        dropStorage();
    });
});

test('N-D export writes the profile keys', () => {
    preservingLive(() => {
        const { store } = freshStore();
        const doc = JSON.parse(store.exportAutoSupportPresetToJson('light'));
        assert.equal(doc.preset.settings.ownGeometry, true);
        assert.equal(doc.preset.settings.shaftDiameterMm, 0.8);
        assert.equal(doc.preset.settings.baseFlareDiameterMm, 2.5);
        dropStorage();
    });
});

test('N-D import of an own-profile document lands in the live block', () => {
    preservingLive(() => {
        const { store } = freshStore();
        const doc = JSON.parse(store.exportAutoSupportPresetToJson('heavy'));
        doc.preset.settings.shaftDiameterMm = 1.65;
        store.importAutoSupportPresetFromJson(JSON.stringify(doc));
        assert.equal(getSettings().autoSupport.shaftDiameterMm, 1.65);
        assert.equal(getSettings().autoSupport.ownGeometry, true);
        dropStorage();
    });
});

test('N-D a stored custom preset from before own profiles keeps borrowing', () => {
    preservingLive(() => {
        const legacy = { byId: { 'asp-old': { id: 'asp-old', name: 'TNH Light', isBuiltIn: false, settings: { areaPerSupportMm2: 4.8, sizingPreset: 'detail' } } }, allIds: ['asp-old'] };
        const { store } = freshStore({ 'auto-support-presets-v1': JSON.stringify(legacy) });
        const loaded = store.getAutoSupportPreset('asp-old');
        assert.ok(loaded, 'the legacy preset loads');
        assert.equal(normalizeAutoSupportSettings(loaded.settings).ownGeometry, false);
        assert.equal(loaded.settings.sizingPreset, 'detail');
        dropStorage();
    });
});

test('N-D activating a legacy preset after Heavy switches Own Profile off', () => {
    preservingLive(() => {
        const legacy = { byId: { 'asp-old': { id: 'asp-old', name: 'Old', isBuiltIn: false, settings: { sizingPreset: 'detail' } } }, allIds: ['asp-old'] };
        const { store } = freshStore({ 'auto-support-presets-v1': JSON.stringify(legacy) });
        store.setActiveAutoSupportPreset('heavy');
        store.setActiveAutoSupportPreset('asp-old');
        assert.equal(getSettings().autoSupport.ownGeometry, false);
        assert.equal(activeSizingBand().shaftDiameterMm, getPresetById('detail')!.settings.shaft.diameterMm);
        dropStorage();
    });
});

// --- E. Real runs (15) --------------------------------------------------------

test('N-E an own-profile run places supports', () => {
    preservingLive(() => {
        const { result, trunks } = placeWith(own());
        assert.ok(trunks.length > 0);
        assert.equal(result.changed, true);
    });
});

test('N-E own shaft reaches the placed trunks', () => {
    preservingLive(() => {
        const { trunks } = placeWith(own({ shaftDiameterMm: 1.6 }));
        assert.ok(trunks.every((t) => near(t.baseDiameterMm, 1.6)), trunks.map((t) => t.baseDiameterMm).join(','));
    });
});

test('N-E own tip contact reaches the placed trunks', () => {
    preservingLive(() => {
        const { trunks } = placeWith(own({ tipContactDiameterMm: 0.42, shaftDiameterMm: 1.0 }));
        assert.ok(trunks.every((t) => near(t.contactCone.profile.contactDiameterMm, 0.42, 0.1)));
    });
});

test('N-E own tip length reaches the placed trunks', () => {
    preservingLive(() => {
        const { trunks } = placeWith(own({ tipLengthMm: 3.5 }));
        assert.ok(trunks.every((t) => near(t.contactCone.profile.lengthMm, 3.5, 0.01)));
    });
});

test('N-E own root pad reaches the placed roots', () => {
    preservingLive(() => {
        const { trunks, roots } = placeWith(own({ rootDiameterMm: 2.9, rootDiskHeightMm: 0.7, rootConeHeightMm: 1.2 }));
        for (const t of trunks) {
            const r = roots[t.rootId];
            assert.ok(near(r.diameter, 2.9));
            assert.deepEqual([r.diskHeight, r.coneHeight], [0.7, 1.2]);
        }
    });
});

test('N-E manual Studio values do not reach an own-profile run', () => {
    preservingLive(() => {
        const { trunks } = placeWith(own({ shaftDiameterMm: 1.0, tipLengthMm: 2.5 }), [flatCeiling(8)], manualLive());
        assert.ok(trunks.every((t) => t.baseDiameterMm < 2 && t.contactCone.profile.lengthMm < 3));
    });
});

test('N-E manual Studio values do not reach a borrowing run', () => {
    preservingLive(() => {
        const { trunks } = placeWith(borrow('detail'), [flatCeiling(8)], manualLive());
        assert.ok(trunks.every((t) => t.baseDiameterMm < 2 && t.contactCone.profile.lengthMm < 3));
    });
});

test('N-E the stamped settings code describes the own profile', () => {
    preservingLive(() => {
        const { trunks } = placeWith(own({ shaftDiameterMm: 1.3, rootDiameterMm: 2.4 }));
        const decoded = decodeSupportSettingsHex(trunks[0].settingsCodeHex!)!;
        assert.ok(near(decoded.shaft.diameterMm, 1.3));
        assert.ok(near(decoded.roots.diameterMm, 2.4));
    });
});

test('N-E the stamped code carries the own flare', () => {
    preservingLive(() => {
        const { trunks } = placeWith(own({ baseFlareEnabled: false, baseFlareDiameterMm: 2.2, baseFlareHeightMm: 0.9 }));
        const decoded = decodeSupportSettingsHex(trunks[0].settingsCodeHex!)!;
        assert.deepEqual(decoded.baseFlare, { enabled: false, diameterMm: 2.2, heightMm: 0.9 });
    });
});

test('N-E a run leaves the live manual settings untouched', () => {
    preservingLive(() => {
        const live = manualLive();
        placeWith(own({ shaftDiameterMm: 0.9 }), [flatCeiling(8)], live);
        assert.equal(getSettings().shaft.diameterMm, 4.2);
        assert.equal(getSettings().tip.contactDiameterMm, 1.9);
        assert.equal(getSettings().roots.diameterMm, 9);
    });
});

test('N-E thicker own shaft gives thicker trunks than thinner own shaft', () => {
    preservingLive(() => {
        const thin = placeWith(own({ shaftDiameterMm: 0.8 })).trunks.map((t) => t.baseDiameterMm);
        const thick = placeWith(own({ shaftDiameterMm: 1.8 })).trunks.map((t) => t.baseDiameterMm);
        assert.ok(Math.min(...thick) > Math.max(...thin));
    });
});

test('N-E Light and Heavy built-ins place different trunk sizes', () => {
    preservingLive(() => {
        const { store } = freshStore();
        const light = store.getAutoSupportPreset('light')!.settings;
        const heavy = store.getAutoSupportPreset('heavy')!.settings;
        const lightMax = Math.max(...placeWith(light).trunks.map((t) => t.baseDiameterMm));
        const heavyMin = Math.min(...placeWith(heavy).trunks.map((t) => t.baseDiameterMm));
        assert.ok(heavyMin > lightMax);
        dropStorage();
    });
});

test('N-E two islands both get own-profile supports', () => {
    preservingLive(() => {
        const { trunks } = placeWith(own({ shaftDiameterMm: 1.2 }), [flatCeiling(8, 3, 'a'), { ...flatCeiling(14, 3, 'b'), contact: new THREE.Vector3(30, 0, 14) }]);
        assert.ok(trunks.length >= 2);
        assert.ok(trunks.every((t) => near(t.baseDiameterMm, 1.2, 0.3)));
    });
});

test('N-E the worker entry point (no worker here) builds with the own profile', async () => {
    await preservingLiveAsync(async () => {
        resetStore();
        resetKickstandsInState();
        setSettings(manualLive());
        updateAutoSupportSettings(own({ shaftDiameterMm: 1.15 }));
        await runAutoPlaceInWorker([flatCeiling(8)], 'm', getSettings().autoSupport);
        const trunks = Object.values((getSnapshot() as unknown as { trunks: Record<string, Trunk> }).trunks);
        assert.ok(trunks.length > 0 && trunks.every((t) => near(t.baseDiameterMm, 1.15)));
    });
});

test('N-E a disabled block places nothing and changes nothing', () => {
    preservingLive(() => {
        const { result, trunks } = placeWith(own({ enabled: false }));
        assert.equal(trunks.length, 0);
        assert.equal(result.changed, false);
    });
});

// ===========================================================================
// EDGE CASES (20)
// ===========================================================================

test('E01 NaN, Infinity and strings fall back to the defaults', () => {
    const n = normalizeAutoSupportSettings({
        shaftDiameterMm: Number.NaN,
        rootDiameterMm: Number.POSITIVE_INFINITY,
        tipLengthMm: '3' as unknown as number,
    });
    assert.equal(n.shaftDiameterMm, AUTO_SUPPORT_CONSTRAINTS.shaftDiameterMm.defaultValue);
    assert.equal(n.rootDiameterMm, AUTO_SUPPORT_CONSTRAINTS.rootDiameterMm.defaultValue);
    assert.equal(n.tipLengthMm, AUTO_SUPPORT_CONSTRAINTS.tipLengthMm.defaultValue);
});

test('E02 negative and huge values clamp into range', () => {
    const n = normalizeAutoSupportSettings({ shaftDiameterMm: -4, rootConeHeightMm: 1e9, tipPenetrationMm: -1 });
    assert.equal(n.shaftDiameterMm, AUTO_SUPPORT_CONSTRAINTS.shaftDiameterMm.min);
    assert.equal(n.rootConeHeightMm, AUTO_SUPPORT_CONSTRAINTS.rootConeHeightMm.max);
    assert.equal(n.tipPenetrationMm, 0);
});

test('E03 an imported file carrying an unknown key imports and keeps the key', () => {
    preservingLive(() => {
        const { store } = freshStore();
        const doc = JSON.parse(store.exportAutoSupportPresetToJson('medium'));
        doc.preset.settings.futureKey = 'kept';
        const imported = store.importAutoSupportPresetFromJson(JSON.stringify(doc));
        assert.equal((imported.settings as unknown as Record<string, unknown>).futureKey, 'kept', 'unknown keys round-trip');
        assert.equal(imported.settings.ownGeometry, true);
        dropStorage();
    });
});

test('E04 ownGeometry as a string or number does not switch the profile on', () => {
    assert.equal(normalizeAutoSupportSettings({ ownGeometry: 'true' as never }).ownGeometry, false);
    assert.equal(normalizeAutoSupportSettings({ ownGeometry: 1 as never }).ownGeometry, false);
});

test('E05 an off-step value is snapped, and the dialog shows what is stored', { todo: 'the dialog rounds to decimals, the store snaps to the step' }, () => {
    // The dialog rounds to the decimals its step implies (2 for 0.05); the store
    // snaps to the step from min. A typed 0.83 mm shaft must not show as 0.83
    // and land as something else without the user seeing it.
    const stored = normalizeAutoSupportSettings({ shaftDiameterMm: 0.83 }).shaftDiameterMm;
    const knob = KNOBS_BY_SECTION.profile.find((k) => k.key === 'shaftDiameterMm')!;
    const shown = Number(Math.min(knob.max, Math.max(knob.min, 0.83)).toFixed(2));
    assert.equal(stored, shown, `dialog shows ${shown}, store keeps ${stored}`);
});

test('E06 dialog field ranges match the store constraints for every profile knob', () => {
    for (const knob of KNOBS_BY_SECTION.profile) {
        const c = AUTO_SUPPORT_CONSTRAINTS[knob.key];
        assert.deepEqual([knob.min, knob.max, knob.step], [c.min, c.max, c.step], knob.key);
    }
});

test('E07 every profile key has a dialog control', () => {
    const knobKeys = new Set(KNOBS_BY_SECTION.profile.map((k) => k.key));
    for (const key of PROFILE_NUMERIC_KEYS) assert.ok(knobKeys.has(key), key);
    const toggleKeys = TOGGLES_BY_SECTION.profile.map((t) => t.key).sort();
    assert.deepEqual(toggleKeys, ['baseFlareEnabled', 'ownGeometry']);
});

test('E08 the band never prints a contact below the published floor', () => {
    preservingLive(() => {
        updateAutoSupportSettings({ ...own(), tipContactDiameterMm: 0.01 });
        assert.ok(activeSizingBand().tipContactDiameterMm >= MIN_CONTACT_TIP_DIAMETER_MM);
    });
});

test('E09 a borrowing block naming a deleted preset falls back without throwing', () => {
    preservingLive(() => {
        const created = createPreset('to delete');
        const id = created.id;
        deletePreset(id);
        updateAutoSupportSettings(borrow(id));
        assert.deepEqual(activeSizingBand(), SIZING_BANDS.structure);
        assert.doesNotThrow(() => autoSupportProfileSettings(getSettings(), borrow(id)));
    });
});

test('E10 an install that stored the built-ins before own profiles gets their own profiles', () => {
    // Every store write saves the built-ins' blocks too, and a load adopts a
    // stored block for a built-in id. A user who ran an older build therefore has
    // Light / Medium / Heavy in storage without the own-profile keys.
    preservingLive(() => {
        const old = createDefaultAutoSupportSettings() as unknown as Record<string, unknown>;
        for (const key of OWN_PROFILE_KEYS) delete old[key];
        const stored = {
            byId: {
                light: { id: 'light', name: 'Light', isBuiltIn: true, settings: { ...old, areaPerSupportMm2: 16, sizingPreset: 'detail' } },
                medium: { id: 'medium', name: 'Medium', isBuiltIn: true, settings: { ...old } },
                heavy: { id: 'heavy', name: 'Heavy', isBuiltIn: true, settings: { ...old, areaPerSupportMm2: 5, sizingPreset: 'anchor' } },
            },
            allIds: ['light', 'medium', 'heavy'],
        };
        const { store } = freshStore({ 'auto-support-presets-v1': JSON.stringify(stored) });
        const states = ['light', 'medium', 'heavy'].map((id) => store.getAutoSupportPreset(id)!.settings.ownGeometry);
        dropStorage();
        assert.deepEqual(states, [true, true, true]);
    });
});

test('E11 runWithSettings nests and unwinds in order', () => {
    preservingLive(() => {
        const outer = getSettings();
        const a = manualLive();
        const b = { ...manualLive(), shaft: { ...manualLive().shaft, diameterMm: 0.7 } };
        const seen = runWithSettings(a, () => [getSettings().shaft.diameterMm, runWithSettings(b, () => getSettings().shaft.diameterMm), getSettings().shaft.diameterMm]);
        assert.deepEqual(seen, [4.2, 0.7, 4.2]);
        assert.equal(getSettings(), outer);
    });
});

test('E12 runWithSettings repairs a partial settings object instead of crashing', () => {
    preservingLive(() => {
        const partial = { tip: { contactDiameterMm: 0.5 } } as unknown as SupportSettings;
        const shaft = runWithSettings(partial, () => getSettings().shaft.diameterMm);
        assert.equal(shaft, createDefaultSettings().shaft.diameterMm);
    });
});

test('E13 a live update made inside a run is discarded when the run ends', () => {
    preservingLive(() => {
        const before = getSettings().shaft.diameterMm;
        runWithSettings(manualLive(), () => updateShaftProfile({ diameterMm: 3.3 }));
        assert.equal(getSettings().shaft.diameterMm, before, 'a write inside the scope does not leak out');
    });
});

test('E14 own profile with a tip contact wider than the shaft keeps the cone body at the shaft', () => {
    const p = autoSupportProfileSettings(manualLive(), own({ tipContactDiameterMm: 1.8, shaftDiameterMm: 0.6 }));
    assert.equal(p.tip.bodyDiameterMm, 0.6);
    assert.ok(p.tip.contactDiameterMm > p.tip.bodyDiameterMm, 'nothing rejects a contact wider than its shaft');
});

test('E15 own profile with a root pad narrower than the shaft is accepted as is', () => {
    const p = autoSupportProfileSettings(manualLive(), own({ rootDiameterMm: 0.5, shaftDiameterMm: 3 }));
    assert.ok(p.roots.diameterMm < p.shaft.diameterMm, 'nothing rejects a pad narrower than its shaft');
});

test('E16 the profile card has a control for every profile key and no other', () => {
    const keys = [...KNOBS_BY_SECTION.profile.map((k) => k.key as string), ...TOGGLES_BY_SECTION.profile.map((t) => t.key as string)];
    assert.deepEqual([...keys].sort(), [...OWN_PROFILE_KEYS].sort());
});

test('E17 own penetration reaches the placed contacts', () => {
    preservingLive(() => {
        const { trunks } = placeWith(own({ tipPenetrationMm: 0.15 }));
        assert.ok(trunks.every((t) => t.contactCone.profile.penetrationMm === 0.15), `got ${trunks[0]?.contactCone.profile.penetrationMm}`);
    });
});

test('E18 editing the manual Detail preset does not change an own-profile run', () => {
    preservingLive(() => {
        const detail = getPresetById('detail')!;
        const savedDetail = structuredClone(detail.settings);
        try {
            preservingLive(() => {
                setSettings({ ...savedDetail, tip: { ...savedDetail.tip, contactDiameterMm: 1.5 } });
                savePreset('detail');
            });
            updateAutoSupportSettings(own({ tipContactDiameterMm: 0.3 }));
            assert.equal(smallIslandTipDiameterMm(), SIZING_BANDS.detail.tipContactDiameterMm, `small-island tips read ${smallIslandTipDiameterMm()} from the manual Detail preset`);
        } finally {
            preservingLive(() => {
                setSettings(savedDetail);
                savePreset('detail');
            });
        }
    });
});

test('E19 a rebuilt own-profile support keeps its flare when the manual flare differs', () => {
    preservingLive(() => {
        const { trunks } = placeWith(own({ baseFlareEnabled: true, baseFlareDiameterMm: 2.6, baseFlareHeightMm: 1.0 }));
        updateBaseFlareProfile({ enabled: false, diameterMm: 9, heightMm: 5 });
        updateTipProfile({ coneAngleMode: 'locked' });
        const decoded = decodeSupportSettingsHex(trunks[0].settingsCodeHex!, getSettings())!;
        assert.deepEqual(decoded.baseFlare, { enabled: true, diameterMm: 2.6, heightMm: 1.0 });
        assert.equal(decoded.tip.coneAngleMode, createDefaultSettings().tip.coneAngleMode);
    });
});

test('E20 a rebuilt own-profile support keeps its own shaft and pad when the manual ones differ', () => {
    preservingLive(() => {
        const { trunks } = placeWith(own({ shaftDiameterMm: 1.1, rootDiameterMm: 2.5 }));
        updateShaftProfile({ diameterMm: 4 });
        const decoded = decodeSupportSettingsHex(trunks[0].settingsCodeHex!, getSettings())!;
        assert.ok(near(decoded.shaft.diameterMm, 1.1));
        assert.ok(near(decoded.roots.diameterMm, 2.5));
    });
});

// --- Stresstest 05.11.2026 ---------------------------------------------------

test('A1 a stored built-in moved to another tier keeps borrowing that tier', () => {
    preservingLive(() => {
        const old = createDefaultAutoSupportSettings() as unknown as Record<string, unknown>;
        for (const key of OWN_PROFILE_KEYS) delete old[key];
        const stored = {
            byId: {
                light: { id: 'light', name: 'Light', isBuiltIn: true, settings: { ...old, areaPerSupportMm2: 16, sizingPreset: 'anchor' } },
                medium: { id: 'medium', name: 'Medium', isBuiltIn: true, settings: { ...old } },
                heavy: { id: 'heavy', name: 'Heavy', isBuiltIn: true, settings: { ...old, sizingPreset: 'anchor' } },
            },
            allIds: ['light', 'medium', 'heavy'],
        };
        const { store } = freshStore({ 'auto-support-presets-v1': JSON.stringify(stored) });
        const [light, medium, heavy] = ['light', 'medium', 'heavy'].map((id) => store.getAutoSupportPreset(id)!.settings);
        dropStorage();
        assert.deepEqual([normalizeAutoSupportSettings(light).ownGeometry, light.sizingPreset], [false, 'anchor']);
        assert.equal(medium.ownGeometry, true);
        assert.equal(heavy.ownGeometry, true);
    });
});

test('A2 the dialog offers no shaft wider than a run builds', () => {
    preservingLive(() => {
        const max = AUTO_SUPPORT_CONSTRAINTS.shaftDiameterMm.max;
        const { trunks } = placeWith({ ownGeometry: true, shaftDiameterMm: max, tipContactDiameterMm: 0.3 });
        assert.ok(trunks.length > 0);
        assert.ok(near(trunks[0].baseDiameterMm, max, 0.01));
        assert.equal(normalizeAutoSupportSettings({ shaftDiameterMm: 5 }).shaftDiameterMm, max);
    });
});

for (const tier of ['detail', 'structure', 'anchor'] as const) {
    test(`A3 switching own profile on from ${tier} starts from that tier`, () => {
        preservingLive(() => {
            const block = withOwnProfileFromTier(borrow(tier, { ownGeometry: true }));
            assert.equal(block.shaftDiameterMm, SIZING_BANDS[tier].shaftDiameterMm);
            assert.equal(block.tipLengthMm, SIZING_BANDS[tier].tipLengthMm);
            assert.equal(block.rootDiameterMm, SIZING_BANDS[tier].rootDiameterMm);
        });
    });
}

test('A3 switching own profile on keeps numbers the block already holds', () => {
    preservingLive(() => {
        const block = withOwnProfileFromTier(borrow('detail', { ownGeometry: true, shaftDiameterMm: 1.75 }));
        assert.equal(block.shaftDiameterMm, 1.75);
    });
});

test('A3 a tier that names no preset falls back without throwing', () => {
    preservingLive(() => {
        const block = withOwnProfileFromTier(borrow('gone', { ownGeometry: true }));
        assert.equal(block.ownGeometry, true);
        assert.ok(block.shaftDiameterMm > 0);
    });
});
