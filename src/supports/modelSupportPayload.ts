import { migrateLegacySupportPayload } from './importMigrations';
import { payloadRecords } from './PlacementLogic/SupportModelLinker';
import { transformedSupportsForModel, type SupportModelTransform } from './state';
import { IMPORT_PAYLOAD_COLLECTION_ORDER } from './supportCollections';
import type { DragonfruitImportFormat } from './types';

type Records = Record<string, Record<string, unknown>>;

/**
 * The file's arrays with `next` written back over them, in the file's order. A
 * record the rule added goes last. An id that only ever lived inside a kickstand
 * wrapper goes back there, not into the shared array.
 */
function payloadFromRecords(payload: DragonfruitImportFormat, before: Records, next: Records): DragonfruitImportFormat {
    const result = { ...payload } as unknown as Record<string, unknown>;

    for (const key of IMPORT_PAYLOAD_COLLECTION_ORDER) {
        if (key === 'kickstands' || next[key] === before[key]) continue;
        const list = (result[key] ?? []) as ({ id: string } | null)[];
        const listed = new Set(list.flatMap((entity) => (entity ? [entity.id] : [])));

        // Records are read by id, last one wins, so only that entry of a repeated id changes.
        const lastIndexById = new Map(list.flatMap((entity, index) => (entity ? [[entity.id, index] as const] : [])));
        const kept = list.flatMap((entity, index) => {
            if (!entity) return [entity];
            if (!Object.hasOwn(next[key], entity.id)) return [];
            return [lastIndexById.get(entity.id) === index ? next[key][entity.id] as { id: string } : entity];
        });
        const added = Object.values(next[key]).filter((entity) => {
            const { id } = entity as { id: string };
            return !listed.has(id) && !Object.hasOwn(before[key], id);
        });
        if (result[key] !== undefined || added.length > 0) result[key] = [...kept, ...added];
    }

    if (payload.kickstands) {
        result.kickstands = payload.kickstands.flatMap((build) => {
            if (!build?.kickstand) return [build];
            const kickstand = next.kickstands[build.kickstand.id];
            if (!kickstand) return [];
            return [{
                ...build,
                kickstand,
                ...(build.root ? { root: next.roots[build.root.id] ?? build.root } : {}),
                ...(build.hostKnot ? { hostKnot: next.knots[build.hostKnot.id] ?? build.hostKnot } : {}),
            }];
        });
    }

    return result as unknown as DragonfruitImportFormat;
}

/**
 * `transformSupportsForModel` for a support payload: the same rule over the
 * file's arrays, for callers with no store. Returns the input when nothing moved.
 */
export function withModelSupportsTransformed({ payload, modelId, beforeTransform, afterTransform, movedRecords }: {
    payload: DragonfruitImportFormat;
    modelId: string;
    beforeTransform: SupportModelTransform;
    afterTransform: SupportModelTransform;
    /** One set across the models of a link group; see `transformedSupportsForModel`. */
    movedRecords?: Set<string>;
}): { payload: DragonfruitImportFormat; changed: boolean } {
    const current = migrateLegacySupportPayload(payload);
    const collections = payloadRecords(current);
    const { collections: next, supportsChanged, kickstandsChanged } = transformedSupportsForModel({
        collections,
        modelId,
        beforeTransform,
        afterTransform,
        movedRecords,
    });
    if (!supportsChanged && !kickstandsChanged) return { payload, changed: false };

    return {
        payload: payloadFromRecords(current, collections as unknown as Records, next as unknown as Records),
        changed: true,
    };
}
