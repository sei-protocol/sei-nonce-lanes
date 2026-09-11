import {
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseEventLogs,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import type { HDAccount } from 'viem/accounts';
import { entryPointAbi } from './abi.js';
import type { OperationJournal, RecoveryBundle, SubmissionAttempt } from './journal.js';
import type { BundlingQueue, PendingOp } from './bundling-queue.js';
import { decodeLaneNonce } from './userop.js';

export type BundleResult = {
  relayer: Address;
  ops: PendingOp[];
  txHash?: Hex;
  blockNumber?: bigint;
  gasUsed?: bigint;
  /** True when the handleOps transaction was mined successfully. */
  mined: boolean;
  /** True when a same-nonce transaction may still land and the relayer must pause. */
  pending: boolean;
  /** Every original/replacement hash tried for this relayer nonce. */
  txHashes: Hex[];
  reconciled?: boolean;
  error?: string;
  /** Per-op execution outcome, keyed by userOpHash. Absent when the bundle never mined. */
  opSuccess: Map<Hex, boolean>;
};

type Relayer = {
  account: HDAccount;
  wallet: ReturnType<typeof createWalletClient>;
  /** Local sequential EVM nonce. Sei rejects gaps, so this only advances on accepted sends. */
  nonce: number;
};

export type RelayerPoolOptions = {
  journal?: OperationJournal;
  receiptTimeoutMs?: number;
  maxAttempts?: number;
  feeBumpPercent?: number;
};

/**
 * A pool of gas-only submitters.
 *
 * The sequential-nonce constraint does not disappear, it moves. Each relayer still
 * burns a strictly sequential EVM nonce and keeps one transaction in flight at a
 * time, because Sei's Autobahn producer mempool rejects out-of-order nonces with
 * `bad nonce` rather than queuing them. What changes is that the relayers hold no
 * inventory: losing one costs gas, not funds, and the trading account's own EVM
 * nonce is never touched.
 *
 * Throughput is roughly `relayers x opsPerBundle` per block.
 */
export class RelayerPool {
  private constructor(
    private readonly relayers: Relayer[],
    private readonly publicClient: PublicClient,
    private readonly chain: Chain,
    private readonly entryPoint: Address,
    private readonly blockGasLimit: bigint,
    private readonly options: Required<Omit<RelayerPoolOptions, 'journal'>> & Pick<RelayerPoolOptions, 'journal'>,
  ) {}

  static async create(
    accounts: HDAccount[],
    publicClient: PublicClient,
    chain: Chain,
    rpcUrl: string,
    entryPoint: Address,
    options: RelayerPoolOptions = {},
  ): Promise<RelayerPool> {
    const blockGasLimit = (await publicClient.getBlock()).gasLimit;
    const relayers = accounts.map((account) => ({
      account,
      wallet: createWalletClient({ account, chain, transport: http(rpcUrl) }),
      nonce: 0,
    }));
    // Sequential nonce reads: a 32-relayer pool otherwise bursts the public RPC.
    for (const relayer of relayers) {
      relayer.nonce = await publicClient.getTransactionCount({ address: relayer.account.address });
    }
    return new RelayerPool(
      relayers,
      publicClient,
      chain,
      entryPoint,
      blockGasLimit,
      {
        journal: options.journal,
        receiptTimeoutMs: options.receiptTimeoutMs ?? 12_000,
        maxAttempts: Math.max(1, options.maxAttempts ?? 3),
        feeBumpPercent: Math.max(10, options.feeBumpPercent ?? 25),
      },
    );
  }

  get addresses(): Address[] {
    return this.relayers.map((r) => r.account.address);
  }

  async balances(): Promise<{ address: Address; balance: bigint }[]> {
    const out: { address: Address; balance: bigint }[] = [];
    for (const r of this.relayers) {
      out.push({
        address: r.account.address,
        balance: await this.publicClient.getBalance({ address: r.account.address }),
      });
    }
    return out;
  }

  /**
   * Drain the queue. One worker per relayer, each submitting bundles back to back.
   * `onSettled` fires as soon as a bundle resolves so lanes can be released promptly.
   */
  async drain(
    queue: BundlingQueue,
    maxOpsPerBundle: number,
    onSettled?: (result: BundleResult) => void | Promise<void>,
  ): Promise<BundleResult[]> {
    const results: BundleResult[] = [];
    let stopRequested = false;

    const workers = await Promise.allSettled(
      this.relayers.map(async (relayer) => {
        for (;;) {
          if (stopRequested) return;
          const bundle = queue.takeBundle(maxOpsPerBundle);
          if (bundle.length === 0) return;
          let result: BundleResult;
          try {
            result = await this.submit(relayer, bundle);
            results.push(result);
            await onSettled?.(result);
          } catch (error) {
            stopRequested = true;
            throw error;
          }
          // A transaction with this relayer nonce may still land. Sending the
          // next nonce would create exactly the gap this pool exists to avoid.
          if (result.pending) return;
        }
      }),
    );
    throwFirstRejected(workers);

    return results;
  }

  /** Resume write-ahead-logged bundles before accepting newly built work. */
  async recover(
    bundles: RecoveryBundle[],
    onSettled?: (result: BundleResult) => void | Promise<void>,
  ): Promise<BundleResult[]> {
    const byRelayer = new Map<Address, RecoveryBundle[]>();
    for (const bundle of bundles) {
      const address = bundle.attempts.at(-1)!.relayer;
      const existing = byRelayer.get(address) ?? [];
      existing.push(bundle);
      byRelayer.set(address, existing);
    }

    const results: BundleResult[] = [];
    let stopRequested = false;
    const workers = await Promise.allSettled(
      [...byRelayer].map(async ([address, assigned]) => {
        const relayer = this.relayers.find(
          (candidate) => candidate.account.address.toLowerCase() === address.toLowerCase(),
        );
        if (!relayer) throw new Error(`journal references unknown relayer ${address}`);

        for (const bundle of assigned) {
          if (stopRequested) return;
          let result: BundleResult;
          try {
            result = await this.submit(relayer, bundle.ops, bundle.attempts);
            results.push(result);
            await onSettled?.(result);
          } catch (error) {
            stopRequested = true;
            throw error;
          }
          if (result.pending) return;
        }
      }),
    );
    throwFirstRejected(workers);
    return results;
  }

  private async submit(
    relayer: Relayer,
    bundle: PendingOp[],
    previousAttempts: SubmissionAttempt[] = [],
  ): Promise<BundleResult> {
    const ops = bundle.map((p) => p.op);
    const args = [ops, relayer.account.address] as const;
    const base = {
      address: this.entryPoint,
      abi: entryPointAbi,
      functionName: 'handleOps',
      args,
      account: relayer.account,
    } as const;

    const txNonce = previousAttempts.at(-1)?.nonce ?? relayer.nonce;
    let attempts = [...previousAttempts];
    let attemptsThisRun = 0;
    let lastError: string | undefined;

    if (attempts.length > 0) {
      const knownReceipt = await this.findReceipt(attempts);
      if (knownReceipt) return this.fromReceipt(relayer, bundle, txNonce, attempts, knownReceipt);

      const state = await this.recoveryState(relayer, bundle, txNonce);
      if (state.consumed === bundle.length) {
        return this.reconciledResult(relayer, bundle, attempts, true, 'all lane nonces advanced');
      }
      if (state.consumed > 0) {
        return this.reconciledResult(
          relayer,
          bundle,
          attempts,
          false,
          `${state.consumed}/${bundle.length} lane nonces advanced; manual reconciliation required`,
          true,
        );
      }
      if (state.confirmedNonce > txNonce) {
        await this.options.journal?.clearAttempts(bundle);
        return this.failedResult(
          relayer,
          bundle,
          attempts,
          'relayer nonce was consumed but UserOp lane nonces were not; safe to retry',
        );
      }
      if (state.confirmedNonce < txNonce) {
        return this.reconciledResult(
          relayer,
          bundle,
          attempts,
          false,
          `relayer confirmed nonce ${state.confirmedNonce} is behind journal nonce ${txNonce}`,
          true,
        );
      }

      // Rebroadcast the exact signed bytes first. This is idempotent and closes
      // the crash window between writing the journal and calling the RPC.
      const latest = attempts.at(-1)!;
      const accepted = await this.broadcast(relayer, latest);
      if (accepted) {
        relayer.nonce = txNonce + 1;
        const receipt = await this.waitForReceipt(latest, attempts);
        if (receipt) return this.fromReceipt(relayer, bundle, txNonce, attempts, receipt);
      }
    }

    // Simulate first. A validation failure (bad signature, stale nonce, thin prefund)
    // reverts the entire bundle, so it is much cheaper to find out before paying gas.
    let gas: bigint;
    try {
      gas = await this.publicClient.estimateContractGas(base);
    } catch (error) {
      return {
        relayer: relayer.account.address,
        ops: bundle,
        mined: false,
        pending: previousAttempts.length > 0,
        txHashes: attempts.map((attempt) => attempt.txHash),
        error: `simulation failed: ${describeError(error)}`,
        opSuccess: new Map(),
      };
    }
    const outerGasLimit = boundedOuterGasLimit(gas, this.blockGasLimit);
    if (outerGasLimit === undefined) {
      return {
        relayer: relayer.account.address,
        ops: bundle,
        mined: false,
        pending: previousAttempts.length > 0,
        txHashes: attempts.map((attempt) => attempt.txHash),
        error:
          `estimated bundle gas ${gas} does not fit the current block gas limit ` +
          `${this.blockGasLimit}`,
        opSuccess: new Map(),
      };
    }

    const estimatedFees = await this.publicClient.estimateFeesPerGas();
    const networkMaxFeePerGas = maxBigInt(estimatedFees.maxFeePerGas * 2n, 1n);
    const networkMaxPriorityFeePerGas = maxBigInt(estimatedFees.maxPriorityFeePerGas * 2n, 1n);
    let maxFeePerGas =
      attempts.length > 0
        ? maxBigInt(attempts.at(-1)!.maxFeePerGas, networkMaxFeePerGas)
        : networkMaxFeePerGas;
    let maxPriorityFeePerGas =
      attempts.length > 0
        ? maxBigInt(attempts.at(-1)!.maxPriorityFeePerGas, networkMaxPriorityFeePerGas)
        : networkMaxPriorityFeePerGas;
    const bundleId = attempts.at(-1)?.bundleId;

    // The retry budget is per invocation, not the lifetime attempt count in the
    // journal. Otherwise a bundle that exhausted its budget before a restart
    // could only rebroadcast the same underpriced bytes forever.
    while (attemptsThisRun < this.options.maxAttempts) {
      if (attempts.length > 0) {
        maxFeePerGas = bumpFee(maxFeePerGas, this.options.feeBumpPercent);
        maxPriorityFeePerGas = bumpFee(maxPriorityFeePerGas, this.options.feeBumpPercent);
      }

      const attempt = await this.signAttempt(
        relayer,
        args,
        txNonce,
        outerGasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        bundleId,
      );
      // WAL ordering is deliberate: signed bytes reach disk before the network.
      await this.options.journal?.recordAttempt(bundle, attempt);
      attempts = [...attempts, attempt];
      attemptsThisRun += 1;

      const accepted = await this.broadcast(relayer, attempt);
      if (!accepted) {
        lastError = `send failed for ${attempt.txHash}`;
        const receipt = await this.findReceipt(attempts);
        if (receipt) return this.fromReceipt(relayer, bundle, txNonce, attempts, receipt);
        continue;
      }

      relayer.nonce = txNonce + 1;
      const receipt = await this.waitForReceipt(attempt, attempts);
      if (receipt) return this.fromReceipt(relayer, bundle, txNonce, attempts, receipt);
      lastError = `receipt timeout after ${this.options.receiptTimeoutMs}ms`;
    }

    const receipt = await this.findReceipt(attempts);
    if (receipt) return this.fromReceipt(relayer, bundle, txNonce, attempts, receipt);

    const state = await this.recoveryState(relayer, bundle, txNonce);
    if (state.consumed === bundle.length) {
      return this.reconciledResult(relayer, bundle, attempts, true, 'all lane nonces advanced');
    }
    if (state.consumed > 0) {
      return this.reconciledResult(
        relayer,
        bundle,
        attempts,
        false,
        `${state.consumed}/${bundle.length} lane nonces advanced; manual reconciliation required`,
        true,
      );
    }
    if (state.confirmedNonce > txNonce) {
      await this.options.journal?.clearAttempts(bundle);
      return this.failedResult(
        relayer,
        bundle,
        attempts,
        'relayer nonce consumed without advancing UserOp lanes; safe to retry',
      );
    }
    return this.reconciledResult(
      relayer,
      bundle,
      attempts,
      false,
      `${lastError ?? 'transaction not found'}; signed bundle remains in the journal`,
      true,
    );
  }

  private async signAttempt(
    relayer: Relayer,
    args: readonly [PendingOp['op'][], Address],
    nonce: number,
    gas: bigint,
    maxFeePerGas: bigint,
    maxPriorityFeePerGas: bigint,
    existingBundleId?: string,
  ): Promise<SubmissionAttempt> {
    const data = encodeFunctionData({
      abi: entryPointAbi,
      functionName: 'handleOps',
      args,
    });
    const rawTransaction = await relayer.account.signTransaction({
      chainId: this.chain.id,
      type: 'eip1559',
      to: this.entryPoint,
      data,
      gas,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    const txHash = keccak256(rawTransaction);
    return {
      bundleId: existingBundleId ?? txHash,
      relayer: relayer.account.address,
      nonce,
      txHash,
      rawTransaction,
      maxFeePerGas,
      maxPriorityFeePerGas,
      submittedAtBlock: await this.publicClient.getBlockNumber(),
      createdAt: Date.now(),
    };
  }

  private async broadcast(relayer: Relayer, attempt: SubmissionAttempt): Promise<boolean> {
    try {
      await relayer.wallet.sendRawTransaction({ serializedTransaction: attempt.rawTransaction });
      return true;
    } catch (error) {
      if (isAlreadyKnown(error)) return true;
      return false;
    }
  }

  private async waitForReceipt(attempt: SubmissionAttempt, attempts: SubmissionAttempt[]) {
    try {
      return await this.publicClient.waitForTransactionReceipt({
        hash: attempt.txHash,
        timeout: this.options.receiptTimeoutMs,
      });
    } catch {
      return this.findReceipt(attempts);
    }
  }

  private async findReceipt(attempts: SubmissionAttempt[]) {
    for (const attempt of [...attempts].reverse()) {
      try {
        return await this.publicClient.getTransactionReceipt({ hash: attempt.txHash });
      } catch {
        // Not mined under this hash.
      }
    }
    return undefined;
  }

  private fromReceipt(
    relayer: Relayer,
    bundle: PendingOp[],
    txNonce: number,
    attempts: SubmissionAttempt[],
    receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>,
  ): BundleResult {
    relayer.nonce = Math.max(relayer.nonce, txNonce + 1);
    const opSuccess = new Map<Hex, boolean>();
    if (receipt.status === 'success') {
      const events = parseEventLogs({
        abi: entryPointAbi,
        eventName: 'UserOperationEvent',
        logs: receipt.logs,
      });
      for (const event of events) opSuccess.set(event.args.userOpHash, event.args.success);
    }
    return {
      relayer: relayer.account.address,
      ops: bundle,
      txHash: receipt.transactionHash,
      txHashes: attempts.map((attempt) => attempt.txHash),
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      mined: receipt.status === 'success',
      pending: false,
      error: receipt.status === 'success' ? undefined : 'handleOps transaction reverted',
      opSuccess,
    };
  }

  private async recoveryState(relayer: Relayer, bundle: PendingOp[], txNonce: number) {
    let consumed = 0;
    for (const pending of bundle) {
      const nonce = await this.publicClient.readContract({
        address: this.entryPoint,
        abi: entryPointAbi,
        functionName: 'getNonce',
        args: [pending.op.sender, pending.lane],
      });
      if (decodeLaneNonce(nonce).seq > pending.seq) consumed += 1;
    }
    const confirmedNonce = await this.publicClient.getTransactionCount({
      address: relayer.account.address,
    });
    relayer.nonce = confirmedNonce;
    return { consumed, confirmedNonce, txNonce };
  }

  private reconciledResult(
    relayer: Relayer,
    bundle: PendingOp[],
    attempts: SubmissionAttempt[],
    mined: boolean,
    error: string,
    pending = false,
  ): BundleResult {
    return {
      relayer: relayer.account.address,
      ops: bundle,
      txHash: attempts.at(-1)?.txHash,
      txHashes: attempts.map((attempt) => attempt.txHash),
      mined,
      pending,
      reconciled: true,
      error,
      opSuccess: new Map(),
    };
  }

  private failedResult(
    relayer: Relayer,
    bundle: PendingOp[],
    attempts: SubmissionAttempt[],
    error: string,
  ): BundleResult {
    return {
      relayer: relayer.account.address,
      ops: bundle,
      txHash: attempts.at(-1)?.txHash,
      txHashes: attempts.map((attempt) => attempt.txHash),
      mined: false,
      pending: false,
      error,
      opSuccess: new Map(),
    };
  }
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function bumpFee(value: bigint, percent: number): bigint {
  return (value * BigInt(100 + percent) + 99n) / 100n;
}

export function boundedOuterGasLimit(
  estimatedGas: bigint,
  blockGasLimit: bigint,
): bigint | undefined {
  if (blockGasLimit <= 1n || estimatedGas >= blockGasLimit) return undefined;
  const gasWithHeadroom = (estimatedGas * 12n + 9n) / 10n;
  const maximumTransactionGas = blockGasLimit - 1n;
  return gasWithHeadroom < maximumTransactionGas ? gasWithHeadroom : maximumTransactionGas;
}

function isAlreadyKnown(error: unknown): boolean {
  const message = describeError(error).toLowerCase();
  return message.includes('already known') || message.includes('known transaction');
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const match = error.message.match(/(AA\d{2}[^"\n]*)/);
    if (match) return match[1]!.trim();
    return error.message.split('\n')[0]!.trim();
  }
  return String(error);
}

function throwFirstRejected(results: PromiseSettledResult<void>[]): void {
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected) throw rejected.reason;
}
