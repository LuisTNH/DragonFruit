/** Past these a support's matrix overflows or stops inverting, and the scene file saves `null`. */
export const MAX_POSITION_MM = 1e6;
export const MAX_ROTATION_RAD = 1e6;
export const MIN_SCALE = 1e-6;
export const MAX_SCALE = 1e6;

type Vec3 = { x: number; y: number; z: number };
const axes = ({ x, y, z }: Vec3): number[] => [x, y, z];

/**
 * Why a model cannot stand at this transform, or `null` when it can. Mirroring stays
 * allowed, so scale is judged by size. A scale of 0 is refused like any other that
 * the supports could not follow back.
 */
export function transformProblem({ position, rotation, scale }: {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}): string | null {
  if (![...axes(position), ...axes(rotation), ...axes(scale)].every(Number.isFinite)) {
    return 'position, rotation and scale take three numbers: x,y,z';
  }
  if (axes(position).some((value) => Math.abs(value) > MAX_POSITION_MM)) {
    return `position is limited to ${MAX_POSITION_MM} mm`;
  }
  if (axes(rotation).some((value) => Math.abs(value) > MAX_ROTATION_RAD)) {
    return `rotation is limited to ${MAX_ROTATION_RAD} radians`;
  }
  if (axes(scale).some((value) => Math.abs(value) < MIN_SCALE || Math.abs(value) > MAX_SCALE)) {
    return `scale must stay between ${MIN_SCALE} and ${MAX_SCALE}, not 0: the supports could not follow it back`;
  }
  return null;
}
