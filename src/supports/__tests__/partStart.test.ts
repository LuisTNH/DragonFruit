import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { isPartStart, spreadStartContacts } from '../autoSupport/partStart';

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

test('an overhang high above the model base is not a part start, though nothing is below it', () => {
    const base = slab(0, 0);
    const arm = slab(30, 10); // held out over empty space, 10 mm up
    const merged = new THREE.BufferGeometry();
    const a = base.getAttribute('position').array as Float32Array;
    const b = arm.getAttribute('position').array as Float32Array;
    const all = new Float32Array(a.length + b.length);
    all.set(a);
    all.set(b, a.length);
    merged.setAttribute('position', new THREE.BufferAttribute(all, 3));
    assert.equal(isPartStart([{ x: 30, y: 0, z: 10 }], new THREE.Mesh(merged)), false);
});

test('start contacts spread from the lowest point and keep their distance', () => {
    const points = [
        { x: 0, y: 0, z: 0.2 },
        { x: 0.3, y: 0, z: 0.1 },
        { x: 0.9, y: 0, z: 0 },
        { x: 0, y: 0.9, z: 0.3 },
    ];
    const spread = spreadStartContacts(points, 4, 0.55);
    assert.deepEqual(spread[0], { x: 0.9, y: 0, z: 0 }, 'lowest first');
    for (let i = 0; i < spread.length; i++) {
        for (let j = i + 1; j < spread.length; j++) {
            const d = Math.hypot(spread[i].x - spread[j].x, spread[i].y - spread[j].y, spread[i].z - spread[j].z);
            assert.ok(d >= 0.55, `${d}`);
        }
    }
    assert.equal(spread.length, 3);
});
