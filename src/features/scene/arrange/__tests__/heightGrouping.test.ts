import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseBedByHeight, sortTallestFirst } from '../heightGrouping';

type Part = { id: string; height: number; area: number };

const part = (id: string, height: number, area = 1): Part => ({ id, height, area });
/** A bed of `capacity` area units, packed in the order given: what still fits is placed. */
const bed = (capacity: number) => (models: Part[]) => {
    let used = 0;
    return models.filter((m) => {
        if (used + m.area > capacity) return false;
        used += m.area;
        return true;
    });
};
const ids = (models: Part[]) => models.map((m) => m.id);
const heightOf = (m: Part) => m.height;

/** Fill beds one after another, as the arrange passes do; returns each bed's ids. */
async function fillBeds(models: Part[], capacity: number): Promise<string[][]> {
    const beds: string[][] = [];
    let pending = [...models];
    while (pending.length > 0) {
        const chosen = await chooseBedByHeight(pending, { heightOf, pack: bed(capacity) });
        if (chosen.length === 0) break;
        beds.push(ids(chosen));
        pending = pending.filter((m) => !chosen.includes(m));
    }
    return beds;
}

test('tallest first, ties keep their order', () => {
    const sorted = sortTallestFirst([part('a', 10), part('b', 30), part('c', 10), part('d', 20)], heightOf);
    assert.deepEqual(ids(sorted), ['b', 'd', 'a', 'c']);
});

test('tall and short models end on separate beds', async () => {
    // Interleaved as they might sit in a scene: three minis, three bases.
    const models = [part('mini1', 50), part('base1', 6), part('mini2', 48), part('base2', 6), part('mini3', 52), part('base3', 5)];
    const beds = await fillBeds(models, 3);
    assert.deepEqual(beds, [['mini3', 'mini1', 'mini2'], ['base1', 'base2', 'base3']]);
    // Print time follows each bed's tallest model: 52 + 6 instead of about 52 + 50.
});

test('a bed the tallest leave room on takes the next shorter that fits', async () => {
    // Capacity 4: the two big tall ones take 3, the next tallest (area 2) does
    // not fit, a shorter one of area 1 does.
    const models = [part('tall-a', 40, 2), part('tall-b', 39, 1), part('mid', 30, 2), part('low', 10, 1), part('lowest', 5, 1)];
    const beds = await fillBeds(models, 4);
    assert.deepEqual(beds, [['tall-a', 'tall-b', 'low'], ['mid', 'lowest']]);
});

test('a model larger than the bed is left for the caller', async () => {
    assert.deepEqual(await chooseBedByHeight([part('huge', 10, 9)], { heightOf, pack: bed(3) }), []);
});

test('each packer call is offered about a bed of models, and calls stop at the cap', async () => {
    const offeredSizes: number[] = [];
    const counting = (models: Part[]) => { offeredSizes.push(models.length); return bed(3)(models); };
    const models = Array.from({ length: 40 }, (_, i) => part(`m${i}`, 100 - i));
    const chosen = await chooseBedByHeight(models, {
        heightOf,
        pack: counting,
        footprintOf: (m) => m.area,
        bedArea: 3,
        maxPacks: 2,
    });
    assert.deepEqual(ids(chosen), ['m0', 'm1', 'm2']);
    assert.ok(offeredSizes.length <= 2, `calls ${offeredSizes.length}`);
    assert.ok(Math.max(...offeredSizes) <= 5, `offered ${offeredSizes}`);
});

test('a packing that drops a bed model does not add the new ones', async () => {
    // A packer that, given the tall one with anything else, only keeps the others.
    const picky = (models: Part[]) => (models.length > 1 ? models.filter((m) => m.id !== 'tall') : models);
    const chosen = await chooseBedByHeight([part('tall', 50), part('a', 10), part('b', 9)], { heightOf, pack: picky });
    assert.deepEqual(ids(chosen), ['tall']);
});
