import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hex } from 'viem';
import { BundlingQueue, type PendingOp } from './bundling-queue.js';
import { laneNonce } from './userop.js';

const SENDER = '0x1111111111111111111111111111111111111111' as Address;

test('never places two operations from the same lane in one bundle', () => {
  const queue = new BundlingQueue();
  const first = makePending(1n, 0);
  const sameLane = makePending(1n, 1);
  const otherLane = makePending(2n, 2);

  queue.add(first);
  queue.add(sameLane);
  queue.add(otherLane);

  assert.deepEqual(queue.takeBundle(2), [first, otherLane]);
  assert.equal(queue.size, 1);
  assert.deepEqual(queue.takeBundle(2), [sameLane]);
  assert.equal(queue.size, 0);
});

test('preserves FIFO order when bundle width is one', () => {
  const queue = new BundlingQueue();
  const operations = [makePending(3n, 0), makePending(2n, 1), makePending(1n, 2)];
  for (const pending of operations) queue.add(pending);

  assert.deepEqual(queue.takeBundle(1), [operations[0]]);
  assert.deepEqual(queue.takeBundle(1), [operations[1]]);
  assert.deepEqual(queue.takeBundle(1), [operations[2]]);
});

test('rejects an invalid bundle width', () => {
  const queue = new BundlingQueue();
  assert.throws(() => queue.takeBundle(0), /positive safe integer/);
  assert.throws(() => queue.takeBundle(1.5), /positive safe integer/);
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
