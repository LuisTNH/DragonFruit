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
 * still waiting, as many as fit; then each shorter model, tallest first, that
 * still fits in the space they leave. A model shorter than the bed's tallest
 * adds no time to it, and it is one model fewer for the beds after, whose
 * height is set by what is left. The packer decides what "fits": `fits` packs
 * a set into the bed and says whether nothing spilled.
 */

export interface HeightGroupingOptions<T> {
    /** Height that sets the model's print time (mm, supports included). */
    heightOf: (model: T) => number;
    /** Whether the whole set packs into the bed with nothing spilled. */
    fits: (models: T[]) => boolean | Promise<boolean>;
    /**
     * At most this many single tries to fill the bed's leftover space after
     * the tallest models are on it. The standard packer is cheap enough for
     * every model; the high-precision one is not.
     */
    maxFillTries?: number;
}

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
    if (sorted.length === 0 || !(await options.fits(sorted.slice(0, 1)))) return [];

    // The longest run of the tallest models that fits together. Packing is
    // close enough to monotonic in the set for a binary search: more models
    // never take less room.
    if (await options.fits(sorted)) return sorted;
    let fitting = 1;
    let failing = sorted.length;
    while (failing - fitting > 1) {
        const middle = Math.floor((fitting + failing) / 2);
        if (await options.fits(sorted.slice(0, middle))) fitting = middle;
        else failing = middle;
    }

    // Fill what is left with shorter models, tallest first.
    const chosen = sorted.slice(0, fitting);
    let tries = options.maxFillTries ?? Infinity;
    for (const model of sorted.slice(fitting + 1)) {
        if (tries <= 0) break;
        tries -= 1;
        const candidate = [...chosen, model];
        if (await options.fits(candidate)) chosen.push(model);
    }
    return chosen;
}
