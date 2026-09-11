import type { Hex } from 'viem';
import type { UserOp } from './userop.js';

export type PendingOp = {
  op: UserOp;
  hash: Hex;
  lane: bigint;
  seq: bigint;
  orderId: bigint;
  /** Human label for the run report, e.g. "order 7 (expected revert)". */
  label: string;
};

/**
 * An in-process queue of signed UserOperations, packed into `handleOps` bundles.
 *
 * This is not an alt-mempool. Nothing is gossiped, admitted from outside, or held
 * for a competing bundler; the queue lives and dies with the process that filled
 * it. Keeping it in-process removes the two limits that make the canonical
 * ERC-4337 mempool unusable for high-frequency submission:
 *
 * - `SAME_SENDER_MEMPOOL_COUNT` (ERC-7562) caps an unstaked sender at 4 pending
 *   UserOperations. That is a wallet number, not a trading number.
 * - The ERC-7562 validation rules exist so competing bundlers can safely pack
 *   strangers' operations together. Every op here comes from one account we
 *   control, so there are no strangers to defend against.
 *
 * The EntryPoint still enforces everything that protects funds: signature over the
 * EIP-712 op hash, per-lane nonce uniqueness, and prefund solvency.
 */
export class BundlingQueue {
  private queue: PendingOp[] = [];

  add(pending: PendingOp): void {
    this.queue.push(pending);
  }

  get size(): number {
    return this.queue.length;
  }

  /**
   * Take up to `max` operations for one `handleOps` call.
   *
   * Never puts two ops from the same lane in one bundle. Same-lane ops are ordered,
   * so batching them means a single failure can invalidate the rest of the lane. The
   * lane pool already guarantees one in-flight op per lane; this is a second latch.
   */
  takeBundle(max: number): PendingOp[] {
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new Error(`bundle size must be a positive safe integer; received ${max}`);
    }
    const bundle: PendingOp[] = [];
    const lanes = new Set<bigint>();
    const deferred: PendingOp[] = [];

    while (this.queue.length > 0 && bundle.length < max) {
      const next = this.queue.shift()!;
      if (lanes.has(next.lane)) {
        deferred.push(next);
        continue;
      }
      lanes.add(next.lane);
      bundle.push(next);
    }

    // Put anything we skipped back at the front, preserving order.
    this.queue.unshift(...deferred);
    return bundle;
  }
}
