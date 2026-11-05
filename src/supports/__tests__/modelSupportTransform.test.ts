import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';

import { linkedPeerTransform } from '@/features/scene/linkedPeerTransform';
import { DEFAULT_TIP_PROFILE } from '../SupportPrimitives/ContactCone/types';
import { withModelSupportsTransformed } from '../modelSupportPayload';
import { payloadRecords } from '../PlacementLogic/SupportModelLinker';
import { getSnapshot, resetStore, setSnapshot, transformedSupportsForModel, transformSupportsForModel, type SupportModelTransform } from '../state';
import { IMPORT_PAYLOAD_COLLECTION_ORDER } from '../supportCollections';
import { SUPPORT_TYPES } from '../supportTypeRegistry';
import type { DragonfruitImportFormat, SupportState } from '../types';

/**
 * A model's supports move with it, in the store and in a saved file, through one
 * rule (ADR-0045). The fixture holds one support of every type with real
 * positions, and the random scenes hold the file's path to the store's.
 */

type Vec = { x: number; y: number; z: number };
const v = (x: number, y: number, z: number): Vec => ({ x, y, z });
const up = v(0, 0, 1);

const placed = (position: Vec, rotation: Vec = v(0, 0, 0), scale: Vec = v(1, 1, 1)): SupportModelTransform => ({
    position: new THREE.Vector3(position.x, position.y, position.z),
    rotation: new THREE.Euler(rotation.x, rotation.y, rotation.z, 'ZYX'),
    scale: new THREE.Vector3(scale.x, scale.y, scale.z),
});
const AT_ORIGIN = placed(v(0, 0, 0));

const joint = (id: string, pos: Vec) => ({ id, pos, diameter: 1 });
const segment = (id: string, x: number, y: number, bottom = 10, top = 20) => ({
    id,
    type: 'straight',
    diameter: 1,
    bottomJoint: joint(`${id}-bj`, v(x, y, bottom)),
    topJoint: joint(`${id}-tj`, v(x, y, top)),
});
const cone = (id: string, pos: Vec) => ({ id, pos, normal: up, surfaceNormal: up, profile: { ...DEFAULT_TIP_PROFILE, lengthMm: 2 } });
const disk = (id: string, pos: Vec) => ({ id, pos, surfaceNormal: up, coneAxis: up });
const knot = (id: string, parentShaftId: string, pos: Vec) => ({ id, parentShaftId, pos, diameter: 1 });
const root = (id: string, modelId: string, x: number, y: number) => ({
    id,
    modelId,
    transform: { pos: v(x, y, 0), rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: 2,
    diskHeight: 0.3,
    coneHeight: 1,
});

/** One support of every type on `model`, around (x, y). */
function supportsOf(model: string, x = 0, y = 0) {
    const trunkSegment = `${model}-seg`;
    const kickRoot = root(`${model}-kick-root`, model, x + 3, y);
    const kickKnot = knot(`${model}-kick-knot`, trunkSegment, v(x, y, 16));
    return {
        roots: [root(`${model}-root`, model, x, y), kickRoot],
        trunks: [{ id: `${model}-trunk`, modelId: model, rootId: `${model}-root`, segments: [segment(trunkSegment, x, y, 1, 30)], contactCone: cone(`${model}-tc`, v(x, y, 31)) }],
        branches: [{ id: `${model}-branch`, modelId: model, parentKnotId: `${model}-bk`, segments: [segment(`${model}-bseg`, x + 1, y)], contactCone: cone(`${model}-bc`, v(x + 1, y, 21)) }],
        leaves: [{ id: `${model}-leaf`, modelId: model, parentKnotId: `${model}-lk`, segments: [], contactCone: cone(`${model}-lc`, v(x + 2, y, 21)) }],
        twigs: [{ id: `${model}-twig`, modelId: model, segments: [segment(`${model}-tw`, x + 4, y)], contactDiskA: disk(`${model}-da`, v(x + 4, y, 9)), contactDiskB: disk(`${model}-db`, v(x + 4, y, 21)) }],
        sticks: [{ id: `${model}-stick`, modelId: model, segments: [segment(`${model}-st`, x + 5, y)], contactConeA: cone(`${model}-ca`, v(x + 5, y, 9)), contactConeB: cone(`${model}-cb`, v(x + 5, y, 21)) }],
        braces: [{
            id: `${model}-brace`, modelId: model, startKnotId: `${model}-bs`, endKnotId: `${model}-be`, segments: [],
            curve: { controlPoint1: v(x, y, 12), controlPoint2: v(x, y, 14), startTangent: up, endTangent: up },
        }],
        stumps: [{
            id: `${model}-stump`, modelId: model, rootPos: v(x + 6, y, 0), rootHeight: 0.3, segments: [],
            joint: joint(`${model}-sj`, v(x + 6, y, 0.4)), contactCone: cone(`${model}-sc`, v(x + 6, y, 3)),
        }],
        knots: [
            knot(`${model}-bk`, trunkSegment, v(x, y, 12)),
            knot(`${model}-lk`, trunkSegment, v(x, y, 13)),
            knot(`${model}-bs`, trunkSegment, v(x, y, 14)),
            knot(`${model}-be`, trunkSegment, v(x, y, 15)),
            kickKnot,
        ],
        kickstands: [{
            root: kickRoot,
            hostKnot: kickKnot,
            kickstand: {
                id: `${model}-kick`, modelId: model, rootId: kickRoot.id, hostKnotId: kickKnot.id,
                hostSegmentId: trunkSegment, segments: [segment(`${model}-ks`, x + 3, y)],
            },
        }],
    };
}

function payloadOf(...parts: ReturnType<typeof supportsOf>[]): DragonfruitImportFormat {
    const payload: Record<string, unknown> = { version: 1, meta: { source: 'test', objectCenter: v(0, 0, 0) } };
    for (const key of IMPORT_PAYLOAD_COLLECTION_ORDER) {
        payload[key] = parts.flatMap((part) => part[key as keyof typeof part] as unknown[]);
    }
    return payload as unknown as DragonfruitImportFormat;
}

/** The same move through the store, as the id-keyed records it ends with. */
function throughStore(
    payload: DragonfruitImportFormat,
    modelId: string,
    before: SupportModelTransform,
    after: SupportModelTransform,
): Record<string, Record<string, unknown>> {
    resetStore();
    setSnapshot({ ...getSnapshot(), ...payloadRecords(payload) } as SupportState);
    transformSupportsForModel(modelId, before, after);
    const state = getSnapshot() as unknown as Record<string, Record<string, unknown>>;
    return Object.fromEntries(IMPORT_PAYLOAD_COLLECTION_ORDER.map((key) => [key, { ...state[key] }]));
}

const asRecords = (payload: DragonfruitImportFormat) => {
    const records = payloadRecords(payload) as unknown as Record<string, Record<string, unknown>>;
    return Object.fromEntries(IMPORT_PAYLOAD_COLLECTION_ORDER.map((key) => [key, { ...records[key] }]));
};

/** Compares plain data, with tiny float noise and the store's own stamp left out. */
const rounded = (value: unknown) => JSON.parse(JSON.stringify(value, (key, entry) => (key === 'typeId' ? undefined : (
    typeof entry === 'number' ? Math.round(entry * 1e6) / 1e6 + 0 : entry)
)));

const move = (payload: DragonfruitImportFormat, modelId: string, after: SupportModelTransform, before = AT_ORIGIN) =>
    withModelSupportsTransformed({ payload, modelId, beforeTransform: before, afterTransform: after });

/** Every position in a record, for the geometry checks. */
function pointsIn(value: unknown, out: Vec[] = []): Vec[] {
    if (!value || typeof value !== 'object') return out;
    for (const [key, entry] of Object.entries(value)) {
        if (key === 'pos' || key === 'rootPos' || key === 'controlPoint1' || key === 'controlPoint2') out.push(entry as Vec);
        else pointsIn(entry, out);
    }
    return out;
}

const allNumbersFinite = (value: unknown): boolean => {
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(allNumbersFinite);
    return value && typeof value === 'object' ? Object.values(value).every(allNumbersFinite) : true;
};

describe('a model\'s supports moving with it', () => {
    it('has a fixture entity for every support type', () => {
        const fixture = supportsOf('m');
        for (const descriptor of SUPPORT_TYPES) {
            assert.ok(fixture[descriptor.location.key as keyof typeof fixture]?.length, `add a ${descriptor.id}`);
        }
    });

    it('carries every type along an XY move, on the file\'s arrays', () => {
        const input = payloadOf(supportsOf('a'));
        const { payload, changed } = move(input, 'a', placed(v(10, -4, 0)));

        assert.ok(changed);
        for (const key of IMPORT_PAYLOAD_COLLECTION_ORDER) {
            const before = pointsIn(input[key as keyof DragonfruitImportFormat]);
            const after = pointsIn(payload[key as keyof DragonfruitImportFormat]);
            assert.equal(after.length, before.length, key);
            after.forEach((point, index) => {
                assert.deepEqual(rounded(point), rounded(v(before[index].x + 10, before[index].y - 4, before[index].z)), key);
            });
        }
    });

    it('leaves another model alone, by reference', () => {
        const input = payloadOf(supportsOf('a'), supportsOf('b', 50));
        const { payload } = move(input, 'a', placed(v(10, 0, 0)));

        for (const key of IMPORT_PAYLOAD_COLLECTION_ORDER) {
            const before = input[key as keyof DragonfruitImportFormat] as { id?: string; kickstand?: { id: string } }[];
            const after = payload[key as keyof DragonfruitImportFormat] as typeof before;
            before.forEach((entity, index) => {
                if ((entity.kickstand?.id ?? entity.id ?? '').startsWith('b-')) assert.deepEqual(after[index], entity, key);
            });
        }
    });

    it('keeps roots on the plate when a model is lifted', () => {
        const { payload } = move(payloadOf(supportsOf('a')), 'a', placed(v(0, 0, 7)));

        for (const entry of payload.roots) assert.equal(entry.transform.pos.z, 0);
        assert.equal(payload.trunks[0].segments[0].topJoint?.pos.z, 37);
    });

    it('moves a kickstand\'s wrapper with what it wraps, once', () => {
        const { payload } = move(payloadOf(supportsOf('a')), 'a', placed(v(10, 0, 0)));
        const [build] = payload.kickstands ?? [];

        assert.equal(build.root.transform.pos.x, 13);
        assert.equal(build.hostKnot.pos.x, 10);
        assert.equal(build.kickstand.segments[0].topJoint?.pos.x, 13, 'a second pass would give 23');
        assert.deepEqual(rounded(build.root), rounded(payload.roots.find((entry) => entry.id === build.root.id)));
        assert.deepEqual(rounded(build.hostKnot), rounded(payload.knots.find((entry) => entry.id === build.hostKnot.id)));
    });

    it('moves a kickstand whose root and knot live only in its wrapper, as the CLI writes it', () => {
        const a = supportsOf('a');
        a.roots = a.roots.filter((entry) => entry.id !== 'a-kick-root');
        a.knots = a.knots.filter((entry) => entry.id !== 'a-kick-knot');

        const { payload } = move(payloadOf(a), 'a', placed(v(10, 0, 0)));

        assert.equal(payload.kickstands?.[0].root.transform.pos.x, 13);
        assert.ok(!payload.roots.some((entry) => entry.id === 'a-kick-root'), 'stays out of the shared array');
        assert.ok(!payload.knots.some((entry) => entry.id === 'a-kick-knot'));
    });

    it('takes along a support of another model hanging off the moved one', () => {
        const a = supportsOf('a');
        const b = supportsOf('b', 50);
        b.branches[0].parentKnotId = 'a-bk';

        const { payload } = move(payloadOf(a, b), 'a', placed(v(10, 0, 0)));

        const branch = payload.branches.find((entry) => entry.id === 'b-branch');
        assert.equal(branch?.segments[0].topJoint?.pos.x, 61);
    });

    it('turns normals with a rotation, and keeps them unit length', () => {
        const { payload } = move(payloadOf(supportsOf('a')), 'a', placed(v(0, 0, 0), v(Math.PI / 2, 0, 0)));
        const normal = (payload.sticks?.[0] as unknown as { contactConeA: { normal: Vec } }).contactConeA.normal;

        assert.ok(Math.abs(Math.hypot(normal.x, normal.y, normal.z) - 1) < 1e-9);
        assert.ok(Math.abs(normal.z) < 1e-9, 'an up normal lies flat after 90 degrees about X');
    });

    it('scales positions with the model', () => {
        const { payload } = move(payloadOf(supportsOf('a')), 'a', placed(v(0, 0, 0), v(0, 0, 0), v(2, 2, 2)));

        assert.equal(payload.trunks[0].segments[0].topJoint?.pos.z, 60);
    });

    it('does nothing for the same transform, and hands back the same object', () => {
        const input = payloadOf(supportsOf('a'));

        assert.deepEqual(move(input, 'a', AT_ORIGIN), { payload: input, changed: false });
    });

    it('does nothing for a model with no supports', () => {
        const input = payloadOf(supportsOf('a'));

        assert.equal(move(input, 'ghost', placed(v(10, 0, 0))).payload.trunks[0].segments[0].topJoint?.pos.x, 0);
    });

    it('does not change its input', () => {
        const input = payloadOf(supportsOf('a'));
        const copy = structuredClone(input);

        move(input, 'a', placed(v(10, 2, 3), v(0.3, 0.2, 0.1)));

        assert.deepEqual(input, copy);
    });

    it('comes back when the move is undone', () => {
        const input = payloadOf(supportsOf('a'));
        const there = placed(v(12, -7, 0), v(0, 0, 1.1));

        const moved = move(input, 'a', there).payload;
        const back = move(moved, 'a', AT_ORIGIN, there).payload;

        assert.deepEqual(rounded(back), rounded(input));
    });

    it('is the same as two moves in a row', () => {
        const input = payloadOf(supportsOf('a'));
        const first = placed(v(5, 0, 0));
        const second = placed(v(5, 9, 0));

        const direct = move(input, 'a', second).payload;
        const stepped = move(move(input, 'a', first).payload, 'a', second, first).payload;

        assert.deepEqual(rounded(direct), rounded(stepped));
    });

    it('moves from where the model stands, not from the origin', () => {
        const here = placed(v(100, 100, 0));
        const { payload } = move(payloadOf(supportsOf('a', 100, 100)), 'a', placed(v(100, 100, 0), v(0, 0, Math.PI)), here);

        const tip = payload.trunks[0].segments[0].topJoint?.pos;
        assert.deepEqual(rounded({ x: tip?.x, y: tip?.y }), { x: 100, y: 100 });
    });

    it('writes a stump a lift turned into a trunk back to the file, with its new root', () => {
        const input = payloadOf(supportsOf('a'));

        const { payload } = move(input, 'a', placed(v(0, 0, 25)));

        assert.deepEqual(payload.stumps, []);
        assert.equal(payload.trunks.length, 2);
        const made = payload.trunks.find((trunk) => trunk.id !== 'a-trunk');
        assert.ok(payload.roots.some((entry) => entry.id === made?.rootId), 'the new trunk stands on a root in the file');
    });

    it('keeps the order of the file', () => {
        const input = payloadOf(supportsOf('c', 90), supportsOf('a'), supportsOf('b', 50));
        const { payload } = move(input, 'a', placed(v(10, 0, 0)));

        for (const key of IMPORT_PAYLOAD_COLLECTION_ORDER) {
            if (key === 'kickstands') continue;
            const ids = (list: unknown) => (list as { id: string }[]).map((entry) => entry.id);
            assert.deepEqual(ids(payload[key as keyof DragonfruitImportFormat]), ids(input[key as keyof DragonfruitImportFormat]), key);
        }
    });

    it('keeps fields it does not know about', () => {
        const input = { ...payloadOf(supportsOf('a')), futureField: { keep: true } } as DragonfruitImportFormat;

        const { payload } = move(input, 'a', placed(v(10, 0, 0)));

        assert.deepEqual((payload as unknown as { futureField: unknown }).futureField, { keep: true });
        assert.deepEqual(payload.meta, input.meta);
    });

    it('leaves a missing optional collection missing', () => {
        const input = payloadOf(supportsOf('b', 50));
        const a = supportsOf('a');
        input.trunks.push(a.trunks[0] as never);
        input.roots.push(a.roots[0] as never);
        input.knots.push(...(a.knots as never[]));
        delete input.twigs;

        const { payload } = move(input, 'a', placed(v(10, 0, 0)));

        assert.equal(payload.twigs, undefined);
    });

    it('skips null entries and keeps them', () => {
        const a = supportsOf('a') as unknown as Record<string, unknown[]>;
        a.twigs.push(null);
        a.kickstands.push(null);

        const { payload } = move(payloadOf(a as never), 'a', placed(v(10, 0, 0)));

        assert.equal(payload.twigs?.length, 2);
        assert.equal(payload.kickstands?.length, 2);
    });

    it('reads a kickstand wrapper missing its root and knot', () => {
        const a = supportsOf('a');
        const entry = a.kickstands[0] as unknown as Record<string, unknown>;
        delete entry.root;
        delete entry.hostKnot;

        assert.equal(move(payloadOf(a), 'a', placed(v(10, 0, 0))).payload.kickstands?.length, 1);
    });

    it('moves a type stored under a former collection key', () => {
        const legacyKey = SUPPORT_TYPES.flatMap((d) => d.renamedFrom?.collectionKeys ?? [])[0];
        if (!legacyKey) return;
        const key = SUPPORT_TYPES.find((d) => d.renamedFrom?.collectionKeys?.includes(legacyKey))?.location.key as string;
        const input = payloadOf(supportsOf('a')) as unknown as Record<string, unknown>;
        input[legacyKey] = input[key];
        delete input[key];

        const { payload } = move(input as unknown as DragonfruitImportFormat, 'a', placed(v(10, 0, 0)));

        assert.equal((payload as unknown as Record<string, { rootPos: Vec }[]>)[key][0].rootPos.x, 16);
    });
});

describe('the store and the rule', () => {
    it('changes nothing in the collections it is given', () => {
        const collections = payloadRecords(payloadOf(supportsOf('a')));
        const copy = JSON.stringify(collections);

        transformedSupportsForModel({ collections, modelId: 'a', beforeTransform: AT_ORIGIN, afterTransform: placed(v(1, 0, 0)) });

        assert.equal(JSON.stringify(collections), copy);
    });

    it('returns the collections it was given when nothing moves', () => {
        const collections = payloadRecords(payloadOf(supportsOf('a')));

        const result = transformedSupportsForModel({ collections, modelId: '', beforeTransform: AT_ORIGIN, afterTransform: placed(v(1, 0, 0)) });

        assert.equal(result.collections, collections);
    });

    it('reports a kickstand-only change', () => {
        const a = supportsOf('a');
        const input = asKickstandOnly(a);

        const { changed } = move(input, 'a', placed(v(10, 0, 0)));

        assert.ok(changed);
    });

    it('gives the file and the store the same result', () => {
        const input = payloadOf(supportsOf('a'), supportsOf('b', 50));
        const after = placed(v(7, 3, 0), v(0.2, 0.1, 0.4));

        assert.deepEqual(
            rounded(asRecords(move(input, 'a', after).payload)),
            rounded(throughStore(input, 'a', AT_ORIGIN, after)),
        );
    });

    it('leaves the store alone when nothing moved', () => {
        const input = payloadOf(supportsOf('a'));
        resetStore();
        setSnapshot({ ...getSnapshot(), ...payloadRecords(input) } as SupportState);
        const before = getSnapshot();

        transformSupportsForModel('a', AT_ORIGIN, AT_ORIGIN);

        assert.equal(getSnapshot(), before);
        resetStore();
    });
});

function asKickstandOnly(a: ReturnType<typeof supportsOf>): DragonfruitImportFormat {
    return {
        ...payloadOf(),
        roots: [],
        knots: [],
        kickstands: a.kickstands,
    } as unknown as DragonfruitImportFormat;
}

describe('a linked model\'s transform', () => {
    const peer = placed(v(30, 5, 2), v(0.1, 0.2, 0.3), v(1, 2, 1));

    it('takes the same change', () => {
        const next = linkedPeerTransform({
            peerBefore: peer,
            before: placed(v(1, 1, 1), v(0.5, 0, 0)),
            after: placed(v(4, 3, 1), v(0.7, 0, 0), v(1.5, 1, 1)),
        });

        assert.deepEqual(rounded(next.position.toArray()), [33, 7, 2]);
        assert.deepEqual(rounded([next.rotation.x, next.rotation.y, next.rotation.z]), [0.3, 0.2, 0.3]);
        assert.deepEqual(rounded(next.scale.toArray()), [1.5, 2, 1]);
    });

    it('stays put when the other model does', () => {
        const here = placed(v(1, 1, 1));
        const next = linkedPeerTransform({ peerBefore: peer, before: here, after: here });

        assert.deepEqual(rounded(next.position.toArray()), rounded(peer.position.toArray()));
    });

    it('does not touch the transforms it is given', () => {
        const before = placed(v(1, 1, 1));
        const after = placed(v(2, 2, 2));

        linkedPeerTransform({ peerBefore: peer, before, after });

        assert.deepEqual(before.position.toArray(), [1, 1, 1]);
        assert.deepEqual(peer.position.toArray(), [30, 5, 2]);
    });
});

/** Small seeded generator, so a failing scene comes back from its seed alone. */
function mulberry32(seed: number) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SCENES = 300;

describe(`${SCENES} random moves`, () => {
    /** Two or three models far apart, some with supports hanging across, and one random move. */
    const eachMove = (check: (input: DragonfruitImportFormat, after: SupportModelTransform, kind: string, seed: number) => void) => {
        for (let seed = 1; seed <= SCENES; seed++) {
            const random = mulberry32(seed * 104729);
            const spread = () => random() * 40 - 20;
            const parts = [supportsOf('a', spread(), spread()), supportsOf('b', 80 + spread(), spread())];
            if (random() < 0.5) parts.push(supportsOf('c', spread(), 80 + spread()));
            if (random() < 0.3) parts[1].branches[0].parentKnotId = 'a-bk';
            if (random() < 0.3) parts[0].roots = parts[0].roots.filter((entry) => entry.id !== 'a-kick-root');

            const kinds = ['xy', 'lift', 'rotate', 'scale', 'all'];
            const kind = kinds[Math.floor(random() * kinds.length)];
            const position = kind === 'lift' ? v(0, 0, 1 + random() * 20) : kind === 'rotate' || kind === 'scale' ? v(0, 0, 0) : v(spread(), spread(), 0);
            const rotation = kind === 'rotate' || kind === 'all' ? v(random() * 6, random() * 6, random() * 6) : v(0, 0, 0);
            const scaled = kind === 'scale' || kind === 'all' ? 0.5 + random() * 2 : 1;
            check(payloadOf(...parts), placed(position, rotation, v(scaled, scaled, scaled)), kind, seed);
        }
    };

    it('agree with the store', () => {
        eachMove((input, after, kind, seed) => {
            const inFile = asRecords(move(input, 'a', after).payload);
            const inStore = throughStore(input, 'a', AT_ORIGIN, after);
            // A lift can turn a stump into a trunk, whose new ids are random.
            if (kind === 'lift') {
                const sizes = (records: typeof inFile) => Object.values(records).map((record) => Object.keys(record).length);
                assert.deepEqual(sizes(inFile), sizes(inStore), `seed ${seed} (${kind})`);
                return;
            }
            assert.deepEqual(rounded(inFile), rounded(inStore), `seed ${seed} (${kind})`);
        });
        resetStore();
    });

    it('never write a number that is not finite', () => {
        eachMove((input, after, kind, seed) => {
            assert.ok(allNumbersFinite(move(input, 'a', after).payload), `seed ${seed} (${kind})`);
        });
    });

    it('keep every id', () => {
        const ids = (payload: DragonfruitImportFormat) => IMPORT_PAYLOAD_COLLECTION_ORDER.map((key) => (
            ((payload[key as keyof DragonfruitImportFormat] ?? []) as { id?: string; kickstand?: { id: string } }[])
                .map((entry) => entry.kickstand?.id ?? entry.id).sort()
        ));
        eachMove((input, after, kind, seed) => {
            if (kind === 'lift') return;
            assert.deepEqual(ids(move(input, 'a', after).payload), ids(input), `seed ${seed} (${kind})`);
        });
    });

    it('keep a wrapper and the shared array in step', () => {
        eachMove((input, after, kind, seed) => {
            const { payload } = move(input, 'a', after);
            for (const build of payload.kickstands ?? []) {
                const shared = payload.roots.find((entry) => entry.id === build.root.id);
                if (shared) assert.deepEqual(rounded(build.root), rounded(shared), `seed ${seed} (${kind})`);
            }
        });
    });

    it('keep the shape of a rotated model', () => {
        eachMove((input, after, kind, seed) => {
            if (kind !== 'rotate') return;
            const key = 'sticks' as const;
            const distance = (payload: DragonfruitImportFormat) => {
                const [p, q] = pointsIn(payload[key]?.filter((entry) => entry.id === 'a-stick'));
                return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
            };
            const expected = distance(input);
            assert.ok(Math.abs(distance(move(input, 'a', after).payload) - expected) < 1e-6, `seed ${seed}`);
        });
    });

    it('undo cleanly', () => {
        eachMove((input, after, kind, seed) => {
            if (kind === 'lift' || kind === 'all') return;
            const moved = move(input, 'a', after).payload;
            const back = move(moved, 'a', AT_ORIGIN, after).payload;
            // A stump is reseated on the plate after every move, so its cone keeps
            // the length that took and does not undo.
            const shaped = (payload: DragonfruitImportFormat) => rounded({ ...payload, stumps: [] });
            assert.deepEqual(shaped(back), shaped(input), `seed ${seed} (${kind})`);
        });
    });
});
