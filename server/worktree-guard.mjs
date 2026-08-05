import { execFile } from 'node:child_process';
import { open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { ApiError } from './database.mjs';

const execFileAsync = promisify(execFile);
const OPERATION_MARKERS = [
  'index.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG',
  'rebase-merge', 'rebase-apply',
];

async function git(cwd, args) {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

async function gitDirectory(cwd) {
  const value = await git(cwd, ['rev-parse', '--git-dir']);
  return path.resolve(cwd, value);
}

export async function inspectWorktree(cwd) {
  try {
    const [root, branch, head, status, gitDir] = await Promise.all([
      git(cwd, ['rev-parse', '--show-toplevel']),
      git(cwd, ['branch', '--show-current']),
      git(cwd, ['rev-parse', 'HEAD']),
      git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
      gitDirectory(cwd),
    ]);
    if (!branch) throw new ApiError(409, 'WORKTREE_DETACHED', 'The task worktree has a detached HEAD');
    for (const marker of OPERATION_MARKERS) {
      try {
        await readFile(path.join(gitDir, marker));
        throw new ApiError(409, 'WORKTREE_GIT_OPERATION', `Git operation marker '${marker}' is present`);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error?.code !== 'ENOENT' && error?.code !== 'EISDIR') throw error;
        if (error?.code === 'EISDIR') {
          throw new ApiError(409, 'WORKTREE_GIT_OPERATION', `Git operation marker '${marker}' is present`);
        }
      }
    }
    return { root: path.resolve(root), branch, head, status, gitDir };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, 'WORKTREE_INVALID', `Cannot inspect task worktree: ${error.message}`);
  }
}

function sameState(left, right) {
  return left && right
    && path.resolve(left.root) === path.resolve(right.root)
    && left.branch === right.branch
    && left.head === right.head
    && left.status === right.status;
}

export async function acquireWorktreeGuard(cwd, expectedState = null) {
  const initial = await inspectWorktree(cwd);
  if (!expectedState && initial.status) {
    throw new ApiError(409, 'WORKTREE_DIRTY', 'The task worktree must be clean before its first run');
  }
  if (expectedState && !sameState(initial, expectedState)) {
    throw new ApiError(409, 'WORKTREE_CHANGED', 'The task worktree changed outside this conversation');
  }
  const lockPath = path.join(initial.gitDir, 'dashi-taskboard-run.lock');
  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new ApiError(409, 'WORKTREE_BUSY', 'Another browser run owns this task worktree');
    }
    throw error;
  }
  try {
    const checked = await inspectWorktree(cwd);
    if (!sameState(initial, checked)) {
      throw new ApiError(409, 'WORKTREE_CHANGED', 'The task worktree changed while acquiring its run lock');
    }
    return {
      state: initial,
      async release() {
        let state = initial;
        try { state = await inspectWorktree(cwd); } catch {}
        await handle.close();
        await rm(lockPath, { force: true });
        return state;
      },
    };
  } catch (error) {
    await handle.close();
    await rm(lockPath, { force: true });
    throw error;
  }
}
