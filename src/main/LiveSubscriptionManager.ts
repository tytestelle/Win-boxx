// src/main/LiveSubscriptionManager.ts
// 网络直播订阅源：下载到本地 + 自动注册到 UserConfig.lives + CRUD + 排序。
//
// 数据文件：
//   <userData>/live-subscriptions/index.json   元数据
//   <userData>/live-subscriptions/files/<id>.m3u | .txt | .json   下载的源文件
//
// 每次添加/启用/刷新订阅源，会把下载的文件注册到 UserConfig.lives（一条 LiveBean），
// 直播页顶部线路下拉即可看到「【订阅】xxx」。

import { app, ipcMain } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  LiveBean,
  LiveSubscription,
  LiveSubscriptionRefreshResult,
  UserConfig,
} from '../shared/types';

// =========================================================================
// 通道名
// =========================================================================
export const LIVE_SUB_CHANNELS = {
  LIST: 'live:subscription:list',
  ADD: 'live:subscription:add',
  REMOVE: 'live:subscription:remove',
  UPDATE: 'live:subscription:update',
  TOGGLE: 'live:subscription:toggle',
  MOVE: 'live:subscription:move',
  REFRESH_ALL: 'live:subscription:refreshAll',
} as const;

// =========================================================================
// 路径
// =========================================================================
function rootDir(): string { return path.join(app.getPath('userData'), 'live-subscriptions'); }
function indexFile(): string { return path.join(rootDir(), 'index.json'); }
function filesDir(): string { return path.join(rootDir(), 'files'); }
function userConfigPath(): string { return path.join(app.getPath('userData'), 'user-config.json'); }

async function ensureDirs(): Promise<void> {
  await fs.mkdir(rootDir(), { recursive: true });
  await fs.mkdir(filesDir(), { recursive: true });
}

// =========================================================================
// 原子写
// =========================================================================
async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, file);
}

// =========================================================================
// 订阅源元数据读写
// =========================================================================
export async function listSubscriptions(): Promise<LiveSubscription[]> {
  await ensureDirs();
  try {
    const raw = await fs.readFile(indexFile(), 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.url === 'string')
      .map((x) => ({
        id: String(x.id),
        name: String(x.name || '').trim() || '未命名订阅',
        url: String(x.url || '').trim(),
        enabled: x.enabled !== false,
        lastUpdated: typeof x.lastUpdated === 'string' ? x.lastUpdated : undefined,
        lastError: typeof x.lastError === 'string' ? x.lastError : undefined,
        localFile: typeof x.localFile === 'string' ? x.localFile : undefined,
      }));
  } catch {
    return [];
  }
}

async function saveSubscriptions(subs: LiveSubscription[]): Promise<void> {
  await ensureDirs();
  await atomicWrite(indexFile(), JSON.stringify(subs, null, 2));
}

// =========================================================================
// UserConfig 读写
//
// ⚠ 如果你的项目 user-config.json 不在 <userData>/user-config.json，
//    请修改 userConfigPath() 指向实际路径。
// =========================================================================
async function readUserConfig(): Promise<UserConfig | null> {
  try {
    const raw = await fs.readFile(userConfigPath(), 'utf-8');
    return JSON.parse(raw) as UserConfig;
  } catch {
    return null;
  }
}

async function writeUserConfig(cfg: UserConfig): Promise<void> {
  await atomicWrite(userConfigPath(), JSON.stringify(cfg, null, 2));
}

// =========================================================================
// LiveBean 生成 / 识别
// =========================================================================

/**
 * 订阅源在 UserConfig.lives 里的名字前缀。
 * 用前缀方便识别哪些 LiveBean 是我们管理的，删除订阅源时能精确清理。
 */
const SUB_BEAN_PREFIX = '【订阅】';

/**
 * ★ 本地直播源文件 → LiveBean.api 的格式。
 * 这里用 file:// 绝对路径（Windows 也统一正斜杠）。
 * 如果你们项目"导入本地直播源"用的是别的 scheme（比如 local-live://），
 * 只需要改这一个函数。
 */
function buildLiveApi(localFile: string): string {
  const norm = localFile.replace(/\\/g, '/');
  return norm.startsWith('/') ? `file://${norm}` : `file:///${norm}`;
}

function buildLiveBean(sub: LiveSubscription, localFile: string): LiveBean {
  return {
    name: `${SUB_BEAN_PREFIX}${sub.name}`,
    api: buildLiveApi(localFile),
    type: '0',
    url: '',
    jar: '',
    ext: '',
    epg: '',
    playerType: '',
    timeout: 15,
  };
}

function isSubLiveBean(bean: LiveBean): boolean {
  return typeof bean?.name === 'string' && bean.name.startsWith(SUB_BEAN_PREFIX);
}

function findSubBeanIndex(lives: LiveBean[], sub: LiveSubscription): number {
  const target = `${SUB_BEAN_PREFIX}${sub.name}`;
  return lives.findIndex((b) => b?.name === target);
}

// =========================================================================
// 注册 / 反注册（写 UserConfig.lives）
// =========================================================================
async function upsertSubToLives(sub: LiveSubscription, localFile: string): Promise<void> {
  const cfg = await readUserConfig();
  if (!cfg) {
    console.warn('[LiveSub] 未找到 user-config.json，跳过注册到 lives');
    return;
  }
  if (!Array.isArray(cfg.lives)) cfg.lives = [];

  const idx = findSubBeanIndex(cfg.lives, sub);
  const bean = buildLiveBean(sub, localFile);
  if (idx >= 0) {
    cfg.lives[idx] = { ...cfg.lives[idx], ...bean };
  } else {
    cfg.lives.push(bean);
  }
  if (!cfg.ui) cfg.ui = { activeSourceKey: '', activeLiveIndex: 0 };
  await writeUserConfig(cfg);
  console.info(`[LiveSub] 已注册到 lives：${bean.name}`);
}

async function removeSubFromLives(sub: LiveSubscription): Promise<void> {
  const cfg = await readUserConfig();
  if (!cfg || !Array.isArray(cfg.lives)) return;
  const idx = findSubBeanIndex(cfg.lives, sub);
  if (idx < 0) return;
  cfg.lives.splice(idx, 1);
  if (cfg.ui && typeof cfg.ui.activeLiveIndex === 'number' && cfg.ui.activeLiveIndex >= cfg.lives.length) {
    cfg.ui.activeLiveIndex = Math.max(0, cfg.lives.length - 1);
  }
  await writeUserConfig(cfg);
  console.info(`[LiveSub] 已从 lives 移除：${SUB_BEAN_PREFIX}${sub.name}`);
}

// =========================================================================
// 网络下载（★ 超时 120 秒，之前 20 秒就是报 aborted 的原因）
// =========================================================================
const FETCH_TIMEOUT_MS = 120_000;

function buildFetchCandidates(url: string): string[] {
  const list: string[] = [url];
  try {
    const u = new URL(url);
    const isGithubRaw =
      u.hostname === 'raw.githubusercontent.com' ||
      u.hostname === 'gist.githubusercontent.com' ||
      (u.hostname === 'github.com' && /\/raw\//.test(u.pathname));
    if (isGithubRaw) {
      list.push(`https://ghproxy.net/${url}`);
      list.push(`https://gh-proxy.com/${url}`);
    }
  } catch { /* ignore */ }
  return list;
}

async function fetchOnce(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Win-Box/1.0 (+live-subscription)',
        Accept: '*/*',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
    const buf = await res.arrayBuffer();

    // 编码处理
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const m = ct.match(/charset=([\w-]+)/i);
    const cs = (m?.[1] || '').toLowerCase();
    const decode = (c: string): string | null => {
      try { return new TextDecoder(c, { fatal: false }).decode(buf); } catch { return null; }
    };
    if (cs === 'gbk' || cs === 'gb2312' || cs === 'gb18030') {
      return decode('gbk') ?? decode('utf-8') ?? '';
    }
    if (cs && cs !== 'utf-8' && cs !== 'utf8') {
      return decode(cs) ?? decode('utf-8') ?? '';
    }
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.length > 0) {
      const bad = (text.match(/\uFFFD/g) || []).length;
      if (bad / text.length > 0.05) {
        const gbk = decode('gbk');
        if (gbk && gbk.length) text = gbk;
      }
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string): Promise<string> {
  const candidates = buildFetchCandidates(url);
  let lastErr: unknown = null;
  for (const c of candidates) {
    try {
      return await fetchOnce(c);
    } catch (e) {
      lastErr = e;
      console.warn(`[LiveSub] fetch 失败 ${c}：${(e as Error)?.message || e}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function extForUrl(url: string): string {
  const u = url.toLowerCase().split('?')[0].split('#')[0];
  if (u.endsWith('.txt')) return 'txt';
  if (u.endsWith('.json')) return 'json';
  return 'm3u'; // .m3u / .m3u8 / 无后缀 → m3u
}

/** 下载到 <userData>/live-subscriptions/files/<id>.<ext> */
async function downloadToLocal(sub: LiveSubscription): Promise<string> {
  const text = await fetchText(sub.url);
  if (!text || !text.trim()) throw new Error('订阅内容为空');
  await ensureDirs();
  const ext = extForUrl(sub.url);
  const file = path.join(filesDir(), `${sub.id}.${ext}`);
  await atomicWrite(file, text);
  return file;
}

async function deleteLocalFile(localFile?: string): Promise<void> {
  if (!localFile) return;
  try { await fs.unlink(localFile); } catch { /* ignore */ }
}

// =========================================================================
// CRUD
// =========================================================================
export async function addSubscription(name: string, url: string): Promise<LiveSubscription> {
  const n = (name || '').trim();
  const u = (url || '').trim();
  if (!n) throw new Error('订阅名称不能为空');
  if (!/^https?:\/\//i.test(u)) throw new Error('订阅链接必须以 http:// 或 https:// 开头');

  const sub: LiveSubscription = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: n,
    url: u,
    enabled: true,
  };

  // 1) 立即下载到本地
  try {
    sub.localFile = await downloadToLocal(sub);
    sub.lastUpdated = new Date().toISOString();
    sub.lastError = undefined;
  } catch (e) {
    sub.lastError = (e as Error)?.message || String(e);
    // 下载失败也落库（用户可以重试）；不注册到 lives
  }

  // 2) 保存元数据
  const subs = await listSubscriptions();
  subs.push(sub);
  await saveSubscriptions(subs);

  // 3) 下载成功 → 注册到 UserConfig.lives
  if (sub.localFile) {
    try { await upsertSubToLives(sub, sub.localFile); }
    catch (e) { console.warn('[LiveSub] 注册失败：', e); }
  }

  return sub;
}

export async function removeSubscription(id: string): Promise<void> {
  const subs = await listSubscriptions();
  const idx = subs.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const sub = subs[idx];

  // 1) 从 lives 移除
  try { await removeSubFromLives(sub); } catch (e) { console.warn('[LiveSub] 移除 lives 失败：', e); }

  // 2) 删除本地文件
  await deleteLocalFile(sub.localFile);

  // 3) 删记录
  subs.splice(idx, 1);
  await saveSubscriptions(subs);
}

export async function updateSubscription(
  id: string,
  patch: Partial<Pick<LiveSubscription, 'name' | 'url' | 'enabled'>>,
): Promise<LiveSubscription | null> {
  const subs = await listSubscriptions();
  const idx = subs.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  const old = subs[idx];
  const next: LiveSubscription = { ...old };

  let nameChanged = false;
  if (typeof patch.name === 'string') {
    const n = patch.name.trim();
    if (!n) throw new Error('名称不能为空');
    if (n !== old.name) nameChanged = true;
    next.name = n;
  }
  if (typeof patch.url === 'string') {
    const u = patch.url.trim();
    if (!/^https?:\/\//i.test(u)) throw new Error('订阅链接必须以 http:// 或 https:// 开头');
    next.url = u;
  }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;

  const wasEnabled = old.enabled;
  const isEnabled = next.enabled;

  if (nameChanged) {
    // 名字变了，先移除旧注册
    try { await removeSubFromLives(old); } catch { /* ignore */ }
  }

  if (!isEnabled) {
    // 停用 → 从 lives 移除（保留本地文件，方便快速重启用）
    try { await removeSubFromLives(next); } catch { /* ignore */ }
  } else {
    // 启用（或保持启用）
    const needDownload =
      !old.enabled ||                            // 从停用变启用
      old.url !== next.url ||                    // URL 变了
      !old.localFile ||                          // 没有本地文件
      !(await fileExists(old.localFile));        // 本地文件丢了

    if (needDownload) {
      try {
        next.localFile = await downloadToLocal(next);
        next.lastUpdated = new Date().toISOString();
        next.lastError = undefined;
      } catch (e) {
        next.lastError = (e as Error)?.message || String(e);
      }
    }

    if (next.localFile) {
      try { await upsertSubToLives(next, next.localFile); }
      catch (e) { console.warn('[LiveSub] 注册失败：', e); }
    }
  }

  subs[idx] = next;
  await saveSubscriptions(subs);
  return next;
}

async function fileExists(p?: string): Promise<boolean> {
  if (!p) return false;
  try { await fs.access(p); return true; } catch { return false; }
}

export async function moveSubscription(
  id: string,
  direction: 'up' | 'down' | 'top' | 'bottom',
): Promise<LiveSubscription[]> {
  const subs = await listSubscriptions();
  const idx = subs.findIndex((s) => s.id === id);
  if (idx < 0) return subs;

  let target = idx;
  if (direction === 'up') target = Math.max(0, idx - 1);
  else if (direction === 'down') target = Math.min(subs.length - 1, idx + 1);
  else if (direction === 'top') target = 0;
  else if (direction === 'bottom') target = subs.length - 1;

  if (target === idx) return subs;

  const [item] = subs.splice(idx, 1);
  subs.splice(target, 0, item);
  await saveSubscriptions(subs);

  // 同步 lives 顺序：把订阅源的 LiveBean 按当前 subs 顺序重排（放在其它 LiveBean 之后）
  try {
    const cfg = await readUserConfig();
    if (cfg && Array.isArray(cfg.lives)) {
      const others = cfg.lives.filter((b) => !isSubLiveBean(b));
      const sorted: LiveBean[] = [];
      for (const s of subs) {
        if (!s.enabled || !s.localFile) continue;
        const target2 = `${SUB_BEAN_PREFIX}${s.name}`;
        const found = cfg.lives.find((b) => b?.name === target2);
        if (found) sorted.push(found);
      }
      cfg.lives = [...others, ...sorted];
      if (cfg.ui && typeof cfg.ui.activeLiveIndex === 'number' && cfg.ui.activeLiveIndex >= cfg.lives.length) {
        cfg.ui.activeLiveIndex = Math.max(0, cfg.lives.length - 1);
      }
      await writeUserConfig(cfg);
    }
  } catch (e) { console.warn('[LiveSub] 同步 lives 顺序失败：', e); }

  return subs;
}

// =========================================================================
// 刷新
// =========================================================================
export async function refreshAllSubscriptions(): Promise<LiveSubscriptionRefreshResult[]> {
  const subs = await listSubscriptions();
  const results: LiveSubscriptionRefreshResult[] = [];
  let dirty = false;

  for (const sub of subs) {
    if (!sub.enabled) {
      results.push({ id: sub.id, name: sub.name, ok: false, error: '已停用' });
      continue;
    }
    try {
      sub.localFile = await downloadToLocal(sub);
      sub.lastUpdated = new Date().toISOString();
      sub.lastError = undefined;
      try { await upsertSubToLives(sub, sub.localFile); } catch (e) { console.warn('[LiveSub] 注册失败：', e); }
      results.push({ id: sub.id, name: sub.name, ok: true, lastUpdated: sub.lastUpdated });
      dirty = true;
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      sub.lastError = msg;
      results.push({ id: sub.id, name: sub.name, ok: false, error: msg });
      dirty = true;
    }
  }

  if (dirty) {
    try { await saveSubscriptions(subs); } catch { /* ignore */ }
  }
  return results;
}

// =========================================================================
// IPC 注册
// =========================================================================
export function registerLiveSubscriptionIpc(): void {
  ipcMain.handle(LIVE_SUB_CHANNELS.LIST, async () => listSubscriptions());
  ipcMain.handle(LIVE_SUB_CHANNELS.ADD, async (_e, name: string, url: string) => addSubscription(name, url));
  ipcMain.handle(LIVE_SUB_CHANNELS.REMOVE, async (_e, id: string) => { await removeSubscription(id); return true; });
  ipcMain.handle(LIVE_SUB_CHANNELS.UPDATE, async (_e, id: string, patch: any) => updateSubscription(id, patch || {}));
  ipcMain.handle(LIVE_SUB_CHANNELS.TOGGLE, async (_e, id: string, enabled: boolean) => updateSubscription(id, { enabled: !!enabled }));
  ipcMain.handle(LIVE_SUB_CHANNELS.MOVE, async (_e, id: string, dir: 'up' | 'down' | 'top' | 'bottom') => moveSubscription(id, dir));
  ipcMain.handle(LIVE_SUB_CHANNELS.REFRESH_ALL, async () => refreshAllSubscriptions());
}
