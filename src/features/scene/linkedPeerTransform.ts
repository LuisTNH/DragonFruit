import * as THREE from 'three';
import { eulerFromGlobalEuler } from '@/utils/rotation';

/** A model's place on the plate, in the manager's shape. */
export interface PeerTransform {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  scale: THREE.Vector3;
}

/**
 * Where a linked model goes when another model of its group moves from `before`
 * to `after`: it takes the same change, added to its own transform. Pure, so the
 * manager and the CLI move a link group alike (ADR-0045).
 */
export function linkedPeerTransform({ peerBefore, before, after }: {
  peerBefore: PeerTransform;
  before: PeerTransform;
  after: PeerTransform;
}): PeerTransform {
  return {
    position: peerBefore.position.clone().add(after.position.clone().sub(before.position)),
    rotation: eulerFromGlobalEuler({
      x: peerBefore.rotation.x + after.rotation.x - before.rotation.x,
      y: peerBefore.rotation.y + after.rotation.y - before.rotation.y,
      z: peerBefore.rotation.z + after.rotation.z - before.rotation.z,
    }),
    scale: peerBefore.scale.clone().add(after.scale.clone().sub(before.scale)),
  };
}

/**
 * A link group scales by the same difference, not the same factor, so a smaller
 * peer can land on 0, which no support can follow back, or come out mirrored.
 */
export function linkedScaleBreaks(
  before: { x: number; y: number; z: number },
  after: { x: number; y: number; z: number },
): boolean {
  return (['x', 'y', 'z'] as const).some((axis) => after[axis] === 0 || Math.sign(after[axis]) !== Math.sign(before[axis]));
}

type ScaleVector = { x: number; y: number; z: number };
type LinkedModel = { id: string; linkGroupId?: string; transform: { scale: ScaleVector } };

/**
 * Whether these moves would take a linked model that is not among them to a scale
 * that `linkedScaleBreaks` refuses. A peer follows the first update of its group, as
 * in the manager. A move that leaves the scale alone never counts, so a peer that
 * already stands wrong can still be moved. `before` is for a caller that passes its
 * own starting point instead of the model's stored transform.
 */
export function linkedUpdatesBreakScale({ models, updates }: {
  models: LinkedModel[];
  updates: Array<{ id: string; transform: { scale: ScaleVector }; before?: { scale: ScaleVector } }>;
}): boolean {
  const claimed = new Set(updates.map((update) => update.id));
  return updates.some((update) => {
    const model = models.find((candidate) => candidate.id === update.id);
    if (!model?.linkGroupId) return false;
    const before = (update.before ?? model.transform).scale;
    const after = update.transform.scale;
    const delta = { x: after.x - before.x, y: after.y - before.y, z: after.z - before.z };
    const peers = models.filter((peer) => peer.linkGroupId === model.linkGroupId && !claimed.has(peer.id));
    peers.forEach((peer) => claimed.add(peer.id));
    if (delta.x === 0 && delta.y === 0 && delta.z === 0) return false;
    return peers.some(({ transform: { scale } }) => linkedScaleBreaks(scale, {
      x: scale.x + delta.x,
      y: scale.y + delta.y,
      z: scale.z + delta.z,
    }));
  });
}
