import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { abortSync, compareBranches, fetchRemoteBranches, finalizeSync, getCommitDetails, inspectRepository, pushLocalBranch, startSync } from '../electron/git-service.mjs';

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
  assert.deepEqual(info.localBranches, ['main', 'release']);
  assert.deepEqual(info.remoteBranches, []);
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

test('recognizes versioned migration scripts with renamed paths and migration ids', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'git-sync-audit-migrations-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(repo, 'init', '-b', 'target');
  await git(repo, 'config', 'user.name', 'Migration Tester');
  await git(repo, 'config', 'user.email', 'migration@example.com');
  await commitFile(repo, 'base.txt', 'base\n', 'base commit');
  await git(repo, 'checkout', '-b', 'source');

  const sourceDir = path.join(repo, 'src', 'V5.26.05.25_patch');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, '_5920260901091655_add_invoice_config.cs'), '[EMigrationPatch(5020260524225415, 5920260901091655, "invoice", "V5.26.05.25_patch")]\n');
  await writeFile(path.join(sourceDir, '_5920260901091655_add_invoice_config.sql'), '\uFEFFALTER TABLE invoice ADD config int;\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', '同步补丁脚本:电子发票完善脚本');
  const sourceHash = await git(repo, 'rev-parse', 'HEAD');

  await git(repo, 'checkout', 'target');
  await commitFile(repo, 'target-only.txt', 'target\n', 'target-only change');
  const targetDir = path.join(repo, 'src', 'V5.26.06.25_patch');
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(targetDir, '_5920260901092546_add_invoice_config.cs'), '[EMigrationPatch(5020260618200127, 5920260901092546, "invoice", "V5.26.06.25_patch")]\n');
  await writeFile(path.join(targetDir, '_5920260901092546_add_invoice_config.sql'), 'ALTER TABLE invoice ADD config int;\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', '同步补丁脚本: 电子发票完善脚本');
  const targetHash = await git(repo, 'rev-parse', 'HEAD');

  assert.match(await git(repo, 'cherry', 'target', 'source'), /^\+/);
  const report = await compareBranches({ repoPath: repo, source: 'source', target: 'target', mode: 'patch', includeMerges: false });
  const result = report.results.find((item) => item.hash === sourceHash);
  assert.equal(result?.status, 'equivalent');
  assert.match(result?.reason ?? '', new RegExp(targetHash.slice(0, 8)));
  assert.equal(report.summary.missing, 0);
  assert.equal(report.summary.equivalent, 1);
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

  const reportAfterSync = await compareBranches({
    repoPath: repo,
    source: 'feature',
    target: 'main',
    mode: 'patch',
    includeMerges: false,
  });
  assert.equal(reportAfterSync.summary.missing, 0);
  assert.equal(reportAfterSync.summary.equivalent, 1);
  assert.equal(reportAfterSync.results[0]?.status, 'equivalent');
});

test('separates local and remote-tracking branches and refreshes remote refs', async (t) => {
  const remote = await mkdtemp(path.join(tmpdir(), 'git-sync-audit-remote-'));
  const repo = await mkdtemp(path.join(tmpdir(), 'git-sync-audit-fetch-'));
  const publisher = await mkdtemp(path.join(tmpdir(), 'git-sync-audit-publisher-'));
  t.after(() => Promise.all([
    rm(remote, { recursive: true, force: true }),
    rm(repo, { recursive: true, force: true }),
    rm(publisher, { recursive: true, force: true }),
  ]));

  await git(remote, 'init', '--bare');
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Fetch Tester');
  await git(repo, 'config', 'user.email', 'fetch@example.com');
  await commitFile(repo, 'base.txt', 'base\n', 'base commit');
  await git(repo, 'remote', 'add', 'origin', remote);
  await git(repo, 'push', '-u', 'origin', 'main');

  await git(publisher, 'clone', remote, '.');
  await git(publisher, 'config', 'user.name', 'Publisher');
  await git(publisher, 'config', 'user.email', 'publisher@example.com');
  await git(publisher, 'checkout', 'main');
  const remoteHash = await commitFile(publisher, 'remote.txt', 'remote\n', 'remote commit');
  await git(publisher, 'push', 'origin', 'main');

  const before = await inspectRepository(repo);
  assert.deepEqual(before.localBranches, ['main']);
  assert.deepEqual(before.remoteBranches, ['origin/main']);
  assert.notEqual(await git(repo, 'rev-parse', 'origin/main'), remoteHash);

  const refreshed = await fetchRemoteBranches(repo);
  assert.deepEqual(refreshed.remotes, ['origin']);
  assert.equal(await git(repo, 'rev-parse', 'origin/main'), remoteHash);
  assert.deepEqual(refreshed.repository.remoteBranches, ['origin/main']);

  await git(repo, 'merge', '--ff-only', 'origin/main');
  const localHash = await commitFile(repo, 'local.txt', 'local\n', 'local commit');
  const pushed = await pushLocalBranch(repo, 'main');
  assert.equal(pushed.remoteRef, 'origin/main');
  assert.equal(pushed.pushedHash, localHash);
  assert.equal(await git(remote, 'rev-parse', 'refs/heads/main'), localHash);
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
