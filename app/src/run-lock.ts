import { randomUUID } from 'node:crypto';
import { mkdir, open as openFile, readFile, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Coordinates every nonce-lane workflow for one trader, even across journals. */
export class SenderRunLock {
  private released = false;

  private constructor(
    private readonly path: string,
    private readonly token: string,
    private readonly handle: FileHandle,
  ) {}

  static async acquire(path: string): Promise<SenderRunLock> {
    await mkdir(dirname(path), { recursive: true });
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
        return new SenderRunLock(path, token, handle);
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
      }

      const owner = await readOwner(path);
      if (owner && isProcessAlive(owner.pid)) {
        throw new Error(
          `another trader operation process (pid ${owner.pid}) owns the sender-wide lock ${path}`,
        );
      }
      await unlink(path).catch((error) => {
        if (!hasErrorCode(error, 'ENOENT')) throw error;
      });
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.handle.close();
    const owner = await readOwner(this.path);
    if (owner?.token !== this.token) return;
    await unlink(this.path).catch((error) => {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    });
  }
}

async function readOwner(path: string): Promise<{ pid: number; token: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as {
      pid?: unknown;
      token?: unknown;
    };
    if (typeof value.pid !== 'number' || typeof value.token !== 'string') return undefined;
    return { pid: value.pid, token: value.token };
  } catch {
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
