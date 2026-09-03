import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  encodeFunctionData,
  keccak256,
  type Hex,
  type PublicClient,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { seiTestnet } from 'viem/chains';
import { entryPointAbi } from './abi.js';
import { OperationJournal, type SubmissionAttempt } from './journal.js';
import type { PendingOp } from './mempool.js';
import { RelayerPool } from './relayers.js';
import { laneNonce } from './userop.js';

const ENTRY_POINT = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';
const SENDER = '0x1111111111111111111111111111111111111111';
const MNEMONIC = 'test test test test test test test test test test test junk';

test('restart gets a fresh same-nonce replacement budget after eviction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sei-relayer-recovery-'));
  const broadcasts: Hex[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as {
      id: number;
      method: string;
      params?: unknown[];
    };

    if (payload.method !== 'eth_sendRawTransaction') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          error: { code: -32601, message: `unsupported method ${payload.method}` },
        }),
      );
      return;
    }

    const raw = payload.params?.[0] as Hex;
    broadcasts.push(raw);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: keccak256(raw) }));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    const rpcUrl = `http://127.0.0.1:${address.port}`;

    const account = mnemonicToAccount(MNEMONIC);
    const pending = makePending();
    const journal = await OperationJournal.open(join(directory, 'pending.json'), {
      chainId: seiTestnet.id,
      entryPoint: ENTRY_POINT,
      sender: SENDER,
    });
    await journal.add([pending]);

    const first = await makeAttempt(account, pending, 7, 100n, 10n, 1);
    const second = await makeAttempt(account, pending, 7, 125n, 13n, 2);
    await journal.recordAttempt([pending], first);
    await journal.recordAttempt([pending], second);

    const publicClient = {
      getTransactionCount: async () => 7,
      getTransactionReceipt: async () => {
        throw new Error('transaction not found');
      },
      waitForTransactionReceipt: async () => {
        throw new Error('receipt timeout');
      },
      readContract: async () => laneNonce(pending.lane, pending.seq),
      estimateContractGas: async () => 500_000n,
      estimateFeesPerGas: async () => ({
        maxFeePerGas: 100n,
        maxPriorityFeePerGas: 10n,
      }),
      getBlockNumber: async () => 100n,
    } as unknown as PublicClient;

    const pool = await RelayerPool.create(
      [account],
      publicClient,
      seiTestnet,
      rpcUrl,
      ENTRY_POINT,
      {
        journal,
        receiptTimeoutMs: 1,
        maxAttempts: 2,
        feeBumpPercent: 25,
      },
    );

    const [result] = await pool.recover(journal.recoveryBundles());
    assert.ok(result);
    assert.equal(result.pending, true);

    const [recovery] = journal.recoveryBundles();
    assert.ok(recovery);
    assert.equal(recovery.attempts.length, 4);
    assert.deepEqual(
      recovery.attempts.map((attempt) => attempt.nonce),
      [7, 7, 7, 7],
    );
    assert.ok(recovery.attempts[2]!.maxFeePerGas > recovery.attempts[1]!.maxFeePerGas);
    assert.ok(recovery.attempts[3]!.maxFeePerGas > recovery.attempts[2]!.maxFeePerGas);

    // First rebroadcast the exact last signed bytes, then send two fee-bumped
    // replacements. No transaction at nonce 8 is ever created.
    assert.equal(broadcasts.length, 3);
    assert.equal(broadcasts[0], second.rawTransaction);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

async function makeAttempt(
  account: ReturnType<typeof mnemonicToAccount>,
  pending: PendingOp,
  nonce: number,
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
  createdAt: number,
): Promise<SubmissionAttempt> {
  const rawTransaction = await account.signTransaction({
    chainId: seiTestnet.id,
    type: 'eip1559',
    to: ENTRY_POINT,
    data: encodeFunctionData({
      abi: entryPointAbi,
      functionName: 'handleOps',
      args: [[pending.op], account.address],
    }),
    gas: 1_000_000n,
    nonce,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  return {
    bundleId: 'bundle-1',
    relayer: account.address,
    nonce,
    txHash: keccak256(rawTransaction),
    rawTransaction,
    maxFeePerGas,
    maxPriorityFeePerGas,
    submittedAtBlock: 99n,
    createdAt,
  };
}

function makePending(): PendingOp {
  return {
    op: {
      sender: SENDER,
      nonce: laneNonce(1n, 0n),
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
