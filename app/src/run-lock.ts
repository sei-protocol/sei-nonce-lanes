import { FileLock } from './file-lock.js';

/** Coordinates every nonce-lane workflow for one trader, even across journals. */
export class SenderRunLock {
  private constructor(private readonly lock: FileLock) {}

  static async acquire(path: string): Promise<SenderRunLock> {
    return new SenderRunLock(
      await FileLock.acquire(path, {
        heldMessage: (owner, lockPath) =>
          `another trader operation process (pid ${owner.pid}) owns the sender-wide lock ${lockPath}`,
      }),
    );
  }

  /** Re-check holdership before anything irreversible, such as signing. */
  async assertHeld(): Promise<void> {
    await this.lock.assertHeld();
  }

  async release(): Promise<void> {
    await this.lock.release();
  }
}
