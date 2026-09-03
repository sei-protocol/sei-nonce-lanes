import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hex } from 'viem';
import {
  decodeLaneNonce,
  laneNonce,
  packPair,
  userOpHash,
  type UserOp,
} from './userop.js';

const ENTRY_POINT = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108' as Address;
const SENDER = '0x1111111111111111111111111111111111111111' as Address;

test('round-trips the full ERC-4337 lane and sequence ranges', () => {
  const maxLane = (1n << 192n) - 1n;
  const maxSequence = (1n << 64n) - 1n;

  assert.deepEqual(decodeLaneNonce(laneNonce(1n, 0n)), { lane: 1n, seq: 0n });
  assert.deepEqual(decodeLaneNonce(laneNonce(42n, 7n)), { lane: 42n, seq: 7n });
  assert.deepEqual(decodeLaneNonce(laneNonce(maxLane, maxSequence)), {
    lane: maxLane,
    seq: maxSequence,
  });
});

test('rejects lane zero and values outside packed nonce ranges', () => {
  assert.throws(() => laneNonce(0n, 0n), /lane out of range/);
  assert.throws(() => laneNonce(1n << 192n, 0n), /lane out of range/);
  assert.throws(() => laneNonce(1n, -1n), /seq out of range/);
  assert.throws(() => laneNonce(1n, 1n << 64n), /seq out of range/);
});

test('packs uint128 pairs without truncation', () => {
  const max = (1n << 128n) - 1n;
  assert.equal(BigInt(packPair(1n, 2n)), (1n << 128n) | 2n);
  assert.equal(BigInt(packPair(max, max)), (1n << 256n) - 1n);

  assert.throws(() => packPair(-1n, 0n), /high value out of uint128 range/);
  assert.throws(() => packPair(0n, -1n), /low value out of uint128 range/);
  assert.throws(() => packPair(1n << 128n, 0n), /high value out of uint128 range/);
  assert.throws(() => packPair(0n, 1n << 128n), /low value out of uint128 range/);
});

test('hashes packed fields but excludes the signature field', () => {
  const op = makeUserOp();
  const original = userOpHash(op, 1328, ENTRY_POINT);
  const resigned = userOpHash(
    { ...op, signature: `0x${'33'.repeat(65)}` as Hex },
    1328,
    ENTRY_POINT,
  );
  const nextNonce = userOpHash({ ...op, nonce: laneNonce(1n, 1n) }, 1328, ENTRY_POINT);

  assert.equal(resigned, original);
  assert.notEqual(nextNonce, original);
});

function makeUserOp(): UserOp {
  return {
    sender: SENDER,
    nonce: laneNonce(1n, 0n),
    initCode: '0x',
    callData: '0x1234',
    accountGasLimits: packPair(150_000n, 500_000n),
    preVerificationGas: 60_000n,
    gasFees: packPair(1n, 2n),
    paymasterAndData: '0x',
    signature: `0x${'22'.repeat(65)}` as Hex,
  };
}
