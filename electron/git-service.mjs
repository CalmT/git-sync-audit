import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HASH_PATTERN = /^[0-9a-f]{7,64}$/i;
const syncOperations = new Map();

function runGit(repoPath, args, { maxBuffer = 30 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, ...args], {
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
    const stdout = [];
    const stderr = [];
    let size = 0;

    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBuffer) {
        child.kill();
        reject(new Error('Git 输出过大，请缩小日期或路径范围。'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => reject(new Error(`无法运行 Git：${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `Git 命令失败 (${code})`));
    });
  });
}

function assertPath(repoPath) {
  if (!repoPath || typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) {
    throw new Error('请选择有效的本地仓库目录。');
  }
}

function assertRef(ref, branches) {
  if (!ref || !branches.includes(ref)) throw new Error(`分支不存在：${ref || '(空)'}`);
}

function assertHashes(hashes) {
  if (!Array.isArray(hashes) || hashes.length === 0) throw new Error('请至少选择一个需要同步的提交。');
  if (hashes.length > 100) throw new Error('单次最多同步 100 个提交，请分批操作。');
  if (hashes.some((hash) => typeof hash !== 'string' || !HASH_PATTERN.test(hash))) {
    throw new Error('待同步提交中包含无效的提交 ID。');
  }
}

async function localBranches(repoPath) {
  const output = await runGit(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return output.split('\n').filter(Boolean);
}

function parseWorktrees(output) {
  return output.trim().split(/\n\n+/).filter(Boolean).map((block) => {
    const result = { path: '', branch: '' };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) result.path = line.slice('worktree '.length);
      if (line.startsWith('branch refs/heads/')) result.branch = line.slice('branch refs/heads/'.length);
    }
    return result;
  });
}

async function cleanupSyncOperation(operation, deleteBranch = true) {
  let worktreeRemoved = true;
  try {
    await runGit(operation.repoPath, ['worktree', 'remove', '--force', operation.worktreePath]);
  } catch {
    worktreeRemoved = false;
  }
  await rm(operation.tempRoot, { recursive: true, force: true });
  if (!worktreeRemoved) {
    try {
      await runGit(operation.repoPath, ['worktree', 'prune']);
    } catch {
      // Branch cleanup below remains best-effort if Git metadata is already inconsistent.
    }
  }
  if (deleteBranch) {
    try {
      await runGit(operation.repoPath, ['branch', '-D', operation.syncBranch]);
    } catch {
      // The safety branch may already have been removed manually.
    }
  }
  syncOperations.delete(operation.id);
}

export async function inspectRepository(repoPath) {
  assertPath(repoPath);
  const inside = (await runGit(repoPath, ['rev-parse', '--is-inside-work-tree'])).trim();
  if (inside !== 'true') throw new Error('所选目录不是 Git 工作区。');

  const root = (await runGit(repoPath, ['rev-parse', '--show-toplevel'])).trim();
  const branchOutput = await runGit(root, [
    'for-each-ref',
    '--format=%(refname:short)%00%(HEAD)',
    'refs/heads',
    'refs/remotes',
  ]);
  let currentBranch = '';
  const branches = branchOutput
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, head] = line.split('\0');
      if (head === '*') currentBranch = name;
      return name;
    })
    .filter((name) => !name.endsWith('/HEAD'))
    .sort((a, b) => a.localeCompare(b));
  const localBranchOutput = await runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const remoteBranchOutput = await runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  const localBranchNames = localBranchOutput.split('\n').filter(Boolean).sort((a, b) => a.localeCompare(b));
  const remoteBranchNames = remoteBranchOutput.split('\n').filter(Boolean).filter((name) => !name.endsWith('/HEAD')).sort((a, b) => a.localeCompare(b));

  const authorOutput = await runGit(root, ['log', '--all', '--format=%aN%x00%aE']);
  const authorMap = new Map();
  for (const line of authorOutput.split('\n')) {
    if (!line) continue;
    const [name, email] = line.split('\0');
    authorMap.set(`${name}\0${email}`, { name, email });
  }

  return {
    root,
    name: path.basename(root),
    currentBranch,
    branches,
    localBranches: localBranchNames,
    remoteBranches: remoteBranchNames,
    authors: [...authorMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    isShallow: (await runGit(root, ['rev-parse', '--is-shallow-repository'])).trim() === 'true',
  };
}

export async function fetchRemoteBranches(repoPath) {
  const repository = await inspectRepository(repoPath);
  const remotes = (await runGit(repository.root, ['remote'])).split('\n').filter(Boolean);
  if (remotes.length === 0) throw new Error('当前仓库没有配置远端仓库。');
  await runGit(repository.root, ['fetch', '--all', '--prune']);
  return {
    repository: await inspectRepository(repository.root),
    remotes,
    fetchedAt: new Date().toISOString(),
  };
}

export async function pushLocalBranch(repoPath, branch) {
  const repository = await inspectRepository(repoPath);
  assertRef(branch, repository.localBranches);
  const tracking = await runGit(repository.root, [
    'for-each-ref',
    '--format=%(upstream:remotename)%00%(upstream:remoteref)',
    `refs/heads/${branch}`,
  ]);
  const [remote, remoteRef] = tracking.trim().split('\0');
  if (!remote || !remoteRef?.startsWith('refs/heads/')) {
    throw new Error(`本地分支 ${branch} 没有配置上游分支，请先使用 Git 配置 upstream。`);
  }
  const remoteBranch = remoteRef.slice('refs/heads/'.length);
  await runGit(repository.root, ['push', remote, `refs/heads/${branch}:refs/heads/${remoteBranch}`]);
  return {
    branch,
    remote,
    remoteBranch,
    remoteRef: `${remote}/${remoteBranch}`,
    pushedHash: (await runGit(repository.root, ['rev-parse', branch])).trim(),
    pushedAt: new Date().toISOString(),
  };
}

function parseLog(output) {
  const records = output.split('\x1e').filter((record) => record.trim());
  return records.map((record) => {
    const [metadata, ...fileLines] = record.replace(/^\n/, '').split('\n');
    const [hash, shortHash, authorName, authorEmail, authoredAt, subject] = metadata.split('\x1f');
    return {
      hash,
      shortHash,
      authorName,
      authorEmail,
      authoredAt,
      subject,
      files: fileLines.filter(Boolean),
    };
  });
}

function normalizeSubject(subject) {
  return subject.trim().toLocaleLowerCase().replace(/\s*([:：])\s*/g, '$1');
}

function migrationFileIdentity(file) {
  if (!/(?:^|\/)V\d+(?:\.\d+)+_patch\//i.test(file)) return null;
  const match = path.basename(file).match(/^_(\d+)_([^/]+)$/);
  if (!match) return null;
  return { migrationId: match[1], logicalName: match[2] };
}

function normalizeMigrationContent(content, migrationId) {
  return content
    .replace(/^\uFEFF/, '')
    .replaceAll('\r\n', '\n')
    .replaceAll(migrationId, 'MIGRATION_ID')
    .replace(/(EMigrationPatch\()\d+(,\s*MIGRATION_ID\b)/g, '$1BASE_MIGRATION_ID$2')
    .replace(/V\d+(?:\.\d+)+_patch/gi, 'VERSION_patch')
    .trimEnd();
}

async function addedFilesForCommit(repoPath, hash) {
  const output = await runGit(repoPath, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', hash]);
  const entries = output.split('\n').filter(Boolean).map((line) => {
    const [status, ...fileParts] = line.split('\t');
    return { status, file: fileParts.join('\t') };
  });
  if (!entries.length || entries.some((entry) => entry.status !== 'A')) return null;
  return entries.map((entry) => entry.file);
}

async function versionedMigrationEquivalent(repoPath, sourceCommit, candidateHash) {
  const [sourceFiles, targetFiles] = await Promise.all([
    addedFilesForCommit(repoPath, sourceCommit.hash),
    addedFilesForCommit(repoPath, candidateHash),
  ]);
  if (!sourceFiles) return false;
  if (!targetFiles || sourceFiles.length !== targetFiles.length) return false;

  const sourceMap = new Map();
  for (const file of sourceFiles) {
    const identity = migrationFileIdentity(file);
    if (!identity || sourceMap.has(identity.logicalName)) return false;
    sourceMap.set(identity.logicalName, { file, ...identity });
  }
  const targetMap = new Map();
  for (const file of targetFiles) {
    const identity = migrationFileIdentity(file);
    if (!identity || targetMap.has(identity.logicalName)) return false;
    targetMap.set(identity.logicalName, { file, ...identity });
  }
  if ([...sourceMap.keys()].some((name) => !targetMap.has(name))) return false;

  for (const [name, source] of sourceMap) {
    const target = targetMap.get(name);
    const [sourceContent, targetContent] = await Promise.all([
      runGit(repoPath, ['show', `${sourceCommit.hash}:${source.file}`]),
      runGit(repoPath, ['show', `${candidateHash}:${target.file}`]),
    ]);
    if (normalizeMigrationContent(sourceContent, source.migrationId)
      !== normalizeMigrationContent(targetContent, target.migrationId)) return false;
  }
  return true;
}

async function findVersionedMigrationEquivalents(repoPath, target, commits, patchStatuses) {
  const candidates = commits.filter((commit) => patchStatuses.get(commit.hash) === 'missing'
    && commit.files.length > 0
    && commit.files.every((file) => migrationFileIdentity(file)));
  if (!candidates.length) return new Map();

  const targetLog = await runGit(repoPath, ['log', target, '--no-merges', '--format=%H%x1f%s']);
  const subjects = new Map();
  for (const line of targetLog.split('\n')) {
    if (!line) continue;
    const separator = line.indexOf('\x1f');
    if (separator < 0) continue;
    const hash = line.slice(0, separator);
    const subject = normalizeSubject(line.slice(separator + 1));
    const hashes = subjects.get(subject) ?? [];
    if (hashes.length < 20) hashes.push(hash);
    subjects.set(subject, hashes);
  }

  const equivalents = new Map();
  for (const commit of candidates) {
    for (const candidateHash of subjects.get(normalizeSubject(commit.subject)) ?? []) {
      if (await versionedMigrationEquivalent(repoPath, commit, candidateHash)) {
        equivalents.set(commit.hash, candidateHash);
        break;
      }
    }
  }
  return equivalents;
}

async function cherryStatus(repoPath, source, target) {
  const output = await runGit(repoPath, ['cherry', target, source]);
  const map = new Map();
  for (const line of output.split('\n')) {
    if (!line) continue;
    const marker = line[0];
    const hash = line.slice(2).trim();
    map.set(hash, marker === '-' ? 'equivalent' : 'missing');
  }
  return map;
}

export async function compareBranches(options) {
  const { repoPath, source, target, author, since, until, pathFilter, includeMerges, mode = 'patch' } = options ?? {};
  const repo = await inspectRepository(repoPath);
  assertRef(source, repo.branches);
  assertRef(target, repo.branches);
  if (source === target) throw new Error('源分支和目标分支不能相同。');

  const args = [
    'log',
    source,
    `^${target}`,
    '--date=iso-strict',
    '--format=%x1e%H%x1f%h%x1f%aN%x1f%aE%x1f%aI%x1f%s',
    '--name-only',
  ];
  if (!includeMerges) args.push('--no-merges');
  if (author) args.push(`--author=${author}`);
  if (since) args.push(`--since=${since}`);
  if (until) args.push(`--until=${until}`);
  if (pathFilter) args.push('--', pathFilter);

  const commits = parseLog(await runGit(repo.root, args));
  const patchStatuses = mode === 'patch' ? await cherryStatus(repo.root, source, target) : new Map();
  const migrationEquivalents = mode === 'patch'
    ? await findVersionedMigrationEquivalents(repo.root, target, commits, patchStatuses)
    : new Map();
  const results = commits.map((commit) => ({
    ...commit,
    status: mode === 'patch'
      ? (migrationEquivalents.has(commit.hash) ? 'equivalent' : (patchStatuses.get(commit.hash) ?? 'unknown'))
      : 'missing',
    reason: mode === 'patch'
      ? migrationEquivalents.has(commit.hash)
        ? `目标分支提交 ${migrationEquivalents.get(commit.hash).slice(0, 8)} 中存在版本路径与迁移编号不同、内容等价的脚本`
        : patchStatuses.get(commit.hash) === 'equivalent'
        ? '目标分支中存在补丁内容等价的提交'
        : patchStatuses.has(commit.hash)
          ? '目标分支中未发现相同提交或等价补丁'
          : '提交不在可比较的共同历史范围内'
      : '目标分支的提交历史中不存在该 commit SHA',
  }));

  return {
    repository: { root: repo.root, name: repo.name, isShallow: repo.isShallow },
    source,
    target,
    mode,
    checkedAt: new Date().toISOString(),
    results,
    summary: {
      total: results.length,
      missing: results.filter((item) => item.status === 'missing').length,
      equivalent: results.filter((item) => item.status === 'equivalent').length,
      unknown: results.filter((item) => item.status === 'unknown').length,
    },
  };
}

export async function getCommitDetails(repoPath, hash) {
  assertPath(repoPath);
  if (!HASH_PATTERN.test(hash)) throw new Error('提交 ID 格式无效。');
  const metadata = await runGit(repoPath, [
    'show',
    '--no-patch',
    '--date=iso-strict',
    '--format=%H%x1f%P%x1f%aN%x1f%aE%x1f%aI%x1f%cN%x1f%cE%x1f%cI%x1f%B',
    hash,
  ]);
  const [header, ...body] = metadata.trimEnd().split('\n');
  const [fullHash, parents, authorName, authorEmail, authoredAt, committerName, committerEmail, committedAt, firstLine] = header.split('\x1f');
  const diff = await runGit(repoPath, ['show', '--format=', '--no-ext-diff', '--unified=3', '--no-color', hash]);
  const stat = await runGit(repoPath, ['show', '--format=', '--stat', '--no-color', hash]);
  return {
    hash: fullHash,
    parents: parents ? parents.split(' ') : [],
    authorName,
    authorEmail,
    authoredAt,
    committerName,
    committerEmail,
    committedAt,
    message: [firstLine, ...body].join('\n').trim(),
    stat,
    diff,
  };
}

export async function startSync(options) {
  const { repoPath, source, target, commitHashes } = options ?? {};
  assertPath(repoPath);
  assertHashes(commitHashes);

  const repo = await inspectRepository(repoPath);
  assertRef(source, repo.branches);
  const locals = await localBranches(repo.root);
  assertRef(target, locals);
  if (source === target) throw new Error('源分支和目标分支不能相同。');

  const selected = [...new Set(commitHashes)];
  const range = (await runGit(repo.root, ['rev-list', '--reverse', '--topo-order', source, `^${target}`]))
    .split('\n')
    .filter(Boolean);
  const rangeSet = new Set(range);
  const invalid = selected.filter((hash) => !rangeSet.has(hash));
  if (invalid.length) throw new Error('部分提交已不在源分支的漏同步范围内，请重新检查后再同步。');

  const patchStatuses = await cherryStatus(repo.root, source, target);
  const equivalent = selected.filter((hash) => patchStatuses.get(hash) !== 'missing');
  if (equivalent.length) {
    throw new Error('部分提交在目标分支中已有等价改动。请使用补丁等价模式重新检查，避免重复同步。');
  }

  const orderedCommits = range.filter((hash) => selected.includes(hash));
  for (const hash of orderedCommits) {
    const parents = (await runGit(repo.root, ['rev-list', '--parents', '-n', '1', hash])).trim().split(/\s+/).slice(1);
    if (parents.length > 1) throw new Error(`暂不支持直接同步合并提交：${hash.slice(0, 8)}`);
  }

  const baseTargetHash = (await runGit(repo.root, ['rev-parse', target])).trim();
  const safeTarget = target.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'target';
  const operationId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const syncBranch = `git-sync-audit/${safeTarget}-${operationId}`;
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'git-sync-audit-sync-'));
  const worktreePath = path.join(tempRoot, 'worktree');
  const operation = {
    id: operationId,
    repoPath: repo.root,
    source,
    target,
    baseTargetHash,
    syncBranch,
    tempRoot,
    worktreePath,
    orderedCommits,
    appliedCommits: [],
    status: 'running',
  };

  try {
    await runGit(repo.root, ['branch', syncBranch, target]);
    await runGit(repo.root, ['worktree', 'add', '--quiet', worktreePath, syncBranch]);
    syncOperations.set(operationId, operation);

    for (const hash of orderedCommits) {
      try {
        await runGit(worktreePath, ['cherry-pick', '-x', hash]);
        operation.appliedCommits.push(hash);
      } catch (error) {
        let conflicts = [];
        try {
          conflicts = (await runGit(worktreePath, ['diff', '--name-only', '--diff-filter=U']))
            .split('\n')
            .filter(Boolean);
        } catch {
          // Preserve the original cherry-pick failure when conflict discovery fails.
        }
        operation.status = 'conflict';
        operation.failedCommit = hash;
        operation.conflicts = conflicts;
        operation.errorMessage = error instanceof Error ? error.message : String(error);
        return {
          operationId,
          status: 'conflict',
          source,
          target,
          baseTargetHash,
          syncBranch,
          orderedCommits,
          appliedCommits: operation.appliedCommits,
          failedCommit: hash,
          conflicts,
          message: conflicts.length
            ? `同步在 ${hash.slice(0, 8)} 发生冲突。`
            : `无法应用提交 ${hash.slice(0, 8)}。`,
        };
      }
    }

    operation.status = 'ready';
    operation.resultHash = (await runGit(worktreePath, ['rev-parse', 'HEAD'])).trim();
    return {
      operationId,
      status: 'ready',
      source,
      target,
      baseTargetHash,
      resultHash: operation.resultHash,
      syncBranch,
      orderedCommits,
      appliedCommits: operation.appliedCommits,
      conflicts: [],
      message: `${orderedCommits.length} 个提交已在安全分支中验证成功。`,
    };
  } catch (error) {
    await cleanupSyncOperation(operation);
    throw error;
  }
}

export async function finalizeSync(operationId) {
  const operation = syncOperations.get(operationId);
  if (!operation || operation.status !== 'ready') throw new Error('同步操作不存在或尚未准备完成。');

  const currentTargetHash = (await runGit(operation.repoPath, ['rev-parse', operation.target])).trim();
  if (currentTargetHash !== operation.baseTargetHash) {
    throw new Error('目标分支在同步期间发生了变化。为避免覆盖新提交，请终止本次同步并重新检查。');
  }

  const worktrees = parseWorktrees(await runGit(operation.repoPath, ['worktree', 'list', '--porcelain']));
  const targetWorktree = worktrees.find((item) => item.branch === operation.target);
  if (targetWorktree) {
    const status = await runGit(targetWorktree.path, ['status', '--porcelain=v1']);
    if (status.trim()) throw new Error('目标分支所在工作区有未提交修改，请处理后再应用同步结果。');
    await runGit(targetWorktree.path, ['merge', '--ff-only', operation.syncBranch]);
  } else {
    await runGit(operation.repoPath, [
      'update-ref',
      `refs/heads/${operation.target}`,
      operation.resultHash,
      operation.baseTargetHash,
    ]);
  }

  const result = {
    status: 'completed',
    target: operation.target,
    previousHash: operation.baseTargetHash,
    resultHash: operation.resultHash,
    appliedCommits: operation.appliedCommits,
  };
  await cleanupSyncOperation(operation);
  return result;
}

export async function abortSync(operationId) {
  const operation = syncOperations.get(operationId);
  if (!operation) return { status: 'aborted' };
  if (operation.status === 'conflict') {
    try {
      await runGit(operation.worktreePath, ['cherry-pick', '--abort']);
    } catch {
      // Cleanup still removes the isolated worktree and safety branch.
    }
  }
  await cleanupSyncOperation(operation);
  return { status: 'aborted' };
}
