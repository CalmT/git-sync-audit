import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  CircleDot,
  Code2,
  Bot,
  BrainCircuit,
  Download,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react';
import type { AiReview, AuditReport, CommitDetails, CommitResult, CommitStatus, CompareOptions, RepositoryInfo, ReviewSeverity } from './types';
import Lightfall from './components/Lightfall';

const statusMeta: Record<CommitStatus, { label: string; className: string; icon: typeof AlertCircle }> = {
  missing: { label: '确认漏同步', className: 'danger', icon: AlertCircle },
  equivalent: { label: '已等价同步', className: 'success', icon: Check },
  unknown: { label: '需要确认', className: 'warning', icon: CircleDot },
};

const severityMeta: Record<ReviewSeverity | 'none', { label: string; className: string }> = {
  critical: { label: '严重', className: 'critical' },
  high: { label: '高风险', className: 'high' },
  medium: { label: '中风险', className: 'medium' },
  low: { label: '低风险', className: 'low' },
  none: { label: '未发现问题', className: 'none' },
};

const categoryLabels: Record<string, string> = {
  boundary: '边界条件',
  error_handling: '异常处理',
  performance: '性能',
  security: '安全',
  correctness: '正确性',
  maintainability: '可维护性',
};

const backgroundParticleColors = ['#2F9E65', '#C69831', '#5D8F79'];
const recommendedModels = ['gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-astra'];

function readableError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function reportToMarkdown(report: AuditReport) {
  const lines = [
    '# Git 分支同步检查报告',
    '',
    `- 仓库：${report.repository.name}`,
    `- 源分支：\`${report.source}\``,
    `- 目标分支：\`${report.target}\``,
    `- 检查模式：${report.mode === 'patch' ? '补丁等价' : '严格提交'}`,
    `- 检查时间：${formatDate(report.checkedAt)}`,
    '',
    `共发现 ${report.summary.missing} 条漏同步、${report.summary.equivalent} 条等价同步、${report.summary.unknown} 条需要确认。`,
    '',
    '| 状态 | 提交 | 作者 | 时间 | 标题 |',
    '| --- | --- | --- | --- | --- |',
    ...report.results.map((item) =>
      `| ${statusMeta[item.status].label} | \`${item.shortHash}\` | ${item.authorName} | ${formatDate(item.authoredAt)} | ${item.subject.replaceAll('|', '\\|')} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="field-label">{children}</label>;
}

function DiffView({ diff }: { diff: string }) {
  let oldLine = 0;
  let newLine = 0;
  const rows = diff.split('\n').map((content, index) => {
    let kind = 'context';
    let oldNumber: number | null = null;
    let newNumber: number | null = null;
    const hunk = content.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      kind = 'hunk';
    } else if (content.startsWith('diff --git') || content.startsWith('index ') || content.startsWith('--- ') || content.startsWith('+++ ')) {
      kind = 'header';
    } else if (content.startsWith('+')) {
      kind = 'addition';
      newNumber = newLine++;
    } else if (content.startsWith('-')) {
      kind = 'deletion';
      oldNumber = oldLine++;
    } else if (content.startsWith('\\ No newline')) {
      kind = 'notice';
    } else {
      oldNumber = oldLine++;
      newNumber = newLine++;
    }
    return { key: `${index}-${kind}`, kind, content: content || ' ', oldNumber, newNumber };
  });

  return (
    <div className="diff-view" role="region" aria-label="代码差异">
      {rows.map((row) => (
        <div className={`diff-line ${row.kind}`} key={row.key}>
          <span className="diff-line-number">{row.oldNumber ?? ''}</span>
          <span className="diff-line-number">{row.newNumber ?? ''}</span>
          <code>{row.content}</code>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onChoose }: { onChoose: () => void }) {
  return (
    <main className="welcome">
      <div className="welcome-mark"><GitBranch size={34} /></div>
      <div className="eyebrow">LOCAL · SAFE · EXPLAINABLE</div>
      <h1>找出没有同步的提交</h1>
      <p>比较两个 Git 分支，识别真正遗漏的改动，同时排除 cherry-pick 和 rebase 造成的假象。</p>
      <button className="primary large" onClick={onChoose}>
        <FolderGit2 size={19} /> 选择本地仓库
      </button>
      <div className="promise-row">
        <span><ShieldCheck size={16} /> 只读检查</span>
        <span><Code2 size={16} /> 本地运行</span>
        <span><GitCommitHorizontal size={16} /> 补丁等价识别</span>
      </div>
    </main>
  );
}

export default function App() {
  const [repo, setRepo] = useState<RepositoryInfo | null>(null);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [author, setAuthor] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [pathFilter, setPathFilter] = useState('');
  const [mode, setMode] = useState<'strict' | 'patch'>('patch');
  const [includeMerges, setIncludeMerges] = useState(false);
  const [report, setReport] = useState<AuditReport | null>(null);
  const [selected, setSelected] = useState<CommitResult | null>(null);
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | CommitStatus>('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gpt-5.4-mini');
  const [availableModels, setAvailableModels] = useState(recommendedModels);
  const [customModel, setCustomModel] = useState(false);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [rememberApiKey, setRememberApiKey] = useState(true);
  const [hasAvailableApiKey, setHasAvailableApiKey] = useState(false);
  const [hasSavedApiKey, setHasSavedApiKey] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [reviewConsent, setReviewConsent] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [aiReview, setAiReview] = useState<AiReview | null>(null);
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  useEffect(() => {
    window.gitAudit.loadAiSettings().then((settings) => {
      setModel(settings.model);
      setRememberApiKey(settings.rememberApiKey);
      setHasAvailableApiKey(settings.hasApiKey);
      setHasSavedApiKey(settings.rememberApiKey);
      setAvailableModels((current) => [...new Set([...current, settings.model])]);
    }).catch(() => {
      // The app remains usable when secure storage is temporarily unavailable.
    });
  }, []);

  const chooseRepository = async () => {
    const path = await window.gitAudit.selectRepository();
    if (!path) return;
    setBusy(true);
    setError('');
    try {
      const info = await window.gitAudit.inspectRepository(path);
      setRepo(info);
      setSource(info.currentBranch || info.branches[0] || '');
      const fallback = info.branches.find((branch) => branch !== info.currentBranch) || '';
      setTarget(fallback);
      setReport(null);
      setSelected(null);
      setDetails(null);
      setAiReview(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const runAudit = async () => {
    if (!repo) return;
    setBusy(true);
    setError('');
    setSelected(null);
    setDetails(null);
    setAiReview(null);
    try {
      const options: CompareOptions = {
        repoPath: repo.root,
        source,
        target,
        author,
        since,
        until,
        pathFilter,
        includeMerges,
        mode,
      };
      const nextReport = await window.gitAudit.compare(options);
      setReport(nextReport);
      setStatusFilter('all');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectCommit = async (commit: CommitResult) => {
    if (!repo) return;
    setSelected(commit);
    setDetails(null);
    setAiReview(null);
    setDetailsBusy(true);
    try {
      setDetails(await window.gitAudit.getCommitDetails(repo.root, commit.hash));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDetailsBusy(false);
    }
  };

  const runAiReview = async () => {
    if (!repo || !selected) return;
    if (!apiKey && !hasAvailableApiKey) {
      setSettingsOpen(true);
      setError('请先配置 OpenAI API Key。');
      return;
    }
    if (!reviewConsent) {
      setError('请先确认允许把当前提交的代码差异发送给模型。');
      return;
    }
    setReviewBusy(true);
    setError('');
    try {
      const result = await window.gitAudit.reviewCommit({
        repoPath: repo.root,
        hash: selected.hash,
        apiKey,
        model,
      });
      setAiReview(result);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setReviewBusy(false);
    }
  };

  const loadAvailableModels = async () => {
    if (!apiKey.trim() && !hasAvailableApiKey) {
      setError('请先填写 OpenAI API Key。');
      return;
    }
    setModelsBusy(true);
    setError('');
    try {
      const accountModels = await window.gitAudit.listModels(apiKey.trim() || undefined);
      const merged = [...new Set([...recommendedModels, ...accountModels])];
      setAvailableModels(merged);
      if (accountModels.length === 0) setError('连接成功，但没有找到适合代码审查的 GPT-5/GPT-6 文本模型。');
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setModelsBusy(false);
    }
  };

  const saveSettings = async () => {
    if (!model.trim()) return;
    setSettingsBusy(true);
    setError('');
    try {
      const saved = await window.gitAudit.saveAiSettings({
        apiKey: apiKey.trim() || undefined,
        model: model.trim(),
        rememberApiKey,
      });
      setHasAvailableApiKey(saved.hasApiKey);
      setHasSavedApiKey(saved.rememberApiKey);
      setRememberApiKey(saved.rememberApiKey);
      setApiKey('');
      setSettingsOpen(false);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setSettingsBusy(false);
    }
  };

  const clearSavedKey = async () => {
    setSettingsBusy(true);
    setError('');
    try {
      await window.gitAudit.clearSavedApiKey();
      setApiKey('');
      setHasAvailableApiKey(false);
      setHasSavedApiKey(false);
      setRememberApiKey(false);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setSettingsBusy(false);
    }
  };

  const filteredResults = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (report?.results ?? []).filter((item) => {
      const matchesStatus = statusFilter === 'all' || item.status === statusFilter;
      const matchesSearch = !query || [item.subject, item.hash, item.authorName, item.authorEmail, ...item.files]
        .some((value) => value.toLocaleLowerCase().includes(query));
      return matchesStatus && matchesSearch;
    });
  }, [report, search, statusFilter]);

  const exportReport = async (format: 'json' | 'markdown') => {
    if (!report) return;
    const content = format === 'json' ? JSON.stringify(report, null, 2) : reportToMarkdown(report);
    await window.gitAudit.exportReport({ content, format });
  };

  return (
    <div className="app-shell">
      <div className="ambient-background">
        <Lightfall colors={backgroundParticleColors} backgroundColor="#E1EEE5" speed={2} streakCount={6} streakWidth={0.34} streakLength={0.5} density={0.58} glow={0.86} opacity={0.92} dpr={2} />
      </div>
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><GitBranch size={19} /></span> Git Sync Audit</div>
        {repo && (
          <div className="repo-chip" title={repo.root}>
            <FolderGit2 size={16} /> <strong>{repo.name}</strong><span>{repo.root}</span>
          </div>
        )}
        <div className="topbar-actions">
          <button className="ghost" onClick={() => setSettingsOpen(true)}><BrainCircuit size={16} /> AI 设置</button>
          {repo && <button className="ghost" onClick={chooseRepository}><RefreshCw size={16} /> 更换仓库</button>}
          <span className="read-only"><ShieldCheck size={15} /> 只读模式</span>
        </div>
      </header>

      {error && (
        <div className="error-banner"><AlertCircle size={17} /><span>{error}</span><button onClick={() => setError('')}><X size={16} /></button></div>
      )}

      {!repo ? <EmptyState onChoose={chooseRepository} /> : (
        <div className={`workspace ${detailsExpanded ? 'details-expanded' : ''}`}>
          <aside className="control-panel">
            <div className="panel-heading"><div><span>检查条件</span><p>定义提交的同步方向</p></div><Settings2 size={19} /></div>

            {repo.isShallow && <div className="shallow-warning"><AlertCircle size={16} /> 当前是浅克隆，结果可能不完整。</div>}

            <div className="field">
              <FieldLabel>源分支</FieldLabel>
              <div className="select-wrap"><GitBranch size={16} /><select value={source} onChange={(e) => setSource(e.target.value)}>{repo.branches.map((branch) => <option key={branch}>{branch}</option>)}</select><ChevronDown size={15} /></div>
            </div>
            <div className="direction"><span /><ArrowRight size={16} /><span /></div>
            <div className="field">
              <FieldLabel>目标分支</FieldLabel>
              <div className="select-wrap"><GitBranch size={16} /><select value={target} onChange={(e) => setTarget(e.target.value)}>{repo.branches.map((branch) => <option key={branch}>{branch}</option>)}</select><ChevronDown size={15} /></div>
            </div>

            <div className="divider" />

            <div className="field">
              <FieldLabel>提交作者</FieldLabel>
              <div className="select-wrap"><UserRound size={16} /><select value={author} onChange={(e) => setAuthor(e.target.value)}><option value="">所有作者</option>{repo.authors.map((item) => <option key={`${item.name}-${item.email}`} value={item.email}>{item.name} · {item.email}</option>)}</select><ChevronDown size={15} /></div>
            </div>
            <div className="date-grid">
              <div className="field"><FieldLabel>开始日期</FieldLabel><input type="date" value={since} onChange={(e) => setSince(e.target.value)} /></div>
              <div className="field"><FieldLabel>结束日期</FieldLabel><input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></div>
            </div>
            <div className="field">
              <FieldLabel>限定文件路径</FieldLabel>
              <div className="input-wrap"><FileCode2 size={16} /><input placeholder="例如 src/api" value={pathFilter} onChange={(e) => setPathFilter(e.target.value)} /></div>
            </div>

            <div className="field">
              <FieldLabel>判断方式</FieldLabel>
              <div className="mode-switch">
                <button className={mode === 'patch' ? 'active' : ''} onClick={() => setMode('patch')}>补丁等价<span>推荐</span></button>
                <button className={mode === 'strict' ? 'active' : ''} onClick={() => setMode('strict')}>严格 SHA</button>
              </div>
              <p className="field-help">补丁等价模式可识别 cherry-pick 或 rebase 后的相同改动。</p>
            </div>
            <label className="check-row"><input type="checkbox" checked={includeMerges} onChange={(e) => setIncludeMerges(e.target.checked)} /><span>包含合并提交</span></label>

            <button className="primary run-button" disabled={busy || !source || !target || source === target} onClick={runAudit}>
              {busy ? <LoaderCircle className="spin" size={18} /> : <Search size={18} />}
              {busy ? '正在分析提交历史…' : '开始检查'}
            </button>
          </aside>

          <section className="results-panel">
            {!report ? (
              <div className="preflight">
                <div className="preflight-icon"><GitCommitHorizontal size={30} /></div>
                <h2>准备检查分支同步情况</h2>
                <p>选择左侧条件并开始检查。分析只会读取提交历史，不会切换或修改任何分支。</p>
                <div className="branch-route"><code>{source || '源分支'}</code><ArrowRight size={18} /><code>{target || '目标分支'}</code></div>
              </div>
            ) : (
              <>
                <div className="results-header">
                  <div><div className="eyebrow">AUDIT RESULT</div><h1>同步检查结果</h1><p><code>{report.source}</code><ArrowRight size={13} /><code>{report.target}</code> · {formatDate(report.checkedAt)}</p></div>
                  <div className="export-menu">
                    <button className="secondary" onClick={() => exportReport('markdown')}><Download size={16} /> 导出 Markdown</button>
                    <button className="icon-button" title="导出 JSON" onClick={() => exportReport('json')}><Code2 size={17} /></button>
                  </div>
                </div>

                <div className="summary-grid">
                  <button className={`summary-card danger ${statusFilter === 'missing' ? 'selected' : ''}`} onClick={() => setStatusFilter(statusFilter === 'missing' ? 'all' : 'missing')}><span>确认漏同步</span><strong>{report.summary.missing}</strong><small>目标分支未发现等价改动</small></button>
                  <button className={`summary-card success ${statusFilter === 'equivalent' ? 'selected' : ''}`} onClick={() => setStatusFilter(statusFilter === 'equivalent' ? 'all' : 'equivalent')}><span>已等价同步</span><strong>{report.summary.equivalent}</strong><small>包含 cherry-pick / rebase</small></button>
                  <button className={`summary-card warning ${statusFilter === 'unknown' ? 'selected' : ''}`} onClick={() => setStatusFilter(statusFilter === 'unknown' ? 'all' : 'unknown')}><span>需要确认</span><strong>{report.summary.unknown}</strong><small>共同历史不足或范围特殊</small></button>
                </div>

                <div className="list-toolbar">
                  <div className="search-box"><Search size={16} /><input placeholder="搜索提交、作者或文件…" value={search} onChange={(e) => setSearch(e.target.value)} />{search && <button onClick={() => setSearch('')}><X size={14} /></button>}</div>
                  <span>{filteredResults.length} 条记录</span>
                </div>

                <div className="commit-list">
                  {filteredResults.length === 0 ? <div className="empty-results"><Check size={24} /><strong>没有符合条件的提交</strong><span>可以调整筛选条件后重新检查。</span></div> : filteredResults.map((commit) => {
                    const meta = statusMeta[commit.status];
                    const StatusIcon = meta.icon;
                    return (
                      <button key={commit.hash} className={`commit-row ${selected?.hash === commit.hash ? 'selected' : ''}`} onClick={() => selectCommit(commit)}>
                        <span className={`status-icon ${meta.className}`}><StatusIcon size={16} /></span>
                        <span className="commit-main"><strong>{commit.subject}</strong><span><code>{commit.shortHash}</code> · {commit.authorName} · {formatDate(commit.authoredAt)}</span></span>
                        <span className="file-count"><FileCode2 size={14} /> {commit.files.length}</span>
                        <span className={`status-pill ${meta.className}`}>{meta.label}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </section>

          {selected && (
            <aside className="details-panel">
              <div className="details-heading"><div><span>提交详情</span><code>{selected.shortHash}</code></div><div className="details-actions"><button className="icon-button" title={detailsExpanded ? '退出放大' : '放大差异区域'} onClick={() => setDetailsExpanded((value) => !value)}>{detailsExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button><button className="icon-button" title="关闭详情" onClick={() => { setSelected(null); setDetails(null); setDetailsExpanded(false); }}><X size={17} /></button></div></div>
              {detailsBusy ? <div className="details-loading"><LoaderCircle className="spin" size={22} /> 正在读取提交内容…</div> : details && (
                <>
                  <div className={`detail-verdict ${statusMeta[selected.status].className}`}><strong>{statusMeta[selected.status].label}</strong><span>{selected.reason}</span></div>
                  <section className="ai-review-card">
                    <div className="ai-review-title"><span><Sparkles size={15} /> AI 代码审查</span>{aiReview && <em className={`risk-badge ${severityMeta[aiReview.riskLevel].className}`}>{severityMeta[aiReview.riskLevel].label}</em>}</div>
                    {!aiReview ? (
                      <>
                        <p>检查边界条件、异常处理、性能瓶颈、安全风险和逻辑正确性。</p>
                        <label className="consent-row"><input type="checkbox" checked={reviewConsent} onChange={(event) => setReviewConsent(event.target.checked)} /><span>我确认当前提交的代码差异将发送给 OpenAI API</span></label>
                        <button className="ai-review-button" disabled={reviewBusy || !reviewConsent} onClick={runAiReview}>{reviewBusy ? <LoaderCircle className="spin" size={16} /> : <Bot size={16} />}{reviewBusy ? '模型正在审查…' : '审查这个提交'}</button>
                      </>
                    ) : (
                      <div className="review-result">
                        <p className="review-summary">{aiReview.summary}</p>
                        {aiReview.truncated && <div className="truncated-note"><AlertCircle size={13} /> diff 过大，本次审查只覆盖了前一部分内容。</div>}
                        {aiReview.findings.length === 0 ? <div className="review-clean"><Check size={16} /> 未发现有明确证据的实质问题</div> : (
                          <div className="finding-list">{aiReview.findings.map((finding, index) => (
                            <article className="finding" key={`${finding.file}-${finding.line}-${index}`}>
                              <div className="finding-heading"><span className={`risk-badge ${severityMeta[finding.severity].className}`}>{severityMeta[finding.severity].label}</span><strong>{finding.title}</strong></div>
                              <div className="finding-location"><code>{finding.file}{finding.line ? `:${finding.line}` : ''}</code><span>{categoryLabels[finding.category]}</span></div>
                              <p><b>证据</b>{finding.evidence}</p>
                              <p><b>影响</b>{finding.impact}</p>
                              <div className="minimal-fix"><b>最小修改方案</b><span>{finding.minimalFix}</span></div>
                            </article>
                          ))}</div>
                        )}
                        <div className="review-footer"><span>{aiReview.model}{aiReview.usage ? ` · ${aiReview.usage.totalTokens} tokens` : ''}</span><button onClick={runAiReview} disabled={reviewBusy}><RefreshCw size={13} /> 重新审查</button></div>
                      </div>
                    )}
                  </section>
                  <section className="detail-section"><h3>提交信息</h3><p className="commit-message">{details.message}</p><dl><div><dt>作者</dt><dd>{details.authorName}<small>{details.authorEmail}</small></dd></div><div><dt>提交时间</dt><dd>{formatDate(details.authoredAt)}</dd></div><div><dt>完整 SHA</dt><dd><code className="hash-code">{details.hash}</code></dd></div></dl></section>
                  <section className="detail-section"><h3>变更统计</h3><pre className="stat-block">{details.stat || '没有文件变更'}</pre></section>
                  <section className="detail-section diff-section"><div className="diff-title"><h3>代码差异</h3><span><i className="legend-add" /> 新增 <i className="legend-del" /> 删除</span></div>{details.diff ? <DiffView diff={details.diff} /> : <div className="no-diff">没有可显示的差异</div>}</section>
                </>
              )}
            </aside>
          )}
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <div className="settings-modal" role="dialog" aria-modal="true" aria-label="AI 模型设置">
            <div className="modal-heading"><div className="modal-icon"><BrainCircuit size={21} /></div><div><h2>AI 模型设置</h2><p>用于对选中的提交进行代码审查</p></div><button className="icon-button" onClick={() => setSettingsOpen(false)}><X size={17} /></button></div>
            <div className="privacy-note"><ShieldCheck size={17} /><div><strong>{hasSavedApiKey ? 'API Key 已由系统安全存储保护' : '可以安全地永久保存 API Key'}</strong><span>macOS 使用 Keychain 加密，配置文件中只保存密文；代码仅在你主动审查时发送。</span></div></div>
            <div className="field"><div className="model-label-row"><FieldLabel>OpenAI API Key</FieldLabel>{hasSavedApiKey && <span className="saved-key-status"><Check size={11} /> 已保存</span>}</div><input className="modal-input" type="password" autoComplete="off" placeholder={hasSavedApiKey ? '已保存；留空可继续使用' : 'sk-…'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></div>
            <label className="remember-key-row"><input type="checkbox" checked={rememberApiKey} onChange={(event) => setRememberApiKey(event.target.checked)} /><span><strong>永久保存到本机</strong><small>使用系统安全存储加密，下次启动无需重新填写</small></span></label>
            <div className="field"><div className="model-label-row"><FieldLabel>模型</FieldLabel><button className="model-refresh" disabled={(!apiKey.trim() && !hasAvailableApiKey) || modelsBusy} onClick={loadAvailableModels}>{modelsBusy ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />}{modelsBusy ? '正在获取…' : '获取账户模型'}</button></div><div className="modal-select-wrap"><select className="modal-input" value={customModel ? '__custom' : model} onChange={(event) => { if (event.target.value === '__custom') { setCustomModel(true); setModel(''); } else { setCustomModel(false); setModel(event.target.value); } }}>{availableModels.map((item) => <option value={item} key={item}>{item}{item === 'gpt-5.4-mini' ? ' · 推荐' : ''}</option>)}<option value="__custom">自定义模型…</option></select><ChevronDown size={15} /></div>{customModel && <input className="modal-input custom-model-input" value={model} onChange={(event) => setModel(event.target.value)} placeholder="输入模型 ID" autoFocus />}</div>
            <p className="settings-help">可以直接选择推荐模型，或使用 API Key 获取当前账户实际可用的模型。API 请求设置为不保存模型响应。</p>
            <button className="primary modal-save" disabled={settingsBusy || (!apiKey.trim() && !hasAvailableApiKey) || !model.trim()} onClick={saveSettings}>{settingsBusy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{settingsBusy ? '正在保存…' : rememberApiKey ? '安全保存设置' : '保存本次会话设置'}</button>
            {hasSavedApiKey && <button className="clear-key-button" disabled={settingsBusy} onClick={clearSavedKey}>清除已保存的 API Key</button>}
          </div>
        </div>
      )}
    </div>
  );
}
