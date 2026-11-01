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
 * `PART_START_BAND_MM` of height (see `generateGridCandidates`).
 */

import * as THREE from 'three';

/** Height above a start region's lowest point that gets the finer lattice (mm). */
export const PART_START_BAND_MM = 0.6;
/** The finer lattice's spacing as a fraction of the region's own. */
export const PART_START_SPACING_FACTOR = 0.5;

const DOWN = new THREE.Vector3(0, 0, -1);
const _raycaster = new THREE.Raycaster();

/**
 * Whether a region faces the plate: no model below any of its contact points.
 * A start is judged on the region's own contacts, so a sole counts while a
 * helmet rim over the shoulders does not.
 */
export function isPartStart(points: ReadonlyArray<{ x: number; y: number; z: number }>, mesh: THREE.Mesh): boolean {
    if (points.length === 0) return false;
    for (const p of points) {
        // Start just below the contact so the surface it sits on is not hit.
        _raycaster.set(new THREE.Vector3(p.x, p.y, p.z - 0.05), DOWN);
        if (_raycaster.intersectObject(mesh, false).length > 0) return false;
    }
    return true;
}
