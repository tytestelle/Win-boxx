// src/main/live/EpgManager.ts
// XMLTV EPG 管理器 —— 移植自 TVBox EpgManager.java
//
// 匹配链路：
//   1) 频道名（trim）→ epg_data.json 的 name 变体精确查表 → epgid
//   2) 查不到 → 直接用频道名当 epgid
//   3) 用 epgid 去 XMLTV 匹配 <display-name>
//   4) 同名 epgid 命中多个 XMLTV <channel> → programmes 全部合并
//   5) loadedEpgIds 只记录成功命中的 epgid（未命中的下次继续尝试）

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  statSync, unlinkSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as sax from 'sax';
import { fileLogger } from '../util/logger';

const TAG = 'EpgManager';
const EPG_DIR_NAME = 'epgche';
const EPG_FILE_NAME = 'epg.xml';
const HASH_FILE_NAME = 'epg.hash';
const LOGO_DIR_NAME = 'logos';
const EPG_DATA_FILE_NAME = 'epg_data.json';
const EPG_DATA_HASH_FILE = 'epg_data_cache.hash';

const EPG_DATA_REMOTE_URL =
  'https://raw.githubusercontent.com/tytestelle/sandiJMYG/main/epg_data/epg_data.json';

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

export class EpgManager {
  // ===== 映射表 =====
  /** 变体名（trim 后）→ epgid */
  private readonly nameToEpgId = new Map<string, string>();
  /** 动态回填：频道名 → epgid */
  private readonly dynamicEpgIds = new Map<string, string>();

  // ===== XMLTV 解析索引 =====
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
  private readonly logoDir: string;
  private readonly epgDataFile: string;
  private readonly epgDataHashFile: string;

  constructor(private readonly userDataDir: string, epgUrl = '') {
    this.epgDir = join(userDataDir, EPG_DIR_NAME);
    this.epgFile = join(this.epgDir, EPG_FILE_NAME);
    this.hashFile = join(this.epgDir, HASH_FILE_NAME);
    this.logoDir = join(userDataDir, LOGO_DIR_NAME);
    this.epgDataFile = join(userDataDir, EPG_DATA_FILE_NAME);
    this.epgDataHashFile = join(userDataDir, EPG_DATA_HASH_FILE);

    for (const d of [this.epgDir, this.logoDir]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    }

    this.epgUrl = this.normalizeEpgUrl(epgUrl);
    this.loadEpgDataMap(false);
  }

  // ==================================================================
  // URL 管理
  // ==================================================================
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

  // ==================================================================
  // epg_data.json 加载
  //   resetXmlCache = true → 同时清空 XMLTV 解析缓存
  // ==================================================================
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

  // ==================================================================
  // 远程同步 epg_data.json
  // ==================================================================
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
      fileLogger.i(`${TAG} 远程 epg_data.json 已更新，将清 XML 缓存`);
      this.loadEpgDataMap(true);
    } catch (e) {
      fileLogger.w(`${TAG} 刷新 epg_data.json 失败: ${String(e)}`);
    } finally {
      this.epgDataRefreshRunning = false;
    }
  }

  // ==================================================================
  // 下载 / 刷新 XMLTV
  // ==================================================================
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

      // gzip 解压
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

  // ==================================================================
  // 分组按需加载
  // ==================================================================
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
    const key = channelName.trim();
    return this.nameToEpgId.get(key) ?? this.dynamicEpgIds.get(key) ?? null;
  }

  resolveEpgId(channelName: string): string | null {
    return this.lookupEpgId(channelName);
  }

  // ==================================================================
  // 流式解析 XMLTV（sax 单遍扫描）
  // ==================================================================
  private parseXmlForEpgIds(file: string, requested: Set<string>): Promise<void> {
    return new Promise((resolve) => {
      const newPrograms = new Map<string, EpgProgram[]>();
      const idsByEpgId = new Map<string, string[]>();
      const iconByEpgId = new Map<string, string>();
      const wantedChannelIds = new Set<string>();

      const parser = sax.createStream(true, { trim: false, normalize: false });

      let curChannelId: string | null = null;
      let curDisplayNames: string[] = [];
      let curIcon: string | null = null;
      let curProgChannel: string | null = null;
      let curStart: string | null = null;
      let curStop: string | null = null;
      let curTitle = '';
      let curDesc = '';
      let captureTag = '';
      let buf = '';

      parser.on('opentag', (node: sax.Tag) => {
        const name = node.name;
        if (name === 'channel') {
          curChannelId = String(node.attributes.id ?? '').trim() || null;
          curDisplayNames = [];
          curIcon = null;
        } else if (name === 'display-name' && curChannelId) {
          captureTag = 'display-name';
          buf = '';
        } else if (name === 'icon' && curChannelId && !curIcon) {
          curIcon = String(node.attributes.src ?? '').trim() || null;
        } else if (name === 'programme') {
          curProgChannel = String(node.attributes.channel ?? '').trim() || null;
          curStart = String(node.attributes.start ?? '').trim() || null;
          curStop = String(node.attributes.stop ?? '').trim() || null;
          curTitle = '';
          curDesc = '';
        } else if (name === 'title' && curProgChannel) {
          captureTag = 'title';
          buf = '';
        } else if (name === 'desc' && curProgChannel) {
          captureTag = 'desc';
          buf = '';
        }
      });

      parser.on('text', (t: string) => { if (captureTag) buf += t; });
      parser.on('cdata', (t: string) => { if (captureTag) buf += t; });

      parser.on('closetag', (node: sax.Tag | string) => {
        const name = typeof node === 'string' ? node : node.name;

        if (name === 'display-name' && captureTag === 'display-name') {
          const v = buf.trim();
          if (v) curDisplayNames.push(v);
          captureTag = '';
          buf = '';
        } else if (name === 'title' && captureTag === 'title') {
          curTitle = buf.trim();
          captureTag = '';
          buf = '';
        } else if (name === 'desc' && captureTag === 'desc') {
          curDesc = buf.trim();
          captureTag = '';
          buf = '';
        } else if (name === 'channel' && curChannelId) {
          const matched = this.matchChannelToEpgId(curDisplayNames, requested);
          if (matched) {
            const arr = idsByEpgId.get(matched) ?? [];
            if (!arr.includes(curChannelId)) arr.push(curChannelId);
            idsByEpgId.set(matched, arr);
            wantedChannelIds.add(curChannelId);
            if (curIcon && !iconByEpgId.has(matched)) iconByEpgId.set(matched, curIcon);
            fileLogger.i(
              `${TAG} XMLTV 命中: epgid=[${matched}] displayName=${JSON.stringify(curDisplayNames)} channelId=[${curChannelId}]`,
            );
          }
          curChannelId = null;
          curDisplayNames = [];
          curIcon = null;
        } else if (name === 'programme' && curProgChannel) {
          if (wantedChannelIds.has(curProgChannel) && curStart && curStop) {
            const s = this.parseXmltvTime(curStart);
            const e = this.parseXmltvTime(curStop);
            if (s && e && e.getTime() > s.getTime()) {
              const arr = newPrograms.get(curProgChannel) ?? [];
              arr.push({ title: curTitle, description: curDesc, start: s, stop: e });
              newPrograms.set(curProgChannel, arr);
            }
          }
          curProgChannel = null;
          curStart = null;
          curStop = null;
          curTitle = '';
          curDesc = '';
        }
      });

      parser.on('end', () => {
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
          fileLogger.i(`${TAG} EPG汇总: epgid=[${epgid}] channelIds=${JSON.stringify(allIds)} programmes=${merged.length}`);
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

        fileLogger.i(`${TAG} 按需解析完成: 请求=${requested.size} 本次命中=${idsByEpgId.size} 累计加载=${this.loadedEpgIds.size}`);
        resolve();
      });

      parser.on('error', (e: Error) => {
        fileLogger.w(`${TAG} XML 解析错误: ${String(e)}`);
        resolve();
      });

      createReadStream(file).pipe(parser);
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
    for (const dn of displayNames) {
      const t = dn.trim();
      const id = this.dynamicEpgIds.get(t);
      if (id && requested.has(id)) return id;
    }
    return null;
  }

  // ==================================================================
  // 查询接口
  // ==================================================================
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

  isEpgIdLoaded(epgid: string): boolean {
    return this.loadedEpgIds.has(epgid);
  }

  isParsed(): boolean {
    return this.parsed && this.programsByEpgId.size > 0;
  }

  // ==================================================================
  // 时间解析：XMLTV 形如 20240101120000 +0800
  // ==================================================================
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

  // ==================================================================
  // 网络工具
  // ==================================================================
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
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(target, buf);
    } finally {
      clearTimeout(t);
    }
  }
}
