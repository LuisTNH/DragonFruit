import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { MaterialProfile } from '@/features/profiles/profileStore';

type Translate = (descriptor: MessageDescriptor) => string;

export const OPEN_EXPOSURE_SERIES_DIALOG_EVENT = 'dragonfruit:open-exposure-series-dialog';

export const EXPOSURE_SERIES_MIN_SEC = 0.1;
export const EXPOSURE_SERIES_MAX_SEC = 120;
export const EXPOSURE_SERIES_MIN_STEPS = 2;
export const EXPOSURE_SERIES_MAX_STEPS = 12;

/** What the user asks for: the first exposure, the step between two, and how many files. */
export type ExposureSeriesRequest = {
  startSec: number;
  stepSec: number;
  count: number;
};

/**
 * Set when the dialog is asked for. The slicing panel that shows it lives in the export
 * workspace only, so a request from another workspace waits here until the panel mounts.
 */
let exposureSeriesDialogPending = false;

export function openExposureSeriesDialog(): void {
  exposureSeriesDialogPending = true;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_EXPOSURE_SERIES_DIALOG_EVENT));
}

/** Whether the dialog was asked for and not shown yet; asking clears it. */
export function takePendingExposureSeriesDialog(): boolean {
  const pending = exposureSeriesDialogPending;
  exposureSeriesDialogPending = false;
  return pending;
}

export function exposureSeriesNeedsModelTitle(translate: Translate): string {
  return translate(msg`Nothing to slice`);
}

export function exposureSeriesNeedsModelMessage(translate: Translate): string {
  return translate(msg`Load a model first; the exposure series slices the active plate.`);
}

/** Hundredths of a second, which is finer than any printer takes and keeps 0.1 + 0.2 at 0.3. */
function roundExposureSec(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The normal exposures of a series, one per file, or an empty list when the request
 * cannot be printed: too few or too many files, a step that is not positive, or an
 * exposure outside what a printer takes.
 */
export function buildExposureSeries(request: ExposureSeriesRequest): number[] {
  const { startSec, stepSec, count } = request;
  if (!Number.isFinite(startSec) || !Number.isFinite(stepSec) || !Number.isInteger(count)) return [];
  if (count < EXPOSURE_SERIES_MIN_STEPS || count > EXPOSURE_SERIES_MAX_STEPS) return [];
  if (stepSec <= 0) return [];
  const exposures = Array.from({ length: count }, (_, index) => roundExposureSec(startSec + index * stepSec));
  const inRange = exposures.every((sec) => sec >= EXPOSURE_SERIES_MIN_SEC && sec <= EXPOSURE_SERIES_MAX_SEC);
  return inRange ? exposures : [];
}

/**
 * The file name of one step: the plate's name and the exposure in milliseconds. Whole
 * milliseconds keep the name free of a decimal point, which some printer firmwares
 * read as the start of the extension.
 */
export function exposureSeriesBaseName(baseName: string, exposureSec: number): string {
  return `${baseName}_exp${Math.round(exposureSec * 1000)}ms`;
}

/**
 * The material with another normal exposure. A format with its own material settings
 * (CTB, Goo, Lumen) writes the exposure from those and not from the profile's own
 * field, so the exposure is set there too, for the printer's output format and every
 * format the profile already holds settings for.
 */
export function withNormalExposure(
  material: MaterialProfile,
  exposureSec: number,
  outputFormat: string | undefined,
): MaterialProfile {
  const localSettingsByOutput = { ...(material.localSettingsByOutput ?? {}) };
  const formatKeys = new Set(Object.keys(localSettingsByOutput));
  const trimmedFormat = outputFormat?.trim();
  if (trimmedFormat) formatKeys.add(trimmedFormat);
  formatKeys.forEach((key) => {
    localSettingsByOutput[key] = { ...(localSettingsByOutput[key] ?? {}), normalExposureSec: exposureSec };
  });
  return {
    ...material,
    normalExposureSec: exposureSec,
    localSettingsByOutput,
  };
}
