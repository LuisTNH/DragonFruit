import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { cullIntrudingMembers, entityIntrudes, findIntrudingMembers } from '../autoSupport/memberClearance';
import { createEmptySupportCollections } from '../supportTypeRegistry';
import type { SupportState } from '../types';

/** A ceiling slab (underside at z=10) and a thin bar at z 5–6 along X, `barY` off the axis. */
function modelWithBar(barY: number): THREE.Mesh {
    const slab = new THREE.BoxGeometry(20, 20, 1).toNonIndexed();
    slab.translate(0, 0, 10.5);
    const bar = new THREE.BoxGeometry(20, 1, 1).toNonIndexed();
    bar.translate(0, barY, 5.5);
    const geometry = mergeGeometries([slab, bar])!;
    (geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH }).boundsTree = new MeshBVH(geometry);
    return new THREE.Mesh(geometry);
}

/** One leaf from a knot at the origin up to a tip on the slab underside. */
function leafState(): SupportState {
    const state = createEmptySupportCollections() as unknown as SupportState;
    state.knots = { k: { id: 'k', pos: { x: 0, y: 0, z: 0 }, diameter: 0.9 } } as unknown as SupportState['knots'];
    state.leaves = {
        l: {
            id: 'l',
            typeId: 'leaf',
            modelId: 'm',
            parentKnotId: 'k',
            contactCone: {
                id: 'c',
                pos: { x: 0, y: 0, z: 10 },
                normal: { x: 0, y: 0, z: -1 },
                surfaceNormal: { x: 0, y: 0, z: -1 },
                profile: { type: 'disk', contactDiameterMm: 0.24, bodyDiameterMm: 0.8, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 0.25, standoffAngleThreshold: Math.PI / 4 },
            },
        },
    } as unknown as SupportState['leaves'];
    return state;
}

test('a leaf whose body passes through a thin bar is found and culled with its knot', () => {
    const mesh = modelWithBar(0);
    const found = findIntrudingMembers(leafState(), mesh);
    assert.equal(found.length, 1);
    assert.equal(found[0].id, 'l');
    const { draft, culled } = cullIntrudingMembers(leafState(), mesh);
    assert.equal(culled.length, 1);
    assert.equal(draft.leaves.l, undefined);
    assert.equal(draft.knots.k, undefined, 'the knot nothing else uses goes too');
});

test('a leaf beside the bar, touching only its own ceiling, stays', () => {
    assert.deepEqual(findIntrudingMembers(leafState(), modelWithBar(5)), []);
});

test('a trunk from its root is vetted the same way', () => {
    const state = createEmptySupportCollections() as unknown as SupportState;
    state.roots = { r: { id: 'r', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } }, diameter: 2, diskHeight: 0.5, coneHeight: 1 } } as unknown as SupportState['roots'];
    state.trunks = {
        t: {
            id: 't',
            typeId: 'trunk',
            modelId: 'm',
            rootId: 'r',
            segments: [{ id: 's', diameter: 0.8, topJoint: { id: 'j', pos: { x: 0, y: 0, z: 7.5 }, diameter: 0.8 } }],
            contactCone: {
                id: 'c',
                pos: { x: 0, y: 0, z: 10 },
                normal: { x: 0, y: 0, z: -1 },
                surfaceNormal: { x: 0, y: 0, z: -1 },
                profile: { type: 'disk', contactDiameterMm: 0.24, bodyDiameterMm: 0.8, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 0.25, standoffAngleThreshold: Math.PI / 4 },
            },
        },
    } as unknown as SupportState['trunks'];
    assert.equal(entityIntrudes(state, modelWithBar(0), 'trunk', 't'), true);
    assert.equal(entityIntrudes(state, modelWithBar(5), 'trunk', 't'), false);
});
