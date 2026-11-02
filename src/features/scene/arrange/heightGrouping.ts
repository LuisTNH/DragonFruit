/**
 * Group by height: which models one bed of a multi-plate arrange should take.
 *
 * A resin plate prints for as long as its tallest model needs: every layer is
 * exposed at once, so ten short bases next to one tall mini cost the mini's
 * time. Spread over several beds, the shortest total time puts the tallest
 * models together and the short ones together, instead of packing by
 * footprint and leaving one tall part on every bed.
 *
 * The rule is first-fit decreasing by height. A bed takes the tallest models
 * still waiting, as many as fit; then shorter models, tallest first, in the
 * space they leave. A model shorter than the bed's tallest adds no time to
 * it, and it is one model fewer for the beds after, whose height is set by
 * what is left. The packer decides what fits.
 *
 * Packing is the expensive part, so each call is made to count. The packer is
 * offered the bed's models so far plus the next tallest waiting, and what it
 * places answers for all of them at once: any subset of a packing is itself a
 * packing, so the models it placed fit together without asking again. The
 * bed keeps the run of new models it placed in height order. A packer that
 * fills an overfull bed may drop the tall models to make room for others, so
 * a call that adds nothing is tried again with half as many new models, down
 * to the next one alone; only that one is then skipped.
 */

export interface HeightGroupingOptions<T> {
    /** Height that sets the model's print time (mm, supports included). */
    heightOf: (model: T) => number;
    /** Packs the set into the bed; returns the models it found a place for. */
    pack: (models: T[]) => T[] | Promise<T[]>;
    /**
     * Footprint of a model and the bed's area, in the same unit. When given,
     * each call offers only about as many new models as could cover the bed,
     * so the packer is not handed the whole queue every time.
     */
    footprintOf?: (model: T) => number;
    bedArea?: number;
    /** At most this many packer calls per bed (the cheap shelf packer needs no cap). */
    maxPacks?: number;
}

/** Offered footprint as a share of the bed: a bounding box overstates a part's real outline. */
const OFFER_AREA_FACTOR = 1.5;

/** Tallest first; ties keep their order, so a run is repeatable. */
export function sortTallestFirst<T>(models: readonly T[], heightOf: (model: T) => number): T[] {
    return models
        .map((model, index) => ({ model, index, height: heightOf(model) }))
        .sort((a, b) => b.height - a.height || a.index - b.index)
        .map((entry) => entry.model);
}

/**
 * The models one bed takes, tallest first. Empty when not even the tallest
 * fits (a model larger than the bed): the caller sets it aside as it does
 * today.
 */
export async function chooseBedByHeight<T>(models: readonly T[], options: HeightGroupingOptions<T>): Promise<T[]> {
    const sorted = sortTallestFirst(models, options.heightOf);
    const chosen: T[] = [];
    let next = 0;
    let packs = options.maxPacks ?? Infinity;
    const offerLimit = options.footprintOf && options.bedArea !== undefined
        ? options.bedArea * OFFER_AREA_FACTOR
        : Infinity;
    const footprintOf = options.footprintOf ?? (() => 0);
    let chosenArea = 0;
    /** How many new models a call may offer; halved after a call that added none. */
    let offerCap = Infinity;

    while (next < sorted.length && packs > 0) {
        // The models so far plus the next tallest, up to about a bed's worth.
        const offered = sorted.slice(next, next + 1);
        let offeredArea = chosenArea + footprintOf(offered[0]);
        for (let i = next + 1; i < sorted.length && offeredArea < offerLimit && offered.length < offerCap; i += 1) {
            offered.push(sorted[i]);
            offeredArea += footprintOf(sorted[i]);
        }
        packs -= 1;
        const placed = new Set(await options.pack([...chosen, ...offered]));

        // A packing that drops one of the bed's models answers nothing about the new ones.
        let taken = 0;
        if (chosen.every((model) => placed.has(model))) {
            while (taken < offered.length && placed.has(offered[taken])) taken += 1;
        }
        if (taken > 0) {
            for (const model of offered.slice(0, taken)) {
                chosen.push(model);
                chosenArea += footprintOf(model);
            }
            next += taken;
        } else if (offered.length > 1) {
            offerCap = Math.ceil(offered.length / 2);
        } else {
            // Not even the next one alone: the tallest is larger than the bed, any
            // later one does not fit beside what the bed has.
            if (chosen.length === 0 && next === 0) return [];
            next += 1;
        }
    }
    return chosen;
}
