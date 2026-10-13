// src/main/LiveSubscriptionManager.ts
// 网络直播订阅源：下载到本地 → 走「本地文件导入」链路注册到 lives → CRUD + 排序。
//
// 数据文件：
//   <userData>/live-subscriptions/index.json   元数据
//   <userData>/live-subscriptions/files/<id>.<ext>   下载的源文件
//
// ★★ 2026-10-13 核心重构（用户报「网络源添加后直播页只有名称没内容」）★★
//   此前自己拼 `file:///<绝对路径>` 写进 UserConfig.lives —— 直播页加载器**只认**
//   `http://127.0.0.1:9978/file/local-live/<文件名>` 形态，所以引擎读到后当成不支持的 url
//   → 顶部下拉有名字，点进去「无直播（请先导入含 lives 的配置）」。
//
//   修复：下载完成后**不再自己构造 LiveBean**，而是走 bindLiveImporter 注入的
//   importLiveFileFromPath（与「配置页 · 导入本地 TXT/M3U」同一条链路）——
//   它负责：编码归一化 → 落 <userData>/local-live/sub-<id>.<ext> → parseLive → host.cfgAddLive。
//   删除时按 api 精确移除；启动时自动检查更新（有变化才重新导入）。

import { app, ipcMain, BrowserWindow } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  LiveSubscription,
  LiveSubscriptionRefreshResult,
  UserConfig,
} from '../shared/types';
import { LOCAL_PROXY_BASE } from '../shared/constants';
import { localLiveUrl } from '../../engine/live/localLive';
import { UserConfigManager } from './store/UserConfigManager';

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

export const LIVE_SUB_CHANGED_CHANNEL = 'live:subscriptions-changed';

export function notifyLiveSubscriptionsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send(LIVE_SUB_CHANGED_CHANNEL);
    } catch { /* ignore */ }
  }
}

// =========================================================================
// ★ 2026-10-13：可注入的「本地文件导入」函数
//   主进程 index.ts 在 registerLiveSubscriptionIpc() 之前调用 bindLiveImporter(...) 接线。
//   不注入 = 任何 CRUD 都会抛错（防「悄悄不注册」）。
// =========================================================================
export interface LiveImporterResult {
  ok: boolean;
  name?: string;
  index?: number;
  replaced?: boolean;
  total?: number;
  api?: string;
  error?: string;
}
export type LiveImporter = (
  srcPath: string,
  opts: { customName?: string; stableFileName?: string },
) => LiveImporterResult;

let liveImporter: LiveImporter | null = null;
export function bindLiveImporter(fn: LiveImporter): void {
  liveImporter = fn;
}

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
// UserConfig 读写（走内存，落盘由 UserConfigManager 内部处理）
// =========================================================================
async function readUserConfig(): Promise<UserConfig | null> {
  const uc = UserConfigManager.current;
  if (uc) {
    try { return uc.snapshot(); }
    catch (e) { console.warn('[LiveSub] 读取内存配置失败，回退磁盘：', e); }
  }
  try {
    const raw = await fs.readFile(userConfigPath(), 'utf-8');
    return JSON.parse(raw) as UserConfig;
  } catch {
    return null;
  }
}

async function writeUserConfig(cfg: UserConfig): Promise<void> {
  const uc = UserConfigManager.current;
  if (uc) {
    try { uc.restore(cfg); return; }
    catch (e) { console.warn('[LiveSub] 写入内存配置失败，回退磁盘：', e); }
  }
  await atomicWrite(userConfigPath(), JSON.stringify(cfg, null, 2));
}

// =========================================================================
// 订阅源在 lives 里的稳定标识
//
// - 落盘到 <userData>/local-live/ 的文件名 = `sub-<id>.<ext>`（本模块管理）
// - 注册进 lives 的 api = localLiveUrl(LOCAL_PROXY_BASE, 上面那个文件名)
//   —— 与"导入本地 TXT/M3U"完全同构；且**稳定可计算**，删除/停用时按它精确清理。
// - LiveBean.name 用「【订阅】xxx」前缀，直播页下拉一眼区分。
// =========================================================================
const SUB_BEAN_PREFIX = '【订阅】';
const LOCAL_LIVE_SUBDIR = 'local-live';

function extForUrl(url: string): string {
  const u = url.toLowerCase().split('?')[0].split('#')[0];
  if (u.endsWith('.txt')) return 'txt';
  if (u.endsWith('.json')) return 'json';
  return 'm3u';
}

/** 本模块管理的本地文件名（稳定） */
function stableFileNameOf(subId: string, url: string): string {
  return `sub-${subId}.${extForUrl(url)}`;
}

/** 注册进 lives 的 api（= 直播页加载器唯一认得的形态） */
function apiOf(subId: string, url: string): string {
  return localLiveUrl(LOCAL_PROXY_BASE, stableFileNameOf(subId, url));
}

/** 从 lives 里移除本订阅源的线路（按 api 精确匹配，经 UserConfigManager 内存快照变更） */
async function removeSubFromLives(sub: LiveSubscription): Promise<void> {
  const uc = UserConfigManager.current;
  if (!uc) {
    console.warn('[LiveSub] UserConfigManager.current 未就绪，无法移除 lives');
    return;
  }
  const api = apiOf(sub.id, sub.url);
  const ok = uc.removeLiveByApi(api);
  if (ok) console.info(`[LiveSub] 已从 lives 移除：${api}`);
}

/** 下载到 <userData>/live-subscriptions/files/<id>.<ext>（仅做元数据缓存，供「对比是否变化」用） */
async function downloadToCache(sub: LiveSubscription): Promise<string> {
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

async function fileExists(p?: string): Promise<boolean> {
  if (!p) return false;
  try { await fs.access(p); return true; } catch { return false; }
}

// =========================================================================
// 网络下载（★ 超时 120 秒；GitHub raw 自动加镜像回退）
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

// =========================================================================
// CRUD
// =========================================================================
export async function addSubscription(name: string, url: string): Promise<LiveSubscription> {
  if (!liveImporter) throw new Error('直播导入器未就绪（主进程未调用 bindLiveImporter）');
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

  // 1) 下载到缓存目录（用于「检查更新」时对比内容）
  try {
    sub.localFile = await downloadToCache(sub);
    sub.lastUpdated = new Date().toISOString();
  } catch (e) {
    sub.lastError = (e as Error).message;
  }

  // 2) 下载成功 → 走「本地文件导入」链路注册到 lives（与配置页按钮同一路径）
  if (sub.localFile) {
    const r = liveImporter(sub.localFile, {
      customName: `${SUB_BEAN_PREFIX}${sub.name}`,
      stableFileName: stableFileNameOf(sub.id, sub.url),
    });
    if (!r.ok) sub.lastError = r.error || '注册失败';
  }

  // 3) 落库
  const subs = await listSubscriptions();
  subs.push(sub);
  await saveSubscriptions(subs);

  notifyLiveSubscriptionsChanged();
  return sub;
}

export async function removeSubscription(id: string): Promise<void> {
  const subs = await listSubscriptions();
  const idx = subs.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const sub = subs[idx];

  try { await removeSubFromLives(sub); } catch (e) { console.warn('[LiveSub] 移除 lives 失败：', e); }
  await deleteLocalFile(sub.localFile);
  subs.splice(idx, 1);
  await saveSubscriptions(subs);

  notifyLiveSubscriptionsChanged();
}

export async function updateSubscription(
  id: string,
  patch: Partial<Pick<LiveSubscription, 'name' | 'url' | 'enabled'>>,
): Promise<LiveSubscription | null> {
  if (!liveImporter) throw new Error('直播导入器未就绪（主进程未调用 bindLiveImporter）');
  const subs = await listSubscriptions();
  const idx = subs.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  const old = subs[idx];
  const next: LiveSubscription = { ...old };

  if (typeof patch.name === 'string') {
    const n = patch.name.trim();
    if (!n) throw new Error('名称不能为空');
    next.name = n;
  }
  if (typeof patch.url === 'string') {
    const u = patch.url.trim();
    if (!/^https?:\/\//i.test(u)) throw new Error('订阅链接必须以 http:// 或 https:// 开头');
    next.url = u;
  }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;

  const urlChanged = old.url !== next.url;
  const enabledChanged = old.enabled !== next.enabled;
  const nameChanged = old.name !== next.name;

  // 停用 → 从 lives 移除（保留本地缓存文件，方便快速重启用）
  if (!next.enabled) {
    if (old.enabled) {
      try { await removeSubFromLives(old); } catch { /* ignore */ }
    }
    if (urlChanged) {
      // URL 变了：旧缓存文件不再可用 → 清掉（下次启用会重新下载）
      await deleteLocalFile(old.localFile);
      next.localFile = undefined;
    }
    subs[idx] = next;
    await saveSubscriptions(subs);
    notifyLiveSubscriptionsChanged();
    return next;
  }

  // 启用（或保持启用）：
  //   · url 变化 → 必须重下
  //   · 无本地缓存 → 必须下
  //   · 只是启停切换 / 只改 name → 无需重下，直接用已有缓存文件重导
  const needDownload = urlChanged || !old.localFile || !(await fileExists(old.localFile));

  if (needDownload) {
    // URL 变了：老缓存文件不再需要
    if (urlChanged && old.localFile) {
      await deleteLocalFile(old.localFile);
      next.localFile = undefined;
    }
    try {
      next.localFile = await downloadToCache(next);
      next.lastUpdated = new Date().toISOString();
      next.lastError = undefined;
    } catch (e) {
      next.lastError = (e as Error).message;
    }
  }

  // 走本地导入链路（新增、启用、改名、URL 变化都落到这里；url 稳定 → replaced=true 覆盖同条目）
  if (next.localFile) {
    const r = liveImporter(next.localFile, {
      customName: `${SUB_BEAN_PREFIX}${next.name}`,
      stableFileName: stableFileNameOf(next.id, next.url),
    });
    if (!r.ok) {
      next.lastError = r.error || '注册失败';
    } else if (nameChanged || enabledChanged || urlChanged) {
      next.lastError = undefined;
    }
  }

  subs[idx] = next;
  await saveSubscriptions(subs);
  notifyLiveSubscriptionsChanged();
  return next;
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

  // 注：lives 里的顺序不再由此处调整 —— 直播页下拉顺序以 lives 数组顺序为准，
  // 本模块追加时都落在末尾；用户如果希望顺序对齐，可通过「删除 + 重加」调整。
  notifyLiveSubscriptionsChanged();
  return subs;
}

// =========================================================================
// 刷新（手动触发；下载最新内容 → 走本地导入覆盖）
// =========================================================================
export async function refreshAllSubscriptions(): Promise<LiveSubscriptionRefreshResult[]> {
  const results: LiveSubscriptionRefreshResult[] = [];
  if (!liveImporter) return results;
  const subs = await listSubscriptions();
  let dirty = false;

  for (const sub of subs) {
    if (!sub.enabled) {
      results.push({ id: sub.id, name: sub.name, ok: false, error: '已停用' });
      continue;
    }
    try {
      sub.localFile = await downloadToCache(sub);
      const r = liveImporter(sub.localFile, {
        customName: `${SUB_BEAN_PREFIX}${sub.name}`,
        stableFileName: stableFileNameOf(sub.id, sub.url),
      });
      if (!r.ok) throw new Error(r.error || '重新导入失败');
      sub.lastUpdated = new Date().toISOString();
      sub.lastError = undefined;
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
  notifyLiveSubscriptionsChanged();
  return results;
}

// =========================================================================
// ★ 2026-10-13：启动时自动检查更新 —— 有变化才重新导入；无变化则保留原样。
// =========================================================================
export interface CheckUpdateSummary {
  updated: number;
  skipped: number;
  failed: number;
}

/**
 * 遍历所有启用的订阅源：
 *   1) 拉取远端最新内容；
 *   2) 与本地缓存逐字节对比；
 *   3) **一致 → 跳过**（不动 lives、不动本地文件）；
 *   4) **有变化 → 覆盖本地文件 + 走本地导入链路重新注册**（replaced=true 覆盖同条目）；
 *   5) 失败 → 记录 lastError，继续处理下一个。
 */
export async function checkAndUpdateSubscriptions(): Promise<CheckUpdateSummary> {
  const summary: CheckUpdateSummary = { updated: 0, skipped: 0, failed: 0 };
  if (!liveImporter) return summary;

  const subs = await listSubscriptions();
  let dirty = false;

  for (const sub of subs) {
    if (!sub.enabled) { summary.skipped++; continue; }
    try {
      const remote = await fetchText(sub.url);
      if (!remote || !remote.trim()) throw new Error('订阅内容为空');

      // 与本地缓存对比：内容一致 → 跳过（不重新导入）
      let local: string | null = null;
      if (sub.localFile) {
        try { local = await fs.readFile(sub.localFile, 'utf-8'); } catch { local = null; }
      }
      if (local !== null && local === remote) { summary.skipped++; continue; }

      // 有变化 → 覆盖本地文件 + 走本地导入覆盖 lives 里的对应线路
      await ensureDirs();
      const ext = extForUrl(sub.url);
      const cacheFile = path.join(filesDir(), `${sub.id}.${ext}`);
      await atomicWrite(cacheFile, remote);
      const r = liveImporter(cacheFile, {
        customName: `${SUB_BEAN_PREFIX}${sub.name}`,
        stableFileName: stableFileNameOf(sub.id, sub.url),
      });
      if (!r.ok) throw new Error(r.error || '重新导入失败');

      sub.localFile = cacheFile;
      sub.lastUpdated = new Date().toISOString();
      sub.lastError = undefined;
      summary.updated++;
      dirty = true;
      console.info(`[LiveSub] 订阅「${sub.name}」有更新，已重新导入到 lives`);
    } catch (e) {
      sub.lastError = (e as Error)?.message || String(e);
      summary.failed++;
      dirty = true;
      console.warn(`[LiveSub] 订阅「${sub.name}」检查更新失败：${sub.lastError}`);
    }
  }

  if (dirty) {
    try { await saveSubscriptions(subs); } catch { /* ignore */ }
  }
  if (summary.updated > 0) notifyLiveSubscriptionsChanged();
  return summary;
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
