import assert from 'node:assert/strict';
import { mkdtemp, open as openFile, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileLock } from './file-lock.js';

const heldMessage = (owner: { pid: number }, path: string) =>
  `another process (pid ${owner.pid}) owns ${path}`;

async function withDirectory(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'sei-file-lock-'));
  try {
    await run(join(directory, 'test.lock'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('excludes a second holder and publishes its owner payload atomically', async () => {
  await withDirectory(async (path) => {
    const first = await FileLock.acquire(path, { heldMessage });
    const owner = JSON.parse(await readFile(path, 'utf8')) as { pid: number; token: string };
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.token, first.owner.token);

    await assert.rejects(FileLock.acquire(path, { heldMessage }), /another process \(pid \d+\) owns/);
    await first.release();

    const second = await FileLock.acquire(path, { heldMessage });
    await second.release();
  });
});

test('replaces a lock owned by a dead process', async () => {
  await withDirectory(async (path) => {
    await writeFile(path, JSON.stringify({ pid: 2_147_483_647, token: 'stale' }), { mode: 0o600 });
    const lock = await FileLock.acquire(path, { heldMessage });
    await lock.release();
  });
});

test('waits out a lock file whose payload has not been written yet', async () => {
  await withDirectory(async (path) => {
    // The window a holder occupies between creating the path and fsyncing its
    // payload. Reading no owner here must not mean "free to delete".
    const publishing = await openFile(path, 'wx', 0o600);
    try {
      await assert.rejects(
        FileLock.acquire(path, { heldMessage, contendedTimeoutMs: 100 }),
        /could not acquire the lock/,
      );
      assert.equal(await readFile(path, 'utf8'), '');
    } finally {
      await publishing.close();
    }
  });
});

test('refuses a torn lock file rather than deleting it', async () => {
  await withDirectory(async (path) => {
    await writeFile(path, '{"pid":', { mode: 0o600 });
    await assert.rejects(
      FileLock.acquire(path, { heldMessage, contendedTimeoutMs: 100 }),
      /could not acquire the lock/,
    );
    assert.equal(await readFile(path, 'utf8'), '{"pid":');
  });
});

test('detects that its lock file was replaced by another process', async () => {
  await withDirectory(async (path) => {
    const lock = await FileLock.acquire(path, { heldMessage });
    await lock.assertHeld();

    await unlink(path);
    const usurper = await FileLock.acquire(path, { heldMessage });
    await assert.rejects(lock.assertHeld(), /lost the lock/);

    await usurper.release();
  });
});

test('release leaves behind a lock file it no longer owns', async () => {
  await withDirectory(async (path) => {
    const lock = await FileLock.acquire(path, { heldMessage });
    await unlink(path);
    await writeFile(path, JSON.stringify({ pid: process.pid, token: 'someone-else' }), {
      mode: 0o600,
    });

    await lock.release();

    const survivor = JSON.parse(await readFile(path, 'utf8')) as { token: string };
    assert.equal(survivor.token, 'someone-else');
  });
});
