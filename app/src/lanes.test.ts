import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, PublicClient } from 'viem';
import { LanePool } from './lanes.js';
import { laneNonce } from './userop.js';

const ENTRY_POINT = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108' as Address;
const SENDER = '0x1111111111111111111111111111111111111111' as Address;

test('allocates one in-flight operation per lane and advances only consumed lanes', async () => {
  const sequences = new Map<bigint, bigint>([
    [1n, 0n],
    [2n, 4n],
    [3n, 2n],
  ]);
  const pool = await LanePool.create(fakeClient(sequences), ENTRY_POINT, SENDER, 3);

  assert.equal(pool.idleCount, 3);
  assert.equal(pool.inFlightCount, 0);

  const first = pool.acquire();
  const second = pool.acquire();
  assert.deepEqual(first, { lane: 3n, seq: 2n });
  assert.deepEqual(second, { lane: 2n, seq: 4n });
  assert.equal(pool.idleCount, 1);
  assert.equal(pool.inFlightCount, 2);

  pool.settle(first!.lane, true);
  pool.settle(second!.lane, false);
  assert.equal(pool.sequence(3n), 3n);
  assert.equal(pool.sequence(2n), 4n);
  assert.equal(pool.idleCount, 3);
  assert.throws(() => pool.settle(first!.lane, true), /was not in flight/);
});

test('reserves durable work only at the chain sequence', async () => {
  const sequences = new Map<bigint, bigint>([
    [1n, 7n],
    [2n, 0n],
  ]);
  const pool = await LanePool.create(fakeClient(sequences), ENTRY_POINT, SENDER, 2);

  pool.reserve(1n, 7n);
  assert.equal(pool.inFlightCount, 1);
  assert.deepEqual(pool.acquire(), { lane: 2n, seq: 0n });

  assert.throws(() => pool.reserve(3n, 0n), /outside the configured pool/);
  assert.throws(() => pool.reserve(1n, 7n), /already in flight/);

  const fresh = await LanePool.create(fakeClient(sequences), ENTRY_POINT, SENDER, 2);
  assert.throws(() => fresh.reserve(1n, 6n), /is at seq 7, pending op expects 6/);
});

test('resync refreshes selected sequence counters from EntryPoint', async () => {
  const sequences = new Map<bigint, bigint>([
    [1n, 1n],
    [2n, 2n],
  ]);
  const pool = await LanePool.create(fakeClient(sequences), ENTRY_POINT, SENDER, 2);

  sequences.set(1n, 9n);
  await pool.resync([1n]);

  assert.equal(pool.sequence(1n), 9n);
  assert.equal(pool.sequence(2n), 2n);
});

test('rejects an invalid lane pool size', async () => {
  const client = fakeClient(new Map());
  await assert.rejects(LanePool.create(client, ENTRY_POINT, SENDER, 0), /positive safe integer/);
  await assert.rejects(LanePool.create(client, ENTRY_POINT, SENDER, 1.5), /positive safe integer/);
});

function fakeClient(sequences: ReadonlyMap<bigint, bigint>): PublicClient {
  return {
    readContract: async (parameters: { args?: readonly unknown[] }) => {
      const lane = parameters.args?.[1];
      if (typeof lane !== 'bigint') throw new Error('missing lane argument');
      return laneNonce(lane, sequences.get(lane) ?? 0n);
    },
  } as unknown as PublicClient;
}
