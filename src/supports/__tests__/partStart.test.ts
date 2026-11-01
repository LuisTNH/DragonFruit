import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { isPartStart } from '../autoSupport/partStart';

/** A slab whose underside sits at z=10, `offsetX` along X. */
function slab(offsetX: number, z: number): THREE.BufferGeometry {
    const geometry = new THREE.BoxGeometry(10, 10, 1).toNonIndexed();
    geometry.translate(offsetX, 0, z + 0.5);
    return geometry;
}

test('a region with nothing below it is a part start', () => {
    const mesh = new THREE.Mesh(slab(0, 10));
    assert.equal(isPartStart([{ x: 0, y: 0, z: 10 }, { x: 2, y: 1, z: 10 }], mesh), true);
});

test('a region over more of the model is not', () => {
    const geometry = slab(0, 10);
    const below = slab(0, 2);
    const merged = new THREE.BufferGeometry();
    const a = geometry.getAttribute('position').array as Float32Array;
    const b = below.getAttribute('position').array as Float32Array;
    const all = new Float32Array(a.length + b.length);
    all.set(a);
    all.set(b, a.length);
    merged.setAttribute('position', new THREE.BufferAttribute(all, 3));
    const mesh = new THREE.Mesh(merged);
    assert.equal(isPartStart([{ x: 0, y: 0, z: 10 }], mesh), false);
    assert.equal(isPartStart([], mesh), false);
});
