import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseBedByHeight, sortTallestFirst } from '../heightGrouping';

type Part = { id: string; height: number; area: number };

const part = (id: string, height: number, area = 1): Part => ({ id, height, area });
/** A bed of `capacity` area units: a set fits when its areas add up to no more. */
const bed = (capacity: number) => (models: Part[]) => models.reduce((sum, m) => sum + m.area, 0) <= capacity;
const ids = (models: Part[]) => models.map((m) => m.id);
const heightOf = (m: Part) => m.height;

/** Fill beds one after another, as the arrange passes do; returns each bed's ids. */
async function fillBeds(models: Part[], capacity: number): Promise<string[][]> {
    const beds: string[][] = [];
    let pending = [...models];
    while (pending.length > 0) {
        const chosen = await chooseBedByHeight(pending, { heightOf, fits: bed(capacity) });
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
    assert.deepEqual(await chooseBedByHeight([part('huge', 10, 9)], { heightOf, fits: bed(3) }), []);
});

test('fill tries stop at the cap', async () => {
    let calls = 0;
    const counting = (models: Part[]) => { calls += 1; return bed(2)(models); };
    const models = [part('a', 9), part('b', 8), part('c', 7), part('d', 6), part('e', 5)];
    const chosen = await chooseBedByHeight(models, { heightOf, fits: counting, maxFillTries: 1 });
    assert.deepEqual(ids(chosen), ['a', 'b']);
    // first model, whole set, binary search (2), then one fill try
    assert.ok(calls <= 5, `calls ${calls}`);
});
