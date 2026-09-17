import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { abortSync, compareBranches, finalizeSync, getCommitDetails, inspectRepository, startSync } from '../electron/git-service.mjs';

const exec = promisify(execFile);

async function git(repo, ...args) {
  const { stdout } = await exec('git', ['-C', repo, ...args]);
  return stdout.trim();
}

async function commitFile(repo, file, content, message) {
  await writeFile(path.join(repo, file), content);
  await git(repo, 'add', file);
  await git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

test('detects missing and patch-equivalent commits without changing the repository', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'git-sync-audit-'));
  t.after(() => rm(repo, { recursive: true, force: true }));

  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Audit Tester');
  await git(repo, 'config', 'user.email', 'audit@example.com');
  await commitFile(repo, 'base.txt', 'base\n', 'base commit');
  await git(repo, 'checkout', '-b', 'release');
  const equivalentSourceHash = await commitFile(repo, 'feature.txt', 'feature\n', 'shared feature');
  await git(repo, 'checkout', 'main');
  await commitFile(repo, 'target-only.txt', 'target\n', 'target-only change');
  await git(repo, 'cherry-pick', equivalentSourceHash);
  await git(repo, 'checkout', 'release');
  const missingHash = await commitFile(repo, 'missing.txt', 'missing\n', 'missing feature');

  const info = await inspectRepository(repo);
  assert.equal(info.name, path.basename(repo));
  assert.deepEqual(info.branches, ['main', 'release']);
  assert.equal(info.currentBranch, 'release');
  assert.equal(info.authors[0].email, 'audit@example.com');

  const patchReport = await compareBranches({
    repoPath: repo,
    source: 'release',
    target: 'main',
    mode: 'patch',
    author: '',
    since: '',
    until: '',
    pathFilter: '',
    includeMerges: false,
  });
  assert.equal(patchReport.summary.missing, 1);
  assert.equal(patchReport.summary.equivalent, 1);
  assert.equal(patchReport.results.find((item) => item.hash === missingHash)?.status, 'missing');
  assert.equal(patchReport.results.find((item) => item.hash === equivalentSourceHash)?.status, 'equivalent');
  await assert.rejects(
    startSync({ repoPath: repo, source: 'release', target: 'main', commitHashes: [equivalentSourceHash] }),
    /已有等价改动/,
  );

  const strictReport = await compareBranches({
    repoPath: repo,
    source: 'release',
    target: 'main',
    mode: 'strict',
    author: '',
    since: '',
    until: '',
    pathFilter: '',
    includeMerges: false,
  });
  assert.equal(strictReport.summary.missing, 2);

  const details = await getCommitDetails(repo, missingHash);
  assert.equal(details.message, 'missing feature');
  assert.match(details.diff, /missing\.txt/);
  assert.equal(await git(repo, 'branch', '--show-current'), 'release');
});

test('rejects equal source and target branches', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'git-sync-audit-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Audit Tester');
  await git(repo, 'config', 'user.email', 'audit@example.com');
  await commitFile(repo, 'base.txt', 'base\n', 'base commit');

  await assert.rejects(
    compareBranches({ repoPath: repo, source: 'main', target: 'main', mode: 'patch' }),
    /不能相同/,
  );
});

test('syncs selected commits through an isolated branch before fast-forwarding the target', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'git-sync-audit-sync-success-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Sync Tester');
  await git(repo, 'config', 'user.email', 'sync@example.com');
  const baseHash = await commitFile(repo, 'base.txt', 'base\n', 'base commit');
  await git(repo, 'checkout', '-b', 'feature');
  const featureHash = await commitFile(repo, 'feature.txt', 'feature\n', 'feature commit');
  await git(repo, 'checkout', 'main');

  const sync = await startSync({ repoPath: repo, source: 'feature', target: 'main', commitHashes: [featureHash] });
  assert.equal(sync.status, 'ready');
  assert.deepEqual(sync.appliedCommits, [featureHash]);
  assert.equal(await git(repo, 'rev-parse', 'main'), baseHash);
  assert.match(await git(repo, 'branch', '--list', sync.syncBranch), /git-sync-audit\//);

  const completed = await finalizeSync(sync.operationId);
  assert.equal(completed.status, 'completed');
  assert.equal(await git(repo, 'rev-parse', 'main'), completed.resultHash);
  assert.equal(await git(repo, 'branch', '--list', sync.syncBranch), '');
  assert.match(await git(repo, 'log', '-1', '--format=%B'), new RegExp(`cherry picked from commit ${featureHash}`));
});

test('keeps the target unchanged and can clean up after a cherry-pick conflict', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'git-sync-audit-sync-conflict-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Sync Tester');
  await git(repo, 'config', 'user.email', 'sync@example.com');
  await commitFile(repo, 'shared.txt', 'base\n', 'base commit');
  await git(repo, 'checkout', '-b', 'feature');
  const featureHash = await commitFile(repo, 'shared.txt', 'source change\n', 'source change');
  await git(repo, 'checkout', 'main');
  const targetHash = await commitFile(repo, 'shared.txt', 'target change\n', 'target change');

  const sync = await startSync({ repoPath: repo, source: 'feature', target: 'main', commitHashes: [featureHash] });
  assert.equal(sync.status, 'conflict');
  assert.deepEqual(sync.conflicts, ['shared.txt']);
  assert.equal(await git(repo, 'rev-parse', 'main'), targetHash);

  await abortSync(sync.operationId);
  assert.equal(await git(repo, 'branch', '--list', sync.syncBranch), '');
  assert.equal(await git(repo, 'rev-parse', 'main'), targetHash);
});
