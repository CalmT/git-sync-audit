# Git Sync Audit

一个用于检查 Git 分支漏同步提交的本地桌面工具。它可以区分：

- 目标分支中不存在的提交；
- 通过 cherry-pick 或 rebase 已经等价同步的改动；
- 因历史范围不足而无法确认的提交。

应用默认只读，不会切换分支、修改工作区或自动执行 cherry-pick。

## 当前功能

- 选择任意本地 Git 工作区；
- 读取本地分支、远程跟踪分支及提交作者；
- 指定源分支和目标分支；
- 按作者、日期和文件路径筛选；
- 严格 SHA、补丁等价两种检查模式；
- 默认排除 merge commit，可选择包含；
- 查看提交信息、文件统计和完整 diff；
- 按检查状态筛选和全文搜索；
- 导出 Markdown 或 JSON 报告；
- 检测浅克隆并提示结果可能不完整。
- 使用 OpenAI 模型审查指定提交，按严重程度展示边界条件、异常处理、性能、安全和正确性问题；
- 为每个审查问题给出代码证据、影响和最小修改方案。
- 使用 React Bits Lightfall 提供高分辨率动态流光粒子背景；
- 支持放大提交详情，diff 逐行显示双侧行号，并明显区分新增、删除、区块和文件头。

## AI 代码审查

在提交详情中打开“AI 设置”，填写 OpenAI API Key 并选择模型。可选择只在当前会话使用，也可永久保存：macOS 版本使用系统 Keychain 加密，配置文件中只写入密文，应用不会把明文 Key 返回给页面。开始审查前，用户还需要单独确认允许发送当前提交的 diff。

推荐列表包含 `gpt-5.5`，也可以通过 API Key 调用模型列表接口，加载当前账户实际可用的 GPT 文本模型；模型选择会随设置一同保存。网络请求使用 Electron 的 Chromium 网络栈，以兼容系统代理、PAC 和常见企业代理认证。

默认模型为 `gpt-5.4-mini`，请求使用 Responses API 的结构化输出，并设置 `store: false`。超大 diff 会在界面中明确提示截断，模型被要求只报告能够从现有差异中具体举证的问题。

## 本地运行

需要 Node.js 20 或更高版本，以及可从命令行使用的 Git。

```bash
npm install
npm run dev
```

## 测试与构建

```bash
npm test
npx tsc --noEmit
npm run build:web
```

构建桌面安装包：

```bash
npm run build
```

安装包默认生成在 `release/` 目录。

## 检查规则

严格模式使用 Git 的可达性判断，检查源分支中的 commit SHA 是否存在于目标分支历史中。

补丁等价模式进一步使用 Git 的稳定补丁标识判断内容是否等价，因此可以识别常见的 cherry-pick 和 rebase。对于没有共同历史、浅克隆或复杂冲突后手工修改的提交，工具会保守地标记为需要确认或漏同步，不声称百分之百等价。

## 项目结构

```text
electron/
  main.mjs          Electron 主进程与窗口
  preload.cjs       安全的渲染进程桥接层
  git-service.mjs   Git 仓库读取和分支比较逻辑
  settings-store.mjs AI 设置与系统安全存储
src/
  App.tsx           主界面及交互
  styles.css        桌面界面样式
tests/
  git-service.test.mjs
```
