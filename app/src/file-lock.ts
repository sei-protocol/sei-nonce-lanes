import { randomUUID } from 'node:crypto';
import { link, mkdir, open as openFile, readFile, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

export type LockOwner = { pid: number; token: string; createdAt: number };

export type FileLockOptions = {
  /** Message thrown when a live process already holds the lock. */
  heldMessage: (owner: LockOwner, path: string) => string;
  /** How long to keep waiting while other processes contend for the same path. */
  contendedTimeoutMs?: number;
};

/**
 * Mutual exclusion between processes, backed by one file.
 *
 * Holdership means "the lock path currently names my inode", not "the lock file
 * exists". The distinction is forced by staleness: a lock left behind by a dead
 * process has to be removable, POSIX cannot unlink a *specific* inode, so every
 * reclaim is a read followed by an unlink and a second reclaimer can land in
 * between. Identifying the lock by inode lets the loser of that race find out
 * from `assertHeld` instead of two processes both believing they hold it.
 *
 * The file is published with its payload already in place, by fsyncing a staging
 * file and hard-linking it into position. `open(path, 'wx')` followed by a write
 * would instead publish the path first, and a contender that reads the file in
 * that window sees no owner at all.
 */
export class FileLock {
  private released = false;

  private constructor(
    readonly path: string,
    readonly owner: LockOwner,
    private readonly handle: FileHandle,
    private readonly identity: { dev: number; ino: number },
  ) {}

  static async acquire(path: string, options: FileLockOptions): Promise<FileLock> {
    const contendedTimeoutMs = options.contendedTimeoutMs ?? 2_000;
    const deadline = Date.now() + contendedTimeoutMs;
    await mkdir(dirname(path), { recursive: true });

    for (;;) {
      const claim = await claimPath(path);
      if (claim) {
        if (await namesInode(path, claim.identity)) {
          return new FileLock(path, claim.owner, claim.handle, claim.identity);
        }
        // Another process reclaimed the path between the link and this check.
        await claim.handle.close();
      } else {
        const owner = await readOwner(path);
        if (typeof owner === 'object') {
          if (isProcessAlive(owner.pid)) throw new Error(options.heldMessage(owner, path));
          if (await reclaim(path, owner)) continue;
        }
        // An `unreadable` owner is either a torn write or a holder mid-publish.
        // Neither is ours to delete: treating it as free is how a live holder
        // gets evicted. A `missing` owner means the file vanished under us, so
        // fall through and race for it again.
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `could not acquire the lock ${path} within ${contendedTimeoutMs}ms: it is being ` +
            'created and removed by other processes, or its owner cannot be read',
        );
      }
      await delay(20);
    }
  }

  /**
   * Confirm this process still holds the lock. Worth calling before each
   * operation the lock protects, because acquisition on its own cannot promise
   * holdership at any later instant.
   */
  async assertHeld(): Promise<void> {
    if (this.released) throw new Error(`the lock ${this.path} was already released`);
    if (await namesInode(this.path, this.identity)) return;
    throw new Error(
      `lost the lock ${this.path}: it now names a different file, so another process may ` +
        'hold it and this one must not continue',
    );
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const held = await namesInode(this.path, this.identity);
    await this.handle.close();
    if (!held) return;
    await unlink(this.path).catch((error) => {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    });
  }
}

type Claim = { handle: FileHandle; owner: LockOwner; identity: { dev: number; ino: number } };

/** Publish a fully written lock file atomically. Undefined means someone holds it. */
async function claimPath(path: string): Promise<Claim | undefined> {
  const owner: LockOwner = { pid: process.pid, token: randomUUID(), createdAt: Date.now() };
  const staging = `${path}.${process.pid}.${owner.token}.stage`;
  const handle = await openFile(staging, 'wx', 0o600);
  let claim: Claim | undefined;
  try {
    await handle.writeFile(JSON.stringify(owner) + '\n', 'utf8');
    await handle.sync();
    const { dev, ino } = await handle.stat();
    try {
      await link(staging, path);
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
      return undefined;
    }
    claim = { handle, owner, identity: { dev, ino } };
    return claim;
  } finally {
    await unlink(staging).catch(() => undefined);
    if (!claim) await handle.close();
  }
}

/**
 * Remove a lock whose recorded process is gone. Re-reading the owner immediately
 * before the unlink keeps this from deleting a file other than the one judged
 * stale. It cannot close that gap completely, which is what `assertHeld` covers.
 */
async function reclaim(path: string, stale: LockOwner): Promise<boolean> {
  const current = await readOwner(path);
  if (typeof current !== 'object' || current.token !== stale.token) return false;
  await unlink(path).catch((error) => {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  });
  return true;
}

async function readOwner(path: string): Promise<LockOwner | 'missing' | 'unreadable'> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return 'missing';
    throw error;
  }
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof value.pid !== 'number' || typeof value.token !== 'string') return 'unreadable';
    return {
      pid: value.pid,
      token: value.token,
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    };
  } catch {
    return 'unreadable';
  }
}

async function namesInode(path: string, identity: { dev: number; ino: number }): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.dev === identity.dev && stats.ino === identity.ino;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
