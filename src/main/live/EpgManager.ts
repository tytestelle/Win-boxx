// src/main/live/EpgManager.ts
// XMLTV EPG 管理器 —— 移植自 TVBox EpgManager.java
// 无外部依赖（自研正则扫描器，兼容 XMLTV 常规格式）

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

const EPG_DATA_RAW_URL =
  'https://raw.githubusercontent.com/tytestelle/sandiJMYG/main/epg_data/epg_data.json';
// ★ 加速前缀：如需更换只改这一行（如 https://githubproxy.cc/ 或 https://ghfast.top/）
const GITHUB_PROXY = 'https://gitproxy.click/';
const EPG_DATA_REMOTE_URL = GITHUB_PROXY + EPG_DATA_RAW_URL;

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

// ===================== XML 工具（无依赖） =====================
/** 从属性串里取值（支持单/双引号） */
function attrValue(attrs: string, name: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`);
  const m = re.exec(attrs);
  if (!m) return '';
  return (m[1] ?? m[2] ?? '').trim();
}

/** 去掉 XML 文本节点里的 CDATA 包裹、实体引用和首尾空白 */
function stripXmlText(s: string): string {
  let t = s.trim();
  const cdataMatch = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(t);
  if (cdataMatch) t = cdataMatch[1];
  t = t
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
  return t.trim();
}

export class EpgManager {
  private readonly nameToEpgId = new Map<string, string>();
  private readonly xmlChannelIdsByEpgId = new Map<string, string[]>();
  private readonly programsByChannelId = new Map<string, EpgProgram[]>();
  private readonly programsByEpgId = new Map<string, EpgProgram[]>();
  private readonly iconUrlByEpgId = new Map<string, string>();
  private readonly loadedEpgIds = new Set<string>();

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

  loadEpgDataMap(resetXmlCache: boolean): void {
    this.nameToEpgId.clear();
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
            for (const v of String(item.name).split(',')) {
              const key = v.trim();
              if (key) this.nameToEpgId.set(key, epgid);
            }
          }
        }
        fileLogger.i(`${TAG} 加载 epg_data.json[${source}]，变体=${this.nameToEpgId.size}`);
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
    this.parsed = false;
  }

  async refreshEpgDataFromRemote(): Promise<void> {
    if (this.epgDataRefreshRunning) return;
    this.epgDataRefreshRunning = true;
    try {
      const remoteHash = await this.fetchText(EPG_DATA_REMOTE_URL + '.hash', 10_000);
      if (!remoteHash) return;
      const localHash = existsSync(this.epgDataHashFile)
        ? readFileSync(this.epgDataHashFile, 'utf-8').trim()
        : '';
      if (remoteHash === localHash && existsSync(this.epgDataFile)) return;
      const buf = await this.fetchBuffer(EPG_DATA_REMOTE_URL, 60_000);
      if (!buf || buf.length === 0) return;
      try {
        const parsed = JSON.parse(buf.toString('utf-8'));
        if (!parsed?.epgs) return;
      } catch {
        return;
      }
      writeFileSync(this.epgDataFile, buf);
      writeFileSync(this.epgDataHashFile, remoteHash, 'utf-8');
      fileLogger.i(`${TAG} 远程 epg_data.json 已更新（${buf.length}B），将清 XML 缓存`);
      this.loadEpgDataMap(true);
    } catch (e) {
      fileLogger.w(`${TAG} 刷新 epg_data.json 失败: ${String(e)}`);
    } finally {
      this.epgDataRefreshRunning = false;
    }
  }

  async refreshEpg(): Promise<EpgRefreshResult> {
    if (!this.epgUrl) return { ok: false, error: 'EPG URL 未设置' };
    if (this.refreshRunning) return { ok: false, error: '正在刷新中' };
    this.refreshRunning = true;
    try {
      const remoteHash = await this.fetchText(this.epgUrl + '.hash', 10_000);
      const localHash = existsSync(this.hashFile)
        ? readFileSync(this.hashFile, 'utf-8').trim()
        : '';
      if (remoteHash && remoteHash === localHash && existsSync(this.epgFile)) {
        this.resetXmlCache();
        return { ok: true };
      }
      if (!remoteHash && existsSync(this.epgFile)) {
        this.resetXmlCache();
        return { ok: true };
      }
      const tmp = this.epgFile + '.tmp';
      await this.downloadToFile(this.epgUrl, tmp);
      if (!existsSync(tmp) || statSync(tmp).size === 0) {
        return { ok: false, error: 'EPG 文件下载为空' };
      }
      const head = readFileSync(tmp).subarray(0, 2);
      if (head.length === 2 && head[0] === 0x1f && head[1] === 0x8b) {
        writeFileSync(tmp, gunzipSync(readFileSync(tmp)));
      }
      if (existsSync(this.epgFile)) unlinkSync(this.epgFile);
      try {
        renameSync(tmp, this.epgFile);
      } catch {
        writeFileSync(this.epgFile, readFileSync(tmp));
        unlinkSync(tmp);
      }
      if (remoteHash) writeFileSync(this.hashFile, remoteHash, 'utf-8');
      this.resetXmlCache();
      fileLogger.i(`${TAG} EPG 下载成功 size=${statSync(this.epgFile).size}`);
      return { ok: true };
    } catch (e) {
      if (existsSync(this.epgFile)) return { ok: true };
      return { ok: false, error: String(e) };
    } finally {
      this.refreshRunning = false;
    }
  }

  async loadChannelGroup(channelNames: string[]): Promise<void> {
    if (!channelNames || channelNames.length === 0) return;
    const requested = new Set<string>();
    for (const name of channelNames) {
      if (!name) continue;
      const epgid = this.lookupEpgId(name) || name.trim();
      requested.add(epgid);
    }
    if (requested.size === 0) return;
    if (!existsSync(this.epgFile) || statSync(this.epgFile).size === 0) return;
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
    return this.nameToEpgId.get(channelName.trim()) ?? null;
  }

  resolveEpgId(channelName: string): string | null {
    return this.lookupEpgId(channelName);
  }

  // ============== 纯正则扫描 XMLTV（无外部依赖） ==============
  private parseXmlForEpgIds(file: string, requested: Set<string>): Promise<void> {
    return new Promise((resolve) => {
      try {
        const xml = readFileSync(file, 'utf-8');
        const newPrograms = new Map<string, EpgProgram[]>();
        const idsByEpgId = new Map<string, string[]>();
        const iconByEpgId = new Map<string, string>();
        const wantedChannelIds = new Set<string>();

        // ---- 第一遍：扫 <channel> 块，匹配 display-name ----
        const channelRe = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
        let m: RegExpExecArray | null;
        while ((m = channelRe.exec(xml)) !== null) {
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

          const iconMatch = /<icon\b[^>]*?\bsrc\s*=\s*"([^"]*)"/.exec(body)
            || /<icon\b[^>]*?\bsrc\s*=\s*'([^']*)'/.exec(body);
          const icon = iconMatch ? (iconMatch[1] || '').trim() : '';

          const matched = this.matchChannelToEpgId(displayNames, requested);
          if (matched) {
            const arr = idsByEpgId.get(matched) ?? [];
            if (!arr.includes(channelId)) arr.push(channelId);
            idsByEpgId.set(matched, arr);
            wantedChannelIds.add(channelId);
            if (icon && !iconByEpgId.has(matched)) iconByEpgId.set(matched, icon);
            fileLogger.i(
              `${TAG} XMLTV 命中: epgid=[${matched}] displayName=${JSON.stringify(displayNames)} channelId=[${channelId}]`,
            );
          }
        }

        // ---- 第二遍：扫 <programme> 块（只收 wantedChannelIds 里的） ----
        const progRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
        while ((m = progRe.exec(xml)) !== null) {
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
        }

        // ---- 合并 ----
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
          fileLogger.i(
            `${TAG} EPG汇总: epgid=[${epgid}] channelIds=${JSON.stringify(allIds)} programmes=${merged.length}`,
          );
        }
        for (const [epgid, url] of iconByEpgId) {
          if (!this.iconUrlByEpgId.has(epgid)) this.iconUrlByEpgId.set(epgid, url);
        }
        for (const epgid of idsByEpgId.keys()) this.loadedEpgIds.add(epgid);
        this.parsed = this.programsByEpgId.size > 0 || this.xmlChannelIdsByEpgId.size > 0;

        const unmatched = new Set<string>();
        for (const r of requested) if (!idsByEpgId.has(r)) unmatched.add(r);
        if (unmatched.size > 0) {
          fileLogger.i(`${TAG} 未匹配上的 epgid: ${JSON.stringify([...unmatched])}`);
        }
        fileLogger.i(
          `${TAG} 按需解析完成: 请求=${requested.size} 本次命中=${idsByEpgId.size} 累计加载=${this.loadedEpgIds.size}`,
        );
        resolve();
      } catch (e) {
        fileLogger.w(`${TAG} XML 解析失败: ${String(e)}`);
        resolve();
      }
    });
  }

  private matchChannelToEpgId(displayNames: string[], requested: Set<string>): string | null {
    if (!displayNames || displayNames.length === 0) return null;
    for (const dn of displayNames) {
      const t = dn.trim();
      if (requested.has(t)) return t;
    }
    for (const dn of displayNames) {
      const t = dn.trim();
      const id = this.nameToEpgId.get(t);
      if (id && requested.has(id)) return id;
    }
    return null;
  }

  getProgramsForChannel(channelName: string): EpgProgram[] {
    if (!channelName || !this.parsed) return [];
    const epgid = this.lookupEpgId(channelName) ?? channelName.trim();
    return this.programsByEpgId.get(epgid)?.slice() ?? [];
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
    return this.iconUrlByEpgId.get(epgid) ?? '';
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

  private async fetchText(url: string, timeoutMs: number): Promise<string> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return '';
      return (await res.text()).trim();
    } catch {
      return '';
    }
  }

  private async fetchBuffer(url: string, timeoutMs: number): Promise<Buffer | null> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  private async downloadToFile(url: string, target: string): Promise<void> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    } finally {
      clearTimeout(t);
    }
  }
}
