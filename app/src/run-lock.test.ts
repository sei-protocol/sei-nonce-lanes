import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SenderRunLock } from './run-lock.js';

test('coordinates workflows that use different operation journals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sei-sender-run-lock-'));
  const path = join(directory, 'sender.lock');
  try {
    const first = await SenderRunLock.acquire(path);
    await assert.rejects(SenderRunLock.acquire(path), /another trader operation process/);
    await first.release();

    const second = await SenderRunLock.acquire(path);
    await second.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('replaces a lock owned by a dead process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sei-sender-run-lock-'));
  const path = join(directory, 'sender.lock');
  try {
    await writeFile(path, JSON.stringify({ pid: 2_147_483_647, token: 'stale' }), {
      mode: 0o600,
    });
    const lock = await SenderRunLock.acquire(path);
    await lock.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
