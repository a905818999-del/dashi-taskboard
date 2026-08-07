import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { acquireWorktreeGuard, inspectWorktree } from '../server/worktree-guard.mjs';

const execFileAsync = promisify(execFile);

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dashi 工作树 '));
  await execFileAsync('git', ['init', '-b', 'feat/windows-test'], { cwd: directory, windowsHide: true });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory, windowsHide: true });
  await execFileAsync('git', ['config', 'user.name', 'Dashi Test'], { cwd: directory, windowsHide: true });
  await writeFile(path.join(directory, 'README.md'), 'ok\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: directory, windowsHide: true });
  await execFileAsync('git', ['commit', '-m', 'baseline'], { cwd: directory, windowsHide: true });
  return directory;
}

test('worktree guard locks one clean Chinese and spaced path', async () => {
  const directory = await fixture();
  try {
    const first = await acquireWorktreeGuard(directory);
    await assert.rejects(
      acquireWorktreeGuard(directory),
      (error) => error.code === 'WORKTREE_BUSY',
    );
    const state = await first.release();
    assert.equal(state.branch, 'feat/windows-test');
    assert.equal(state.status, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('worktree guard rejects dirty, changed and Git-operation states', async () => {
  const directory = await fixture();
  try {
    const clean = await inspectWorktree(directory);
    await writeFile(path.join(directory, 'outside.txt'), 'changed\n');
    await assert.rejects(acquireWorktreeGuard(directory), (error) => error.code === 'WORKTREE_DIRTY');
    await assert.rejects(acquireWorktreeGuard(directory, clean), (error) => error.code === 'WORKTREE_CHANGED');
    await rm(path.join(directory, 'outside.txt'));
    await writeFile(path.join(directory, '.git', 'index.lock'), 'locked');
    await assert.rejects(acquireWorktreeGuard(directory), (error) => error.code === 'WORKTREE_GIT_OPERATION');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
