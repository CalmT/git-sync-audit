import { spawn } from 'node:child_process';
import path from 'node:path';

const HASH_PATTERN = /^[0-9a-f]{7,64}$/i;

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
    authors: [...authorMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    isShallow: (await runGit(root, ['rev-parse', '--is-shallow-repository'])).trim() === 'true',
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
  const results = commits.map((commit) => ({
    ...commit,
    status: mode === 'patch' ? (patchStatuses.get(commit.hash) ?? 'unknown') : 'missing',
    reason: mode === 'patch'
      ? patchStatuses.get(commit.hash) === 'equivalent'
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
