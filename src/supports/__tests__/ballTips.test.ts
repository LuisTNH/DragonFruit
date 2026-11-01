import assert from 'node:assert/strict';
import test from 'node:test';

import { applyBallTips } from '../autoSupport/ballTips';
import { getContactBall, getContactConeLowestZ } from '../SupportPrimitives/ContactCone/contactConeUtils';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import { createEmptySupportCollections } from '../supportTypeRegistry';
import type { SupportState } from '../types';

function cone(type: 'disk' | 'sphere', ratio?: number): ContactCone {
    return {
        id: 'c',
        pos: { x: 0, y: 0, z: 10 },
        normal: { x: 0, y: 0, z: -1 },
        surfaceNormal: { x: 0, y: 0, z: -1 },
        profile: type === 'sphere'
            ? { type, sphereRadiusRatio: ratio ?? 1, contactDiameterMm: 0.24, bodyDiameterMm: 0.8, lengthMm: 2.5, penetrationMm: 0.1 }
            : { type, contactDiameterMm: 0.24, bodyDiameterMm: 0.8, lengthMm: 2.5, penetrationMm: 0.1, diskThicknessMm: 0.1, maxStandoffMm: 0.25, standoffAngleThreshold: Math.PI / 4 },
    } as ContactCone;
}

test('a sphere contact rests its ball on the surface, sunk by the penetration', () => {
    assert.equal(getContactBall(cone('disk')), null);
    const ball = getContactBall(cone('sphere', 0.4 / 0.24))!;
    assert.ok(Math.abs(ball.radius - 0.2) < 1e-9);
    // Ceiling contact, surface normal down: the ball hangs below the contact.
    assert.ok(Math.abs(ball.center.z - (10 - (0.2 - 0.1))) < 1e-9);
    assert.ok(getContactConeLowestZ(cone('sphere', 0.4 / 0.24)) <= ball.center.z - 0.2 + 1e-9, 'the bound covers the ball');
    // On an upward face the cone rises away; a large, deeply sunk ball then
    // reaches lower than anything else and sets the bound.
    const base = cone('sphere', 1.0 / 0.24);
    const up = { ...base, normal: { x: 0, y: 0, z: 1 }, surfaceNormal: { x: 0, y: 0, z: 1 }, profile: { ...base.profile, penetrationMm: 0.6 } } as ContactCone;
    assert.ok(Math.abs(getContactConeLowestZ(up) - (10 + (0.5 - 0.6) - 0.5)) < 1e-9);
});

test('ball tips turn every trunk, branch and leaf contact into a sized ball', () => {
    const state = createEmptySupportCollections() as unknown as SupportState;
    state.trunks = { t: { id: 't', typeId: 'trunk', modelId: 'm', rootId: 'r', segments: [], contactCone: cone('disk') } } as unknown as SupportState['trunks'];
    state.leaves = { l: { id: 'l', typeId: 'leaf', modelId: 'm', parentKnotId: 'k', contactCone: cone('disk') } } as unknown as SupportState['leaves'];
    const { draft, converted } = applyBallTips(state, 0.4);
    assert.equal(converted, 2);
    for (const entity of [draft.trunks.t, draft.leaves.l]) {
        const profile = entity.contactCone!.profile as { type: string; sphereRadiusRatio: number; contactDiameterMm: number };
        assert.equal(profile.type, 'sphere');
        assert.ok(Math.abs(profile.sphereRadiusRatio * profile.contactDiameterMm - 0.4) < 1e-9);
    }
});
