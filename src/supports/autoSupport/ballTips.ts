/**
 * Ball tips (a run whose tip type is `sphere`): turn every placed contact into a
 * `sphere` contact whose break-off ball is `ballDiameterMm` across.
 *
 * The cone keeps its contact diameter where it leaves the ball, so the neck is
 * the weakest point and the support breaks there; the ball stays on the model
 * as a small bump that sands off, rather than a pit (Lychee calls the idea a
 * "break point"). Geometry comes from `getContactBall`, which slicing, export
 * and both renderers share. Runs once every contact has its final size (after
 * the forest resize and the cone sync).
 *
 * A ball is never narrower than the contact it ends: the neck has to be the
 * thinnest point, so a contact wider than the ball gets a ball its own width.
 */

import type { SupportState } from '../types';
import { draftAddEntity } from './supportDraft';
import { sphereTipProfile } from '../SupportPrimitives/ContactCone/contactConeUtils';
import type { SupportTipProfile } from '../SupportPrimitives/ContactCone/types';

/** The member types whose contact cone touches the model. */
const BALL_TIP_TYPES = [
    { typeId: 'trunk', key: 'trunks' },
    { typeId: 'branch', key: 'branches' },
    { typeId: 'leaf', key: 'leaves' },
] as const;

export function applyBallTips(draft: SupportState, ballDiameterMm: number): { draft: SupportState; converted: number } {
    let next = draft;
    let converted = 0;
    for (const { typeId, key } of BALL_TIP_TYPES) {
        for (const entity of Object.values(draft[key] ?? {}) as Array<{ id: string; contactCone?: { profile: { contactDiameterMm: number } } }>) {
            const cone = entity.contactCone;
            if (!cone || !(cone.profile.contactDiameterMm > 0)) continue;
            const balled: { id: string; contactCone: object } = {
                ...entity,
                contactCone: { ...cone, profile: sphereTipProfile(cone.profile as SupportTipProfile, ballDiameterMm) },
            };
            next = draftAddEntity(next, typeId, balled);
            converted++;
        }
    }
    return { draft: next, converted };
}
