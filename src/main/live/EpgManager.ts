// src/main/live/EpgManager.ts
// XMLTV EPG 管理器 —— 移植自 TVBox EpgManager.java（含归一化模糊匹配兜底）

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
// ★ 加速前缀：如需更换只改这一行
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
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
  return t.trim();
}

/**
 * ★ 2026-10-13：频道名归一化（用于模糊匹配兜底）。
 * 目标：`CCTV-1 高清` / `CCTV1高清` / `CCTV-1 HD` / `CCTV1` 归一化后都能对上。
 * 保留大小写（避免 CCTV 与 cctv 混淆），去掉空白、横杠、常见清晰度后缀、括号内容。
 */
function normalizeChannelName(name: string): string {
  if (!name) return '';
  let s = name.trim();
  // 去掉括号内容（含中英文括号）
  s = s.replace(/[（(][^）)]*[）)]/g, '');
  // 去掉清晰度后缀（顺序敏感：先长后短）
  s = s.replace(/超清|蓝光|高清|标清|原画|流畅|超高清|HD|UHD|SD|4K|8K|FHD|QHD/gi, '');
  // 去掉空白、横杠、下划线、点
  s = s.replace(/[\s\-_.·]+/g, '');
  // 去掉结尾的"台""频道""高清"（有些源叫 CCTV1台）
  s = s.replace(/(频道|台)$/, '');
  return s.toUpperCase();
}

export class EpgManager {
  private readonly nameToEpgId = new Map<string, string>();
  private readonly xmlChannelIdsByEpgId = new Map<string, string[]>();
  private readonly programsByChannelId = new Map<string, EpgProgram[]>();
  private readonly programsByEpgId = new Map<string, EpgProgram[]>();
  private readonly iconUrlByEpgId = new Map<string, string>();
  private readonly loadedEpgIds = new Set<string>();

  /** ★ 归一化名 → epgid（用于模糊匹配：CCTV1 高清 与 CCTV-1 归一到同一个键） */
  private readonly normalizedNameToEpgId = new Map<string, string>();
  /** ★ 归一化名 → XMLTV channelId（解析时构建） */
  private readonly normalizedToXmlChannelId = new Map<string, string>();
  /** ★ 归一化名 → iconUrl（解析时构建） */
  private readonly normalizedToIconUrl = new Map<string, string>();

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
            // 归一化 epgid 也放一份（用于反查）
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
      } else {
        fileLogger.w(`${TAG} epg_data.json 尚未下载（${this.epgDataFile} 不存在），请检查网络/加速前缀`);
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
    this.parsed = false;
  }

  async refreshEpgDataFromRemote(): Promise<void> {
    if (this.epgDataRefreshRunning) return;
    this.epgDataRefreshRunning = true;
    try {
      const remoteHash = await this.fetchText(EPG_DATA_REMOTE_URL + '.hash', 10_000);
      const localHash = existsSync(this.epgDataHashFile)
        ? readFileSync(this.epgDataHashFile, 'utf-8').trim()
        : '';
      if (remoteHash && remoteHash === localHash && existsSync(this.epgDataFile)) {
        fileLogger.i(`${TAG} epg_data.json 远程 hash 未变化，使用本地缓存`);
        return;
      }
      fileLogger.i(`${TAG} 下载 epg_data.json ← ${EPG_DATA_REMOTE_URL}`);
      const buf = await this.fetchBuffer(EPG_DATA_REMOTE_URL, 60_000);
      if (!buf || buf.length === 0) {
        fileLogger.w(`${TAG} epg_data.json 下载为空（可能加速前缀失效）`);
        return;
      }
      try {
        const parsed = JSON.parse(buf.toString('utf-8'));
        if (!parsed?.epgs) {
          fileLogger.w(`${TAG} epg_data.json 无 epgs 字段，丢弃`);
          return;
        }
      } catch {
        fileLogger.w(`${TAG} epg_data.json 不是合法 JSON，丢弃`);
        return;
      }
      writeFileSync(this.epgDataFile, buf);
      if (remoteHash) writeFileSync(this.epgDataHashFile, remoteHash, 'utf-8');
      fileLogger.i(`${TAG} epg_data.json 已更新（${buf.length}B），清 XML 缓存`);
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
        fileLogger.i(`${TAG} EPG hash 未变化，用本地 ${statSync(this.epgFile).size}B`);
        this.resetXmlCache();
        return { ok: true };
      }
      if (!remoteHash && existsSync(this.epgFile)) {
        fileLogger.i(`${TAG} EPG hash 拉取失败但本地文件存在，用本地 ${statSync(this.epgFile).size}B`);
        this.resetXmlCache();
        return { ok: true };
      }
      fileLogger.i(`${TAG} 开始下载 EPG ← ${this.epgUrl}`);
      const tmp = this.epgFile + '.tmp';
      await this.downloadToFile(this.epgUrl, tmp);
      if (!existsSync(tmp) || statSync(tmp).size === 0) {
        return { ok: false, error: 'EPG 文件下载为空' };
      }
      fileLogger.i(`${TAG} EPG 下载完成 ${statSync(tmp).size}B`);
      const head = readFileSync(tmp).subarray(0, 2);
      if (head.length === 2 && head[0] === 0x1f && head[1] === 0x8b) {
        fileLogger.i(`${TAG} EPG 是 gzip，解压中`);
        writeFileSync(tmp, gunzipSync(readFileSync(tmp)));
        fileLogger.i(`${TAG} EPG 解压后 ${statSync(tmp).size}B`);
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
      fileLogger.i(`${TAG} EPG 就绪 size=${statSync(this.epgFile).size}`);
      return { ok: true };
    } catch (e) {
      if (existsSync(this.epgFile)) {
        fileLogger.w(`${TAG} EPG 刷新异常但本地文件存在，用本地: ${String(e)}`);
        return { ok: true };
      }
      return { ok: false, error: String(e) };
    } finally {
      this.refreshRunning = false;
    }
  }

  async loadChannelGroup(channelNames: string[]): Promise<void> {
    if (!channelNames || channelNames.length === 0) return;
    if (!existsSync(this.epgFile) || statSync(this.epgFile).size === 0) {
      fileLogger.w(`${TAG} EPG 文件不存在，跳过解析`);
      return;
    }
    const requested = new Set<string>();
    for (const name of channelNames) {
      if (!name) continue;
      const epgid = this.lookupEpgId(name) || name.trim();
      requested.add(epgid);
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
    // ★ 归一化兜底
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

  // ============== XML 扫描（含归一化模糊匹配兜底） ==============
  private parseXmlForEpgIds(file: string, requested: Set<string>): Promise<void> {
    return new Promise((resolve) => {
      try {
        const t0 = Date.now();
        const xml = readFileSync(file, 'utf-8');
        fileLogger.i(`${TAG} 已读入 XML ${xml.length}B，开始扫描（请求 ${requested.size} 个频道）`);

        // 预构建 requested 的归一化集合
        const requestedNorm = new Map<string, string>(); // 归一化 → 原 epgid
        for (const r of requested) {
          const nr = normalizeChannelName(r);
          if (nr && !requestedNorm.has(nr)) requestedNorm.set(nr, r);
        }

        const newPrograms = new Map<string, EpgProgram[]>();
        const idsByEpgId = new Map<string, string[]>();
        const iconByEpgId = new Map<string, string>();
        const wantedChannelIds = new Set<string>();

        // ---- 第一遍：<channel> ----
        const channelRe = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
        let m: RegExpExecArray | null;
        let totalChannel = 0;
        let matchByExact = 0;
        let matchByVariant = 0;
        let matchByNorm = 0;
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

          // 三级匹配
          let matched: string | null = null;
          let how = '';

          // 1) 精确等于 requested 里的 epgid
          for (const d of displayNames) {
            const t = d.trim();
            if (requested.has(t)) { matched = t; how = 'exact'; break; }
          }
          // 2) 走 epg_data.json 变体表（精确）
          if (!matched) {
            for (const d of displayNames) {
              const t = d.trim();
              const id = this.nameToEpgId.get(t);
              if (id && requested.has(id)) { matched = id; how = 'variant'; break; }
            }
          }
          // 3) ★ 归一化模糊匹配（display-name 归一化后与 requested 的归一化集合对应）
          if (!matched) {
            for (const d of displayNames) {
              const nd = normalizeChannelName(d);
              if (!nd) continue;
              const r = requestedNorm.get(nd);
              if (r) { matched = r; how = 'norm'; break; }
            }
          }
          // 4) ★ 归一化+变体表：display-name 归一化后命中 epg_data.json 变体表，且其 epgid 在 requested 里
          if (!matched) {
            for (const d of displayNames) {
              const nd = normalizeChannelName(d);
              if (!nd) continue;
              const id = this.normalizedNameToEpgId.get(nd);
              if (id && requested.has(id)) { matched = id; how = 'norm-variant'; break; }
            }
          }

          if (matched) {
            if (how === 'exact') matchByExact++;
            else if (how === 'variant') matchByVariant++;
            else if (how === 'norm') matchByNorm++;
            const arr = idsByEpgId.get(matched) ?? [];
            if (!arr.includes(channelId)) arr.push(channelId);
            idsByEpgId.set(matched, arr);
            wantedChannelIds.add(channelId);
            if (icon && !iconByEpgId.has(matched)) iconByEpgId.set(matched, icon);

            // 归一化表也记下：便于后续查 icon
            const mNorm = normalizeChannelName(matched);
            if (mNorm && !this.normalizedToXmlChannelId.has(mNorm)) {
              this.normalizedToXmlChannelId.set(mNorm, channelId);
              if (icon) this.normalizedToIconUrl.set(mNorm, icon);
            }

            fileLogger.i(
              `${TAG} XMLTV 命中[${how}]: epgid=[${matched}] displayName=${JSON.stringify(displayNames)} channelId=[${channelId}]`,
            );
          }
        }

        fileLogger.i(
          `${TAG} channel 扫描完成：共 ${totalChannel} 个 channel；精确 ${matchByExact} / 变体 ${matchByVariant} / 归一化 ${matchByNorm}`,
        );

        // ---- 第二遍：<programme> ----
        const progRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
        let totalProg = 0;
        let usedProg = 0;
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
          const sample = [...unmatched].slice(0, 30);
          fileLogger.w(
            `${TAG} 未匹配上的 epgid（共 ${unmatched.size} 个，示例 30 个）: ${JSON.stringify(sample)}`,
          );
        }
        fileLogger.i(
          `${TAG} 解析完成: 请求=${requested.size} 命中=${idsByEpgId.size} 累计加载=${this.loadedEpgIds.size} 耗时=${Date.now() - t0}ms`,
        );
        resolve();
      } catch (e) {
        fileLogger.w(`${TAG} XML 解析失败: ${String(e)}`);
        resolve();
      }
    });
  }

  getProgramsForChannel(channelName: string): EpgProgram[] {
    if (!channelName || !this.parsed) return [];
    const epgid = this.lookupEpgId(channelName) ?? channelName.trim();
    const direct = this.programsByEpgId.get(epgid);
    if (direct && direct.length) return direct.slice();
    // ★ 归一化兜底：拿归一化名反查 xmlChannelId
    const nk = normalizeChannelName(channelName);
    if (nk) {
      const xmlId = this.normalizedToXmlChannelId.get(nk);
      if (xmlId) {
        const list = this.programsByChannelId.get(xmlId);
        if (list && list.length) return list.slice();
      }
      // 再查一次归一化 epgid
      const nEpgid = this.normalizedNameToEpgId.get(nk);
      if (nEpgid) {
        const l2 = this.programsByEpgId.get(nEpgid);
        if (l2 && l2.length) return l2.slice();
      }
    }
    return [];
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
    const t = setTimeout(() => ctrl.abort(), 180_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    } finally {
      clearTimeout(t);
    }
  }
}
