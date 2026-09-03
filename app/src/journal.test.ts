import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Address, Hex } from 'viem';
import { OperationJournal, type SubmissionAttempt } from './journal.js';
import type { PendingOp } from './mempool.js';

const ENTRY_POINT = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108' as Address;
const SENDER = '0x1111111111111111111111111111111111111111' as Address;
const RELAYER = '0x2222222222222222222222222222222222222222' as Address;

test('persists signed ops and raw outer transactions across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sei-op-journal-'));
  const path = join(directory, 'pending.json');
  try {
    const pending = makePending();
    const attempt = makeAttempt();
    const journal = await OperationJournal.open(path, {
      chainId: 1328,
      entryPoint: ENTRY_POINT,
      sender: SENDER,
    });

    await journal.add([pending]);
    await journal.recordAttempt([pending], attempt);
    await journal.flush();

    const reopened = await OperationJournal.open(path, {
      chainId: 1328,
      entryPoint: ENTRY_POINT,
      sender: SENDER,
    });
    assert.equal(reopened.size, 1);
    assert.equal(reopened.queuedOps().length, 0);
    assert.deepEqual(reopened.allOps(), [pending]);
    assert.deepEqual(reopened.recoveryBundles(), [
      { bundleId: attempt.bundleId, ops: [pending], attempts: [attempt] },
    ]);
    assert.deepEqual(reopened.completedBundles(), []);

    await reopened.complete([pending]);
    assert.equal(reopened.size, 0);
    assert.deepEqual(reopened.runOps(), [pending]);
    assert.deepEqual(reopened.allOps(), []);
    assert.deepEqual(reopened.queuedOps(), []);
    assert.deepEqual(reopened.recoveryBundles(), []);
    assert.deepEqual(reopened.completedBundles(), [
      { bundleId: attempt.bundleId, ops: [pending], attempts: [attempt] },
    ]);

    const completedReopen = await OperationJournal.open(path, {
      chainId: 1328,
      entryPoint: ENTRY_POINT,
      sender: SENDER,
    });
    assert.equal(completedReopen.size, 0);
    assert.deepEqual(completedReopen.runOps(), [pending]);
    assert.deepEqual(completedReopen.completedBundles(), [
      { bundleId: attempt.bundleId, ops: [pending], attempts: [attempt] },
    ]);

    await completedReopen.finishRun();
    assert.deepEqual(completedReopen.runOps(), []);
    assert.deepEqual(completedReopen.completedBundles(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('prevents concurrent journal owners and releases the lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sei-op-journal-'));
  const path = join(directory, 'pending.json');
  const context = { chainId: 1328, entryPoint: ENTRY_POINT, sender: SENDER };
  try {
    const first = await OperationJournal.open(path, context);
    const second = await OperationJournal.open(path, context);

    await first.acquireLock();
    await assert.rejects(second.acquireLock(), /another spray process/);
    await first.releaseLock();

    await second.acquireLock();
    await second.releaseLock();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stores one signed outer transaction per bundle instead of per operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sei-op-journal-'));
  const path = join(directory, 'pending.json');
  try {
    const first = makePending();
    const second: PendingOp = {
      ...makePending(),
      op: { ...makePending().op, nonce: 2n << 64n },
      hash: `0x${'55'.repeat(32)}`,
      lane: 2n,
    };
    const attempt = makeAttempt();
    const journal = await OperationJournal.open(path, {
      chainId: 1328,
      entryPoint: ENTRY_POINT,
      sender: SENDER,
    });
    await journal.add([first, second]);
    await journal.recordAttempt([first, second], attempt);

    const persisted = await readFile(path, 'utf8');
    assert.equal(persisted.match(/"rawTransaction":/g)?.length, 1);
    assert.deepEqual(journal.recoveryBundles(), [
      { bundleId: attempt.bundleId, ops: [first, second], attempts: [attempt] },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('migrates legacy duplicated-attempt journals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sei-op-journal-'));
  const path = join(directory, 'pending.json');
  try {
    const first = makePending();
    const second: PendingOp = {
      ...makePending(),
      op: { ...makePending().op, nonce: 2n << 64n },
      hash: `0x${'55'.repeat(32)}`,
      lane: 2n,
    };
    const attempt = makeAttempt();
    const legacy = {
      version: 1,
      context: { chainId: 1328, entryPoint: ENTRY_POINT, sender: SENDER },
      records: [
        { pending: first, attempts: [attempt] },
        { pending: second, attempts: [attempt] },
      ],
    };
    await writeFile(
      path,
      JSON.stringify(legacy, (_key, value) =>
        typeof value === 'bigint' ? { $bigint: value.toString() } : value,
      ),
    );

    const journal = await OperationJournal.open(path, legacy.context);
    assert.deepEqual(journal.recoveryBundles(), [
      { bundleId: attempt.bundleId, ops: [first, second], attempts: [attempt] },
    ]);
    const migrated = await readFile(path, 'utf8');
    assert.equal(JSON.parse(migrated).version, 2);
    assert.equal(migrated.match(/"rawTransaction":/g)?.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('refuses to replay pending work for another sender', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sei-op-journal-'));
  const path = join(directory, 'pending.json');
  try {
    const journal = await OperationJournal.open(path, {
      chainId: 1328,
      entryPoint: ENTRY_POINT,
      sender: SENDER,
    });
    await journal.add([makePending()]);

    await assert.rejects(
      OperationJournal.open(path, {
        chainId: 1328,
        entryPoint: ENTRY_POINT,
        sender: '0x3333333333333333333333333333333333333333',
      }),
      /refusing to replay/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function makePending(): PendingOp {
  return {
    op: {
      sender: SENDER,
      nonce: 18446744073709551616n,
      initCode: '0x',
      callData: '0x1234',
      accountGasLimits: `0x${'00'.repeat(32)}`,
      preVerificationGas: 60_000n,
      gasFees: `0x${'11'.repeat(32)}`,
      paymasterAndData: '0x',
      signature: `0x${'22'.repeat(65)}`,
    },
    hash: `0x${'33'.repeat(32)}`,
    lane: 1n,
    seq: 0n,
    orderId: 123n,
    label: 'test',
  };
}

function makeAttempt(): SubmissionAttempt {
  return {
    bundleId: 'bundle-1',
    relayer: RELAYER,
    nonce: 7,
    txHash: `0x${'44'.repeat(32)}` as Hex,
    rawTransaction: '0x02f86c',
    maxFeePerGas: 100n,
    maxPriorityFeePerGas: 10n,
    submittedAtBlock: 456n,
    createdAt: 789,
  };
}
