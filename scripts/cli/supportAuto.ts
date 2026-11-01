/**
 * Auto supports for `support auto`, run with the app's own placement pipeline.
 *
 * Islands come from the voxel detector the Islands panel runs (in-process, see
 * `scripts/bench-island-scan.ts`); placement is `runAutoPlaceRequest`, the path
 * the app's auto-support worker takes. The app also merges islands from two
 * Rust scanners (`scan_mesh_minima`, `scan_overhangs`) that only exist behind
 * Tauri, so a headless run sees voxel islands only and may place fewer
 * supports than the app on the same model.
 *
 * Isolated from the CLI entry point because it pulls in THREE, the support
 * stores and the generated registries; `dragonfruit-ts-cli.ts` loads it only
 * for `support auto`.
 */
import * as THREE from 'three';

import { accelerateGeometry, initializeBVH } from '../../src/utils/bvh';
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
import type { AutoSupportSettings } from '../../src/supports/autoSupport/settings';
import type { DragonfruitImportFormat } from '../../src/supports/types';
import { DEFAULT_DETECT_OPTIONS, detectIslands, type DetectOptions } from '../bench-island-scan';

export type SupportAutoInput = {
  modelId: string;
  /** World-space triangle positions, 9 floats per triangle, already lifted. */
  positions: Float32Array;
  /** Overrides on the default auto-support settings (the app's preset JSON shape). */
  settings?: Partial<AutoSupportSettings>;
  detect?: Partial<DetectOptions>;
};

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
  const islands = await detectIslands(geometry, { ...DEFAULT_DETECT_OPTIONS, ...input.detect });

  resetStore();
  resetKickstandsInState();
  clearHistory();
  const dispose = registerSupportHistoryHandlers();
  initializeBVH();
  const appSettings = createDefaultSettings();
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
