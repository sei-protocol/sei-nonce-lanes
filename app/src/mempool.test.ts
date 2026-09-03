import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hex } from 'viem';
import { PrivateMempool, type PendingOp } from './mempool.js';
import { laneNonce } from './userop.js';

const SENDER = '0x1111111111111111111111111111111111111111' as Address;

test('never places two operations from the same lane in one bundle', () => {
  const mempool = new PrivateMempool();
  const first = makePending(1n, 0);
  const sameLane = makePending(1n, 1);
  const otherLane = makePending(2n, 2);

  mempool.add(first);
  mempool.add(sameLane);
  mempool.add(otherLane);

  assert.deepEqual(mempool.takeBundle(2), [first, otherLane]);
  assert.equal(mempool.size, 1);
  assert.deepEqual(mempool.takeBundle(2), [sameLane]);
  assert.equal(mempool.size, 0);
});

test('preserves FIFO order when bundle width is one', () => {
  const mempool = new PrivateMempool();
  const operations = [makePending(3n, 0), makePending(2n, 1), makePending(1n, 2)];
  for (const pending of operations) mempool.add(pending);

  assert.deepEqual(mempool.takeBundle(1), [operations[0]]);
  assert.deepEqual(mempool.takeBundle(1), [operations[1]]);
  assert.deepEqual(mempool.takeBundle(1), [operations[2]]);
});

test('rejects an invalid bundle width', () => {
  const mempool = new PrivateMempool();
  assert.throws(() => mempool.takeBundle(0), /positive safe integer/);
  assert.throws(() => mempool.takeBundle(1.5), /positive safe integer/);
});

function makePending(lane: bigint, index: number): PendingOp {
  const byte = index.toString(16).padStart(2, '0');
  return {
    op: {
      sender: SENDER,
      nonce: laneNonce(lane, 0n),
      initCode: '0x',
      callData: '0x',
      accountGasLimits: `0x${'00'.repeat(32)}`,
      preVerificationGas: 60_000n,
      gasFees: `0x${'11'.repeat(32)}`,
      paymasterAndData: '0x',
      signature: `0x${'22'.repeat(65)}`,
    },
    hash: `0x${byte.repeat(32)}` as Hex,
    lane,
    seq: 0n,
    orderId: BigInt(index),
    label: `operation ${index}`,
  };
}
