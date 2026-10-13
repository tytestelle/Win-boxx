// src/main/live/EpgManager.ts
// XMLTV EPG 管理器 —— 移植自 TVBox EpgManager.java（含别名表，支持多 key 反查）

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  statSync, unlinkSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
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

// ===================== XML 工具 =====================
function attrValue(attrs: string, name: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`);
  const m = re.exec(attrs);
  if (!m) return '';
  return (m[1] ?? m[2] ?? '').trim();
}

function stripXmlText(s: string): string {
  let t = s.trim();
  const cdataMatch = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(t);
  if (cdataMatch) t = cdataMatch[1];
  t = t
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
  return t.trim();
}

function normalizeChannelName(name: string): string {
  if (!name) return '';
  let s = name.trim();
  s = s.replace(/[（(][^）)]*[）)]/g, '');
  s = s.replace(/超清|蓝光|高清|标清|原画|流畅|超高清|HD|UHD|SD|4K|8K|FHD|QHD/gi, '');
  s = s.replace(/[\s\-_.·]+/g, '');
  s = s.replace(/(频道|台)$/, '');
  return s.toUpperCase();
}

/** 把任意 Date/string/number 解析成本地时区的"当天 00:00:00"时间戳 */
function localDayStartMs(input: Date | string | number): number | null {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

/** 本地时区"次日 00:00:00"时间戳 */
function localNextDayStartMs(input: Date | string | number): number | null {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

/** 本地时区 YYYY-MM-DD 字符串（用于日志/调试） */
function localYmd(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

  /** ★ 别名表：任何已知的名字/归一化名字/channelId/epgid → channelId 列表 */
  private readonly aliasToChannelIds = new Map<string, string[]>();

  private activeProxy: string | null = null;
  private proxyProbing: Promise<string> | null = null;

  private parsed = false;
  private epgUrl: string;
  private refreshRunning = false;
  private epgDataRefreshRunning = false;

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
      // ★ 保留原始名字（"CCTV1"）—— 这样 noteAlias 能记录它
      requested.add(trimmed);
      // ★ 也加上查表后的 epgid（"CCTV-1 高清"）
      const epgid = this.lookupEpgId(trimmed);
      if (epgid) requested.add(epgid);
    }
    if (requested.size === 0) return;
    if (!this.parsed || !this.isSubset(requested, this.loadedEpgIds)) {
      await this.parseXmlForEpgIds(this.epgFile, requested);
    }
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

  /** ★ 记录别名 → channelId（精确名 + 归一化名都记） */
  private noteAlias(name: string, channelId: string): void {
    if (!name || !channelId) return;
    const key = name.trim();
    if (!key) return;
    const add = (k: string) => {
      if (!k) return;
      const arr = this.aliasToChannelIds.get(k) ?? [];
      if (!arr.includes(channelId)) arr.push(channelId);
      this.aliasToChannelIds.set(k, arr);
    };
    add(key);
    const nk = normalizeChannelName(key);
    if (nk) add(nk);
  }

  // ===================== XML 扫描（含别名记录） =====================
  private parseXmlForEpgIds(file: string, requested: Set<string>): Promise<void> {
    return new Promise((resolve) => {
      try {
        const t0 = Date.now();
        const xml = readFileSync(file, 'utf-8');
        fileLogger.i(`${TAG} 已读入 XML ${xml.length}B，扫描（请求 ${requested.size} 个频道）`);

        const requestedNorm = new Map<string, string>();
        for (const r of requested) {
          const nr = normalizeChannelName(r);
          if (nr && !requestedNorm.has(nr)) requestedNorm.set(nr, r);
        }

        const newPrograms = new Map<string, EpgProgram[]>();
        const idsByEpgId = new Map<string, string[]>();
        const iconByEpgId = new Map<string, string>();
        const wantedChannelIds = new Set<string>();

        const channelRe = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
        let m: RegExpExecArray | null;
        let totalChannel = 0;
        let matchByChannelId = 0, matchByExact = 0, matchByVariant = 0, matchByNorm = 0;

        while ((m = channelRe.exec(xml)) !== null) {
          totalChannel++;
          const attrs = m[1];
          const body = m[2];
          const channelId = attrValue(attrs, 'id');
          if (!channelId) continue;

          const displayNames: string[] = [];
          const dnRe = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g;
          let dn: RegExpExecArray | null;
          while ((dn = dnRe.exec(body)) !== null) {
            const v = stripXmlText(dn[1]);
            if (v) displayNames.push(v);
          }

          const iconMatch =
            /<icon\b[^>]*?\bsrc\s*=\s*"([^"]*)"/.exec(body) ||
            /<icon\b[^>]*?\bsrc\s*=\s*'([^']*)'/.exec(body);
          const icon = iconMatch ? (iconMatch[1] || '').trim() : '';

          let matched: string | null = null;
          let how = '';

          // 0) channelId 本身在 requested 里
          if (requested.has(channelId)) { matched = channelId; how = 'channelId'; }
          // 1) 精确等于 requested
          if (!matched) for (const d of displayNames) {
            const t = d.trim();
            if (requested.has(t)) { matched = t; how = 'exact'; break; }
          }
          // 2) 走 epg_data.json 变体表（精确）
          if (!matched) for (const d of displayNames) {
            const t = d.trim();
            const id = this.nameToEpgId.get(t);
            if (id && requested.has(id)) { matched = id; how = 'variant'; break; }
          }
          // 3) 归一化匹配
          if (!matched) for (const d of displayNames) {
            const nd = normalizeChannelName(d);
            if (!nd) continue;
            const r = requestedNorm.get(nd);
            if (r) { matched = r; how = 'norm'; break; }
          }
          // 4) 归一化 + 变体表
          if (!matched) for (const d of displayNames) {
            const nd = normalizeChannelName(d);
            if (!nd) continue;
            const id = this.normalizedNameToEpgId.get(nd);
            if (id && requested.has(id)) { matched = id; how = 'norm-variant'; break; }
          }

          if (matched) {
            if (how === 'channelId') matchByChannelId++;
            else if (how === 'exact') matchByExact++;
            else if (how === 'variant') matchByVariant++;
            else if (how === 'norm') matchByNorm++;

            const arr = idsByEpgId.get(matched) ?? [];
            if (!arr.includes(channelId)) arr.push(channelId);
            idsByEpgId.set(matched, arr);
            wantedChannelIds.add(channelId);
            if (icon && !iconByEpgId.has(matched)) iconByEpgId.set(matched, icon);

            const mNorm = normalizeChannelName(matched);
            if (mNorm && !this.normalizedToXmlChannelId.has(mNorm)) {
              this.normalizedToXmlChannelId.set(mNorm, channelId);
              if (icon) this.normalizedToIconUrl.set(mNorm, icon);
            }

            // ★ 记录所有别名
            for (const d of displayNames) this.noteAlias(d, channelId);
            this.noteAlias(matched, channelId);
            this.noteAlias(channelId, channelId);
          } else {
            // ★ 未匹配也记 channelId 别名（用户可能直接传 channelId）
            this.noteAlias(channelId, channelId);
          }
        }

        fileLogger.i(
          `${TAG} channel 扫描完成：共 ${totalChannel} 个 channel；channelId ${matchByChannelId} / 精确 ${matchByExact} / 变体 ${matchByVariant} / 归一化 ${matchByNorm}`,
        );

        const progRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
        let totalProg = 0, usedProg = 0;
        while ((m = progRe.exec(xml)) !== null) {
          totalProg++;
          const attrs = m[1];
          const body = m[2];
          const channel = attrValue(attrs, 'channel');
          if (!channel || !wantedChannelIds.has(channel)) continue;
          const start = attrValue(attrs, 'start');
          const stop = attrValue(attrs, 'stop');
          if (!start || !stop) continue;
          const s = this.parseXmltvTime(start);
          const e = this.parseXmltvTime(stop);
          if (!s || !e || e.getTime() <= s.getTime()) continue;

          const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/.exec(body);
          const descMatch = /<desc\b[^>]*>([\s\S]*?)<\/desc>/.exec(body);
          const title = titleMatch ? stripXmlText(titleMatch[1]) : '';
          const desc = descMatch ? stripXmlText(descMatch[1]) : '';

          const arr = newPrograms.get(channel) ?? [];
          arr.push({ title, description: desc, start: s, stop: e });
          newPrograms.set(channel, arr);
          usedProg++;
        }

        fileLogger.i(
          `${TAG} programme 扫描完成：共 ${totalProg} 条；命中 ${usedProg} 条（属于 ${newPrograms.size} 个 channel）`,
        );

        for (const [chId, list] of newPrograms) this.programsByChannelId.set(chId, list);
        for (const [epgid, ids] of idsByEpgId) {
          const existing = this.xmlChannelIdsByEpgId.get(epgid) ?? [];
          for (const id of ids) if (!existing.includes(id)) existing.push(id);
          this.xmlChannelIdsByEpgId.set(epgid, existing);
        }
        for (const [epgid] of idsByEpgId) {
          const allIds = this.xmlChannelIdsByEpgId.get(epgid) ?? [];
          const merged: EpgProgram[] = [];
          for (const id of allIds) {
            const list = this.programsByChannelId.get(id);
            if (list) merged.push(...list);
          }
          merged.sort((a, b) => a.start.getTime() - b.start.getTime());
          this.programsByEpgId.set(epgid, merged);
        }
        for (const [epgid, url] of iconByEpgId) {
          if (!this.iconUrlByEpgId.has(epgid)) this.iconUrlByEpgId.set(epgid, url);
        }
        for (const epgid of idsByEpgId.keys()) this.loadedEpgIds.add(epgid);
        this.parsed = this.programsByEpgId.size > 0 || this.xmlChannelIdsByEpgId.size > 0;

        const unmatched = new Set<string>();
        for (const r of requested) if (!idsByEpgId.has(r)) unmatched.add(r);
        if (unmatched.size > 0) {
          fileLogger.i(`${TAG} 未匹配上的 epgid（共 ${unmatched.size} 个，示例 20 个）: ${JSON.stringify([...unmatched].slice(0, 20))}`);
        }
        fileLogger.i(
          `${TAG} 解析完成: 请求=${requested.size} 命中=${idsByEpgId.size} 累计=${this.loadedEpgIds.size} 别名=${this.aliasToChannelIds.size} 耗时=${Date.now() - t0}ms`,
        );
        resolve();
      } catch (e) {
        fileLogger.w(`${TAG} XML 解析失败: ${String(e)}`);
        resolve();
      }
    });
  }

  // =====================================================================
  // ★ 多 key 联合查询：依次尝试所有可能的名字，返回合并去重排序后的节目列表
  // =====================================================================
  getProgramsForChannelMulti(names: string[]): EpgProgram[] {
    if (!names || !names.length) return [];

    const candidateEpgids = new Set<string>();
    const candidateChannelIds = new Set<string>();

    for (const raw of names) {
      const name = String(raw || '').trim();
      if (!name) continue;
      const nk = normalizeChannelName(name);

      // 1) 精确变体名 → epgid
      const e1 = this.nameToEpgId.get(name);
      if (e1) candidateEpgids.add(e1);
      // 2) 归一化变体名 → epgid
      if (nk) {
        const e2 = this.normalizedNameToEpgId.get(nk);
        if (e2) candidateEpgids.add(e2);
      }
      // 3) 名字本身当 epgid 候选
      candidateEpgids.add(name);

      // 4) 别名表（精确 & 归一化）
      const aliased = this.aliasToChannelIds.get(name);
      if (aliased) for (const cid of aliased) candidateChannelIds.add(cid);
      if (nk) {
        const aliased2 = this.aliasToChannelIds.get(nk);
        if (aliased2) for (const cid of aliased2) candidateChannelIds.add(cid);
        const cid = this.normalizedToXmlChannelId.get(nk);
        if (cid) candidateChannelIds.add(cid);
      }
    }

    fileLogger.i(
      `[EPG] multi 查询 keys=${JSON.stringify(names)} → epgids=${JSON.stringify([...candidateEpgids])} channelIds=${JSON.stringify([...candidateChannelIds])} 已解析=${this.programsByEpgId.size}/${this.programsByChannelId.size}`,
    );

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
    fileLogger.i(`[EPG] multi 结果 ${merged.length} 条`);
    return merged;
  }

  /** 单 key 查询（向后兼容，内部走 multi） */
  getProgramsForChannel(channelName: string): EpgProgram[] {
    return this.getProgramsForChannelMulti([channelName]);
  }

  // =====================================================================
  // ★ 按日期查询（弹窗使用）
  //   用"本地时区当天 00:00 ~ 次日 00:00"作为边界，避免 UTC 偏移导致
  //   "当天暂无节目"；与 getCurrentProgram 用的 Date.now() 语义一致。
  //   返回与该日有交集的所有节目（跨零点的节目也会保留）。
  // =====================================================================
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
      `[EPG] 按日期查询 localYMD=${localYmd(date)} ` +
      `dayStart=${new Date(dayStart).toISOString()} ` +
      `dayEnd=${new Date(dayEnd).toISOString()} ` +
      `全部=${all.length} 命中=${result.length}`,
    );
    return result;
  }

  /** 便捷：返回某天的所有节目（不区分频道，只走 multi 合并） */
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

  private parseXmltvTime(v: string): Date | null {
    if (!v || v.length < 14) return null;
    const main = v.substring(0, 14);
    let zone = '+0800';
    if (v.length >= 15) {
      const z = v.substring(14).trim();
      if (/^[+-]\d{4}/.test(z)) zone = z.substring(0, 5);
    }
    const iso = `${main.slice(0, 4)}-${main.slice(4, 6)}-${main.slice(6, 8)}T${main.slice(8, 10)}:${main.slice(10, 12)}:${main.slice(12, 14)}${zone.slice(0, 3)}:${zone.slice(3, 5)}`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
}
