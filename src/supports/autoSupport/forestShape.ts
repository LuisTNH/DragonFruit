/**
 * Forest-shape preferences for auto supports: two switches on the
 * `autoSupport` settings block that change which link the placement builds,
 * not how it sizes or routes it.
 *
 * - `allowModelToModel` (default on): a tip whose trunk cannot reach the plate
 *   and that no host can carry as a fan leaf is bridged to a lower surface of
 *   the model (twig/stick). Off refuses that bridge, so the tip stays to the
 *   later fan and merge passes or goes unsupported; it never leaves a second
 *   scar on the model.
 * - `preferTrees` (default off): overhang consolidation only converts overhang,
 *   standalone and reinforcement pillars into fan leaves. On, island trunks —
 *   voxel islands and mesh minima — may fan into a neighbouring host too, so a
 *   cluster of minima under a shoulder becomes a tree on few trunks instead of
 *   a bundle of pillars.
 */

import type { AutoSupportSettings } from './settings';
import { isOriginConvertibleToTree } from '../supportTypeRegistry';

type ForestShapeSettings = Partial<Pick<AutoSupportSettings, 'allowModelToModel' | 'preferTrees'>> | null | undefined;

/** Whether a tip with no plate route may be bridged model-to-model. */
export function allowsModelToModelBridges(settings: ForestShapeSettings): boolean {
    return settings?.allowModelToModel !== false;
}

/** Whether consolidation may turn a bare trunk of this origin into a fan link. */
export function isTreeConvertibleOrigin(origin: string | undefined, settings: ForestShapeSettings): boolean {
    if (isOriginConvertibleToTree(origin)) return true;
    return settings?.preferTrees === true && origin === 'island';
}
