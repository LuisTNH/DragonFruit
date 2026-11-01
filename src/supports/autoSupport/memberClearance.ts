/**
 * Final clearance check for fan members (`strictClearance`, default off).
 *
 * The placement gates test a leaf as three thin rays from its knot to the tip
 * (`contactConeCollides`, ±0.25 mm, last 0.5 mm exempt) and a branch by its
 * segments, and the cone bodies are widened to their host shafts only after
 * that (`syncContactConeDiameters`). A cone that runs beside a thin feature —
 * a spear shaft next to the sole a tip lands on — can therefore cut through it
 * and still pass. This pass samples every leaf and branch cone as the frustum
 * it is built as, after the sync, and culls a member whose body sits inside
 * the model on a surface other than the one its tip contacts. Branch shafts are
 * sampled too, the first one from the parent knot it starts at.
 *
 * "Other surface" is judged by orientation: a sample inside the model whose
 * nearest surface faces more than 45° away from the contact's surface normal
 * is foreign geometry. That allowance only holds within `OWN_SURFACE_GRACE_MM`
 * of the tip: further back a cone buried in its own curved surface (a vertical
 * cone on a steep helmet rim) is an intrusion too. The last `TIP_EXEMPT_MM`
 * before the tip is skipped, as the contact itself sits on (and slightly in)
 * its own surface.
 */

import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';

import type { SupportState, Vec3 } from '../types';
import { draftRemoveEntity, draftRemovePrimitive } from './supportDraft';
import { getFinalSocketPosition } from '../SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';

/** Axial stretch before the tip the check ignores (mm). */
const TIP_EXEMPT_MM = 0.3;
/** Axial sampling step along a cone (mm). */
const AXIAL_STEP_MM = 0.1;
/** Points sampled around each ring of the cone surface. */
const RING_SAMPLES = 8;
/** Inside samples on foreign geometry a member may have before it is culled. */
const MAX_FOREIGN_SAMPLES = 1;
const FOREIGN_COS = Math.cos(Math.PI / 4);
/** Distance before the tip (mm) within which the contact's own surface may
 *  hold cone samples; past it every inside sample counts. */
const OWN_SURFACE_GRACE_MM = 0.6;

const PARITY_DIRS = [
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0.577, 0.577, 0.577),
    new THREE.Vector3(-0.3, 0.8, 0.52).normalize(),
];

export type IntrudingMember = { typeId: 'leaf' | 'branch'; id: string; parentKnotId: string; foreignSamples: number };

/** Surface crossings along a ray. A ray through the edge two triangles share
 *  hits both; counting that twice flips the inside/outside parity. */
function crossingCount(bvh: MeshBVH, ray: THREE.Ray): number {
    const distances = bvh.raycast(ray, THREE.DoubleSide).map((hit) => hit.distance).sort((x, y) => x - y);
    let count = 0;
    let last = -Infinity;
    for (const d of distances) {
        if (d - last > 1e-5) count++;
        last = d;
    }
    return count;
}

function boundsTreeOf(mesh: THREE.Mesh): MeshBVH | null {
    return ((mesh.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH }).boundsTree) ?? null;
}

/** Counts samples of one frustum (a → b, radius rA → rB) inside the model,
 *  skipping the last `exemptEndMm` before b. With a contact normal only samples
 *  whose nearest surface faces away from it count; without one (a shaft, which
 *  has no surface of its own) every inside sample does. */
function countForeignSamples(
    a: Vec3,
    b: Vec3,
    rA: number,
    rB: number,
    exemptEndMm: number,
    contactNormal: THREE.Vector3 | null,
    bvh: MeshBVH,
    toLocal: THREE.Matrix4,
    normalToWorld: THREE.Matrix3,
): number {
    const base = new THREE.Vector3(a.x, a.y, a.z);
    const axis = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
    const length = axis.length();
    if (length <= exemptEndMm) return 0;
    axis.divideScalar(length);
    const u = new THREE.Vector3().crossVectors(axis, Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(axis, u);

    const p = new THREE.Vector3();
    const local = new THREE.Vector3();
    const ray = new THREE.Ray();
    const hitNormal = new THREE.Vector3();
    const A = new THREE.Vector3();
    const B = new THREE.Vector3();
    const C = new THREE.Vector3();
    const position = bvh.geometry.getAttribute('position');
    const index = bvh.geometry.getIndex();
    let foreign = 0;
    for (let s = 0; s <= length - exemptEndMm; s += AXIAL_STEP_MM) {
        const r = rA + (rB - rA) * (s / length);
        for (let k = 0; k < RING_SAMPLES; k++) {
            const angle = (k / RING_SAMPLES) * Math.PI * 2;
            p.copy(base).addScaledVector(axis, s).addScaledVector(u, Math.cos(angle) * r).addScaledVector(v, Math.sin(angle) * r);
            local.copy(p).applyMatrix4(toLocal);
            let votes = 0;
            for (const dir of PARITY_DIRS) {
                ray.set(local, dir);
                if (crossingCount(bvh, ray) % 2 === 1) votes++;
            }
            if (votes < 2) continue;
            if (!contactNormal || length - s > OWN_SURFACE_GRACE_MM) {
                foreign++;
                continue;
            }
            const closest = bvh.closestPointToPoint(local);
            if (!closest) continue;
            const tri = closest.faceIndex;
            A.fromBufferAttribute(position, index ? index.getX(tri * 3) : tri * 3);
            B.fromBufferAttribute(position, index ? index.getX(tri * 3 + 1) : tri * 3 + 1);
            C.fromBufferAttribute(position, index ? index.getX(tri * 3 + 2) : tri * 3 + 2);
            THREE.Triangle.getNormal(A, B, C, hitNormal);
            hitNormal.applyMatrix3(normalToWorld).normalize();
            if (hitNormal.dot(contactNormal) < FOREIGN_COS) foreign++;
        }
    }
    return foreign;
}

/** A member as built: the body from its knot (or last joint) to the cone's
 *  socket, then the contact cone from the socket along its own axis to the tip. */
function countMemberForeignSamples(
    from: Vec3,
    cone: ContactCone,
    bvh: MeshBVH,
    toLocal: THREE.Matrix4,
    normalToWorld: THREE.Matrix3,
): number {
    const sn = cone.surfaceNormal ?? cone.normal;
    const contactNormal = new THREE.Vector3(sn.x, sn.y, sn.z).normalize();
    const socket = getFinalSocketPosition(cone);
    // The cone body starts where the contact disk ends, offset along the
    // surface normal (as `getFinalSocketPosition` builds it), not at the tip.
    const diskMm = cone.profile.type === 'disk'
        ? (cone.diskLengthOverride ?? calculateDiskThickness(sn, cone.normal, cone.profile))
        : 0;
    const coneStart = { x: cone.pos.x + sn.x * diskMm, y: cone.pos.y + sn.y * diskMm, z: cone.pos.z + sn.z * diskMm };
    const body = cone.profile.bodyDiameterMm / 2;
    const contact = cone.profile.contactDiameterMm / 2;
    return countForeignSamples(from, socket, body, body, 0, null, bvh, toLocal, normalToWorld)
        + countForeignSamples(socket, coneStart, body, contact, TIP_EXEMPT_MM, contactNormal, bvh, toLocal, normalToWorld);
}

/** Foreign samples of one shaft chain from `from` through its segments, then its cone. */
function countChainForeignSamples(
    from: Vec3 | undefined,
    segments: ReadonlyArray<{ bottomJoint?: { pos: Vec3 } | null; topJoint?: { pos: Vec3 } | null; diameter?: number }>,
    cone: ContactCone,
    bvh: MeshBVH,
    toLocal: THREE.Matrix4,
    normalToWorld: THREE.Matrix3,
): number {
    let start = from;
    let shaftSamples = 0;
    for (const segment of segments) {
        const a = segment.bottomJoint?.pos ?? start;
        const b = segment.topJoint?.pos;
        if (a && b) {
            const r = (segment.diameter ?? 1.0) / 2;
            shaftSamples += countForeignSamples(a, b, r, r, 0, null, bvh, toLocal, normalToWorld);
        }
        start = b ?? start;
    }
    const last = segments[segments.length - 1]?.topJoint?.pos ?? from;
    return last ? shaftSamples + countMemberForeignSamples(last, cone, bvh, toLocal, normalToWorld) : shaftSamples;
}

/**
 * Whether one entity — a leaf, a branch, or a trunk from its root — cuts into
 * the model as built. Used to vet a re-placed contact before it is kept.
 */
export function entityIntrudes(draft: SupportState, mesh: THREE.Mesh, typeId: string, id: string): boolean {
    const bvh = boundsTreeOf(mesh);
    if (!bvh) return false;
    mesh.updateMatrixWorld(true);
    const toLocal = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
    const normalToWorld = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    let samples = 0;
    if (typeId === 'leaf') {
        const leaf = draft.leaves?.[id];
        const knot = leaf ? draft.knots?.[leaf.parentKnotId] : undefined;
        if (!leaf?.contactCone || !knot) return false;
        samples = countMemberForeignSamples(knot.pos, leaf.contactCone, bvh, toLocal, normalToWorld);
    } else if (typeId === 'branch') {
        const branch = draft.branches?.[id];
        if (!branch?.contactCone) return false;
        samples = countChainForeignSamples(draft.knots?.[branch.parentKnotId]?.pos, branch.segments, branch.contactCone, bvh, toLocal, normalToWorld);
    } else if (typeId === 'trunk') {
        const trunk = draft.trunks?.[id];
        if (!trunk?.contactCone) return false;
        samples = countChainForeignSamples(draft.roots?.[trunk.rootId]?.transform?.pos, trunk.segments, trunk.contactCone, bvh, toLocal, normalToWorld);
    } else {
        return false;
    }
    return samples > MAX_FOREIGN_SAMPLES;
}

/** Leaves and branches whose cone body cuts into foreign model geometry. */
export function findIntrudingMembers(draft: SupportState, mesh: THREE.Mesh): IntrudingMember[] {
    const bvh = boundsTreeOf(mesh);
    if (!bvh) return [];
    mesh.updateMatrixWorld(true);
    const toLocal = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
    const normalToWorld = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const out: IntrudingMember[] = [];
    for (const leaf of Object.values(draft.leaves ?? {})) {
        const knot = draft.knots?.[leaf.parentKnotId];
        if (!knot || !leaf.contactCone) continue;
        const foreignSamples = countMemberForeignSamples(knot.pos, leaf.contactCone, bvh, toLocal, normalToWorld);
        if (foreignSamples > MAX_FOREIGN_SAMPLES) out.push({ typeId: 'leaf', id: leaf.id, parentKnotId: leaf.parentKnotId, foreignSamples });
    }
    for (const branch of Object.values(draft.branches ?? {})) {
        const last = branch.segments[branch.segments.length - 1]?.topJoint?.pos;
        if (!last || !branch.contactCone) continue;
        // The first segment starts at the parent knot and has no bottom joint
        // of its own; `branchCollidesWithSDF` skips it, so the shaft leaving
        // the host was never tested.
        const foreignSamples = countChainForeignSamples(draft.knots?.[branch.parentKnotId]?.pos, branch.segments, branch.contactCone, bvh, toLocal, normalToWorld);
        if (foreignSamples > MAX_FOREIGN_SAMPLES) out.push({ typeId: 'branch', id: branch.id, parentKnotId: branch.parentKnotId, foreignSamples });
    }
    return out;
}

/**
 * Removes the intruding members, and each parent knot nothing else still
 * references (a brace may share one).
 */
export function cullIntrudingMembers(
    draft: SupportState,
    mesh: THREE.Mesh,
): { draft: SupportState; culled: IntrudingMember[] } {
    const culled = findIntrudingMembers(draft, mesh);
    if (culled.length === 0) return { draft, culled };
    let next = draft;
    for (const member of culled) next = draftRemoveEntity(next, member.typeId, member.id);
    const referenced = new Set<string>();
    const collect = (value: unknown): void => {
        if (typeof value === 'string') referenced.add(value);
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    for (const [key, collection] of Object.entries(next)) {
        if (key === 'knots') continue;
        collect(collection);
    }
    for (const member of culled) {
        if (!referenced.has(member.parentKnotId)) next = draftRemovePrimitive(next, 'knots', member.parentKnotId);
    }
    return { draft: next, culled };
}
