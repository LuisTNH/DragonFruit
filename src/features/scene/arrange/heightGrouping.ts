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
 * packing, so the models it placed fit together without asking again, and
 * the bed keeps every new one placed. A tallest waiting model the packer left
 * out is skipped, as first-fit decreasing would; the others it left out wait
 * for the next call. A packer that fills an overfull bed may drop the bed's
 * own models to make room for others, so a call that drops one is tried
 * again with half as many new models.
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
    /**
     * At most this many new models per call. A packer that takes longer the
     * more it is given would otherwise be handed a whole bed of small parts.
     */
    maxOffer?: number;
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
    /** Tallest first, neither on the bed nor skipped. */
    let waiting = sorted;
    let packs = options.maxPacks ?? Infinity;
    const offerLimit = options.footprintOf && options.bedArea !== undefined
        ? options.bedArea * OFFER_AREA_FACTOR
        : Infinity;
    const footprintOf = options.footprintOf ?? (() => 0);
    let chosenArea = 0;
    /** How many new models a call may offer: halved after a call that dropped the bed's own, doubled after one that kept them. */
    const maxOffer = options.maxOffer ?? Infinity;
    let offerCap = maxOffer;

    while (waiting.length > 0 && packs > 0) {
        // The models so far plus the tallest waiting, up to about a bed's worth.
        const offered = waiting.slice(0, 1);
        let offeredArea = chosenArea + footprintOf(offered[0]);
        for (let i = 1; i < waiting.length && offeredArea < offerLimit && offered.length < offerCap; i += 1) {
            offered.push(waiting[i]);
            offeredArea += footprintOf(waiting[i]);
        }
        packs -= 1;
        const placed = new Set(await options.pack([...chosen, ...offered]));

        // The bed's own models must stay, and an empty bed is the tallest's: a
        // packing without them says nothing about the rest, so ask about fewer.
        const required = chosen.length > 0 ? chosen : offered.slice(0, 1);
        if (!required.every((model) => placed.has(model))) {
            if (offered.length > 1) {
                offerCap = Math.ceil(offered.length / 2);
                continue;
            }
            // The tallest alone does not fit: a model larger than the bed.
            if (chosen.length === 0) return [];
            waiting = waiting.slice(1);
            continue;
        }
        for (const model of offered) {
            if (!placed.has(model)) continue;
            chosen.push(model);
            chosenArea += footprintOf(model);
        }
        offerCap = Math.min(offerCap * 2, maxOffer);
        const skipTallest = !placed.has(waiting[0]);
        waiting = waiting.filter((model, index) => !placed.has(model) && !(skipTallest && index === 0));
    }
    // The calls ran out on packings that dropped the tallest: an empty answer
    // means "larger than the bed", so it is asked about alone before saying so.
    if (chosen.length === 0 && waiting.length > 0) {
        const tallest = waiting[0];
        if ((await options.pack([tallest])).includes(tallest)) chosen.push(tallest);
    }
    return chosen;
}
