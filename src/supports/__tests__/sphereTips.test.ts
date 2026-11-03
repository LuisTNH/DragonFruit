import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import { runAutoPlace } from '../autoSupport/autoPlace';
import { normalizeAutoSupportSettings } from '../autoSupport/settings';
import { createPreset, deletePreset, isPresetDirtyForSettings } from '../Settings/presets';
import { getSettings, setSettings, updateAutoSupportSettings, updateTipProfile } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import {
    areSupportGeometrySettingsEqual,
    decodeSupportSettingsHex,
    encodeSupportSettingsHex,
} from '../Settings/supportSettingsCodec';
import { sphereTipProfile, withTipType } from '../SupportPrimitives/ContactCone/contactConeUtils';
import type { SupportTipProfile } from '../SupportPrimitives/ContactCone/types';
import { buildTrunkData } from '../SupportTypes/Trunk/trunkBuilder';
import { applySettingsToSupportTarget, getSnapshot, resetKickstandsInState, resetStore } from '../state';

type Profile = { type?: string; contactDiameterMm: number; sphereRadiusRatio?: number };
type WithCone = { contactCone?: { profile: Profile } };

const DISK: SupportTipProfile = {
    type: 'disk',
    contactDiameterMm: 0.3,
    bodyDiameterMm: 1,
    lengthMm: 2.5,
    penetrationMm: 0,
    diskThicknessMm: 0.1,
    maxStandoffMm: 1.5,
    standoffAngleThreshold: Math.PI / 4,
};

function preservingLive<T>(fn: () => T): T {
    const before = getSettings();
    try {
        return fn();
    } finally {
        setSettings(before);
    }
}

function flatCeiling(): DetectedIsland {
    const voxels: Array<{ x: number; y: number; z: number }> = [];
    for (let x = -6; x <= 6; x += 0.5) for (let y = -6; y <= 6; y += 0.5) voxels.push({ x, y, z: 8 });
    return {
        id: 'o0', source: 'overhang', contact: new THREE.Vector3(0, 0, 8), baseZ: 8, maxZ: 12, areaMm2: 144,
        overhangAngleDeg: 0, surfaceNormal: { x: 0, y: 0, z: -1 }, contactVoxels: footprintFromPoints(voxels),
    };
}

/** A run on a fresh store; returns the trunks and leaves it placed. */
function placeContacts(): Array<WithCone & { id: string }> {
    resetStore();
    resetKickstandsInState();
    runAutoPlace([flatCeiling()], 'm', getSettings().autoSupport);
    const snap = getSnapshot() as unknown as Record<string, Record<string, WithCone & { id: string }>>;
    return [...Object.values(snap.trunks), ...Object.values(snap.leaves)];
}

const ballOf = (p: Profile) => p.contactDiameterMm * (p.sphereRadiusRatio ?? 1);

test('withTipType leaves a disk tip alone and turns a sphere tip into a sized ball', () => {
    assert.equal(withTipType(DISK, { type: 'disk', ballDiameterMm: 0.5 }), DISK);
    const ball = withTipType(DISK, { type: 'sphere', ballDiameterMm: 0.5 }) as Profile;
    assert.equal(ball.type, 'sphere');
    assert.ok(Math.abs(ballOf(ball) - 0.5) < 1e-9);
});

test('a ball is never narrower than its contact', () => {
    const wide = sphereTipProfile({ ...DISK, contactDiameterMm: 0.7 }, 0.4) as Profile;
    assert.equal(wide.sphereRadiusRatio, 1);
});

test('a manual trunk built with a sphere tip ends in a ball of the Studio size', () => {
    preservingLive(() => {
        updateTipProfile({ type: 'sphere', ballDiameterMm: 0.6, contactDiameterMm: 0.3 });
        const { trunk } = buildTrunkData({ tipPos: { x: 0, y: 0, z: 10 }, tipNormal: { x: 0, y: 0, z: -1 }, modelId: 'm' });
        const profile = trunk.contactCone!.profile as Profile;
        assert.equal(profile.type, 'sphere');
        assert.ok(Math.abs(ballOf(profile) - 0.6) < 1e-9);
    });
});

test('a manual trunk built with a disk tip stays a disk', () => {
    preservingLive(() => {
        updateTipProfile({ type: 'disk' });
        const { trunk } = buildTrunkData({ tipPos: { x: 0, y: 0, z: 10 }, tipNormal: { x: 0, y: 0, z: -1 }, modelId: 'm' });
        assert.equal(trunk.contactCone!.profile.type, 'disk');
    });
});

test('the stamped code of a sphere trunk carries the tip type and ball', () => {
    preservingLive(() => {
        updateTipProfile({ type: 'sphere', ballDiameterMm: 0.55 });
        const { trunk } = buildTrunkData({ tipPos: { x: 0, y: 0, z: 10 }, tipNormal: { x: 0, y: 0, z: -1 }, modelId: 'm' });
        updateTipProfile({ type: 'disk', ballDiameterMm: 0.3 });
        const decoded = decodeSupportSettingsHex(trunk.settingsCodeHex!, getSettings())!;
        assert.equal(decoded.tip.type, 'sphere');
        assert.equal(decoded.tip.ballDiameterMm, 0.55);
    });
});

test('a code written before the sphere bit decodes as a disk with the base ball', () => {
    const settings = createDefaultSettings();
    const hex = encodeSupportSettingsHex(settings);
    const legacy = hex.slice(0, 2 + 2 + 20 * 4); // version, flags, the original 20 values
    const base = { ...settings, tip: { ...settings.tip, type: 'sphere' as const, ballDiameterMm: 0.7 } };
    const decoded = decodeSupportSettingsHex(legacy, base)!;
    assert.equal(decoded.tip.type, 'disk');
    assert.equal(decoded.tip.ballDiameterMm, 0.7);
});

test('the geometry comparison sees a tip type or ball change', () => {
    const a = createDefaultSettings();
    assert.equal(areSupportGeometrySettingsEqual(a, { ...a, tip: { ...a.tip, type: 'sphere' } }), false);
    assert.equal(areSupportGeometrySettingsEqual(a, { ...a, tip: { ...a.tip, ballDiameterMm: 0.65 } }), false);
});

test('switching a Studio preset to sphere marks it modified', () => {
    preservingLive(() => {
        const created = createPreset('sphere drift');
        try {
            assert.equal(isPresetDirtyForSettings(created.id, getSettings()), false);
            updateTipProfile({ type: 'sphere' });
            assert.equal(isPresetDirtyForSettings(created.id, getSettings()), true);
        } finally {
            deletePreset(created.id);
        }
    });
});

test('the Studio store clamps the ball and repairs an unknown tip type', () => {
    preservingLive(() => {
        updateTipProfile({ ballDiameterMm: 9, type: 'cone' as never });
        assert.equal(getSettings().tip.ballDiameterMm, 1);
        assert.equal(getSettings().tip.type, 'disk');
        updateTipProfile({ ballDiameterMm: -1 });
        assert.equal(getSettings().tip.ballDiameterMm, 0.2);
    });
});

test('editing a selected trunk to sphere gives it a ball, and back to disk removes it', () => {
    preservingLive(() => {
        updateAutoSupportSettings(normalizeAutoSupportSettings({ sizingPreset: 'structure' }));
        const trunk = placeContacts().find((e) => (e as { typeId?: string }).typeId === 'trunk')!;
        const target = { kind: 'trunk' as const, id: trunk.id };

        const sphere = { ...getSettings(), tip: { ...getSettings().tip, type: 'sphere' as const, ballDiameterMm: 0.5 } };
        assert.equal(applySettingsToSupportTarget(target, sphere), true);
        let profile = (getSnapshot().trunks[trunk.id] as unknown as WithCone).contactCone!.profile;
        assert.equal(profile.type, 'sphere');
        assert.ok(Math.abs(ballOf(profile) - Math.max(0.5, profile.contactDiameterMm)) < 1e-9);

        const disk = { ...sphere, tip: { ...sphere.tip, type: 'disk' as const } };
        applySettingsToSupportTarget(target, disk);
        profile = (getSnapshot().trunks[trunk.id] as unknown as WithCone).contactCone!.profile;
        assert.equal(profile.type, 'disk');
        assert.ok((profile as { diskThicknessMm?: number }).diskThicknessMm! > 0, 'the disk fields come back');
    });
});

test('an auto run with a sphere tip places balls of the Studio size', () => {
    // On this branch an auto run builds with the live Support Studio tip, so the
    // tip type set there decides whether its contacts end in balls.
    preservingLive(() => {
        updateTipProfile({ type: 'sphere', ballDiameterMm: 0.45 });
        updateAutoSupportSettings(normalizeAutoSupportSettings({ sizingPreset: 'structure' }));
        const contacts = placeContacts();
        assert.ok(contacts.length > 0);
        for (const entity of contacts) {
            const profile = entity.contactCone!.profile;
            assert.equal(profile.type, 'sphere');
            assert.ok(Math.abs(ballOf(profile) - Math.max(0.45, profile.contactDiameterMm)) < 1e-9);
        }
    });
});

test('an auto run with a disk tip places no balls', () => {
    preservingLive(() => {
        updateTipProfile({ type: 'disk' });
        updateAutoSupportSettings(normalizeAutoSupportSettings({ sizingPreset: 'structure' }));
        const contacts = placeContacts();
        assert.ok(contacts.length > 0);
        assert.ok(contacts.every((e) => e.contactCone!.profile.type === 'disk'));
    });
});
