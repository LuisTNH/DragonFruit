/**
 * Built-in calibration models: well-known resin test prints the app menu drops onto
 * the plate. The STL files are served from `public/calibration-models/`; this module
 * only knows their names and where they came from.
 *
 * Messages live at module level for the same React Compiler reason as
 * `sceneImportMessages.ts`.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

type Translate = (descriptor: MessageDescriptor) => string;

export const CALIBRATION_MODELS_BASE_PATH = '/calibration-models';

export type CalibrationModel = {
  id: string;
  /** Product name of the test print. A brand, so it stays untranslated. */
  name: string;
  maker: string;
  /** File name under `CALIBRATION_MODELS_BASE_PATH`, also the scene model's name. */
  file: string;
  /** Where the original and its guide live. */
  sourceUrl: string;
};

// i18n-ignore-start: product and maker names
export const CALIBRATION_MODELS: readonly CalibrationModel[] = [
  {
    id: 'cones-of-calibration',
    name: 'Cones of Calibration',
    maker: 'TableFlip Foundry',
    file: 'cones-of-calibration.stl',
    sourceUrl: 'https://www.tableflipfoundry.com/',
  },
  {
    id: 'ameralabs-town',
    name: 'AmeraLabs Town',
    maker: 'AmeraLabs',
    file: 'ameralabs-town.stl',
    sourceUrl: 'https://www.printables.com/model/237684-ameralabs-town-calibration-for-sla-3d-printers',
  },
  {
    id: 'xp2-validation-matrix',
    name: 'Resin XP2 Validation Matrix',
    maker: 'Photonsters',
    file: 'xp2-validation-matrix.stl',
    sourceUrl: 'https://pixup3d.com/posts/428',
  },
  {
    id: 'phrozen-xp-finder',
    name: 'Phrozen XP Finder',
    maker: 'Phrozen',
    file: 'phrozen-xp-finder.stl',
    sourceUrl: 'https://pixup3d.com/en/posts/427',
  },
  {
    id: 'siraya-tech-test-model',
    name: 'Siraya Tech Test Model V5',
    maker: 'Siraya Tech',
    file: 'siraya-tech-test-model-v5.stl',
    sourceUrl: 'https://siraya.tech/pages/siraya-tech-test-model',
  },
];
// i18n-ignore-end

export function findCalibrationModel(id: string): CalibrationModel | undefined {
  return CALIBRATION_MODELS.find((model) => model.id === id);
}

export function calibrationModelUrl(model: CalibrationModel): string {
  return `${CALIBRATION_MODELS_BASE_PATH}/${model.file}`;
}

/** Fetches the bundled STL as a `File`, ready for the normal mesh import. */
export async function fetchCalibrationModelFile(
  model: CalibrationModel,
  fetchImpl: typeof fetch = fetch,
): Promise<File> {
  const res = await fetchImpl(calibrationModelUrl(model));
  if (!res.ok) {
    throw new Error(`${model.file}: HTTP ${res.status}`);
  }
  const blob = await res.blob();
  // A server that falls back to its start page answers a missing file with 200 and HTML.
  const start = await blob.slice(0, 64).text();
  if (blob.size === 0 || res.headers.get('content-type')?.includes('text/html') || /^\s*<(!doctype|html)/i.test(start)) {
    throw new Error(`${model.file}: not an STL file`);
  }
  return new File([blob], model.file, { type: 'model/stl' });
}

export function calibrationModelUnavailableTitle(translate: Translate): string {
  return translate(msg`Calibration model not available`);
}

export function calibrationModelUnavailableMessage(name: string, translate: Translate): string {
  return translate(msg`${name} could not be loaded. Its file may be missing from this build.`);
}
