import { randomUUID } from 'node:crypto';
import { mkdir, open as openFile, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Address, Hex } from 'viem';
import type { PendingOp } from './mempool.js';

export type JournalContext = {
  chainId: number;
  entryPoint: Address;
  sender: Address;
};

export type SubmissionAttempt = {
  bundleId: string;
  relayer: Address;
  nonce: number;
  txHash: Hex;
  rawTransaction: Hex;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  submittedAtBlock: bigint;
  createdAt: number;
};

type JournalRecord = {
  pending: PendingOp;
  attempts: SubmissionAttempt[];
  completed?: boolean;
};

type JournalState = {
  version: 1;
  context: JournalContext;
  records: JournalRecord[];
};

export type RecoveryBundle = {
  bundleId: string;
  ops: PendingOp[];
  attempts: SubmissionAttempt[];
};

/**
 * A tiny write-ahead log for signed UserOperations and signed outer transactions.
 *
 * The raw transaction is persisted before broadcast. After a crash, the exact
 * transaction can therefore be safely rebroadcast without creating a second
 * transaction that might race the first one.
 */
export class OperationJournal {
  private writeChain: Promise<void> = Promise.resolve();
  private writeSequence = 0;
  private lock?: { handle: FileHandle; path: string; token: string };

  private constructor(
    private readonly path: string,
    private readonly state: JournalState,
  ) {}

  static async open(path: string, context: JournalContext): Promise<OperationJournal> {
    let state: JournalState = { version: 1, context, records: [] };
    try {
      state = JSON.parse(await readFile(path, 'utf8'), reviveBigInt) as JournalState;
      if (state.version !== 1 || !Array.isArray(state.records)) {
        throw new Error(`unsupported journal format in ${path}`);
      }
      if (state.records.length > 0 && !sameContext(state.context, context)) {
        throw new Error(
          `journal belongs to chain ${state.context.chainId}, sender ${state.context.sender}; ` +
            `refusing to replay it on chain ${context.chainId}, sender ${context.sender}`,
        );
      }
      state.context = context;
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
    return new OperationJournal(path, state);
  }

  get size(): number {
    return this.state.records.filter((record) => !record.completed).length;
  }

  /**
   * Prevent two spray processes from assigning the same lanes or overwriting
   * each other's journal snapshots. A dead process's PID makes its lock stale.
   */
  async acquireLock(): Promise<void> {
    if (this.lock) throw new Error('operation journal is already locked by this process');

    await mkdir(dirname(this.path), { recursive: true });
    const path = `${this.path}.lock`;
    for (;;) {
      const token = randomUUID();
      try {
        const handle = await openFile(path, 'wx', 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }) + '\n',
            'utf8',
          );
          await handle.sync();
        } catch (error) {
          await handle.close();
          await unlink(path).catch(() => undefined);
          throw error;
        }
        this.lock = { handle, path, token };
        return;
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
      }

      const owner = await readLock(path);
      if (owner && isProcessAlive(owner.pid)) {
        throw new Error(`another spray process (pid ${owner.pid}) owns ${path}`);
      }

      // A crash leaves the lock file behind. Remove it only after confirming
      // that its recorded process no longer exists, then retry the atomic open.
      await unlink(path).catch((error) => {
        if (!isFileNotFound(error)) throw error;
      });
    }
  }

  async releaseLock(): Promise<void> {
    const lock = this.lock;
    if (!lock) return;
    this.lock = undefined;
    await lock.handle.close();

    const owner = await readLock(lock.path);
    if (owner?.token !== lock.token) return;
    await unlink(lock.path).catch((error) => {
      if (!isFileNotFound(error)) throw error;
    });
  }

  queuedOps(): PendingOp[] {
    return this.state.records
      .filter((record) => !record.completed && record.attempts.length === 0)
      .map((record) => record.pending);
  }

  recoveryBundles(): RecoveryBundle[] {
    const groups = new Map<string, RecoveryBundle>();
    for (const record of this.state.records) {
      if (record.completed) continue;
      const latest = record.attempts.at(-1);
      if (!latest) continue;
      const group = groups.get(latest.bundleId);
      if (group) {
        group.ops.push(record.pending);
        continue;
      }
      groups.set(latest.bundleId, {
        bundleId: latest.bundleId,
        ops: [record.pending],
        attempts: [...record.attempts],
      });
    }
    return [...groups.values()];
  }

  /** Every operation in the current run, including ones completed before a crash. */
  runOps(): PendingOp[] {
    return this.state.records.map((record) => record.pending);
  }

  /** Operations that still require reconciliation or submission. */
  allOps(): PendingOp[] {
    return this.state.records.filter((record) => !record.completed).map((record) => record.pending);
  }

  async add(ops: PendingOp[]): Promise<void> {
    const known = new Set(this.state.records.map((record) => record.pending.hash));
    for (const pending of ops) {
      if (known.has(pending.hash)) continue;
      this.state.records.push({ pending, attempts: [] });
      known.add(pending.hash);
    }
    await this.persist();
  }

  async recordAttempt(ops: PendingOp[], attempt: SubmissionAttempt): Promise<void> {
    const hashes = new Set(ops.map((pending) => pending.hash));
    let matched = 0;
    for (const record of this.state.records) {
      if (!hashes.has(record.pending.hash)) continue;
      record.attempts.push(attempt);
      matched += 1;
    }
    if (matched !== hashes.size) {
      throw new Error(`cannot record bundle attempt: ${hashes.size - matched} op(s) are missing from journal`);
    }
    await this.persist();
  }

  async clearAttempts(ops: PendingOp[]): Promise<void> {
    const hashes = new Set(ops.map((pending) => pending.hash));
    for (const record of this.state.records) {
      if (hashes.has(record.pending.hash)) record.attempts = [];
    }
    await this.persist();
  }

  async complete(ops: PendingOp[]): Promise<void> {
    const hashes = new Set(ops.map((pending) => pending.hash));
    for (const record of this.state.records) {
      if (hashes.has(record.pending.hash)) record.completed = true;
    }
    await this.persist();
  }

  /**
   * Forget a fully completed run. Completed records stay durable until this
   * point so a crash cannot make the next process replace already-landed work.
   */
  async finishRun(): Promise<void> {
    if (this.size !== 0) throw new Error(`cannot finish run with ${this.size} pending op(s)`);
    this.state.records = [];
    await this.persist();
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, replaceBigInt, 2) + '\n';
    const sequence = this.writeSequence++;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${sequence}.tmp`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.writeChain;
  }
}

function sameContext(a: JournalContext, b: JournalContext): boolean {
  return (
    a.chainId === b.chainId &&
    a.entryPoint.toLowerCase() === b.entryPoint.toLowerCase() &&
    a.sender.toLowerCase() === b.sender.toLowerCase()
  );
}

function replaceBigInt(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? { $bigint: value.toString() } : value;
}

function reviveBigInt(_key: string, value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    '$bigint' in value &&
    typeof value.$bigint === 'string'
  ) {
    return BigInt(value.$bigint);
  }
  return value;
}

function isFileNotFound(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

async function readLock(path: string): Promise<{ pid: number; token: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown; token?: unknown };
    if (typeof value.pid !== 'number' || typeof value.token !== 'string') return undefined;
    return { pid: value.pid, token: value.token };
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, 'EPERM');
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
