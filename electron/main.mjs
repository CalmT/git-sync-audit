import { app, BrowserWindow, dialog, ipcMain, net } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRepository, compareBranches, getCommitDetails } from './git-service.mjs';
import { listAvailableModels, reviewCommit } from './ai-review-service.mjs';
import { clearSavedApiKey, loadAiSettings, resolveApiKey, saveAiSettings } from './settings-store.mjs';
import { writeFile } from 'node:fs/promises';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 700,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#f5f7f2',
    webPreferences: {
      preload: path.join(currentDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (app.isPackaged) {
    window.loadFile(path.join(currentDir, '..', 'dist', 'index.html'));
  } else {
    window.loadURL('http://127.0.0.1:5173');
  }
}

function registerHandlers() {
  ipcMain.handle('repo:select', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 Git 仓库',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('repo:inspect', (_event, repoPath) => inspectRepository(repoPath));
  ipcMain.handle('repo:compare', (_event, options) => compareBranches(options));
  ipcMain.handle('repo:commit-details', (_event, repoPath, hash) => getCommitDetails(repoPath, hash));
  ipcMain.handle('ai:review-commit', async (_event, { repoPath, hash, apiKey, model }) => {
    const details = await getCommitDetails(repoPath, hash);
    const resolvedApiKey = await resolveApiKey(apiKey);
    return reviewCommit({ apiKey: resolvedApiKey, model, details, fetchImpl: (input, init) => net.fetch(input, init) });
  });
  ipcMain.handle('ai:list-models', async (_event, apiKey) =>
    listAvailableModels({ apiKey: await resolveApiKey(apiKey), fetchImpl: (input, init) => net.fetch(input, init) }));
  ipcMain.handle('ai:load-settings', () => loadAiSettings());
  ipcMain.handle('ai:save-settings', (_event, settings) => saveAiSettings(settings));
  ipcMain.handle('ai:clear-key', () => clearSavedApiKey());

  ipcMain.handle('report:export', async (_event, { content, format }) => {
    const filters = format === 'json'
      ? [{ name: 'JSON', extensions: ['json'] }]
      : [{ name: 'Markdown', extensions: ['md'] }];
    const result = await dialog.showSaveDialog({
      title: '导出检查报告',
      defaultPath: `git-sync-audit-report.${format === 'json' ? 'json' : 'md'}`,
      filters,
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, content, 'utf8');
    return result.filePath;
  });
}

app.whenReady().then(() => {
  registerHandlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
