/**
 * Auto supports for `support auto`, run with the app's own placement pipeline.
 *
 * Placement is `runAutoPlaceRequest`, the path the app's auto-support worker
 * takes. Islands come, like in the app, from the combined native scan (voxel
 * islands + mesh minima + overhang regions) when a built `dragonfruit-cli` is
 * given (`island combined`). Without it only the in-process voxel detector runs
 * (see `scripts/bench-island-scan.ts`), which misses the minima and overhang
 * islands and places far fewer supports than the app on the same model.
 *
 * Isolated from the CLI entry point because it pulls in THREE, the support
 * stores and the generated registries; `dragonfruit-ts-cli.ts` loads it only
 * for `support auto`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from 'three';

import { accelerateGeometry, initializeBVH } from '../../src/utils/bvh';
import { classifyIntersection } from '../../src/volumeAnalysis/Islands/intersection';
import { mergeOverhangRegions, overhangRegionToIsland } from '../../src/volumeAnalysis/Islands/useIslands';
import type { DetectedIsland, OverhangRegion } from '../../src/volumeAnalysis/Islands/types';
import { OVERHANG_SELF_SUPPORT_ANGLE_DEG } from '../../src/supports/autoSupport/constants';
import { createDefaultSettings } from '../../src/supports/Settings/types';
import { setSettings } from '../../src/supports/Settings/state';
import { clearHistory } from '../../src/history/historyStore';
import { getSnapshot, resetKickstandsInState, resetStore } from '../../src/supports/state';
import { registerSupportHistoryHandlers } from '../../src/supports/history/useSupportHistoryHandlers';
import { setModelMesh } from '../../src/supports/autoSupport/meshStore';
import {
  modelMeshKey,
  runAutoPlaceRequest,
  serializeIsland,
  serializeModelMesh,
} from '../../src/supports/autoSupport/autoPlace.worker.shared';
import { buildScopedSupportExportDocument } from '../../src/features/export/logic/supportExportReconstruction';
import { disposeEventLoopChannel } from '../../src/utils/yieldToEventLoop';
import { normalizeAutoSupportSettings, type AutoSupportSettings } from '../../src/supports/autoSupport/settings';
import type { DragonfruitImportFormat } from '../../src/supports/types';
import { DEFAULT_DETECT_OPTIONS, detectIslands, type DetectOptions } from '../bench-island-scan';

export type SupportAutoInput = {
  modelId: string;
  /** World-space triangle positions, 9 floats per triangle, already lifted. */
  positions: Float32Array;
  /** Overrides on the default auto-support settings (the app's preset JSON shape). */
  settings?: Partial<AutoSupportSettings>;
  detect?: Partial<DetectOptions>;
  /**
   * Path to a built `dragonfruit-cli`. When given, islands come from its
   * `island combined` (voxel + mesh minima + overhang regions, the scan the app
   * runs) instead of the in-process voxel detector.
   */
  islandsCli?: string;
};

/** The JSON `island combined` writes: what `scan_islands_staged` returns to the app. */
type CombinedIslandScan = {
  voxelIslands: Array<{
    id: string;
    contact: { x: number; y: number; z: number };
    baseZ: number;
    areaMm2?: number;
    layerSpan: [number, number];
    contactVoxels?: number[];
  }>;
  minimaIslands: Array<{
    position: { x: number; y: number; z: number };
    vertexIndex?: number;
    seedTriangleId?: number;
    persistenceMm?: number;
  }>;
  overhangIslands: OverhangRegion[];
};

/**
 * The app's island list from a native combined scan: voxel islands above the
 * minimum area, classified against the mesh minima, then merged with the
 * overhang regions — the chain `useIslands` builds `allIslands` from (voxel
 * consolidation is off by default there too). On a lifted model with no
 * supports nothing is supported or grounded, so the panel's filter keeps all.
 */
function islandsFromCombinedScan(scan: CombinedIslandScan, detect: DetectOptions): DetectedIsland[] {
  const voxel: DetectedIsland[] = scan.voxelIslands
    .filter((v) => (v.areaMm2 ?? 0) >= detect.minAreaMm2)
    .map((v) => ({
      id: v.id,
      source: 'voxel',
      contact: new THREE.Vector3(v.contact.x, v.contact.y, v.contact.z),
      baseZ: v.baseZ,
      areaMm2: v.areaMm2,
      layerSpan: v.layerSpan,
      contactVoxels: v.contactVoxels && v.contactVoxels.length >= 2
        ? { xy: new Float32Array(v.contactVoxels), z: null, count: v.contactVoxels.length / 2 }
        : undefined,
    }));
  const minima: DetectedIsland[] = scan.minimaIslands.map((m, i) => ({
    id: `m${i}`,
    source: 'minima',
    contact: new THREE.Vector3(m.position.x, m.position.y, m.position.z),
    baseZ: m.position.z,
    vertexIndex: m.vertexIndex,
    seedTriangleId: m.seedTriangleId,
    persistenceMm: m.persistenceMm,
  }));
  const classified = classifyIntersection(voxel, minima, { xyToleranceMm: 0.5, zBandMm: detect.layerHeightMm });
  return mergeOverhangRegions(classified.islands, (scan.overhangIslands ?? []).map(overhangRegionToIsland));
}

function runCombinedScan(cli: string, positions: Float32Array, detect: DetectOptions): DetectedIsland[] {
  const dir = mkdtempSync(join(tmpdir(), 'df-support-auto-'));
  try {
    const soupPath = join(dir, 'positions.bin');
    const outPath = join(dir, 'islands.json');
    writeFileSync(soupPath, Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
    execFileSync(cli, [
      'island', 'combined', soupPath, '-o', outPath,
      '--layer-height', String(detect.layerHeightMm),
      '--px-mm', String(detect.pxMm),
      '--buffer', String(detect.supportBufferMm),
      '--connectivity', String(detect.connectivity),
      '--k', '2',
      '--overhang-angle', String(OVERHANG_SELF_SUPPORT_ANGLE_DEG),
      '--overhang-px-mm', '0.25',
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    return islandsFromCombinedScan(JSON.parse(readFileSync(outPath, 'utf8')) as CombinedIslandScan, detect);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type SupportAutoResult = {
  supports: DragonfruitImportFormat;
  islands: number;
  islandsCovered: number;
  islandsUncovered: number;
  coveragePct: number;
  placed: Record<string, number>;
};

export async function computeSupportAuto(input: SupportAutoInput): Promise<SupportAutoResult> {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(input.positions, 3));
  geometry.computeVertexNormals();
  accelerateGeometry(geometry);
  const detect = { ...DEFAULT_DETECT_OPTIONS, ...input.detect };
  const islands = input.islandsCli
    ? runCombinedScan(input.islandsCli, input.positions, detect)
    : await detectIslands(geometry, detect);

  resetStore();
  resetKickstandsInState();
  clearHistory();
  const dispose = registerSupportHistoryHandlers();
  initializeBVH();
  const appSettings = createDefaultSettings();
  // The panel stores its settings here, and sizing reads them from here
  // (`activeSizingBand`, model-scale switches), not from the run override.
  appSettings.autoSupport = normalizeAutoSupportSettings({ ...appSettings.autoSupport, ...input.settings });
  setSettings(appSettings);
  const mesh = new THREE.Mesh(geometry);
  mesh.updateMatrixWorld(true);
  setModelMesh(input.modelId, mesh);
  try {
    const plan = runAutoPlaceRequest({
      modelId: input.modelId,
      islands: islands.map(serializeIsland),
      settingsOverride: input.settings ?? {},
      appSettings,
      baseState: getSnapshot(),
      mesh: serializeModelMesh(mesh),
      meshKey: modelMeshKey(mesh),
    });
    if (!plan) throw new Error(`auto supports produced no plan (${islands.length} islands)`);
    const placed: Record<string, number> = {};
    for (const [type, count] of Object.entries(plan.result.placed)) placed[type] = count ?? 0;
    return {
      supports: buildScopedSupportExportDocument(plan.support, [input.modelId], 'dragonfruit-ts-cli'),
      islands: islands.length,
      islandsCovered: plan.analytics.islandsCovered,
      islandsUncovered: plan.analytics.islandsUncovered,
      coveragePct: plan.analytics.areaCoverage * 100,
      placed,
    };
  } finally {
    setModelMesh(input.modelId, null);
    dispose();
    // The yield channel keeps the event loop open: without this the command
    // prints its result and then never exits (as in bench-auto-supports).
    disposeEventLoopChannel();
  }
}
