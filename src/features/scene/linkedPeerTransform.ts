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
