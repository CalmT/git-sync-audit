export type Author = { name: string; email: string };

export type RepositoryInfo = {
  root: string;
  name: string;
  currentBranch: string;
  branches: string[];
  authors: Author[];
  isShallow: boolean;
};

export type RecentRepository = {
  path: string;
  name: string;
  lastOpenedAt: string;
};

export type CommitStatus = 'missing' | 'equivalent' | 'unknown';

export type CommitResult = {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  files: string[];
  status: CommitStatus;
  reason: string;
};

export type AuditReport = {
  repository: { root: string; name: string; isShallow: boolean };
  source: string;
  target: string;
  mode: 'strict' | 'patch';
  checkedAt: string;
  results: CommitResult[];
  summary: { total: number; missing: number; equivalent: number; unknown: number };
};

export type CommitDetails = {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committerName: string;
  committerEmail: string;
  committedAt: string;
  message: string;
  stat: string;
  diff: string;
};

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';

export type ReviewFinding = {
  severity: ReviewSeverity;
  category: 'boundary' | 'error_handling' | 'performance' | 'security' | 'correctness' | 'maintainability';
  title: string;
  file: string;
  line: number | null;
  evidence: string;
  impact: string;
  minimalFix: string;
};

export type AiReview = {
  summary: string;
  riskLevel: ReviewSeverity | 'none';
  findings: ReviewFinding[];
  model: string;
  reviewedAt: string;
  truncated: boolean;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
};

export type CompareOptions = {
  repoPath: string;
  source: string;
  target: string;
  author: string;
  since: string;
  until: string;
  pathFilter: string;
  includeMerges: boolean;
  mode: 'strict' | 'patch';
};

export type SyncResult = {
  operationId: string;
  status: 'ready' | 'conflict';
  source: string;
  target: string;
  baseTargetHash: string;
  resultHash?: string;
  syncBranch: string;
  orderedCommits: string[];
  appliedCommits: string[];
  failedCommit?: string;
  conflicts: string[];
  message: string;
};

export type SyncCompletion = {
  status: 'completed';
  target: string;
  previousHash: string;
  resultHash: string;
  appliedCommits: string[];
};

export type GitAuditApi = {
  selectRepository(): Promise<string | null>;
  inspectRepository(path: string): Promise<RepositoryInfo>;
  loadRepositoryHistory(): Promise<{ recentRepositories: RecentRepository[] }>;
  forgetRepository(path: string): Promise<{ recentRepositories: RecentRepository[] }>;
  compare(options: CompareOptions): Promise<AuditReport>;
  getCommitDetails(repoPath: string, hash: string): Promise<CommitDetails>;
  startSync(options: { repoPath: string; source: string; target: string; commitHashes: string[] }): Promise<SyncResult>;
  finalizeSync(operationId: string): Promise<SyncCompletion>;
  abortSync(operationId: string): Promise<{ status: 'aborted' }>;
  reviewCommit(options: { repoPath: string; hash: string; apiKey: string; model: string }): Promise<AiReview>;
  listModels(apiKey?: string): Promise<string[]>;
  loadAiSettings(): Promise<{ model: string; rememberApiKey: boolean; hasApiKey: boolean }>;
  saveAiSettings(settings: { apiKey?: string; model: string; rememberApiKey: boolean }): Promise<{ model: string; rememberApiKey: boolean; hasApiKey: boolean }>;
  clearSavedApiKey(): Promise<{ model: string; rememberApiKey: false; hasApiKey: false }>;
  exportReport(payload: { content: string; format: 'json' | 'markdown' }): Promise<string | null>;
};
