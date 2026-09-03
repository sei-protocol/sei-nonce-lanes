import {
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import type { HDAccount } from 'viem/accounts';
import { entryPointAbi } from './abi.js';
import type { PendingOp } from './mempool.js';
import type { PrivateMempool } from './mempool.js';

export type BundleResult = {
  relayer: Address;
  ops: PendingOp[];
  txHash?: Hex;
  blockNumber?: bigint;
  gasUsed?: bigint;
  /** True when the handleOps transaction was mined successfully. */
  mined: boolean;
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
    private readonly entryPoint: Address,
  ) {}

  static async create(
    accounts: HDAccount[],
    publicClient: PublicClient,
    chain: Chain,
    rpcUrl: string,
    entryPoint: Address,
  ): Promise<RelayerPool> {
    const relayers = await Promise.all(
      accounts.map(async (account) => ({
        account,
        wallet: createWalletClient({ account, chain, transport: http(rpcUrl) }),
        nonce: await publicClient.getTransactionCount({ address: account.address }),
      })),
    );
    return new RelayerPool(relayers, publicClient, entryPoint);
  }

  get addresses(): Address[] {
    return this.relayers.map((r) => r.account.address);
  }

  async balances(): Promise<{ address: Address; balance: bigint }[]> {
    return Promise.all(
      this.relayers.map(async (r) => ({
        address: r.account.address,
        balance: await this.publicClient.getBalance({ address: r.account.address }),
      })),
    );
  }

  /**
   * Drain the mempool. One worker per relayer, each submitting bundles back to back.
   * `onSettled` fires as soon as a bundle resolves so lanes can be released promptly.
   */
  async drain(
    mempool: PrivateMempool,
    maxOpsPerBundle: number,
    onSettled?: (result: BundleResult) => void,
  ): Promise<BundleResult[]> {
    const results: BundleResult[] = [];

    await Promise.all(
      this.relayers.map(async (relayer) => {
        for (;;) {
          const bundle = mempool.takeBundle(maxOpsPerBundle);
          if (bundle.length === 0) return;
          const result = await this.submit(relayer, bundle);
          results.push(result);
          onSettled?.(result);
        }
      }),
    );

    return results;
  }

  private async submit(relayer: Relayer, bundle: PendingOp[]): Promise<BundleResult> {
    const ops = bundle.map((p) => p.op);
    const args = [ops, relayer.account.address] as const;
    const base = {
      address: this.entryPoint,
      abi: entryPointAbi,
      functionName: 'handleOps',
      args,
      account: relayer.account,
    } as const;

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
        error: `simulation failed: ${describeError(error)}`,
        opSuccess: new Map(),
      };
    }

    let txHash: Hex;
    try {
      txHash = await relayer.wallet.writeContract({
        ...base,
        chain: relayer.wallet.chain,
        nonce: relayer.nonce,
        gas: (gas * 12n) / 10n,
      });
      // Only advance once the node has accepted the transaction, otherwise the
      // relayer would leave a nonce gap and strand its own later sends.
      relayer.nonce += 1;
    } catch (error) {
      return {
        relayer: relayer.account.address,
        ops: bundle,
        mined: false,
        error: `send failed: ${describeError(error)}`,
        opSuccess: new Map(),
      };
    }

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    const opSuccess = new Map<Hex, boolean>();

    if (receipt.status === 'success') {
      const events = parseEventLogs({
        abi: entryPointAbi,
        eventName: 'UserOperationEvent',
        logs: receipt.logs,
      });
      for (const event of events) {
        opSuccess.set(event.args.userOpHash, event.args.success);
      }
    }

    return {
      relayer: relayer.account.address,
      ops: bundle,
      txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      mined: receipt.status === 'success',
      error: receipt.status === 'success' ? undefined : 'transaction reverted',
      opSuccess,
    };
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const match = error.message.match(/(AA\d{2}[^"\n]*)/);
    if (match) return match[1]!.trim();
    return error.message.split('\n')[0]!.trim();
  }
  return String(error);
}
