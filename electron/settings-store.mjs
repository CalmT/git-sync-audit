import { app, safeStorage } from 'electron';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

let sessionApiKey = '';

function settingsPath() {
  return path.join(app.getPath('userData'), 'ai-settings.json');
}

async function readSettingsFile() {
  try {
    return JSON.parse(await readFile(settingsPath(), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error('无法读取本地应用设置。');
  }
}

async function writeSettingsFile(settings) {
  const target = settingsPath();
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

async function decryptSavedKey(settings) {
  if (!settings.encryptedApiKey) return '';
  try {
    const encrypted = Buffer.from(settings.encryptedApiKey, 'base64');
    if (typeof safeStorage.decryptStringAsync === 'function') {
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      if (decrypted.shouldReEncrypt) {
        const rotated = await safeStorage.encryptStringAsync(decrypted.result);
        await writeSettingsFile({ ...settings, encryptedApiKey: rotated.toString('base64') });
      }
      return decrypted.result;
    }
    return safeStorage.decryptString(encrypted);
  } catch {
    throw new Error('无法从系统安全存储中读取 API Key，请重新填写。');
  }
}

export async function loadAiSettings() {
  const settings = await readSettingsFile();
  if (!sessionApiKey && settings.encryptedApiKey) sessionApiKey = await decryptSavedKey(settings);
  return {
    model: typeof settings.model === 'string' ? settings.model : 'gpt-5.4-mini',
    rememberApiKey: Boolean(settings.encryptedApiKey),
    hasApiKey: Boolean(sessionApiKey),
  };
}

export async function saveAiSettings({ apiKey, model, rememberApiKey }) {
  const settings = await readSettingsFile();
  if (typeof apiKey === 'string' && apiKey.trim()) sessionApiKey = apiKey.trim();
  const next = { ...settings, model: model || settings.model || 'gpt-5.4-mini' };
  delete next.encryptedApiKey;

  if (rememberApiKey) {
    if (!sessionApiKey) throw new Error('请先填写 OpenAI API Key。');
    const available = typeof safeStorage.isAsyncEncryptionAvailable === 'function'
      ? await safeStorage.isAsyncEncryptionAvailable()
      : safeStorage.isEncryptionAvailable();
    if (!available) throw new Error('当前系统安全存储不可用，无法永久保存 API Key。');
    const encrypted = typeof safeStorage.encryptStringAsync === 'function'
      ? await safeStorage.encryptStringAsync(sessionApiKey)
      : safeStorage.encryptString(sessionApiKey);
    next.encryptedApiKey = encrypted.toString('base64');
  }

  await writeSettingsFile(next);
  return { model: next.model, rememberApiKey: Boolean(next.encryptedApiKey), hasApiKey: Boolean(sessionApiKey) };
}

export async function resolveApiKey(candidate) {
  if (typeof candidate === 'string' && candidate.trim()) {
    sessionApiKey = candidate.trim();
    return sessionApiKey;
  }
  if (sessionApiKey) return sessionApiKey;
  const settings = await readSettingsFile();
  sessionApiKey = await decryptSavedKey(settings);
  if (!sessionApiKey) throw new Error('请先填写或恢复 OpenAI API Key。');
  return sessionApiKey;
}

export async function clearSavedApiKey() {
  sessionApiKey = '';
  const settings = await readSettingsFile();
  const next = { ...settings, model: settings.model || 'gpt-5.4-mini' };
  delete next.encryptedApiKey;
  await writeSettingsFile(next);
  return { model: settings.model || 'gpt-5.4-mini', rememberApiKey: false, hasApiKey: false };
}

function normalizedRepositories(settings) {
  if (!Array.isArray(settings.recentRepositories)) return [];
  return settings.recentRepositories
    .filter((item) => item && typeof item.path === 'string' && path.isAbsolute(item.path))
    .map((item) => ({
      path: item.path,
      name: typeof item.name === 'string' && item.name ? item.name : path.basename(item.path),
      lastOpenedAt: typeof item.lastOpenedAt === 'string' ? item.lastOpenedAt : '',
    }))
    .slice(0, 8);
}

export async function loadRepositoryHistory() {
  const settings = await readSettingsFile();
  const recentRepositories = normalizedRepositories(settings);
  return { recentRepositories };
}

export async function rememberRepository({ path: repoPath, name }) {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) throw new Error('仓库路径无效。');
  const settings = await readSettingsFile();
  const entry = {
    path: repoPath,
    name: typeof name === 'string' && name ? name : path.basename(repoPath),
    lastOpenedAt: new Date().toISOString(),
  };
  const recentRepositories = [entry, ...normalizedRepositories(settings).filter((item) => item.path !== repoPath)].slice(0, 8);
  const next = { ...settings, recentRepositories };
  delete next.lastRepository;
  await writeSettingsFile(next);
  return { recentRepositories };
}

export async function forgetRepository(repoPath) {
  if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) throw new Error('仓库路径无效。');
  const settings = await readSettingsFile();
  const recentRepositories = normalizedRepositories(settings).filter((item) => item.path !== repoPath);
  const next = { ...settings, recentRepositories };
  delete next.lastRepository;
  await writeSettingsFile(next);
  return { recentRepositories };
}
