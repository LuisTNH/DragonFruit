import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { initializeBVH, accelerateGeometry } from '@/utils/bvh';
import { soupTriangleOf } from '../autoSupport/gridPlacement';

test('a raycast on a BVH-built soup maps back to the scan triangle', () => {
    initializeBVH();
    // Triangles in an order the tree reorders: scattered, not sorted along an axis.
    const count = 300;
    const positions = new Float32Array(count * 9);
    for (let k = 0; k < count; k++) {
        const x = ((k * 7919) % count) * 2;
        const y = ((k * 104729) % 17) * 2;
        positions.set([x, y, 0, x + 1, y, 0, x, y + 1, 0], k * 9);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const raycaster = new THREE.Raycaster();
    let reordered = 0;
    for (const k of [0, 41, 150, 299]) {
        const x = ((k * 7919) % count) * 2;
        const y = ((k * 104729) % 17) * 2;
        raycaster.set(new THREE.Vector3(x + 0.2, y + 0.2, -1), new THREE.Vector3(0, 0, 1));
        const hit = raycaster.intersectObject(mesh)[0];
        assert.ok(hit?.faceIndex != null);
        if (hit.faceIndex !== k) reordered++;
        assert.equal(soupTriangleOf(geometry, hit.faceIndex), k);
    }
    assert.ok(reordered > 0, 'the tree reorders, so the raw faceIndex alone would miss');
});
