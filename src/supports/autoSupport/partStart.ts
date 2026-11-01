/**
 * Part-start reinforcement (`reinforcePartStart`, default off).
 *
 * The first layers of a part are the ones that hold it to the supports while
 * everything above is still to come, and on a leaned mini that start is a
 * small patch: the heel of a sole, the foot of a spear. The density grid
 * spaces those contacts like any other overhang, which leaves one tip at the
 * very lowest point and a gap before the next row. With the switch on, an
 * overhang region that has nothing of the model below it — it faces the plate,
 * so the print starts there — gets a second, finer lattice over its lowest
 * `PART_START_BAND_MM` of height (see `generateGridCandidates`). A start
 * region too small for a grid (the foot of a spear) gets a few contacts spread
 * over it instead of its single one (`generatePartStartClusters`).
 */

import * as THREE from 'three';

/** Height above a start region's lowest point that gets the finer lattice (mm). */
export const PART_START_BAND_MM = 0.6;
/** The finer lattice's spacing as a fraction of the region's own. */
export const PART_START_SPACING_FACTOR = 0.5;
/** Contacts a start region too small for a grid gets (a spear's foot). */
export const PART_START_CLUSTER_MAX = 4;
/** Least spacing between those contacts (mm): past the merge radius, so
 *  deduplication keeps them apart. */
export const PART_START_CLUSTER_SEPARATION_MM = 0.55;

/**
 * Spread up to `max` contacts over a small patch, at least `minSeparation`
 * apart: its lowest point first (where the print starts), then each next the
 * point farthest from those already taken.
 */
export function spreadStartContacts<T extends { x: number; y: number; z: number }>(
    points: readonly T[],
    max = PART_START_CLUSTER_MAX,
    minSeparation = PART_START_CLUSTER_SEPARATION_MM,
): T[] {
    if (points.length === 0) return [];
    const taken: T[] = [points.reduce((low, p) => (p.z < low.z ? p : low))];
    while (taken.length < max) {
        let best: T | null = null;
        let bestDistSq = minSeparation * minSeparation;
        for (const p of points) {
            const d = Math.min(...taken.map((t) => (t.x - p.x) ** 2 + (t.y - p.y) ** 2 + (t.z - p.z) ** 2));
            if (d >= bestDistSq) {
                bestDistSq = d;
                best = p;
            }
        }
        if (!best) break;
        taken.push(best);
    }
    return taken;
}

const DOWN = new THREE.Vector3(0, 0, -1);
const _raycaster = new THREE.Raycaster();

/** How far above the model's lowest point a part start may begin (mm). An arm
 *  held out over empty space also has nothing below it, but the model does
 *  not start there. */
export const PART_START_MAX_HEIGHT_MM = 2.0;

const _box = new THREE.Box3();

/**
 * Whether a region is where the model starts: it sits within
 * `PART_START_MAX_HEIGHT_MM` of the model's lowest point and has no model
 * below any of its contact points. A sole counts; a helmet rim over the
 * shoulders or the underside of an outstretched arm does not.
 */
export function isPartStart(points: ReadonlyArray<{ x: number; y: number; z: number }>, mesh: THREE.Mesh): boolean {
    if (points.length === 0) return false;
    _box.setFromObject(mesh);
    const lowest = Math.min(...points.map((p) => p.z));
    if (lowest > _box.min.z + PART_START_MAX_HEIGHT_MM) return false;
    for (const p of points) {
        // Start just below the contact so the surface it sits on is not hit.
        _raycaster.set(new THREE.Vector3(p.x, p.y, p.z - 0.05), DOWN);
        if (_raycaster.intersectObject(mesh, false).length > 0) return false;
    }
    return true;
}
