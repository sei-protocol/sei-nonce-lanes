import type { Address, PublicClient } from 'viem';
import { entryPointAbi } from './abi.js';
import { decodeLaneNonce } from './userop.js';

/**
 * A fixed pool of ERC-4337 nonce lanes for one account.
 *
 * Two rules drive the whole design:
 *
 * 1. Ops on different lanes are independent. Whatever happens to one, the others
 *    stay valid and includable.
 * 2. Ops on the *same* lane are strictly ordered, and a missing sequence strands
 *    every later one. So a lane may hold at most one in-flight op at a time.
 *
 * Rule 2 makes the pool size the ceiling on in-flight operations. Widen the pool
 * to fire more at once.
 *
 * Sequences are tracked locally after a single batched read at startup, so the
 * hot path never calls `eth_getTransactionCount` or `getNonce`. That matters on
 * Sei in particular, where `eth_getTransactionCount(addr, "pending")` returns the
 * same value as `"latest"` and cannot be used to discover in-flight nonces.
 */
export class LanePool {
  private readonly nextSeq = new Map<bigint, bigint>();
  private readonly available: bigint[] = [];
  private readonly inFlight = new Set<bigint>();

  private constructor(
    private readonly client: PublicClient,
    private readonly entryPoint: Address,
    private readonly sender: Address,
    lanes: { lane: bigint; seq: bigint }[],
  ) {
    for (const { lane, seq } of lanes) {
      this.nextSeq.set(lane, seq);
      this.available.push(lane);
    }
  }

  static async create(
    client: PublicClient,
    entryPoint: Address,
    sender: Address,
    size: number,
  ): Promise<LanePool> {
    const lanes = Array.from({ length: size }, (_, i) => BigInt(i + 1));

    // Read sequences at startup, then track them locally. Cap concurrency so a
    // public RPC does not rate-limit a 32-lane pool.
    const nonces = await mapPool(lanes, 4, (lane) =>
      client.readContract({
        address: entryPoint,
        abi: entryPointAbi,
        functionName: 'getNonce',
        args: [sender, lane],
      }),
    );

    return new LanePool(
      client,
      entryPoint,
      sender,
      lanes.map((lane, i) => ({ lane, seq: decodeLaneNonce(nonces[i]!).seq })),
    );
  }

  get idleCount(): number {
    return this.available.length;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  sequence(lane: bigint): bigint | undefined {
    return this.nextSeq.get(lane);
  }

  /** Reserve a specific lane while recovering a durable pending operation. */
  reserve(lane: bigint, seq: bigint): void {
    const current = this.nextSeq.get(lane);
    if (current === undefined) throw new Error(`lane ${lane} is outside the configured pool`);
    if (current !== seq) throw new Error(`lane ${lane} is at seq ${current}, pending op expects ${seq}`);
    if (this.inFlight.has(lane)) throw new Error(`lane ${lane} is already in flight`);
    const availableIndex = this.available.indexOf(lane);
    if (availableIndex === -1) throw new Error(`lane ${lane} is not available`);
    this.available.splice(availableIndex, 1);
    this.inFlight.add(lane);
  }

  /** Reserve a lane. Returns undefined when every lane already has an op in flight. */
  acquire(): { lane: bigint; seq: bigint } | undefined {
    const lane = this.available.pop();
    if (lane === undefined) return undefined;
    this.inFlight.add(lane);
    return { lane, seq: this.nextSeq.get(lane)! };
  }

  /**
   * Release a lane.
   *
   * `consumed` must be true exactly when the `handleOps` transaction was mined
   * successfully, because that is when the EntryPoint advanced the sequence. An op
   * that reverted during *execution* still consumed its sequence. An op in a
   * bundle that reverted during *validation* consumed nothing.
   */
  settle(lane: bigint, consumed: boolean): void {
    if (!this.inFlight.delete(lane)) throw new Error(`lane ${lane} was not in flight`);
    if (consumed) this.nextSeq.set(lane, this.nextSeq.get(lane)! + 1n);
    this.available.push(lane);
  }

  /** Re-read sequences from chain. Use after an ambiguous failure. */
  async resync(lanes: bigint[] = [...this.nextSeq.keys()]): Promise<void> {
    const nonces = await mapPool(lanes, 4, (lane) =>
      this.client.readContract({
        address: this.entryPoint,
        abi: entryPointAbi,
        functionName: 'getNonce',
        args: [this.sender, lane],
      }),
    );
    lanes.forEach((lane, i) => this.nextSeq.set(lane, decodeLaneNonce(nonces[i]!).seq));
  }
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}
