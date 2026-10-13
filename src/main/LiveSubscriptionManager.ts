// src/main/LiveSubscriptionManager.ts
// 网络直播订阅源：CRUD + 网络拉取 + m3u/txt/json 解析 + IPC 注册。
// 持久化到 <userData>/live-subscriptions.json。
// 使用方式：主进程启动时调用一次 registerLiveSubscriptionIpc()。

import { app, ipcMain } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  LiveGroup,
  LiveChannel,
  LiveSubscription,
  LiveSubscriptionRefreshResult,
} from '../shared/types';

/** IPC 通道名常量（渲染层需保持完全一致） */
export const LIVE_SUB_CHANNELS = {
  LIST: 'live:subscription:list',
  ADD: 'live:subscription:add',
  REMOVE: 'live:subscription:remove',
  UPDATE: 'live:subscription:update',
  TOGGLE: 'live:subscription:toggle',
  REFRESH_ALL: 'live:subscription:refreshAll',
} as const;

// =========================================================================
// 持久化
// =========================================================================

let subsFilePathCache = '';
function subsFilePath(): string {
  if (!subsFilePathCache) {
    subsFilePathCache = path.join(app.getPath('userData'), 'live-subscriptions.json');
  }
  return subsFilePathCache;
}

export async function listSubscriptions(): Promise<LiveSubscription[]> {
  try {
    const raw = await fs.readFile(subsFilePath(), 'utf-8');
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
      }));
  } catch {
    return [];
  }
}

async function saveSubscriptions(subs: LiveSubscription[]): Promise<void> {
  await fs.writeFile(subsFilePath(), JSON.stringify(subs, null, 2), 'utf-8');
}

// =========================================================================
// CRUD
// =========================================================================

export async function addSubscription(name: string, url: string): Promise<LiveSubscription> {
  const n = (name || '').trim();
  const u = (url || '').trim();
  if (!n) throw new Error('订阅名称不能为空');
  if (!/^https?:\/\//i.test(u)) throw new Error('订阅链接必须以 http:// 或 https:// 开头');

  const subs = await listSubscriptions();
  const sub: LiveSubscription = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: n,
    url: u,
    enabled: true,
  };
  subs.push(sub);
  await saveSubscriptions(subs);
  return sub;
}

export async function removeSubscription(id: string): Promise<void> {
  const subs = await listSubscriptions();
  await saveSubscriptions(subs.filter((s) => s.id !== id));
}

export async function updateSubscription(
  id: string,
  patch: Partial<Pick<LiveSubscription, 'name' | 'url' | 'enabled'>>,
): Promise<LiveSubscription | null> {
  const subs = await listSubscriptions();
  const idx = subs.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  subs[idx] = { ...subs[idx], ...patch };
  await saveSubscriptions(subs);
  return subs[idx];
}

// =========================================================================
// 网络拉取
// =========================================================================

/** 根据 URL 后缀判断解析格式；无后缀默认按 m3u 处理（兼容绝大多数 IPTV 源） */
function detectFormat(url: string): 'm3u' | 'txt' | 'json' {
  const lower = url.toLowerCase().split('?')[0].split('#')[0];
  if (lower.endsWith('.m3u') || lower.endsWith('.m3u8')) return 'm3u';
  if (lower.endsWith('.txt')) return 'txt';
  if (lower.endsWith('.json')) return 'json';
  return 'm3u';
}

/**
 * GitHub 加速：当 URL 是 raw.githubusercontent.com / github.com/.../raw/ 时，
 * 依次尝试「直连 → ghproxy.net 镜像」。
 * 仅在直连失败时启用镜像，避免用户网络本身良好时反而绕路。
 */
function buildFetchCandidates(url: string): string[] {
  const candidates: string[] = [url];
  try {
    const u = new URL(url);
    const isGithubRaw =
      u.hostname === 'raw.githubusercontent.com' ||
      (u.hostname === 'github.com' && /\/raw\//.test(u.pathname)) ||
      u.hostname === 'gist.githubusercontent.com';
    if (isGithubRaw) {
      candidates.push(`https://ghproxy.net/${url}`);
      candidates.push(`https://gh-proxy.com/${url}`);
    }
  } catch {
    // URL 解析失败 → 不加镜像
  }
  return candidates;
}

async function fetchTextOnce(url: string, timeoutMs = 20000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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

    // 编码处理：优先 Content-Type 里声明的 charset；缺省按 UTF-8，含 BOM 自动剥离
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const m = ct.match(/charset=([\w-]+)/i);
    const charset = (m?.[1] || '').toLowerCase();
    const tryDecode = (cs: string): string | null => {
      try {
        return new TextDecoder(cs, { fatal: false }).decode(buf);
      } catch {
        return null;
      }
    };
    if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') {
      return tryDecode('gbk') ?? tryDecode('utf-8') ?? '';
    }
    if (charset && charset !== 'utf-8' && charset !== 'utf8') {
      return tryDecode(charset) ?? tryDecode('utf-8') ?? '';
    }
    // 无声明 charset：先按 utf-8 解，若首字节是 EF BB BF 会被 TextDecoder 自动去除
    let text = new TextDecoder('utf-8').decode(buf);
    // 简单启发：utf-8 解码后出现明显乱码（U+FFFD 比例过高）→ 尝试 gbk
    if (text.length > 0) {
      const bad = (text.match(/\uFFFD/g) || []).length;
      if (bad / text.length > 0.05) {
        const gbk = tryDecode('gbk');
        if (gbk && gbk.length) text = gbk;
      }
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取订阅正文；GitHub 直连失败时自动尝试镜像 */
async function fetchSubscriptionText(url: string): Promise<string> {
  const candidates = buildFetchCandidates(url);
  let lastErr: unknown = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      return await fetchTextOnce(candidates[i]);
    } catch (e) {
      lastErr = e;
      // 直连失败且还有镜像 → 继续；否则抛出
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// =========================================================================
// 解析：m3u / txt / json
// =========================================================================

/** 构造 LiveChannel，保证所有必填字段都有默认值 */
function makeChannel(
  name: string,
  url: string,
  extra: Partial<Omit<LiveChannel, 'name' | 'urls'>> = {},
): LiveChannel {
  return {
    name: (name || '').trim() || 'Unnamed',
    urls: [url],
    logo: '',
    epg: '',
    ua: '',
    click: '',
    format: '',
    origin: '',
    referer: '',
    'tvg-id': '',
    'tvg-name': '',
    'tvg-chno': '',
    ...extra,
  };
}

/** 把 urls 数组去重 + 过滤非法 URL + 保留 $线路名 后缀 */
function cleanUrls(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const s = (r || '').trim();
    if (!s) continue;
    // 允许 http(s):// 、rtmp(s):// 、rtsp:// 等；同时保留 URL$线路名
    const bare = s.split('$')[0];
    if (!/^(https?|rtmp|rtmps|rtsp|udp|rtp|mms):\/\//i.test(bare)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function parseM3U(text: string, defaultGroup: string): LiveGroup[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const groupMap = new Map<string, LiveChannel[]>();
  let pending: Partial<Omit<LiveChannel, 'name' | 'urls'>> | null = null;
  let pendingGroup = defaultGroup;

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      // 抽取所有 k="v" 属性
      const attrs: Record<string, string> = {};
      const attrRe = /([\w-]+)="([^"]*)"/g;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(line))) attrs[m[1].toLowerCase()] = m[2];

      // 逗号后的显示名（M3U 规范：最后一个逗号之后是标题）
      const commaIdx = line.lastIndexOf(',');
      const displayName = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';

      pending = {
        logo: attrs['tvg-logo'] || '',
        'tvg-id': attrs['tvg-id'] || '',
        'tvg-name': attrs['tvg-name'] || '',
        'tvg-chno': attrs['tvg-chno'] || '',
        ua: attrs['http-user-agent'] || attrs['user-agent'] || '',
        referer: attrs['http-referer'] || '',
        origin: attrs['http-origin'] || '',
        click: attrs['click'] || '',
        format: attrs['format'] || '',
      };
      pendingGroup = (attrs['group-title'] || '').trim() || defaultGroup;

      // 名称最终在 URL 行组装；此处先把"显示名优先"暂存
      (pending as any).__displayName = attrs['tvg-name'] || displayName || 'Unnamed';
      continue;
    }

    if (line.startsWith('#')) continue;

    // 非 # 开头 → 视为 URL 行
    if (!pending) continue;
    const chName = String((pending as any).__displayName || 'Unnamed');
    delete (pending as any).__displayName;
    const cleaned = cleanUrls([line]);
    if (!cleaned.length) {
      pending = null;
      continue;
    }
    const ch = makeChannel(chName, cleaned[0], pending);
    if (cleaned.length > 1) ch.urls = cleaned;
    if (!groupMap.has(pendingGroup)) groupMap.set(pendingGroup, []);
    groupMap.get(pendingGroup)!.push(ch);
    pending = null;
  }

  return [...groupMap.entries()].map(([group, channels]) => ({ group, channels }));
}

function parseTXT(text: string, defaultGroup: string): LiveGroup[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const groupMap = new Map<string, LiveChannel[]>();
  let currentGroup = defaultGroup;

  for (const line of lines) {
    // 支持三种 #genre# 形态：#genre# 央视 / 央视,#genre# / 央视 #genre#
    if (line.includes('#genre#')) {
      const g = line.replace(/#genre#/gi, '').replace(/^#\s*/, '').replace(/^,\s*/, '').replace(/,\s*$/, '').trim();
      currentGroup = g || defaultGroup;
      continue;
    }
    if (line.startsWith('#')) continue;

    const commaIdx = line.indexOf(',');
    if (commaIdx === -1) continue;
    const name = line.slice(0, commaIdx).trim();
    const urlPart = line.slice(commaIdx + 1).trim();
    // 一个条目可能携带多条线路：url1$线路1#url2$线路2
    const urls = cleanUrls(urlPart.split('#'));
    if (!urls.length) continue;

    if (!groupMap.has(currentGroup)) groupMap.set(currentGroup, []);
    const ch = makeChannel(name || 'Unnamed', urls[0]);
    if (urls.length > 1) ch.urls = urls;
    groupMap.get(currentGroup)!.push(ch);
  }

  return [...groupMap.entries()].map(([group, channels]) => ({ group, channels }));
}

function parseJSON(text: string, defaultGroup: string): LiveGroup[] {
  const data = JSON.parse(text);

  // 形态 1：LiveGroup[] —— [{group, channels:[{name,urls,logo,...}]}, ...]
  if (Array.isArray(data) && data.length && data.every((x) => x && typeof x === 'object' && 'channels' in x)) {
    const out: LiveGroup[] = [];
    for (const g of data as any[]) {
      const group = String(g.group || g.name || defaultGroup);
      const channels: LiveChannel[] = [];
      for (const c of (g.channels || [])) {
        const rawUrls: string[] = Array.isArray(c.urls) ? c.urls : (c.url ? [c.url] : []);
        const urls = cleanUrls(rawUrls);
        if (!urls.length) continue;
        const ch = makeChannel(c.name || 'Unnamed', urls[0], {
          logo: c.logo || '',
          epg: c.epg || '',
          'tvg-id': c['tvg-id'] || '',
          'tvg-name': c['tvg-name'] || '',
          'tvg-chno': c['tvg-chno'] || '',
          ua: c.ua || '',
          referer: c.referer || '',
          origin: c.origin || '',
        });
        if (urls.length > 1) ch.urls = urls;
        channels.push(ch);
      }
      if (channels.length) out.push({ group, channels });
    }
    if (out.length) return out;
  }

  // 形态 2：FongMi 风格 {lives:[{name, url/api, group?}, ...]}
  if (data && typeof data === 'object' && Array.isArray((data as any).lives)) {
    const groupMap = new Map<string, LiveChannel[]>();
    for (const l of (data as any).lives) {
      if (!l) continue;
      const group = String(l.group || l.name || defaultGroup);
      const url = String(l.url || l.api || '').trim();
      if (!/^(https?|rtmp|rtmps|rtsp):\/\//i.test(url)) continue;
      if (!groupMap.has(group)) groupMap.set(group, []);
      groupMap.get(group)!.push(makeChannel(l.name || group, url));
    }
    if (groupMap.size) return [...groupMap.entries()].map(([group, channels]) => ({ group, channels }));
  }

  // 形态 3：{ "央视": [{name,url}, ...], "卫视": [...] }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const out: LiveGroup[] = [];
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const channels: LiveChannel[] = [];
      for (const item of v as any[]) {
        if (!item) continue;
        const rawUrls: string[] = Array.isArray(item.urls) ? item.urls : (item.url ? [item.url] : []);
        const urls = cleanUrls(rawUrls);
        if (!urls.length) continue;
        const ch = makeChannel(item.name || k, urls[0], {
          logo: item.logo || '',
          epg: item.epg || '',
          'tvg-id': item['tvg-id'] || '',
          'tvg-name': item['tvg-name'] || '',
          ua: item.ua || '',
          referer: item.referer || '',
        });
        if (urls.length > 1) ch.urls = urls;
        channels.push(ch);
      }
      if (channels.length) out.push({ group: k, channels });
    }
    if (out.length) return out;
  }

  throw new Error('无法识别的 JSON 直播源结构（支持 LiveGroup[]、{lives:[]}、{分组名:[频道]}）');
}

// =========================================================================
// 公开刷新 API
// =========================================================================

/** 拉取并解析单个订阅源 */
export async function refreshSubscription(sub: LiveSubscription): Promise<LiveGroup[]> {
  const text = await fetchSubscriptionText(sub.url);
  if (!text || !text.trim()) throw new Error('订阅内容为空');
  const format = detectFormat(sub.url);
  if (format === 'm3u') return parseM3U(text, sub.name);
  if (format === 'txt') return parseTXT(text, sub.name);
  return parseJSON(text, sub.name);
}

/**
 * 刷新全部**启用**的订阅源。
 * - 单个源失败不会阻塞其他源（逐项 try/catch）
 * - 同时回写 lastUpdated / lastError 到磁盘
 */
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
      const groups = await refreshSubscription(sub);
      sub.lastUpdated = new Date().toISOString();
      sub.lastError = undefined;
      results.push({
        id: sub.id,
        name: sub.name,
        ok: true,
        groups,
        lastUpdated: sub.lastUpdated,
      });
      dirty = true;
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      sub.lastError = msg;
      results.push({ id: sub.id, name: sub.name, ok: false, error: msg });
      dirty = true;
    }
  }

  if (dirty) {
    try { await saveSubscriptions(subs); } catch { /* 写盘失败不影响本次结果返回 */ }
  }
  return results;
}

// =========================================================================
// IPC 注册
// =========================================================================

export function registerLiveSubscriptionIpc(): void {
  ipcMain.handle(LIVE_SUB_CHANNELS.LIST, async () => listSubscriptions());

  ipcMain.handle(LIVE_SUB_CHANNELS.ADD, async (_e, name: string, url: string) => {
    return await addSubscription(name, url);
  });

  ipcMain.handle(LIVE_SUB_CHANNELS.REMOVE, async (_e, id: string) => {
    await removeSubscription(id);
    return true;
  });

  ipcMain.handle(LIVE_SUB_CHANNELS.UPDATE, async (_e, id: string, patch: any) => {
    return await updateSubscription(id, patch || {});
  });

  ipcMain.handle(LIVE_SUB_CHANNELS.TOGGLE, async (_e, id: string, enabled: boolean) => {
    return await updateSubscription(id, { enabled: !!enabled });
  });

  ipcMain.handle(LIVE_SUB_CHANNELS.REFRESH_ALL, async () => {
    return await refreshAllSubscriptions();
  });
}

// 供 main/index.ts 一行接入：
//   import { registerLiveSubscriptionIpc } from './LiveSubscriptionManager';
//   registerLiveSubscriptionIpc();
