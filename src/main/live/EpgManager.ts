// src/main/live/EpgManager.ts
// XMLTV EPG 管理器 —— 移植自 TVBox EpgManager.java（含别名表，支持多 key 反查）
//
// ★★ 2026-10-14（用户报「加载 50MB EPG XML 时未响应/崩溃」根本解决）★★
//   前两版尝试：
//     ① 主线程 readFileSync 整读 → 主进程卡死
//     ② 主线程流式分块 + 每 2000 条让出 → 仍慢（字符串拼接/正则的回溯成本太高）
//
//   现改为：**worker_threads（inline、eval 模式）跑解析**。
//     · 主进程完全不做解析，只等 worker 的 postMessage 结果
//     · 期间主进程 IPC 完全正常（窗口可拖动、按钮可点击、日志可写）
//     · worker 里直接 readFileSync + 正则扫（在独立线程/独立内存里，不影响 UI）
//     · 结果通过 structured clone 传回（Date 会被正确保留）
//     · 用 inline worker（eval: true）→ 不需要新文件、不需要改构建脚本

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  statSync, unlinkSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { fileLogger } from '../util/logger';

const TAG = 'EpgManager';
const EPG_DIR_NAME = 'epgche';
const EPG_FILE_NAME = 'epg.xml';
const HASH_FILE_NAME = 'epg.hash';
const EPG_DATA_FILE_NAME = 'epg_data_cache.json';
const EPG_DATA_HASH_FILE = 'epg_data_cache.hash';

const GITHUB_PROXIES = [
  'https://gh-proxy.org/',
  'https://ghfast.top/',
  'https://githubproxy.cc/',
  'https://mirror.ghproxy.com/',
  'https://ghproxy.net/',
  'https://gitproxy.click/',
  '',
];
const PROBE_RAW =
  'https://raw.githubusercontent.com/tytestelle/sandiJMYG/main/epg_data/epg_data.json.hash';

export interface EpgProgram {
  title: string;
  description: string;
  start: Date;
  stop: Date;
}

export interface EpgRefreshResult {
  ok: boolean;
  error?: string;
}

// =====================================================================
// ★ Worker 代码（inline）
//
//   worker 里独立完成：
//     1) readFileSync 读整个 XML（在 worker 自己的线程/内存里，不影响主进程）
//     2) 正则扫 channel + programme
//     3) postMessage 结果（只传命中的部分，量小）
//
//   纯函数（attrValue / stripXmlText / normalizeChannelName / parseXmltvTime）
//   在 worker 里重定义一次 —— 它们极小，重复没维护成本。
// =====================================================================
const EPG_WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');

const nameToEpgId = new Map(workerData.nameToEpgIdArr);
const normalizedNameToEpgId = new Map(workerData.normalizedNameToEpgIdArr);
const requested = new Set(workerData.requestedArr);
const xmlFile = workerData.xmlFile;

const attrReCache = new Map();
function attrValue(attrs, name) {
  let re = attrReCache.get(name);
  if (!re) {
    re = new RegExp('\\\\b' + name + '\\\\s*=\\\\s*"([^"]*)"|\\\\b' + name + '\\\\s*=\\\\s*\\'([^\\']*)\\'');
    attrReCache.set(name, re);
  }
  const m = re.exec(attrs);
  if (!m) return '';
  return (m[1] || m[2] || '').trim();
}

function stripXmlText(s) {
  let t = s.trim();
  const cdata = /^<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>$/.exec(t);
  if (cdata) t = cdata[1];
  t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
       .replace(/&amp;/g, '&');
  return t.trim();
}

function normalizeChannelName(name) {
  if (!name) return '';
  let s = name.trim();
  s = s.replace(/[\\uFF08(][^\\uFF09)]*[\\uFF09)]/g, '');
  s = s.replace(/\\u8D85\\u6E05|\\u84DD\\u5149|\\u9AD8\\u6E05|\\u6807\\u6E05|\\u539F\\u753B|\\u6D41\\u7545|\\u8D85\\u9AD8\\u6E05|HD|UHD|SD|4K|8K|FHD|QHD/gi, '');
  s = s.replace(/[\\s\\-_.\\u00B7]+/g, '');
  s = s.replace(/(\\u9891\\u9053|\\u53F0)$/, '');
  return s.toUpperCase();
}

function parseXmltvTime(v) {
  if (!v || v.length < 14) return null;
  const main = v.substring(0, 14);
  let zone = '+0800';
  if (v.length >= 15) {
    const z = v.substring(14).trim();
    if (/^[+-]\\d{4}/.test(z)) zone = z.substring(0, 5);
  }
  const iso = main.slice(0,4) + '-' + main.slice(4,6) + '-' + main.slice(6,8) + 'T' +
              main.slice(8,10) + ':' + main.slice(10,12) + ':' + main.slice(12,14) +
              zone.slice(0,3) + ':' + zone.slice(3,5);
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

// ---------- 请求集合归一化 ----------
const requestedNorm = new Map();
for (const r of requested) {
  const nr = normalizeChannelName(r);
  if (nr && !requestedNorm.has(nr)) requestedNorm.set(nr, r);
}

// ---------- 读取 XML ----------
let xml = '';
try {
  xml = fs.readFileSync(xmlFile, 'utf-8');
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e) });
  return;
}

// ---------- 扫 channel ----------
const newPrograms = new Map();
const idsByEpgId = new Map();
const iconByEpgId = new Map();
const wantedChannelIds = new Set();
const normalizedToXmlChannelId = new Map();
const normalizedToIconUrl = new Map();
const aliasToChannelIds = new Map();

let totalChannel = 0, matchByChannelId = 0, matchByExact = 0, matchByVariant = 0, matchByNorm = 0;

const noteAlias = (name, channelId) => {
  if (!name || !channelId) return;
  const key = name.trim();
  if (!key) return;
  const add = (k) => {
    if (!k) return;
    const arr = aliasToChannelIds.get(k) || [];
    if (arr.indexOf(channelId) < 0) arr.push(channelId);
    aliasToChannelIds.set(k, arr);
  };
  add(key);
  const nk = normalizeChannelName(key);
  if (nk) add(nk);
};

const channelRe = /<channel\\b([^>]*)>([\\s\\S]*?)<\\/channel>/g;
let m;
while ((m = channelRe.exec(xml)) !== null) {
  totalChannel++;
  const attrs = m[1], body = m[2];
  const channelId = attrValue(attrs, 'id');
  if (!channelId) continue;

  const displayNames = [];
  const dnRe = /<display-name\\b[^>]*>([\\s\\S]*?)<\\/display-name>/g;
  let dn;
  while ((dn = dnRe.exec(body)) !== null) {
    const v = stripXmlText(dn[1]);
    if (v) displayNames.push(v);
  }

  const iconMatch = /<icon\\b[^>]*?\\bsrc\\s*=\\s*"([^"]*)"/.exec(body) ||
                    /<icon\\b[^>]*?\\bsrc\\s*=\\s*'([^']*)'/.exec(body);
  const icon = iconMatch ? (iconMatch[1] || '').trim() : '';

  let matched = null, how = '';
  if (requested.has(channelId)) { matched = channelId; how = 'channelId'; }
  if (!matched) for (const d of displayNames) {
    const t = d.trim();
    if (requested.has(t)) { matched = t; how = 'exact'; break; }
  }
  if (!matched) for (const d of displayNames) {
    const t = d.trim();
    const id = nameToEpgId.get(t);
    if (id && requested.has(id)) { matched = id; how = 'variant'; break; }
  }
  if (!matched) for (const d of displayNames) {
    const nd = normalizeChannelName(d);
    if (!nd) continue;
    const r = requestedNorm.get(nd);
    if (r) { matched = r; how = 'norm'; break; }
  }
  if (!matched) for (const d of displayNames) {
    const nd = normalizeChannelName(d);
    if (!nd) continue;
    const id = normalizedNameToEpgId.get(nd);
    if (id && requested.has(id)) { matched = id; how = 'norm-variant'; break; }
  }

  if (matched) {
    if (how === 'channelId') matchByChannelId++;
    else if (how === 'exact') matchByExact++;
    else if (how === 'variant') matchByVariant++;
    else if (how === 'norm') matchByNorm++;

    const arr = idsByEpgId.get(matched) || [];
    if (arr.indexOf(channelId) < 0) arr.push(channelId);
    idsByEpgId.set(matched, arr);
    wantedChannelIds.add(channelId);
    if (icon && !iconByEpgId.has(matched)) iconByEpgId.set(matched, icon);

    const mNorm = normalizeChannelName(matched);
    if (mNorm && !normalizedToXmlChannelId.has(mNorm)) {
      normalizedToXmlChannelId.set(mNorm, channelId);
      if (icon) normalizedToIconUrl.set(mNorm, icon);
    }

    for (const d of displayNames) noteAlias(d, channelId);
    noteAlias(matched, channelId);
    noteAlias(channelId, channelId);
  } else {
    noteAlias(channelId, channelId);
  }
}

// ---------- 扫 programme ----------
let totalProg = 0, usedProg = 0;
const progRe = /<programme\\b([^>]*)>([\\s\\S]*?)<\\/programme>/g;
while ((m = progRe.exec(xml)) !== null) {
  totalProg++;
  const attrs = m[1], body = m[2];
  const channel = attrValue(attrs, 'channel');
  if (!channel || !wantedChannelIds.has(channel)) continue;
  const start = attrValue(attrs, 'start');
  const stop = attrValue(attrs, 'stop');
  if (!start || !stop) continue;
  const s = parseXmltvTime(start);
  const e = parseXmltvTime(stop);
  if (!s || !e || e.getTime() <= s.getTime()) continue;

  const titleMatch = /<title\\b[^>]*>([\\s\\S]*?)<\\/title>/.exec(body);
  const descMatch = /<desc\\b[^>]*>([\\s\\S]*?)<\\/desc>/.exec(body);
  const title = titleMatch ? stripXmlText(titleMatch[1]) : '';
  const desc = descMatch ? stripXmlText(descMatch[1]) : '';

  const arr = newPrograms.get(channel) || [];
  arr.push({ title: title, description: desc, start: s, stop: e });
  newPrograms.set(channel, arr);
  usedProg++;
}

// ---------- 回传（Map → 数组，便于 structured clone） ----------
parentPort.postMessage({
  ok: true,
  idsByEpgId: Array.from(idsByEpgId.entries()),
  programsByChannelId: Array.from(newPrograms.entries()),
  iconByEpgId: Array.from(iconByEpgId.entries()),
  normalizedToXmlChannelId: Array.from(normalizedToXmlChannelId.entries()),
  normalizedToIconUrl: Array.from(normalizedToIconUrl.entries()),
  aliasToChannelIds: Array.from(aliasToChannelIds.entries()),
  stats: { totalChannel, totalProg, usedProg, matchByChannelId, matchByExact, matchByVariant, matchByNorm },
});
`;

// worker 回传结果的结构
interface EpgWorkerResult {
  ok: boolean;
  error?: string;
  idsByEpgId: Array<[string, string[]]>;
  programsByChannelId: Array<[string, EpgProgram[]]>;
  iconByEpgId: Array<[string, string]>;
  normalizedToXmlChannelId: Array<[string, string]>;
  normalizedToIconUrl: Array<[string, string]>;
  aliasToChannelIds: Array<[string, string[]]>;
  stats: {
    totalChannel: number;
    totalProg: number;
    usedProg: number;
    matchByChannelId: number;
    matchByExact: number;
    matchByVariant: number;
    matchByNorm: number;
  };
}

export class EpgManager {
  private readonly nameToEpgId = new Map<string, string>();
  private readonly normalizedNameToEpgId = new Map<string, string>();

  private readonly xmlChannelIdsByEpgId = new Map<string, string[]>();
  private readonly programsByChannelId = new Map<string, EpgProgram[]>();
  private readonly programsByEpgId = new Map<string, EpgProgram[]>();
  private readonly iconUrlByEpgId = new Map<string, string>();
  private readonly loadedEpgIds = new Set<string>();
  private readonly normalizedToXmlChannelId = new Map<string, string>();
  private readonly normalizedToIconUrl = new Map<string, string>();
  private readonly aliasToChannelIds = new Map<string, string[]>();

  private activeProxy: string | null = null;
  private proxyProbing: Promise<string> | null = null;

  private parsed = false;
  private epgUrl: string;
  private refreshRunning = false;
  private epgDataRefreshRunning = false;
  /** ★ worker 解析锁：同一时间只跑一个 worker（避免重复解析大文件） */
  private parseRunning: Promise<void> | null = null;

  private readonly epgDir: string;
  private readonly epgFile: string;
  private readonly hashFile: string;
  private readonly epgDataFile: string;
  private readonly epgDataHashFile: string;

  constructor(private readonly userDataDir: string, epgUrl = '') {
    this.epgDir = join(userDataDir, EPG_DIR_NAME);
    this.epgFile = join(this.epgDir, EPG_FILE_NAME);
    this.hashFile = join(this.epgDir, HASH_FILE_NAME);
    this.epgDataFile = join(userDataDir, EPG_DATA_FILE_NAME);
    this.epgDataHashFile = join(userDataDir, EPG_DATA_HASH_FILE);
    if (!existsSync(this.epgDir)) mkdirSync(this.epgDir, { recursive: true });
    this.epgUrl = this.normalizeEpgUrl(epgUrl);
    this.loadEpgDataMap(false);
  }

  setEpgUrl(url: string): void {
    this.epgUrl = this.normalizeEpgUrl(url);
  }
  getEpgUrl(): string {
    return this.epgUrl;
  }
  private normalizeEpgUrl(url: string): string {
    if (!url) return '';
    const v = url.trim();
    const idx = v.indexOf('$');
    return idx > 0 ? v.substring(0, idx).trim() : v;
  }

  // ===================== 加速前缀探测 =====================
  private async probeProxy(): Promise<string> {
    if (this.activeProxy !== null) return this.activeProxy;
    if (this.proxyProbing) return this.proxyProbing;
    this.proxyProbing = (async (): Promise<string> => {
      for (const prefix of GITHUB_PROXIES) {
        const url = prefix + PROBE_RAW;
        const label = prefix || '直连';
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 8000);
          const res = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 Win-Box', Accept: '*/*' },
          });
          clearTimeout(t);
          if (res.ok) {
            const txt = (await res.text()).trim();
            if (txt && txt.length < 512) {
              fileLogger.i(`${TAG} 加速前缀选定：${label}`);
              this.activeProxy = prefix;
              return prefix;
            }
          }
        } catch { /* 尝试下一个 */ }
      }
      fileLogger.w(`${TAG} 所有加速前缀均不可用，退化为直连`);
      this.activeProxy = '';
      return '';
    })();
    try { return await this.proxyProbing; } finally { this.proxyProbing = null; }
  }

  private async fetchViaProxy(rawUrl: string, timeoutMs: number, asBuffer: false): Promise<string>;
  private async fetchViaProxy(rawUrl: string, timeoutMs: number, asBuffer: true): Promise<Buffer | null>;
  private async fetchViaProxy(rawUrl: string, timeoutMs: number, asBuffer: boolean): Promise<string | Buffer | null> {
    const prefix = await this.probeProxy();
    const url = prefix + rawUrl;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 Win-Box', Accept: '*/*' },
      });
      clearTimeout(t);
      if (!res.ok) {
        if (res.status === 403 || res.status === 404 || res.status >= 500) this.activeProxy = null;
        return asBuffer ? null : '';
      }
      if (asBuffer) return Buffer.from(await res.arrayBuffer());
      return (await res.text()).trim();
    } catch {
      this.activeProxy = null;
      return asBuffer ? null : '';
    }
  }

  // ===================== epg_data.json 加载 =====================
  loadEpgDataMap(resetXmlCache: boolean): void {
    this.nameToEpgId.clear();
    this.normalizedNameToEpgId.clear();
    let source = '无';
    try {
      if (existsSync(this.epgDataFile) && statSync(this.epgDataFile).size > 0) {
        source = '本地缓存';
        const root = JSON.parse(readFileSync(this.epgDataFile, 'utf-8'));
        const epgs = root?.epgs;
        if (Array.isArray(epgs)) {
          for (const item of epgs) {
            if (!item?.epgid || !item?.name) continue;
            const epgid = String(item.epgid).trim();
            if (!epgid) continue;
            const normEpgid = normalizeChannelName(epgid);
            if (normEpgid && !this.normalizedNameToEpgId.has(normEpgid)) {
              this.normalizedNameToEpgId.set(normEpgid, epgid);
            }
            for (const v of String(item.name).split(',')) {
              const key = v.trim();
              if (!key) continue;
              this.nameToEpgId.set(key, epgid);
              const nk = normalizeChannelName(key);
              if (nk && !this.normalizedNameToEpgId.has(nk)) {
                this.normalizedNameToEpgId.set(nk, epgid);
              }
            }
          }
        }
        fileLogger.i(
          `${TAG} 加载 epg_data.json[${source}]，精确变体=${this.nameToEpgId.size}，归一化键=${this.normalizedNameToEpgId.size}`,
        );
      }
    } catch (e) {
      fileLogger.w(`${TAG} 加载 epg_data.json 失败[${source}]: ${String(e)}`);
    }
    if (resetXmlCache) this.resetXmlCache();
  }

  private resetXmlCache(): void {
    this.xmlChannelIdsByEpgId.clear();
    this.programsByChannelId.clear();
    this.programsByEpgId.clear();
    this.iconUrlByEpgId.clear();
    this.loadedEpgIds.clear();
    this.normalizedToXmlChannelId.clear();
    this.normalizedToIconUrl.clear();
    this.aliasToChannelIds.clear();
    this.parsed = false;
  }

  // ===================== 远程 epg_data.json 刷新 =====================
  async refreshEpgDataFromRemote(): Promise<void> {
    if (this.epgDataRefreshRunning) return;
    this.epgDataRefreshRunning = true;
    try {
      const hashRaw = 'https://raw.githubusercontent.com/tytestelle/sandiJMYG/main/epg_data/epg_data.json.hash';
      const dataRaw = 'https://raw.githubusercontent.com/tytestelle/sandiJMYG/main/epg_data/epg_data.json';
      const remoteHash = await this.fetchViaProxy(hashRaw, 15000, false);
      const localHash = existsSync(this.epgDataHashFile)
        ? readFileSync(this.epgDataHashFile, 'utf-8').trim() : '';
      if (remoteHash && remoteHash === localHash && existsSync(this.epgDataFile)) return;
      const buf = await this.fetchViaProxy(dataRaw, 60000, true);
      if (!buf || buf.length === 0) return;
      try {
        const parsed = JSON.parse(buf.toString('utf-8'));
        if (!parsed?.epgs) return;
      } catch { return; }
      writeFileSync(this.epgDataFile, buf);
      if (remoteHash) writeFileSync(this.epgDataHashFile, remoteHash, 'utf-8');
      fileLogger.i(`${TAG} epg_data.json 已更新（${buf.length}B）`);
      this.loadEpgDataMap(true);
    } catch (e) {
      fileLogger.w(`${TAG} 刷新 epg_data.json 失败: ${String(e)}`);
    } finally {
      this.epgDataRefreshRunning = false;
    }
  }

  // ===================== XMLTV 下载 =====================
  async refreshEpg(): Promise<EpgRefreshResult> {
    if (!this.epgUrl) return { ok: false, error: 'EPG URL 未设置' };
    if (this.refreshRunning) return { ok: false, error: '正在刷新中' };
    this.refreshRunning = true;
    try {
      if (existsSync(this.epgFile) && statSync(this.epgFile).size > 1024) {
        const age = Date.now() - statSync(this.epgFile).mtimeMs;
        if (age < 6 * 3600 * 1000) {
          fileLogger.i(`${TAG} EPG 本地文件未过期（${Math.round(age / 60000)} 分钟前）`);
          this.resetXmlCache();
          return { ok: true };
        }
      }
      const remoteHash = await this.fetchViaProxy(this.epgUrl + '.hash', 10000, false);
      const localHash = existsSync(this.hashFile)
        ? readFileSync(this.hashFile, 'utf-8').trim() : '';
      if (remoteHash && remoteHash === localHash && existsSync(this.epgFile)) {
        this.resetXmlCache();
        return { ok: true };
      }
      fileLogger.i(`${TAG} 开始下载 EPG ← ${this.epgUrl}`);
      const tmp = this.epgFile + '.tmp';
      const buf = await this.fetchViaProxy(this.epgUrl, 180000, true);
      if (!buf || buf.length === 0) {
        if (existsSync(this.epgFile)) {
          fileLogger.w(`${TAG} 下载失败但本地存在，用本地`);
          this.resetXmlCache();
          return { ok: true };
        }
        return { ok: false, error: 'EPG 下载失败' };
      }
      writeFileSync(tmp, buf);
      const head = readFileSync(tmp).subarray(0, 2);
      if (head.length === 2 && head[0] === 0x1f && head[1] === 0x8b) {
        writeFileSync(tmp, gunzipSync(readFileSync(tmp)));
      }
      if (existsSync(this.epgFile)) unlinkSync(this.epgFile);
      try { renameSync(tmp, this.epgFile); } catch {
        writeFileSync(this.epgFile, readFileSync(tmp));
        unlinkSync(tmp);
      }
      if (remoteHash) writeFileSync(this.hashFile, remoteHash, 'utf-8');
      this.resetXmlCache();
      fileLogger.i(`${TAG} EPG 就绪 size=${statSync(this.epgFile).size}`);
      return { ok: true };
    } catch (e) {
      if (existsSync(this.epgFile)) { this.resetXmlCache(); return { ok: true }; }
      return { ok: false, error: String(e) };
    } finally {
      this.refreshRunning = false;
    }
  }

  // ===================== 分组按需加载 =====================
  async loadChannelGroup(channelNames: string[]): Promise<void> {
    if (!channelNames || channelNames.length === 0) return;
    if (!existsSync(this.epgFile) || statSync(this.epgFile).size === 0) return;
    const requested = new Set<string>();
    for (const name of channelNames) {
      if (!name) continue;
      const trimmed = String(name).trim();
      if (!trimmed) continue;
      requested.add(trimmed);
      const epgid = this.lookupEpgId(trimmed);
      if (epgid) requested.add(epgid);
    }
    if (requested.size === 0) return;
    // 已有缓存覆盖 → 直接返回
    if (this.parsed && this.isSubset(requested, this.loadedEpgIds)) return;
    // 若已有 worker 在跑 → 等它完成再看
    if (this.parseRunning) {
      await this.parseRunning;
      if (this.parsed && this.isSubset(requested, this.loadedEpgIds)) return;
    }
    await this.parseXmlForEpgIds(this.epgFile, requested);
  }

  private isSubset(a: Set<string>, b: Set<string>): boolean {
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }

  private lookupEpgId(channelName: string): string | null {
    if (!channelName) return null;
    const key = channelName.trim();
    const hit = this.nameToEpgId.get(key);
    if (hit) return hit;
    const nk = normalizeChannelName(key);
    if (nk) {
      const nHit = this.normalizedNameToEpgId.get(nk);
      if (nHit) return nHit;
    }
    return null;
  }

  resolveEpgId(channelName: string): string | null {
    return this.lookupEpgId(channelName);
  }

  // =====================================================================
  // ★★ Worker 线程解析（主进程完全不阻塞）★★
  // =====================================================================
  private parseXmlForEpgIds(file: string, requested: Set<string>): Promise<void> {
    // 若已有 worker 在跑 → 复用
    if (this.parseRunning) return this.parseRunning;

    const t0 = Date.now();
    let sizeBytes = 0;
    try { sizeBytes = statSync(file).size; } catch { /* ignore */ }
    fileLogger.i(
      `${TAG} 启动 worker 解析 ${(sizeBytes / 1024 / 1024).toFixed(1)}MB（请求 ${requested.size} 个频道）…`,
    );

    const workerData = {
      xmlFile: file,
      requestedArr: [...requested],
      nameToEpgIdArr: [...this.nameToEpgId.entries()],
      normalizedNameToEpgIdArr: [...this.normalizedNameToEpgId.entries()],
    };

    const p = (async (): Promise<void> => {
      try {
        const result = await runEpgWorker(workerData);
        if (!result.ok) {
          fileLogger.w(`${TAG} worker 解析失败: ${result.error || 'unknown'}`);
          return;
        }
        this.applyWorkerResult(result, requested);
        const s = result.stats;
        fileLogger.i(
          `${TAG} 解析完成: 请求=${requested.size} 命中=${result.idsByEpgId.length} 累计=${this.loadedEpgIds.size} 别名=${this.aliasToChannelIds.size} ` +
            `channel=${s.totalChannel}(channelId ${s.matchByChannelId}/精确 ${s.matchByExact}/变体 ${s.matchByVariant}/归一化 ${s.matchByNorm}) ` +
            `programme=${s.totalProg}/命中 ${s.usedProg} 耗时=${Date.now() - t0}ms`,
        );
      } catch (e) {
        fileLogger.w(`${TAG} worker 异常: ${String(e)}`);
      } finally {
        this.parseRunning = null;
      }
    })();
    this.parseRunning = p;
    return p;
  }

  private applyWorkerResult(result: EpgWorkerResult, requested: Set<string>): void {
    // 合并 programmes（按 channelId）
    for (const [chId, list] of result.programsByChannelId) {
      const existing = this.programsByChannelId.get(chId);
      if (existing) {
        const seen = new Set(existing.map((p) => `${p.start.getTime()}_${p.stop.getTime()}_${p.title}`));
        for (const p of list) {
          const k = `${p.start.getTime()}_${p.stop.getTime()}_${p.title}`;
          if (!seen.has(k)) { seen.add(k); existing.push(p); }
        }
        existing.sort((a, b) => a.start.getTime() - b.start.getTime());
      } else {
        list.sort((a, b) => a.start.getTime() - b.start.getTime());
        this.programsByChannelId.set(chId, list);
      }
    }
    // channelIds by epgId
    for (const [epgid, ids] of result.idsByEpgId) {
      const existing = this.xmlChannelIdsByEpgId.get(epgid) ?? [];
      for (const id of ids) if (!existing.includes(id)) existing.push(id);
      this.xmlChannelIdsByEpgId.set(epgid, existing);
    }
    // 归一化名字 → xml channelId
    for (const [k, v] of result.normalizedToXmlChannelId) {
      if (!this.normalizedToXmlChannelId.has(k)) this.normalizedToXmlChannelId.set(k, v);
    }
    // icon
    for (const [epgid, url] of result.iconByEpgId) {
      if (!this.iconUrlByEpgId.has(epgid)) this.iconUrlByEpgId.set(epgid, url);
    }
    for (const [k, v] of result.normalizedToIconUrl) {
      if (!this.normalizedToIconUrl.has(k)) this.normalizedToIconUrl.set(k, v);
    }
    // aliases
    for (const [name, ids] of result.aliasToChannelIds) {
      const arr = this.aliasToChannelIds.get(name) ?? [];
      for (const id of ids) if (!arr.includes(id)) arr.push(id);
      this.aliasToChannelIds.set(name, arr);
    }
    // 重建 programsByEpgId（用于 multi 查询的 eid 分支）
    for (const [epgid] of result.idsByEpgId) {
      const allIds = this.xmlChannelIdsByEpgId.get(epgid) ?? [];
      const merged: EpgProgram[] = [];
      const seen = new Set<string>();
      for (const id of allIds) {
        const list = this.programsByChannelId.get(id);
        if (!list) continue;
        for (const p of list) {
          const k = `${p.start.getTime()}_${p.stop.getTime()}_${p.title}`;
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push(p);
        }
      }
      merged.sort((a, b) => a.start.getTime() - b.start.getTime());
      this.programsByEpgId.set(epgid, merged);
    }
    for (const epgid of result.idsByEpgId.map(([e]) => e)) this.loadedEpgIds.add(epgid);
    this.parsed = this.programsByEpgId.size > 0 || this.xmlChannelIdsByEpgId.size > 0;

    const unmatched = new Set<string>();
    for (const r of requested) if (!result.idsByEpgId.some(([e]) => e === r)) unmatched.add(r);
    if (unmatched.size > 0) {
      fileLogger.i(
        `${TAG} 未匹配上的 epgid（共 ${unmatched.size} 个，示例 20 个）: ${JSON.stringify([...unmatched].slice(0, 20))}`,
      );
    }
  }

  // =====================================================================
  // 多 key 联合查询
  // =====================================================================
  getProgramsForChannelMulti(names: string[]): EpgProgram[] {
    if (!names || !names.length) return [];

    const candidateEpgids = new Set<string>();
    const candidateChannelIds = new Set<string>();

    for (const raw of names) {
      const name = String(raw || '').trim();
      if (!name) continue;
      const nk = normalizeChannelName(name);

      const e1 = this.nameToEpgId.get(name);
      if (e1) candidateEpgids.add(e1);
      if (nk) {
        const e2 = this.normalizedNameToEpgId.get(nk);
        if (e2) candidateEpgids.add(e2);
      }
      candidateEpgids.add(name);

      const aliased = this.aliasToChannelIds.get(name);
      if (aliased) for (const cid of aliased) candidateChannelIds.add(cid);
      if (nk) {
        const aliased2 = this.aliasToChannelIds.get(nk);
        if (aliased2) for (const cid of aliased2) candidateChannelIds.add(cid);
        const cid = this.normalizedToXmlChannelId.get(nk);
        if (cid) candidateChannelIds.add(cid);
      }
    }

    // 未命中任何候选（且没解析过）→ 静默返回空
    if (candidateChannelIds.size === 0 && candidateEpgids.size === 0) return [];

    const merged: EpgProgram[] = [];
    const seen = new Set<string>();
    const pushAll = (list: EpgProgram[] | undefined) => {
      if (!list) return;
      for (const p of list) {
        const k = `${p.start.getTime()}_${p.stop.getTime()}_${p.title}`;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(p);
      }
    };

    for (const cid of candidateChannelIds) pushAll(this.programsByChannelId.get(cid));
    for (const eid of candidateEpgids) pushAll(this.programsByEpgId.get(eid));

    merged.sort((a, b) => a.start.getTime() - b.start.getTime());
    return merged;
  }

  getProgramsForChannel(channelName: string): EpgProgram[] {
    return this.getProgramsForChannelMulti([channelName]);
  }

  getProgramsForChannelByDate(
    channelNames: string | string[],
    date: Date | string | number,
  ): EpgProgram[] {
    const names = Array.isArray(channelNames) ? channelNames : [channelNames];
    const all = this.getProgramsForChannelMulti(names);
    if (all.length === 0) return [];

    const dayStart = localDayStartMs(date);
    const dayEnd = localNextDayStartMs(date);
    if (dayStart === null || dayEnd === null) return all;

    const result = all.filter((p) => {
      const s = p.start.getTime();
      const e = p.stop.getTime();
      return e > dayStart && s < dayEnd;
    });

    fileLogger.i(
      `[EPG] 按日期查询 localYMD=${localYmd(date)} 全部=${all.length} 命中=${result.length}`,
    );
    return result;
  }

  getProgramsForChannelsByDate(
    channelNames: string[],
    date: Date | string | number,
  ): EpgProgram[] {
    return this.getProgramsForChannelByDate(channelNames, date);
  }

  getCurrentProgram(channelName: string): EpgProgram | null {
    const now = Date.now();
    for (const p of this.getProgramsForChannel(channelName)) {
      if (now >= p.start.getTime() && now < p.stop.getTime()) return p;
    }
    return null;
  }

  getNextProgram(channelName: string): EpgProgram | null {
    const now = Date.now();
    for (const p of this.getProgramsForChannel(channelName)) {
      if (p.start.getTime() > now) return p;
    }
    return null;
  }

  getChannelIconUrl(channelName: string): string {
    if (!channelName) return '';
    const epgid = this.lookupEpgId(channelName) ?? channelName.trim();
    const direct = this.iconUrlByEpgId.get(epgid);
    if (direct) return direct;
    const nk = normalizeChannelName(channelName);
    if (nk) {
      const nIcon = this.normalizedToIconUrl.get(nk);
      if (nIcon) return nIcon;
      const nEpgid = this.normalizedNameToEpgId.get(nk);
      if (nEpgid) {
        const l2 = this.iconUrlByEpgId.get(nEpgid);
        if (l2) return l2;
      }
    }
    return '';
  }

  isParsed(): boolean {
    return this.parsed && this.programsByEpgId.size > 0;
  }
}

// =====================================================================
// Worker 启动器（模块级纯函数）
// =====================================================================
function runEpgWorker(payload: {
  xmlFile: string;
  requestedArr: string[];
  nameToEpgIdArr: Array<[string, string]>;
  normalizedNameToEpgIdArr: Array<[string, string]>;
}): Promise<EpgWorkerResult> {
  return new Promise<EpgWorkerResult>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(EPG_WORKER_CODE, {
      eval: true,
      workerData: payload,
      /** worker 自身内存不占主进程（Node 默认 2GB heap，够 50MB 解析） */
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    });
    const finish = (err: Error | null, result?: EpgWorkerResult): void => {
      if (settled) return;
      settled = true;
      void worker.terminate().catch(() => undefined);
      if (err) reject(err);
      else resolve(result!);
    };
    worker.once('message', (msg: EpgWorkerResult) => finish(null, msg));
    worker.once('error', (e) => finish(e instanceof Error ? e : new Error(String(e))));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(new Error(`EPG worker exited with code=${code}`));
    });
    /** 兜底超时：90 秒没结果就放弃（避免 worker 卡死导致永不返回） */
    setTimeout(() => finish(new Error('EPG worker timeout (90s)')), 90_000).unref?.();
  });
}

// =====================================================================
// 主进程侧的纯函数（与 worker code 内的同名实现保持一致）
// =====================================================================
function normalizeChannelName(name: string): string {
  if (!name) return '';
  let s = name.trim();
  s = s.replace(/[（(][^）)]*[）)]/g, '');
  s = s.replace(/超清|蓝光|高清|标清|原画|流畅|超高清|HD|UHD|SD|4K|8K|FHD|QHD/gi, '');
  s = s.replace(/[\s\-_.·]+/g, '');
  s = s.replace(/(频道|台)$/, '');
  return s.toUpperCase();
}

function localDayStartMs(input: Date | string | number): number | null {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

function localNextDayStartMs(input: Date | string | number): number | null {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

function localYmd(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
