// src/main/spider/SpiderHost.ts — engine host
import { HttpClient } from '../net/HttpClient';
import { request as undiciRequest } from 'undici';
import { JsonStore } from '../store/JsonStore';
import { UserConfigManager, subscriptionStamp, type ConfigChangeKind } from '../store/UserConfigManager';
import { DriveStore } from '../store/DriveStore';
import type { LocalPkgAccess } from '../store/LocalPkgStore';
import { parsePkgUrl } from '../../engine/config/localPkg';
import { getAdapter } from '../net/qr';
import { runDriveWebLogin } from '../net/webLogin';
import { quarkTransfer, isQuarkSharePlay, quarkFileDelete, extractEpisodeFid, extractEpisodeName, extractQuarkShare } from '../net/quarkTransfer';
import { ucResolveShare, ucFileDelete, isUcSharePlay, extractUcShare } from '../net/ucTransfer';
import { baiduResolveShare, baiduResolveSharedFile, baiduFileDelete, isBaiduSharePlay, extractBaiduShare, extractBaiduSharedFile, extractBaiduInnerName, baiduDirectLinkByFsid, type BaiduSharedFile } from '../net/baiduTransfer';
import { fileLogger } from '../util/logger';
import { parseSiteConfig, parseSiteConfigWithBase, looksLikeSubscribeJson, type ParseResult } from '../../engine/config/ApiConfigParser';
import { parseMultiRepo, isFetchedRepoUrl, repoDisplayName, pickRepoLine, splitRepoLine, type MultiRepo } from '../../engine/config/multiRepo';
import { SourceViewModel } from '../../engine/vod/SourceViewModel';
import { parseToJsonArray, toLiveGroups } from '../../engine/live/TxtSubscribe';
import { EpgManager, type EpgProgram } from '../live/EpgManager';
import type { BackupSettingsState } from '../../shared/backup';
import type {
  SourceBean,
  SiteConfig,
  VodItem,
  VodDetail,
  PlayResult,
  LiveGroup,
  LiveBean,
  ImportReport,
  HttpClient as IHttpClient,
  KVStore,
  Logger,
  UserConfig,
  SourceUpdatePatch,
  SourceMoveDirection,
  EpgChannelRef,
  LiveEpgEntry,
  LiveEpgResult,
} from '../../shared/types';
import type { EngineHost } from '../../engine/ports';
import { createPooledSandboxFactory } from '../../engine/js/worker/JsWorkerPool';
import { userDataDir, cacheDir, resourcesDir, spiderCacheDir, distDir } from '../util/paths';
import { safeStorageDriveCodec } from '../util/driveCodec';
import {
  driveBindHintFromPlaySources,
  driveBindProviderFromText,
  driveProviderLabel,
  looksLikeDriveBindFailure,
  matchDriveCookieProvider,
  wrapPlayUrl,
  wrapPlayUrlWithHeaders,
} from '../../shared/driveProvider';
import { join, dirname } from 'node:path';
import { directPlayUrlError } from '../../shared/playbackResult';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { JarSpiderBridge, normalizeJarUrl } from '../../engine/spider/JarSpiderBridge';
import { mergeCloudDriveTokens } from '../../engine/spider/driveExt';
import {
  syncPizazzCookieFiles,
  syncWexCookieFiles,
  spiderSandboxDir,
} from './driveCookieFiles';
import { sourceTimeoutMs } from '../../engine/spider/SpiderFactory';
import { mergeSearchResults, isSearchableSource, type AggSearchInput } from '../../engine/vod/aggSearch';
import {
  newSourceStat,
  noteSourceOk,
  noteSourceFail,
  scheduleOrder,
  sourceBudgetMs,
  type SourceStat,
} from '../../engine/vod/searchScheduler';
import { SearchCache } from '../../engine/vod/searchCache';
import { classifyHealth } from '../../engine/vod/sourceHealth';
import { buildMergedSubscription, type MergeInput } from '../../engine/config/mergeSubscriptions';
import type { AuditItem, SearchAllReport, SearchAllProgressEvent } from '../../shared/types';
import {
  describeFailures,
  disguiseLadder,
  fetchWithDisguise,
  looksEncrypted,
  siteRootOf,
  sniffBody,
} from '../../engine/util/fetchWithDisguise';
import { tryDecryptConfig } from '../net/configDecrypt';
import { extractStegoConfig, looksLikeImage } from '../../engine/util/imageStego';
import { classifyPlayLink } from '../../engine/vod/playLink';
import type { TorrentPlay } from '../torrent/torrentPlay';
import { SubtitleStore } from '../subtitle/SubtitleStore';
import { diagTimer, logPlayDiag, shortHash } from '../util/playDiag';
import { fetchSubtitle, providerSettingsView, searchSubtitles } from '../subtitle';
import type { SubtitleSearchContext } from '../subtitle/provider';
import { buildSearchQuery, normalizeSubtitleQuery, titleVariants } from '../../engine/subtitle/normalizeQuery';
import type {
  SubtitleCandidate,
  SubtitleSettings,
  SubtitleFetchResult,
  SubtitleSearchReport,
} from '../../shared/subtitle';
import { DanmakuStore } from '../danmaku/DanmakuStore';
import {
  DanmakuEndpointHealth,
  logvarBangumi,
  logvarComment,
  logvarSearchAnime,
  mapLimit,
} from '../danmaku/logvarProvider';
import { endpointLabel, rankDanmakuAnimes } from '../../engine/danmaku/endpoints';
import type { DanmakuAnime, DanmakuApiEndpoint, DanmakuCandidate, DanmakuSettings } from '../../shared/danmaku';
import type { MetaHit, MetaExtra, DiscoverSection, DiscoverGenre, DiscoverGenrePage, MetaImages } from '../../shared/types';
import type { MetaSettings, MetaSettingsView, MetaSuggestion } from '../../shared/meta';
import { normalizeMetaSettings } from '../../shared/meta';
import { MetaStore } from '../meta/MetaStore';
import { MetaSettingsStore } from '../meta/MetaSettings';
import {
  tmdbSearchTitle,
  tmdbExtras,
  tmdbSuggest,
  tmdbImages,
  tmdbDiscover,
  tmdbGenres,
  tmdbGenrePage,
  metaCacheKey,
  metaQueryVariants,
  setTmdbRuntime,
  hasUserTmdbKey,
} from '../meta/tmdbProvider';
import { doubanSearchTitle, doubanSuggest, DOUBAN_CACHE_PREFIX } from '../meta/doubanProvider';
import { DomesticDiscover } from '../meta/domesticDiscover';
import { DiscoverArtwork } from '../meta/discoverArtwork';
import { ParseService } from '../parse/ParseService';
import { sniffMediaUrl } from '../parse/PageSniffer';
import { getProxySettings, jvmProxyArgs, childProxyEnv } from '../net/proxy';

const DOUBAN_MAX_VARIANTS = 2;

const SEARCH_ALL_WORKERS = 10;
const SEARCH_ALL_WORKERS_MAX = 24;
const SEARCH_ALL_BUDGET_MS = 40_000;
const SEARCH_ALL_SOURCE_MAX_MS = 10_000;
const SEARCH_ALL_JS_MAX_MS = 5_000;
const SEARCH_ALL_QUICK_MS = 3_000;
const UNSUPPORTED_ERR = /UNSUPPORTED_|SCRIPT_ERROR|PY_UNSUPPORTED|desktop unsupported|unsupported|not implemented/i;
const SEARCH_ALL_PREPARE_MS = 12_000;

const DEFAULT_EPG_URL =
  'https://raw.githubusercontent.com/tytestelle/sandiJMYG/main/epg_data/epg_merged.xml';

function raceTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export function isBaiduPanDescriptor(url: string): boolean {
  const s = String(url || '').trim();
  return s.startsWith('{') && (/"surl"\s*:\s*"/.test(s) || extractBaiduSharedFile(s) !== null);
}

export function parsePanProxyQuery(proxyUrl: string): Record<string, string> {
  const out: Record<string, string> = {};
  const s = String(proxyUrl || '');
  const qi = s.indexOf('?');
  const q = qi >= 0 ? s.slice(qi + 1) : '';
  for (const kv of q.split('&')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    const k = i >= 0 ? kv.slice(0, i) : kv;
    const raw = i >= 0 ? kv.slice(i + 1) : '';
    let v = raw;
    for (let n = 0; n < 2; n++) {
      let next = '';
      try {
        next = decodeURIComponent(v);
      } catch {
        break;
      }
      if (next === v) break;
      v = next;
    }
    out[k] = v;
  }
  return out;
}

export interface LiveLoadResult {
  groups: LiveGroup[];
  liveName: string;
}

function collectEpgUrls(liveEpg: string | undefined, refs: EpgChannelRef[]): string[] {
  const out: string[] = [];
  const push = (raw: string): void => {
    const t = (raw || '').trim();
    if (!t || t.includes('{') || !/^https?:\/\//i.test(t)) return;
    const low = t.toLowerCase();
    if (!low.includes('xml') && !low.includes('gz')) return;
    if (!out.includes(t)) out.push(t);
  };
  for (const u of (liveEpg || '').split(',')) push(u);
  for (const r of refs) push(r.epg || '');
  return out;
}

export class SpiderHost {
  private http: IHttpClient;
  private kv: KVStore;
  private logger: Logger;
  private bridge: JarSpiderBridge;
  private vm: SourceViewModel;
  private manager: UserConfigManager;
  private drives: DriveStore;
  private subtitles: SubtitleStore;
  private danmakuStore: DanmakuStore;
  private danmakuCache = new Map<string, string>();
  private static readonly DANMAKU_CACHE_MAX = 200;
  private danmakuHealth = new DanmakuEndpointHealth();
  private metaStore: MetaStore;
  private metaSettings: MetaSettingsStore;
  private domesticDiscover: DomesticDiscover;
  private discoverArtwork: DiscoverArtwork;
  private pendingQuarkDeletes: Array<{ cookie: string; pdirFid: string; fid: string; dirFid?: string; path?: string; at: number; provider?: 'quark' | 'uc' | 'baidu' }> = [];
  private pendingQuarkStore: JsonStore;
  private pendingDeleteRun: Promise<void> | null = null;
  private parseService: ParseService;
  private autoRefreshStore: JsonStore;
  private config: SiteConfig | null = null;
  private report: ImportReport | null = null;
  private sourceMap = new Map<string, SourceBean>();
  // 2026-10-14: live source load cache (URL -> parsed groups + timestamp).
  // Avoids re-fetching local /file/local-live/ URLs and re-parsing on every page entry.
  private liveCache = new Map<string, { at: number; result: LiveLoadResult }>();
  private static readonly LIVE_CACHE_TTL_MS = 5 * 60_000;
  private lastSpiderJar = '';
  private epgMgr: EpgManager | null = null;
  private sourceHealth = new Map<string, SourceStat>();
  private unsupportedSources = new Set<string>();
  private searchCache = new SearchCache<SearchAllReport>();
  private lastPrewarmAt = 0;
  private driveBindKeys = new Set<string>();
  private driveBindStore!: JsonStore;
  onSearchAllProgress?: (ev: SearchAllProgressEvent) => void;
  torrentPlay?: Pick<TorrentPlay, 'open'>;
  localPkgs?: LocalPkgAccess;

  constructor() {
    const store = new JsonStore(join(cacheDir(), 'spider-local.json'));
    this.http = new HttpClient();
    this.kv = store;
    this.logger = fileLogger;
    this.parseService = new ParseService(this.http, this.logger, sniffMediaUrl);
    const host: EngineHost = {
      http: this.http,
      kv: this.kv,
      logger: this.logger,
      jsLibDir: join(resourcesDir(), 'js-lib'),
      driveTokens: () => this.drives.list(),
    };
    host.jsSandboxFactory = createPooledSandboxFactory(host, join(distDir(), 'js-worker.cjs'));
    this.engineHost = host;
    this.bridge = new JarSpiderBridge(
      {
        jvmDir: join(resourcesDir(), 'jvm'),
        cacheDir: join(spiderCacheDir(), 'converted'),
        callTimeoutMs: 20000,
        pyRuntimeDir: join(cacheDir(), 'python'),
        nativeRuntimeDir: join(cacheDir(), 'native'),
        proxyProvider: () => {
          const s = getProxySettings();
          return { jvmArgs: jvmProxyArgs(s), env: childProxyEnv(s) };
        },
      },
      host,
    );
    this.vm = new SourceViewModel(host, { jarBridge: this.bridge });
    this.manager = new UserConfigManager(new JsonStore(join(userDataDir(), 'user-config.json')), this.logger);
    this.drives = new DriveStore(new JsonStore(join(userDataDir(), 'drive-tokens.json')), this.logger, safeStorageDriveCodec());
    this.subtitles = new SubtitleStore(join(userDataDir(), 'subtitle.json'), this.logger, safeStorageDriveCodec());
    this.danmakuStore = new DanmakuStore(join(userDataDir(), 'danmaku.json'), this.logger);
    this.metaStore = new MetaStore(new JsonStore(join(userDataDir(), 'meta.json')));
    this.domesticDiscover = new DomesticDiscover(new JsonStore(join(cacheDir(), 'discovery.json')), this.logger);
    this.discoverArtwork = new DiscoverArtwork(new JsonStore(join(cacheDir(), 'discovery-artwork.json')), cacheDir(), this.logger);
    this.metaSettings = new MetaSettingsStore(join(userDataDir(), 'meta-settings.json'), this.logger, safeStorageDriveCodec());
    this.applyMetaRuntime();
    this.autoRefreshStore = new JsonStore(join(userDataDir(), 'auto-refresh.json'));
    this.pendingQuarkStore = new JsonStore(join(userDataDir(), 'pending-quark-delete.json'));
    const pendingRaw = this.pendingQuarkStore.getObject<Array<{ cookie?: string; pdirFid?: string; fid?: string; dirFid?: string; path?: string; at?: number; provider?: string }> | null>('list', null);
    if (Array.isArray(pendingRaw)) {
      this.pendingQuarkDeletes = pendingRaw
        .filter((x) => x && typeof x.cookie === 'string' && x.cookie && (typeof x.fid === 'string' ? x.fid : '') + (x.path || '') !== '')
        .map((x) => ({
          cookie: x.cookie as string,
          pdirFid: (x.pdirFid || '') as string,
          fid: (x.fid || '') as string,
          dirFid: x.dirFid || undefined,
          path: x.path || undefined,
          at: typeof x.at === 'number' ? x.at : Date.now(),
          provider: (x.provider === 'uc' || x.provider === 'baidu' ? x.provider : undefined) as 'quark' | 'uc' | 'baidu' | undefined,
        }));
    }
    this.manager.setOnChange((snap, kind) => this.onUserConfigChange(snap, kind));
    if (this.manager.load()) {
      this.onUserConfigChange(this.manager.snapshot());
    }
    this.driveBindStore = new JsonStore(join(userDataDir(), 'drive-bind-learned.json'));
    const learned = this.driveBindStore.getObject<unknown>('list', null);
    if (Array.isArray(learned)) {
      for (const k of learned) if (typeof k === 'string' && k) this.driveBindKeys.add(k);
    }
  }

  markDriveBindNeeded(key: string): void {
    const k = (key || '').trim();
    if (!k || this.driveBindKeys.has(k)) return;
    this.driveBindKeys.add(k);
    try {
      this.driveBindStore.setObject('list', [...this.driveBindKeys]);
      this.driveBindStore.flush();
    } catch (e) {
      this.logger.w(`drive-bind persist failed: ${(e as Error).message}`);
    }
  }

  driveBindLearned(): string[] {
    return [...this.driveBindKeys];
  }

  settingsSnapshot(): Pick<BackupSettingsState, 'userConfig' | 'driveTokens' | 'subtitle' | 'metaSettings' | 'danmaku'> {
    return {
      userConfig: this.cfgSnapshot(),
      driveTokens: this.drives.list(),
      subtitle: this.subtitles.settings,
      metaSettings: this.metaSettings.settings,
      danmaku: this.danmakuStore.settings,
    };
  }

  restoreSettings(s: Partial<BackupSettingsState>): void {
    if (s.userConfig) this.manager.restore(s.userConfig);
    if (s.driveTokens && typeof s.driveTokens === 'object') {
      const want = s.driveTokens;
      for (const p of Object.keys(this.drives.list())) if (!(p in want)) this.drives.remove(p);
      for (const [p, t] of Object.entries(want)) {
        if (p && typeof t === 'string' && t.trim()) this.drives.set(p, t);
      }
      this.resetSpidersAfterDriveChange();
    }
    this.syncDriveFiles();
    if (s.subtitle) this.subtitles.settings = s.subtitle;
    if (s.metaSettings) {
      this.metaSettings.settings = s.metaSettings;
      this.applyMetaRuntime();
    }
    if (s.danmaku) this.danmakuStore.settings = s.danmaku;
  }

  private readonly engineHost: EngineHost;
  get host(): EngineHost {
    return this.engineHost;
  }

  cfgSnapshot(): UserConfig {
    return this.manager.snapshot();
  }

  initializeLocalImports(): void {
    try {
      const before = this.manager.snapshot();
      const after = this.localPkgs?.migrateConfig?.(before, message => this.logger.w(message));
      if (after && JSON.stringify(after) !== JSON.stringify(before)) this.manager.restore(after);
    } catch (e) {
      this.logger.w(`local imports migration failed (original preserved): ${(e as Error).message}`);
    }
  }

  private cleanupLocalImports(before: UserConfig): void {
    try { this.localPkgs?.cleanupRemoved?.(before, this.manager.snapshot()); }
    catch (e) { this.logger.w(`local imports cleanup failed: ${(e as Error).message}`); }
  }

  cfgAddSource(raw: SourceBean): SourceBean {
    return this.manager.addSource(raw);
  }

  cfgUpdateSource(key: string, patch: SourceUpdatePatch): SourceBean {
    return this.manager.updateSource(key, patch);
  }

  cfgDeleteSource(key: string): void {
    const before = this.manager.snapshot();
    this.manager.deleteSource(key);
    this.cleanupLocalImports(before);
  }

  cfgMoveSource(key: string, direction: SourceMoveDirection): void {
    this.manager.moveSource(key, direction);
  }

  cfgSetActiveSource(key: string): void {
    this.manager.setActiveSource(key);
  }

  cfgSetActiveLive(index: number): void {
    this.manager.setActiveLiveIndex(index);
  }

  cfgProfiles() {
    return this.manager.profiles();
  }
  cfgProfileSites() {
    return this.manager.profileSitesView();
  }
  cfgSwitchProfileSource(id: string, key: string): void {
    this.manager.activateProfile(id, key);
  }
  cfgAddLive(bean: LiveBean) {
    return this.manager.addLive(bean);
  }
  cfgActiveProfileId(): string {
    return this.manager.activeProfileId();
  }
  cfgSaveAsProfile(name: string) {
    return this.manager.saveAsProfile(name);
  }
  cfgActivateProfile(id: string): void {
    this.manager.activateProfile(id);
  }
  cfgDeleteProfile(id: string): void {
    const before = this.manager.snapshot();
    this.manager.deleteProfile(id);
    this.cleanupLocalImports(before);
  }
  cfgUpdateProfileName(id: string, name: string): void {
    this.manager.updateProfileName(id, name);
  }

  async auditAll(): Promise<AuditItem[]> {
    const pool = (this.config?.sites ?? []).filter((b) => {
      if (b.type === 0 || b.type === 1) return true;
      if (b.type === 3) return true;
      return false;
    });
    const out: AuditItem[] = [];
    const workers = Math.min(4, pool.length || 1);
    let cursor = 0;
    const kindOf = (b: SourceBean): AuditItem['kind'] => {
      if (b.type === 0) return 'cms-xml';
      if (b.type === 1) return 'cms-json';
      const low = String(b.api || '').toLowerCase();
      if (low.endsWith('.js')) return 'js';
      if (low.endsWith('.py')) return 'py';
      return 'jar';
    };
    const run = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= pool.length) return;
        const b = pool[i];
        const t0 = Date.now();
        const kind = kindOf(b);
        try {
          const r = await raceTimeout(this.vm.home(b), 30000, 'home timeout (>30s)');
          const h = classifyHealth({ kind, items: r.items.length, classes: r.sortClasses.length, extEmpty: !String(b.ext || '').trim() });
          out.push({
            key: b.key, name: b.name || b.key, type: b.type, kind,
            items: r.items.length, classes: r.sortClasses.length, homeFallback: r.homeFallback,
            extEmpty: !String(b.ext || '').trim(), ms: Date.now() - t0,
            health: h.health, usable: h.usable, needsExt: h.needsExt, advice: h.advice,
          });
        } catch (e) {
          const msg = (e as Error).message;
          const h = classifyHealth({ kind, items: 0, classes: 0, extEmpty: !String(b.ext || '').trim(), error: msg });
          out.push({
            key: b.key, name: b.name || b.key, type: b.type, kind, items: 0, classes: 0,
            extEmpty: !String(b.ext || '').trim(), error: msg, ms: Date.now() - t0,
            health: h.health, usable: h.usable, needsExt: h.needsExt, advice: h.advice,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: workers }, () => run()));
    return out;
  }

  mergeProfilesExport(ids: string[]): { content: string; summary: MergeInput[] } {
    const pick = new Set(ids || []);
    const chosen = this.manager
      .rawProfiles()
      .filter((p) => pick.has(p.id))
      .map((p) => ({ name: p.name, json: p.json || '' }));
    const out = buildMergedSubscription(chosen);
    this.logger.i(
      `merge export: profiles=${out.summary.length} sites=${out.summary.reduce((n, s) => n + s.sites.length, 0)} ` +
        `spiders=${out.spiders.length ? out.spiders.length : 0} flags=${out.flags.length} parses=${out.parseCount}`,
    );
    return { content: out.content, summary: out.summary };
  }

  driveList() { return this.drives.list(); }
  pinSpiderProxy(port: number): void {
    this.bridge.pinSpiderProxy(port);
  }
  driveSet(provider: string, token: string) {
    this.drives.set(provider, token);
    this.syncDriveFiles();
    this.resetSpidersAfterDriveChange();
  }
  driveRemove(provider: string) {
    this.drives.remove(provider);
    this.syncDriveFiles();
    this.resetSpidersAfterDriveChange();
  }

  subtitleGetSettings(): SubtitleSettings {
    return this.subtitles.settings;
  }
  subtitleSetSettings(patch: Partial<SubtitleSettings>): SubtitleSettings {
    return this.subtitles.update(patch);
  }
  subtitleProviderView() {
    return providerSettingsView(this.subtitles.settings);
  }
  private subtitleContext(resourceName: string): SubtitleSearchContext {
    const { title, ep } = normalizeSubtitleQuery(resourceName || '');
    const mainKw = buildSearchQuery(resourceName || '');
    const variants = titleVariants(title || '');
    const keywords = Array.from(new Set([mainKw, ...variants.map((t) => t + (ep ? ' ' + ep : ''))])).filter(Boolean);
    return { title: title || mainKw, keywords, ep, settings: this.subtitles.settings };
  }
  async subtitleSearch(resourceName: string): Promise<SubtitleSearchReport> {
    const ctx = this.subtitleContext(resourceName);
    if (!ctx.keywords.length) throw new Error('cannot extract title from resource name');
    const report = await searchSubtitles(ctx);
    for (const p of report.providers) {
      this.logger.w(
        `subtitle ${p.id}: ${p.ok ? `hit ${p.count}` : p.skipped ? 'skipped' : 'failed'}${p.reason ? ' - ' + p.reason : ''}`,
      );
    }
    return report;
  }
  async subtitleFetch(candidate: SubtitleCandidate): Promise<SubtitleFetchResult> {
    if (!candidate || !candidate.file) return { text: '', fileName: '', reason: 'subtitle candidate missing download id' };
    return fetchSubtitle(candidate, this.subtitleContext(candidate.subname || ''));
  }

  danmakuGetSettings(): DanmakuSettings {
    return this.danmakuStore.settings;
  }
  danmakuSetSettings(patch: Partial<DanmakuSettings>): DanmakuSettings {
    return this.danmakuStore.update(patch || {});
  }
  private danmakuEndpoints(): DanmakuApiEndpoint[] {
    return (this.danmakuStore.settings.endpoints || []).filter((e) => e && e.enabled !== false && e.url);
  }
  private danmakuEndpointName(url: string): string {
    const hit = (this.danmakuStore.settings.endpoints || []).find((e) => e.url === url);
    return (hit?.name || '').trim() || endpointLabel(url) || 'external';
  }

  async danmakuSearch(keyword: string, season?: number): Promise<DanmakuAnime[]> {
    const kw = (keyword || '').trim();
    if (!kw) return [];
    const t0 = Date.now();
    const all = this.danmakuEndpoints();
    const live = all.filter((e) => !this.danmakuHealth.isCooling(e.url));
    const external = await mapLimit(live, 10, async (e): Promise<DanmakuAnime[]> => {
      try {
        const list = await logvarSearchAnime(e.url, kw, e.name);
        this.danmakuHealth.markOk(e.url);
        return list;
      } catch (err) {
        this.danmakuHealth.markFail(e.url);
        this.logger.w(`danmaku endpoint failed "${e.name}": ${(err as Error).message}`);
        return [];
      }
    });
    const merged = rankDanmakuAnimes(external.flat(), kw, season);
    const perSource = new Map<string, number>();
    const limited = merged.filter((a) => {
      const k = a.source || '';
      const n = perSource.get(k) || 0;
      if (n >= 15) return false;
      perSource.set(k, n + 1);
      return true;
    });
    this.logger.i(
      `danmaku search "${kw}": ${live.length} endpoints (${all.length - live.length} cooling); ${limited.length} hits / ${perSource.size} sources; ${Date.now() - t0}ms`,
    );
    return limited.slice(0, 60);
  }
  async danmakuEpisodes(bangumiId: number, animeTitle: string | undefined, source: string): Promise<DanmakuCandidate[]> {
    if (!bangumiId || !source) return [];
    try {
      const list = await logvarBangumi(source, Number(bangumiId), this.danmakuEndpointName(source), animeTitle);
      this.danmakuHealth.markOk(source);
      return list;
    } catch (e) {
      this.danmakuHealth.markFail(source);
      this.logger.w(`danmaku episodes failed "${this.danmakuEndpointName(source)}": ${(e as Error).message}`);
      return [];
    }
  }
  async danmakuFetch(episodeId: number, source: string): Promise<string> {
    if (!episodeId || !source) return '';
    const key = `${source}|${episodeId}`;
    const hit = this.danmakuCache.get(key);
    if (hit) return hit;
    let xml = '';
    try {
      xml = await logvarComment(source, episodeId);
      this.danmakuHealth.markOk(source);
    } catch (e) {
      this.danmakuHealth.markFail(source);
      this.logger.w(`danmaku fetch failed "${this.danmakuEndpointName(source)}": ${(e as Error).message}`);
      return '';
    }
    if (xml) {
      if (this.danmakuCache.size >= SpiderHost.DANMAKU_CACHE_MAX) {
        const oldest = this.danmakuCache.keys().next().value;
        if (oldest !== undefined) this.danmakuCache.delete(oldest);
      }
      this.danmakuCache.set(key, xml);
    }
    return xml;
  }

  private applyMetaRuntime(): void {
    const s = this.metaSettings.settings;
    setTmdbRuntime({ userKey: s.tmdbApiKey, apiBase: s.tmdbApiBase, imageBase: s.tmdbImageBase });
  }

  metaGetSettings(): MetaSettingsView {
    const s = this.metaSettings.settings;
    return { ...s, hasBuiltin: false, hasUserKey: !!s.tmdbApiKey.trim() };
  }

  metaSetSettings(patch: Partial<MetaSettings>): MetaSettingsView {
    const next = normalizeMetaSettings({ ...this.metaSettings.settings, ...patch });
    this.metaSettings.settings = next;
    this.applyMetaRuntime();
    this.logger.i(`meta: source=${next.metaSource}; user key=${next.tmdbApiKey ? 'set' : 'unset'}; proxy=${next.tmdbApiBase || 'default'}; image=${next.tmdbImageBase || 'default'}`);
    return this.metaGetSettings();
  }

  async metaImages(mediaType: 'movie' | 'tv', tmdbId: number): Promise<MetaImages> {
    try {
      return await tmdbImages(this.logger, mediaType, tmdbId);
    } catch (e) {
      this.logger.w(`meta images failed: ${(e as Error).message}`);
      return { backdrops: [], posters: [] };
    }
  }

  async metaSuggest(q: string): Promise<MetaSuggestion[]> {
    const term = (q || '').trim();
    if (!term) return [];
    try {
      const list = hasUserTmdbKey() ? await tmdbSuggest(this.logger, term) : [];
      if (list.length) return list;
      return await doubanSuggest(this.logger, term);
    } catch {
      return [];
    }
  }

  private async doubanLookup(n: string, year?: string): Promise<MetaHit | null> {
    for (const v of metaQueryVariants(n).slice(0, DOUBAN_MAX_VARIANTS)) {
      const dbKey = `${DOUBAN_CACHE_PREFIX}cover-v2:${metaCacheKey(v, year || '')}`;
      const diskDb = this.metaStore.cacheGet(dbKey);
      if (diskDb) {
        if (diskDb.hit) return diskDb.hit;
        continue;
      }
      const db = await doubanSearchTitle(this.logger, v, year);
      this.metaStore.cacheSet(dbKey, db, Date.now());
      if (db) return db;
    }
    return null;
  }

  async metaSearch(name: string, year?: string, provider?: 'tmdb' | 'douban'): Promise<MetaHit | null> {
    const n = (name || '').trim();
    if (!n) return null;
    try {
      if (provider !== 'douban' && hasUserTmdbKey()) {
        try {
          const hit = await tmdbSearchTitle(this.metaStore, this.logger, n, year || undefined);
          if (hit) return hit;
        } catch { /* fall through to douban */ }
      }
      if (provider === 'tmdb') return null;
      return await this.doubanLookup(n, year);
    } catch (e) {
      this.logger.e('meta search failed', e);
      return null;
    }
  }

  async metaExtra(name: string, year?: string): Promise<MetaExtra | null> {
    const n = (name || '').trim();
    if (!n) return null;
    if (!hasUserTmdbKey()) return null;
    try {
      return await tmdbExtras(this.metaStore, this.logger, n, year || undefined);
    } catch (e) {
      this.logger.w(`meta extras failed: ${(e as Error).message}`);
      return null;
    }
  }

  async metaDiscover(refresh = false): Promise<DiscoverSection[]> {
    try {
      return hasUserTmdbKey() ? await tmdbDiscover(this.logger, !!refresh) : await this.domesticDiscover.discover(!!refresh);
    } catch (e) {
      this.logger.w(`meta discover failed: ${(e as Error).message}`);
      return [];
    }
  }

  async metaGenres(): Promise<{ movie: DiscoverGenre[]; tv: DiscoverGenre[] }> {
    try {
      return hasUserTmdbKey() ? await tmdbGenres(this.logger) : this.domesticDiscover.genres();
    } catch (e) {
      this.logger.w(`meta genres failed: ${(e as Error).message}`);
      return { movie: [], tv: [] };
    }
  }

  async metaGenrePage(mediaType: string, genreId: number, page: number): Promise<DiscoverGenrePage> {
    const t: 'movie' | 'tv' = String(mediaType) === 'tv' ? 'tv' : 'movie';
    try {
      return hasUserTmdbKey()
        ? await tmdbGenrePage(this.logger, t, Number(genreId) || 0, Number(page) || 1)
        : await this.domesticDiscover.genrePage(t, Number(genreId) || 0, Number(page) || 1);
    } catch (e) {
      this.logger.w(`meta genre page failed: ${(e as Error).message}`);
      return { items: [], page: 1, totalPages: 1 };
    }
  }

  quarkDeletePending(): Promise<void> {
    if (this.pendingDeleteRun) return this.pendingDeleteRun;
    const run = this.deletePendingBatch();
    this.pendingDeleteRun = run.finally(() => { this.pendingDeleteRun = null; });
    return this.pendingDeleteRun;
  }

  metaMovieHot() { return this.domesticDiscover.hot(); }

  async metaDiscoverImages(name: string, mediaType: 'movie' | 'tv', year?: string, kind: 'backdrop' | 'poster' = 'backdrop') {
    if (kind === 'poster') {
      const hit = await this.metaSearch(name, year);
      return { backdrops: [], posters: hit?.poster ? [hit.poster] : [] };
    }
    if (hasUserTmdbKey()) {
      try {
        const hit = await tmdbSearchTitle(this.metaStore, this.logger, name, year);
        if (hit?.tmdbId) {
          const images = await tmdbImages(this.logger, hit.type, hit.tmdbId);
          if (images.backdrops.length) return images;
        }
      } catch { /* fall through */ }
    }
    return this.discoverArtwork.images(name, mediaType, year, kind);
  }

  private async deletePendingBatch(): Promise<void> {
    if (this.pendingQuarkDeletes.length === 0) return;
    const batch = this.pendingQuarkDeletes.slice();
    const remain: typeof this.pendingQuarkDeletes = [];
    for (const item of batch) {
      try {
        let ok = false;
        if (item.provider === 'baidu') {
          ok = await baiduFileDelete(item.cookie, item.path || '', this.logger);
        } else {
          const del = item.provider === 'uc' ? ucFileDelete : quarkFileDelete;
          if (item.dirFid && item.provider !== 'uc') ok = await quarkFileDelete(item.cookie, item.dirFid, item.dirFid, this.logger);
          if (!ok) ok = await del(item.cookie, item.pdirFid, item.fid, this.logger);
        }
        if (ok) {
          this.logger.i(`quark delete ok fid=${item.fid.slice(0, 8)}...` + (item.dirFid ? ` dir=${item.dirFid.slice(0, 8)}...` : '') + (item.path ? ` path=${item.path}` : ''));
        } else {
          remain.push(item);
        }
      } catch {
        remain.push(item);
      }
    }
    this.pendingQuarkDeletes = [...remain, ...this.pendingQuarkDeletes.filter((item) => !batch.includes(item))];
    this.persistPendingQuark();
  }

  private persistPendingQuark(): void {
    try {
      this.pendingQuarkStore.setObject('list', this.pendingQuarkDeletes);
      this.pendingQuarkStore.flush();
    } catch {
      /* ignore */
    }
  }

  protected async baiduContextFromJvm(port: number, fsid: string): Promise<BaiduSharedFile | null> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^\d+$/.test(fsid)) return null;
    try {
      const res = await undiciRequest(`http://127.0.0.1:${port}/proxy?do=winbox-baidu-context&fileId=${fsid}`, {
        headersTimeout: 5000, bodyTimeout: 5000,
      });
      const text = await res.body.text();
      const file = res.statusCode === 200 ? extractBaiduSharedFile(text) : null;
      return file?.fsid === fsid ? file : null;
    } catch { return null; }
  }

  private async baiduFromPanUrl(url: string, flag: string, miss?: string[], jvmPort?: number | null, episodeId = ''): Promise<PlayResult | null> {
    const share = extractBaiduShare(url) || extractBaiduShare(episodeId);
    const cookie = (this.driveList() as Record<string, string>)['baidu'] || '';
    const pan = parsePanProxyQuery(url);
    const fid = String(pan.fileId || '').trim();
    const sharedFile = extractBaiduSharedFile(episodeId) || extractBaiduSharedFile(url) ||
      (jvmPort && String(pan.site || '').toLowerCase().startsWith('baidu') && /^\d+$/.test(fid)
        ? await this.baiduContextFromJvm(jvmPort, fid) : null);
    if (sharedFile) {
      if (!cookie) { miss?.push('baidu: share file detected but no cookie'); return null; }
      try {
        const t = await baiduResolveSharedFile(sharedFile, cookie, fileLogger);
        if (t.path) {
          this.pendingQuarkDeletes.push({ provider: 'baidu', cookie, pdirFid: '', fid: '', path: t.path, at: Date.now() });
          if (this.pendingQuarkDeletes.length > 200) this.pendingQuarkDeletes.shift();
          this.persistPendingQuark();
        }
        if (!t.ok || !t.url) { miss?.push(`baidu: resolve failed (${t.reason || 'unknown'})`); return null; }
        return { parse: 0, url: wrapPlayUrlWithHeaders(t.url, t.header), playUrl: '', flag, header: t.header, jx: 0 };
      } catch (e) { miss?.push(`baidu: exception (${(e as Error).message.slice(0, 80)})`); return null; }
    }
    if (!share) {
      const site = String(pan.site || '').toLowerCase();
      if (!site.startsWith('baidu') || !/^\d{6,}$/.test(fid)) {
        return null;
      }
      if (!cookie) {
        miss?.push('baidu: fs_id detected but no cookie');
        return null;
      }
      try {
        const d = await baiduDirectLinkByFsid(fid, cookie, fileLogger);
        if (!d.ok || !d.url) {
          fileLogger.w(`baiduTransfer(fs_id) failed (${d.reason || 'unknown'})`);
          miss?.push(`baidu: resolve failed (${d.reason || 'unknown'})`);
          return null;
        }
        fileLogger.i('baiduTransfer(fs_id) direct link ok');
        return {
          parse: 0,
          url: wrapPlayUrlWithHeaders(d.url, d.header || {}),
          playUrl: '',
          flag,
          header: d.header || {},
          jx: 0,
        };
      } catch (e) {
        fileLogger.w(`baiduTransfer(fs_id) exception: ${(e as Error).message}`);
        miss?.push(`baidu: exception (${(e as Error).message.slice(0, 80)})`);
        return null;
      }
    }
    if (!cookie) {
      miss?.push('baidu: share detected but no cookie');
      return null;
    }
    try {
      const t = await baiduResolveShare(share.short, share.pwd, cookie, {
        innerFid: extractEpisodeFid(episodeId) || extractEpisodeFid(url) || (/^\d+$/.test(fid) ? fid : undefined),
        innerName: extractBaiduInnerName(episodeId) || extractEpisodeName(episodeId) || extractBaiduInnerName(url) || undefined,
        logger: fileLogger,
      });
      if (t.path) {
        this.pendingQuarkDeletes.push({ provider: 'baidu', cookie, pdirFid: '', fid: '', path: t.path, at: Date.now() });
        if (this.pendingQuarkDeletes.length > 200) this.pendingQuarkDeletes.shift();
        this.persistPendingQuark();
      }
      if (!t.ok || !t.url) {
        fileLogger.w(`baiduTransfer(do=pan) failed (${t.reason || 'unknown'})`);
        miss?.push(`baidu: resolve failed (${t.reason || 'unknown'})`);
        return null;
      }
      fileLogger.i(`baiduTransfer(do=pan) direct link ok (${t.path || ''})`);
      return {
        parse: 0,
        url: wrapPlayUrlWithHeaders(t.url, t.header || {}),
        playUrl: '',
        flag,
        header: t.header || {},
        jx: 0,
      };
    } catch (e) {
      fileLogger.w(`baiduTransfer(do=pan) exception: ${(e as Error).message}`);
      miss?.push(`baidu: exception (${(e as Error).message.slice(0, 80)})`);
      return null;
    }
  }

  private async ucFromPanUrl(url: string, flag: string, miss?: string[], episodeId = ''): Promise<PlayResult | null> {
    const pan = parsePanProxyQuery(url);
    const share = extractUcShare(episodeId, flag) || extractUcShare(url, flag) ||
      (/^uc/i.test(pan.site || '') && /^[0-9a-z_-]+$/i.test(pan.shareId || '')
        ? { pwdId: pan.shareId, passcode: pan.passcode || pan.pwd || '' } : null);
    if (!share) {
      return null;
    }
    const cookie = (this.driveList() as Record<string, string>)['uc'] || '';
    if (!cookie) {
      miss?.push('uc: share detected but no cookie');
      return null;
    }
    try {
      const fileId = pan.fileId && !/[/:?]/.test(pan.fileId) ? pan.fileId : '';
      const t = await ucResolveShare(share.pwdId, share.passcode, cookie, {
        innerFid: extractEpisodeFid(episodeId) || extractEpisodeFid(url) || fileId,
        innerName: extractEpisodeName(episodeId) || extractEpisodeName(url),
        logger: fileLogger,
      });
      if (!t.ok || !t.url) {
        fileLogger.w(`ucTransfer(do=pan) failed (${t.reason || 'unknown'})`);
        miss?.push(`uc: resolve failed (${t.reason || 'unknown'})`);
        return null;
      }
      if (t.fid) {
        this.pendingQuarkDeletes.push({ provider: 'uc', cookie, pdirFid: t.pdirFid || '', fid: t.fid, at: Date.now() });
        if (this.pendingQuarkDeletes.length > 200) this.pendingQuarkDeletes.shift();
        this.persistPendingQuark();
      }
      fileLogger.i('ucTransfer(do=pan) ok');
      return {
        parse: 0,
        url: wrapPlayUrlWithHeaders(t.url, t.header || {}),
        playUrl: '',
        flag,
        header: t.header || {},
        jx: 0,
      };
    } catch (e) {
      fileLogger.w(`ucTransfer(do=pan) exception: ${(e as Error).message}`);
      miss?.push(`uc: exception (${(e as Error).message.slice(0, 80)})`);
      return null;
    }
  }

  private async quarkFromPanUrl(url: string, flag: string, miss?: string[], episodeId = ''): Promise<PlayResult | null> {
    let share = extractQuarkShare(episodeId, flag) || extractQuarkShare(url, flag);
    let innerFid = extractEpisodeFid(episodeId) || extractEpisodeFid(url);
    const innerName = extractEpisodeName(episodeId) || extractEpisodeName(url);
    if (!share) {
      const pan = parsePanProxyQuery(url);
      const sid = String(pan.shareId || '').trim();
      const fid = String(pan.fileId || '').trim();
      if (/^quark/i.test(pan.site || '') && /^[0-9a-f]{10,}$/i.test(sid)) {
        share = { sId: sid, passcode: '' };
        if (!innerFid && /^[0-9a-f]{20,}$/i.test(fid)) innerFid = fid;
      }
    }
    if (!share) {
      return null;
    }
    const cookie = (this.driveList() as Record<string, string>)['quark'] || '';
    if (!cookie) {
      miss?.push('quark: share detected but no cookie');
      return null;
    }
    try {
      const t = await quarkTransfer(share.sId, cookie, {
        passcode: share.passcode,
        innerFid,
        innerName,
        logger: fileLogger,
      });
      if (!t.ok || !t.url) {
        fileLogger.w(`quarkTransfer(do=pan) failed (${t.reason || 'unknown'})`);
        miss?.push(`quark: resolve failed (${t.reason || 'unknown'})`);
        return null;
      }
      if (t.fid) {
        this.pendingQuarkDeletes.push({ cookie, pdirFid: t.pdirFid || '', dirFid: t.pdirFid || '', fid: t.fid, at: Date.now() });
        if (this.pendingQuarkDeletes.length > 200) this.pendingQuarkDeletes.shift();
        this.persistPendingQuark();
      }
      fileLogger.i(`quarkTransfer(do=pan) direct link ok: ${t.url.slice(0, 90)}...`);
      return {
        parse: 0,
        url: wrapPlayUrlWithHeaders(t.url, t.header || {}),
        playUrl: '',
        flag,
        header: t.header || {},
        jx: 0,
      };
    } catch (e) {
      fileLogger.w(`quarkTransfer(do=pan) exception: ${(e as Error).message}`);
      miss?.push(`quark: exception (${(e as Error).message.slice(0, 80)})`);
      return null;
    }
  }

  driveQrCreate(provider = 'ali') {
    return getAdapter(provider).qrCreate(this.http, this.logger);
  }
  driveQrPoll(provider: string, sid: string) {
    return getAdapter(provider || 'ali').qrPoll(this.http, this.logger, sid);
  }

  async driveWebLogin(provider: string): Promise<void> {
    const p = (provider || 'quark').trim().toLowerCase();
    const r = await runDriveWebLogin(p, this.logger);
    if (!r.done) {
      throw new Error(`${p}: login not detected (complete the QR authorization and keep the window open); no changes saved`);
    }
    if (!r.cookie.trim()) {
      throw new Error(`${p}: login detected but cookie not captured, retry`);
    }
    this.drives.set(p, r.cookie);
    this.syncDriveFiles();
    this.resetSpidersAfterDriveChange();
  }

  syncDriveFiles(): void {
    const tokens = this.drives.list();
    this.syncCloudDriveConfig(tokens);
    const written = syncPizazzCookieFiles(tokens);
    if (written.length) this.logger.i(`pizazz cookie files synced: ${written.join(', ')}`);
    const sandbox = spiderSandboxDir(spiderCacheDir());
    const wexWritten = syncWexCookieFiles(tokens, sandbox);
    if (wexWritten.length) {
      const ucPath = wexWritten.find((p) => p.endsWith('.ucpancookie'));
      const ucLen = ucPath ? readFileSync(ucPath, 'utf-8').trim().length : 0;
      this.logger.i(`wex cookie files synced: ${wexWritten.join(', ')} (sandbox=${sandbox}, ucLen=${ucLen})`);
    } else if (tokens.uc) {
      this.logger.w(`wex UC cookie not written (sandbox=${sandbox}, ucLen=${tokens.uc.trim().length})`);
    }
  }

  private syncCloudDriveConfig(tokens: Record<string, string>): void {
    const path = this.cloudDriveFilePath();
    let obj: Record<string, unknown> = {};
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
      }
    } catch { /* ignore */ }
    obj = mergeCloudDriveTokens(obj, tokens);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(obj), 'utf-8');
      this.logger.i(`Cloud-drive config synced -> ${path}`);
    } catch (e) {
      this.logger.w(`Cloud-drive config write failed: ${(e as Error).message}`);
    }
  }

  private cloudDriveFilePath(): string {
    for (const s of this.config?.sites ?? []) {
      try {
        const ext = JSON.parse(String(s.ext || '{}')) as Record<string, unknown>;
        const cd = ext['Cloud-drive'];
        if (typeof cd === 'string' && cd.trim()) {
          let rel = cd.trim().replace(/^\.\//, '');
          try {
            const parsed = new URL(rel);
            if (parsed.pathname.startsWith('/file/')) rel = decodeURIComponent(parsed.pathname.slice('/file/'.length));
          } catch { /* ignore */ }
          rel = rel.replace(/^\/+/, '');
          return join(userDataDir(), rel);
        }
      } catch { /* ignore */ }
    }
    return join(userDataDir(), 'tvfan', 'Cloud-drive.txt');
  }

  async debug(key: string) {
    const b = this.getSource(key);
    if (!b) throw new Error(`source missing: ${key}`);
    const { sourceDebug } = await import('./SourceDebugger');
    const runHome = async (k: string) => {
      const t0 = Date.now();
      try {
        const r = await this.vm.home(b);
        return {
          ok: true,
          ms: Date.now() - t0,
          classes: r.sortClasses.length,
          items: r.items.length,
          head: JSON.stringify(r.items[0] ?? r.sortClasses[0] ?? null).slice(0, 200),
        };
      } catch (e) {
        return { ok: false, ms: Date.now() - t0, classes: 0, items: 0, head: '', error: (e as Error).message };
      }
    };
    return sourceDebug(
      b,
      { http: this.http, logger: this.logger, globalSpiderJar: this.config?.spider || '' },
      runHome,
    );
  }

  async importConfig(source: { url?: string; json?: string; name?: string }, opts: { snapshot?: boolean } = {}): Promise<ParseResult> {
    const snapshot = opts.snapshot !== false;
    let text = source.json || '';
    this.lastConfigFetchHint = '';
    const sub = splitRepoLine(source.url || '');
    const fetchUrl = sub.url;
    if (source.url) {
      text = await this.fetchConfigText(fetchUrl);
    }
    const hint = (): string => (this.lastConfigFetchHint ? ` | diagnose: ${this.lastConfigFetchHint}` : '');
    const multi = parseMultiRepo(text);
    if (multi) {
      return this.importMultiRepo(multi, snapshot, source.name, sub.line);
    }
    let result: ParseResult;
    try {
      result = source.url ? parseSiteConfigWithBase(text, fetchUrl) : parseSiteConfig(text);
    } catch (e) {
      throw new Error(`${(e as Error).message}${hint()}`);
    }
    if (!result.config.sites.length && !result.config.lives.length && !result.config.parses.length) {
      throw new Error('no usable source in this subscription (maybe unrecognized multi-repo format, or expired); original config preserved' + hint());
    }
    this.report = result.report;
    this.config = result.config;
    this.applyConfig(result.config);
    this.applyImportedConfig(result.config, source.url || '', snapshot, source.name);
    return result;
  }

  private applyImportedConfig(parsed: SiteConfig, apiUrl: string, snapshot: boolean, name = ''): void {
    const custom = (name || '').trim();
    if (snapshot) {
      const snap = this.manager.snapshot();
      const hasOld = snap.sources.length > 0 || snap.lives.length > 0;
      const sameRemote = !!apiUrl && snap.apiUrl === apiUrl;
      if (hasOld && !sameRemote) {
        const stamp = subscriptionStamp();
        this.manager.renameActiveProfileAsOld(`old subscription ${stamp}`);
        this.manager.saveAsProfile(custom || `new subscription ${stamp}`, { parsed, apiUrl });
        return;
      }
    }
    this.manager.replaceFromImport(parsed, apiUrl);
    const id = custom ? this.manager.activeProfileId() : '';
    if (id) this.manager.updateProfileName(id, custom);
  }

  private lastConfigFetchHint = '';

  private async fetchConfigText(url: string, quick = false): Promise<string> {
    const pkgRef = parsePkgUrl(url);
    if (pkgRef) {
      this.lastConfigFetchHint = '';
      const got = this.localPkgs?.readSubscription(pkgRef.index, pkgRef.rel);
      if (!got) {
        this.lastConfigFetchHint =
          'local package not registered or subscription file missing (package moved/deleted?) - re-import the local package from the config page.';
        return '';
      }
      for (const w of got.warnings) this.logger.w(`local package: ${w}`);
      this.logger.i(`local package subscription read: ${url} -> ${got.text.length}B`);
      return got.text;
    }
    const timeoutMs = quick ? 12_000 : 30_000;
    this.lastConfigFetchHint = '';
    const isSubJson = (b: Buffer): boolean => looksLikeSubscribeJson(b.toString('utf-8'));
    const res = await fetchWithDisguise(this.http, url, {
      accept: isSubJson,
      attempts: disguiseLadder({ quick, referer: siteRootOf(url) }),
      timeoutMs,
      onTry: (t) => {
        const feat = [t.status ? `HTTP ${t.status}` : '', t.sniff ? `${t.sniff.kind} ${t.sniff.size}B` : '', t.reason || '']
          .filter(Boolean)
          .join(' . ');
        this.logger.i(`subscription try "${t.label}" ${t.ok ? 'hit' : 'miss'}: ${feat} <- ${t.url}`);
      },
    });
    if (res.buf) {
      if (res.used && res.used.label !== 'default UA') this.logger.i(`subscription via "${res.used.label}": ${url}`);
      if (res.altUrl) this.logger.i(`subscription via alt url (${res.altUrl}): ${url}`);
      return res.buf.toString('utf-8');
    }
    const stego = res.last ? extractStegoConfig(res.last) : null;
    if (stego) {
      this.logger.i(`subscription stego config extracted (${stego.kind}, tail ${stego.offset}, ${stego.text.length}B): ${url}`);
      return stego.text;
    }
    const raw = res.last ? res.last.toString('utf-8') : '';
    const dec = await tryDecryptConfig(this.http, url, raw, this.logger);
    if (dec) return dec.text;
    const encrypted = res.last ? looksEncrypted(res.last) : false;
    const image = res.last ? looksLikeImage(res.last) : false;
    const sn = res.last ? sniffBody(res.last) : null;
    this.lastConfigFetchHint =
      (encrypted ? 'response looks encrypted. ' : '') +
      (image ? 'response is an image (stego config not extracted). ' : '') +
      (sn ? `last response ${sn.kind} (${sn.size}B)${sn.head ? `, head="${sn.head.slice(0, 60)}"` : ''}. ` : 'no response body. ') +
      `tried: ${describeFailures(res.tries)}`;
    return raw;
  }

  private async importMultiRepo(multi: MultiRepo, snapshot: boolean, name = '', preferLine = -1): Promise<ParseResult> {
    const skipped: string[] = [];
    const total = multi.items.length;
    if (preferLine >= 0) {
      const picked = pickRepoLine(multi.items, preferLine)!;
      const label = repoDisplayName(picked.item.url, picked.item.name);
      const lineNo = picked.index + 1;
      const clampedNote = picked.index !== preferLine ? ` (#line=${preferLine} out of range, total ${total}, used last)` : '';
      if (!isFetchedRepoUrl(picked.item.url)) {
        const why = /^clan:/i.test(picked.item.url) ? 'local directory repo (clan://) not supported on desktop' : 'unsupported protocol';
        throw new Error(`multi-repo line ${lineNo} "${label}" unavailable: ${why}${clampedNote}`);
      }
      try {
        const text = await this.fetchConfigText(picked.item.url);
        const result = parseSiteConfigWithBase(text, picked.item.url);
        if (!result.config.sites.length && !result.config.lives.length) throw new Error('empty/not a subscription');
        this.report = result.report;
        this.config = result.config;
        this.applyConfig(result.config);
        this.applyImportedConfig(result.config, picked.item.url, snapshot, name);
        const note = `imported multi-repo line ${lineNo}/${total} "${label}" per #line=${preferLine}${clampedNote}${this.lastConfigFetchHint ? ` | diagnose: ${this.lastConfigFetchHint}` : ''}`;
        this.logger.i('multi-repo(line): ' + note);
        return { ...result, warnings: [...(result.warnings || []), note] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`multi-repo line ${lineNo} (#line=${preferLine}) "${label}" import failed: ${msg}`);
      }
    }
    const started = Date.now();
    let tried = 0;
    for (const item of multi.items) {
      if (tried >= SpiderHost.MULTI_REPO_MAX_TRY || (tried > 0 && Date.now() - started > SpiderHost.MULTI_REPO_BUDGET_MS)) {
        skipped.push(`remaining ${total - tried} not tried (multi-repo too large, budget ${Math.round(SpiderHost.MULTI_REPO_BUDGET_MS / 1000)}s cut off)`);
        break;
      }
      const label = repoDisplayName(item.url, item.name);
      if (!isFetchedRepoUrl(item.url)) {
        const why = /^clan:/i.test(item.url) ? 'local directory repo (clan://) not supported on desktop' : 'unsupported protocol';
        skipped.push(`"${label}" ${why}`);
        continue;
      }
      tried += 1;
      try {
        const text = await this.fetchConfigText(item.url, true);
        const result = parseSiteConfigWithBase(text, item.url);
        if (!result.config.sites.length && !result.config.lives.length) {
          skipped.push(`"${label}" empty/not a subscription`);
          continue;
        }
        this.report = result.report;
        this.config = result.config;
        this.applyConfig(result.config);
        this.applyImportedConfig(result.config, item.url, snapshot, name);
        const note = `multi-repo has ${total} items, imported first usable "${label}"${total > 1 ? `; rest ${total - 1}: ${skipped.join('; ') || 'all usable (import individually)'}; use #line=N (0-based) to pick a specific line` : ''}`;
        this.logger.i('multi-repo: ' + note);
        return { ...result, warnings: [...(result.warnings || []), note] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        skipped.push(`"${label}" ${msg}`);
      }
    }
    throw new Error(`multi-repo ${total} items, none usable (tried ${tried}): ${skipped.join('; ') || 'no valid item'}`);
  }

  private static readonly MULTI_REPO_BUDGET_MS = 60_000;
  private static readonly MULTI_REPO_MAX_TRY = 12;

  async maybeAutoRefreshSubscriptions(): Promise<boolean> {
    try {
      const snap = this.manager.snapshot();
      const url = (snap.apiUrl || '').trim();
      if (!/^https?:\/\//i.test(url)) return false;
      const lastAt = Number(this.autoRefreshStore.getObject<number>('lastAt', 0) || 0);
      const DAY_MS = 7 * 24 * 60 * 60 * 1000;
      if (lastAt && Date.now() - lastAt < DAY_MS) return false;
      const r = await this.importConfig({ url }, { snapshot: false });
      this.autoRefreshStore.setObject('lastAt', Date.now());
      this.autoRefreshStore.flush();
      this.logger.i(`auto refresh ok: ${url} (ok=${r.report.ok} skipped=${r.report.skipped} degraded=${r.report.degraded})`);
      return true;
    } catch (e) {
      this.logger.w('auto refresh failed: ' + (e instanceof Error ? e.message : String(e)));
      return false;
    }
  }

  get siteConfig(): SiteConfig | null {
    return this.config;
  }
  get importReport(): ImportReport | null {
    return this.report;
  }
  get sites(): SourceBean[] {
    return this.config?.sites ?? [];
  }
  getSource(key: string): SourceBean | null {
    return this.sourceMap.get(key) ?? null;
  }

  dispose(): void {
    try {
      this.bridge.dispose();
    } catch {
      /* ignore */
    }
  }

  home(key: string) {
    const b = this.getSource(key);
    if (!b) throw new Error(`source missing: ${key}`);
    return this.vm.home(b);
  }
  async pythonProxy(key: string, params: Record<string, string>): Promise<unknown[]> {
    const source = this.getSource(key);
    if (!source || !/\.py(?:[?#]|$)/i.test(source.api || '')) throw new Error('python proxy source not found');
    const spider = this.vm.spiderFactory.getCSP(source, this.host);
    const raw = await spider.proxy(params);
    const result: unknown = JSON.parse(raw);
    if (!Array.isArray(result)) throw new Error('python source returned invalid proxy response');
    return result;
  }
  category(key: string, tid: string, pg: string, extend: Record<string, string>) {
    const b = this.getSource(key);
    if (!b) throw new Error(`source missing: ${key}`);
    return this.vm.category(b, tid, pg, extend);
  }
  detail(key: string, ids: string[]) {
    const b = this.getSource(key);
    if (!b) throw new Error(`source missing: ${key}`);
    return this.vm.detail(b, ids).then((d) => {
      const hit = driveBindHintFromPlaySources(d?.flags, d ? Object.values(d.episodes || {}).flat().map((e) => e.url) : null);
      if (hit) {
        this.logger.i(`detect: play source contains cloud drive (${hit}) -> mark bind list: ${key}`);
        this.markDriveBindNeeded(key);
      }
      return d;
    });
  }
  search(key: string, wd: string) {
    const b = this.getSource(key);
    if (!b) throw new Error(`source missing: ${key}`);
    return this.vm.search(b, wd);
  }
  async searchAll(wd: string, opts?: { refresh?: boolean }): Promise<SearchAllReport> {
    const term = (wd || '').trim();
    if (!term) throw new Error('please enter a search keyword');
    if (!opts?.refresh) {
      const hit = this.searchCache.getEntry(term);
      if (hit) {
        this.logger.i(`search all cache hit "${term}" (${Math.round((Date.now() - hit.at) / 1000)}s ago) -> instant`);
        return { ...hit.value, cachedAt: hit.at };
      }
    } else {
      this.searchCache.delete(term);
    }
    const pool = this.searchableSites();
    const results = new Array<AggSearchInput | null>(pool.length).fill(null);
    const active: number[] = [];
    const skipped = new Array<AggSearchInput | null>(pool.length).fill(null);
    const searchT0 = Date.now();
    let firstHitAt = 0;
    let pushed = 0;
    const prepWaiters: Array<Promise<unknown>> = [];
    const notReadyYet = new Set<number>();
    for (let i = 0; i < pool.length; i++) {
      const b = pool[i];
      if (this.unsupportedSources.has(b.key)) continue;
      if (b.type !== 3) continue;
      try {
        const sp = this.vm.spiderFactory.getCSP(b, this.host) as {
          runtimeState?: () => 'ready' | 'preparing' | 'unavailable';
          pendingRuntime?: () => Promise<unknown> | null;
          lastReason?: string;
        };
        if (typeof sp.runtimeState !== 'function') continue;
        const state = sp.runtimeState();
        if (state === 'ready') continue;
        if (state === 'unavailable') {
          skipped[i] = {
            key: b.key, name: b.name || b.key, status: 'error',
            error: sp.lastReason || 'runtime unavailable: check jar url or runtime config', ms: 0,
          };
          continue;
        }
        notReadyYet.add(i);
        const w = sp.pendingRuntime?.();
        if (w) prepWaiters.push(w);
      } catch { /* ignore */ }
    }
    if (notReadyYet.size > 0) {
      this.logger.i(`search all: ${notReadyYet.size} sources preparing runtime (first-time download/convert jar) -> wait up to ${Math.round(SEARCH_ALL_PREPARE_MS / 1000)}s`);
      try {
        this.onSearchAllProgress?.({ wd: term, done: 0, total: pool.length, pending: pool.length });
      } catch { /* ignore */ }
      if (prepWaiters.length > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all(prepWaiters),
            new Promise((res) => { timer = setTimeout(res, SEARCH_ALL_PREPARE_MS); }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    }
    for (let i = 0; i < pool.length; i++) {
      const b = pool[i];
      if (this.unsupportedSources.has(b.key)) {
        skipped[i] = {
          key: b.key,
          name: b.name || b.key,
          status: 'error',
          error: 'skipped: source not supported on desktop (per session; single-source search still available)',
          ms: 0,
        };
        continue;
      }
      if (notReadyYet.has(i)) {
        let state = 'ready';
        let reason = '';
        try {
          const sp = this.vm.spiderFactory.getCSP(b, this.host) as { runtimeState?: () => string; lastReason?: string };
          state = sp.runtimeState?.() ?? 'ready';
          reason = sp.lastReason || '';
        } catch { state = 'ready'; }
        if (state !== 'ready') {
          skipped[i] = {
            key: b.key,
            name: b.name || b.key,
            status: 'error',
            error: state === 'unavailable'
              ? reason || 'runtime unavailable: check jar url or runtime config'
              : `runtime preparing: ${reason || 'background downloading/converting jar'}; not part of this round, re-search when ready`,
            ms: 0,
          };
          continue;
        }
      }
      if (skipped[i]) continue;
      active.push(i);
    }
    const total = active.length;
    let done = 0;
    const workerCount = Math.min(SEARCH_ALL_WORKERS_MAX, Math.max(SEARCH_ALL_WORKERS, Math.ceil(total / 5)));
    const deadline = Date.now() + SEARCH_ALL_BUDGET_MS;
    const order = scheduleOrder(pool.length, (i) => pool[i].key, this.sourceHealth).filter((i) => !skipped[i]);
    const activeKey = this.manager.activeSourceKey();
    if (activeKey) {
      const ai = order.findIndex((i) => pool[i].key === activeKey);
      if (ai > 0) order.unshift(...order.splice(ai, 1));
    }
    let cursor = 0;
    const finish = (i: number, input: AggSearchInput): void => {
      results[i] = input;
      done++;
      if (input.status === 'ok' && !firstHitAt) firstHitAt = Date.now() - searchT0;
      const cb = this.onSearchAllProgress;
      if (cb) {
        try {
          cb({ wd: term, source: input, done, total, pending: Math.max(0, total - done) });
          pushed++;
        } catch { /* ignore */ }
      }
    };
    const quickTimer = setTimeout(() => {
      try {
        this.onSearchAllProgress?.({ wd: term, done, total, pending: Math.max(0, total - done) });
      } catch { /* ignore */ }
    }, SEARCH_ALL_QUICK_MS);
    const run = async (): Promise<void> => {
      for (;;) {
        const i = order[cursor++];
        if (i === undefined) return;
        const b = pool[i];
        const t0 = Date.now();
        const budget = deadline - Date.now();
        if (budget <= 500) {
          finish(i, {
            key: b.key,
            name: b.name || b.key,
            status: 'error',
            error: `overall search timeout (>${Math.round(SEARCH_ALL_BUDGET_MS / 1000)}s), source skipped`,
            ms: 0,
          });
          continue;
        }
        const maxMs = /\.js(\?|$)/i.test(b.api || '') ? SEARCH_ALL_JS_MAX_MS : SEARCH_ALL_SOURCE_MAX_MS;
        const toMs = Math.min(sourceBudgetMs(this.sourceHealth.get(b.key), sourceTimeoutMs(b), maxMs), budget);
        try {
          const items = await raceTimeout(this.vm.search(b, term, false, toMs), toMs + 500, `source search timeout (>${Math.round(toMs / 1000)}s)`);
          const ms = Date.now() - t0;
          noteSourceOk(this.statOf(b.key), ms, { empty: items.length === 0 });
          finish(i, {
            key: b.key,
            name: b.name || b.key,
            status: items.length > 0 ? 'ok' : 'empty',
            items,
            ms,
          });
        } catch (e) {
          const ms = Date.now() - t0;
          const msg = (e as Error).message || String(e);
          if (UNSUPPORTED_ERR.test(msg)) {
            if (!this.unsupportedSources.has(b.key)) {
              this.unsupportedSources.add(b.key);
              this.logger.w(`search all: source "${b.name || b.key}" not supported on desktop (${msg.slice(0, 60)}) -> future searches will skip`);
            }
          }
          noteSourceFail(this.statOf(b.key));
          finish(i, { key: b.key, name: b.name || b.key, status: 'error', error: msg, ms });
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => run()));
    clearTimeout(quickTimer);
    const all = pool.map((_, i) => results[i] ?? skipped[i]).filter((r): r is AggSearchInput => r !== null);
    const report = mergeSearchResults(all);
    const pendingSources = all.filter((r) => r.status === 'error' && (r.error || '').startsWith('runtime preparing')).length;
    if (pendingSources > 0) report.pendingSources = pendingSources;
    this.searchCache.set(term, report);
    this.logger.i(
      `search all "${term}": pool ${pool.length} (ran ${total} / skipped ${pool.length - total}); ` +
        `first hit ${firstHitAt || '-'}ms; done in ${Date.now() - searchT0}ms; hit ${report.hitSources} sources ${report.items.length} items; ` +
        `pushed ${pushed} progress events`,
    );
    return report;
  }

  prewarmPythonSources(maxSources = 5): void {
    let n = 0;
    for (const b of this.config?.sites ?? []) {
      if (n >= maxSources) break;
      if (!(b.api || '').toLowerCase().includes('.py')) continue;
      try {
        const sp = this.vm.spiderFactory.getCSP(b, this.host) as { warmup?: () => void };
        if (typeof sp.warmup === 'function') {
          sp.warmup();
          n++;
        }
      } catch { /* ignore */ }
    }
    if (n > 0) this.logger.i(`python: scheduled ${n} .py source warmups, first access ready`);
  }

  poolAliveCount(): number {
    return this.bridge.alivePoolCount();
  }

  rewarmAfterCacheClear(): void {
    this.lastPrewarmAt = 0;
    if (this.lastSpiderJar) {
      this.bridge.warmup(this.lastSpiderJar).catch(() => undefined);
    }
    setTimeout(() => {
      try { this.prewarmSpiders(3, 1); } catch { /* ignore */ }
      try { this.prewarmPythonSources(); } catch { /* ignore */ }
    }, 500).unref?.();
  }

  private statOf(key: string): SourceStat {
    let s = this.sourceHealth.get(key);
    if (!s) {
      s = newSourceStat();
      this.sourceHealth.set(key, s);
    }
    return s;
  }

  private searchableSites(): SourceBean[] {
    return (this.config?.sites ?? []).filter((b) => isSearchableSource(b));
  }

  prewarmSpiders(maxKeys = 3, perKey = 1): number {
    if (Date.now() - this.lastPrewarmAt < 30_000) return 0;
    const pool = this.searchableSites();
    if (pool.length === 0) return 0;
    const order = scheduleOrder(pool.length, (i) => pool[i].key, this.sourceHealth);
    let started = 0;
    for (const i of order) {
      if (started >= maxKeys) break;
      const b = pool[i];
      try {
        const sp = this.vm.spiderFactory.getCSP(b, this.host) as { prewarm?: (n?: number) => number };
        if (typeof sp.prewarm !== 'function') continue;
        started += sp.prewarm(perKey);
      } catch { /* ignore */ }
    }
    if (started > 0) {
      this.lastPrewarmAt = Date.now();
      this.logger.i(`spider prewarm: started ${started} resident processes (first search avoids cold start)`);
    }
    return started;
  }

  get vipFlags(): string[] {
    return this.config?.flags ?? [];
  }

  resetSpidersForProxyChange(): void {
    this.vm.spiderFactory.clear();
  }

  resetSpidersAfterDriveChange(): void {
    this.vm.spiderFactory.clear();
    this.bridge.resetPool();
  }

  async play(key: string, flag: string, id: string): Promise<PlayResult> {
    const t = diagTimer();
    try {
      let r = await this.playInner(key, flag, id);
      if (r.parse === 0) {
        const error = directPlayUrlError(r.url);
        if (error) r = { ...r, parse: 1, url: '', playUrl: '', message: r.message || error };
      }
      logPlayDiag({
        kind: 'play',
        stage: 'done',
        ok: r.parse === 0 && !!r.url,
        ms: t.ms(),
        key,
        flag,
        ep: shortHash(id),
        parse: r.parse,
        needBind: r.needDriveCookieBind,
        msg: r.message ? String(r.message).slice(0, 120) : undefined,
        url: r.url ? String(r.url).slice(0, 80) : undefined,
      });
      return r;
    } catch (e) {
      logPlayDiag({
        kind: 'play',
        stage: 'failed',
        ok: false,
        ms: t.ms(),
        key,
        flag,
        ep: shortHash(id),
        reason: String((e as Error)?.message ?? e).slice(0, 200),
      });
      throw e;
    }
  }

  protected async probeSelfResolveUrl(url: string): Promise<boolean> {
    try {
      const res = await undiciRequest(url, {
        method: 'GET',
        headers: { range: 'bytes=0-0', accept: '*/*' },
        headersTimeout: 20000,
        bodyTimeout: 20000,
      });
      const ct = String(res.headers['content-type'] || '');
      const status = res.statusCode;
      res.body.on('error', () => undefined);
      res.body.destroy();
      if (status >= 200 && status <= 299 && /video|audio|octet-stream|mpegurl|mp2t|dash/i.test(ct)) {
        return true;
      }
      this.logger.w(`play: self-resolve probe failed status=${status} ct=${ct}: ${url.slice(0, 90)}`);
      return false;
    } catch (e) {
      this.logger.w(`play: self-resolve probe exception: ${(e as Error).message}`);
      return false;
    }
  }

  private async playInner(key: string, flag: string, id: string, retried = false): Promise<PlayResult> {
    const b = this.getSource(key);
    if (!b) throw new Error(`source missing: ${key}`);
    if (extractUcShare(id, flag) && !isUcSharePlay(id)) {
      const miss: string[] = [];
      const got = await this.ucFromPanUrl(id, flag, miss, id);
      if (got) return got;
      return { parse: 1, url: '', playUrl: '', flag, jx: 0,
        ...(!this.driveList()['uc'] ? { needDriveCookieBind: 'uc' } : {}),
        message: `UC cloud drive play failed (${miss.join('; ') || 'share file resolve failed'})` };
    }
    if (isQuarkSharePlay(id, flag) || /^quark/i.test(parsePanProxyQuery(id).site || '')) {
      const miss: string[] = [];
      const got = await this.quarkFromPanUrl(id, flag, miss, id);
      if (got) return got;
      return { parse: 1, url: '', playUrl: '', flag, jx: 0,
        ...(!this.driveList()['quark'] ? { needDriveCookieBind: 'quark' } : {}),
        message: `Quark cloud drive play failed (${miss.join('; ') || 'share or file info missing'})` };
    }
    let quarkFail = '';
    if (isQuarkSharePlay(id, flag)) {
      const quarkCookie = (this.driveList() as Record<string, string>)['quark'] || '';
      if (quarkCookie) {
        const share = extractQuarkShare(id, flag);
        const pwdId = share?.sId || '';
        if (pwdId) {
          try {
            const innerFid = extractEpisodeFid(id);
            const t = await quarkTransfer(pwdId, quarkCookie, {
              passcode: share?.passcode || '',
              innerFid,
              innerName: extractEpisodeName(id),
              logger: fileLogger,
            });
            if (t.ok && t.url) {
              fileLogger.i(`quarkTransfer direct link ok: ${t.url.slice(0, 90)}...`);
              if (t.fid) {
                this.pendingQuarkDeletes.push({ cookie: quarkCookie, pdirFid: t.pdirFid || '', dirFid: t.pdirFid || '', fid: t.fid, at: Date.now() });
                if (this.pendingQuarkDeletes.length > 200) this.pendingQuarkDeletes.shift();
                this.persistPendingQuark();
              }
              return {
                parse: 0,
                url: wrapPlayUrlWithHeaders(t.url, t.header || {}),
                playUrl: '',
                flag,
                header: t.header || {},
                jx: 0,
              };
            }
            quarkFail = t.reason || 'unknown';
            fileLogger.w(`quarkTransfer failed (${quarkFail}), fallback to spider`);
          } catch (e) {
            quarkFail = (e as Error).message;
            fileLogger.w(`quarkTransfer exception, fallback: ${quarkFail}`);
          }
        }
      } else {
        quarkFail = 'no quark cookie';
      }
    }
    let ucFail = '';
    if (isUcSharePlay(id)) {
      const ucCookie = (this.driveList() as Record<string, string>)['uc'] || '';
      const share = extractUcShare(id, flag);
      if (!ucCookie) {
        ucFail = 'no uc cookie';
      } else if (share) {
        try {
          const t = await ucResolveShare(share.pwdId, share.passcode, ucCookie, {
            innerFid: extractEpisodeFid(id),
            innerName: extractEpisodeName(id),
            logger: fileLogger,
          });
          if (t.ok && t.url) {
            fileLogger.i(`ucTransfer direct link ok: ${t.url.slice(0, 90)}...`);
            if (t.fid) {
              this.pendingQuarkDeletes.push({ provider: 'uc', cookie: ucCookie, pdirFid: t.pdirFid || '', fid: t.fid, at: Date.now() });
              if (this.pendingQuarkDeletes.length > 200) this.pendingQuarkDeletes.shift();
              this.persistPendingQuark();
            }
            return {
              parse: 0,
              url: wrapPlayUrlWithHeaders(t.url, t.header || {}),
              playUrl: '',
              flag,
              header: t.header || {},
              jx: 0,
            };
          }
          ucFail = t.reason || 'unknown';
          fileLogger.w(`ucTransfer failed (${ucFail}), fallback to spider`);
        } catch (e) {
          ucFail = (e as Error).message;
          fileLogger.w(`ucTransfer exception, fallback: ${ucFail}`);
        }
      }
    }
    let bdFail = '';
    if (extractBaiduSharedFile(id)) {
      const miss: string[] = [];
      const got = await this.baiduFromPanUrl(id, flag, miss);
      if (got) return got;
      return {
        parse: 1, url: '', playUrl: '', flag, jx: 0,
        ...(!this.driveList()['baidu'] ? { needDriveCookieBind: 'baidu' } : {}),
        message: `Baidu cloud drive play failed (${miss.join('; ') || 'share file resolve failed'})`,
      };
    }
    if (isBaiduSharePlay(id) && !isBaiduPanDescriptor(id)) {
      const bdCookie = (this.driveList() as Record<string, string>)['baidu'] || '';
      const share = extractBaiduShare(id);
      if (!bdCookie) {
        bdFail = 'no baidu cookie';
      } else if (share) {
        try {
          const t = await baiduResolveShare(share.short, share.pwd, bdCookie, {
            innerFid: extractEpisodeFid(id),
            innerName: extractBaiduInnerName(id) || extractEpisodeName(id),
            logger: fileLogger,
          });
          if (t.path) {
            this.pendingQuarkDeletes.push({ provider: 'baidu', cookie: bdCookie, pdirFid: '', fid: '', path: t.path, at: Date.now() });
            this.persistPendingQuark();
          }
          if (t.ok && t.url) {
            fileLogger.i(`baiduTransfer direct link ok (${t.path || ''})`);
            return {
              parse: 0,
              url: wrapPlayUrlWithHeaders(t.url, t.header || {}),
              playUrl: '',
              flag,
              header: t.header || {},
              jx: 0,
            };
          }
          bdFail = t.reason || 'unknown';
          fileLogger.w(`baiduTransfer failed (${bdFail}), fallback to spider`);
        } catch (e) {
          bdFail = (e as Error).message;
          fileLogger.w(`baiduTransfer exception, fallback: ${bdFail}`);
        }
      }
    }
    return this.vm.play(b, flag, id, this.vipFlags).then(async (r) => {
      const panJson = !!r.url && isBaiduPanDescriptor(r.url);
      if (r.url && (/[?&]do=pan\b/i.test(r.url) || /127\.0\.0\.1:-1/i.test(r.url) || panJson)) {
        const pan = parsePanProxyQuery(r.url);
        const panKeys = Object.keys(pan).join(',');
        if (panJson) {
          this.logger.w(
            `play: spider returned baidu descriptor JSON -> native resolve: ${key} | surl=${(extractBaiduShare(r.url)?.short || '-').slice(0, 40)}`,
          );
        } else {
          this.logger.w(
            `play: spider returned desktop-missing pan proxy (do=pan) -> no url: ${key} | keys=${panKeys}` +
              ` | site=${pan.site || '-'} | shareId=${(pan.shareId || '-').slice(0, 40)} | fileId=${(pan.fileId || '-').slice(0, 140)}`,
          );
        }
        let jvmPort: number | null = null;
        try {
          jvmPort = this.vm.proxyPortFor ? this.vm.proxyPortFor(b) : null;
        } catch {
          jvmPort = null;
        }
        if (jvmPort && !/^quark/i.test(pan.site || '') && !extractQuarkShare(r.url)) {
          const mProxy = /^http:\/\/127\.0\.0\.1:(?:9978|-1)\/proxy\?/i.exec(r.url);
          if (mProxy) {
            const rewritten = r.url.replace(mProxy[0], `http://127.0.0.1:9978/proxy/${jvmPort}?`);
            this.logger.i(
              `play: pan/proxy url rewritten -> spider jvm self-resolve (/proxy/${jvmPort}) do=${pan.do || '-'} site=${pan.site || '-'}: ${key}`,
            );
            if (await this.probeSelfResolveUrl(rewritten)) {
              return { ...r, parse: 0, url: rewritten, playUrl: '', jx: 0 };
            }
            this.logger.w(`play: jar self-resolve probe failed -> native channel fallback: ${key}`);
          } else if (panJson) {
            const shareId = /"share_id"\s*:\s*"([0-9a-zA-Z_-]+)"/.exec(r.url)?.[1] || '';
            const fsId = /"fs_id"\s*:\s*"([0-9]+)"/.exec(r.url)?.[1] || '';
            if (fsId) {
              const q = `do=pan&type=2&site=baidu&shareId=${encodeURIComponent(shareId)}&fileId=${fsId}&fileToken=`;
              const synth = `http://127.0.0.1:9978/proxy/${jvmPort}?${q}`;
              this.logger.i(
                `play: baidu descriptor JSON -> synth do=pan to jar self-resolve (/proxy/${jvmPort}) share_id=${shareId.slice(0, 24)} fs_id=${fsId.slice(0, 24)}: ${key}`,
              );
              if (await this.probeSelfResolveUrl(synth)) {
                return { ...r, parse: 0, url: synth, playUrl: '', jx: 0 };
              }
              this.logger.w(`play: descriptor JSON synth do=pan probe failed -> native channel fallback: ${key}`);
            }
          } else {
            this.logger.w(`play: got jvm port but url cannot self-resolve (not proxy/descriptor shape) -> native channel: ${key}`);
          }
        } else if (/[?&]do=pan\b/i.test(r.url) || /127\.0\.0\.1:-1/i.test(r.url) || panJson) {
          this.logger.w(`play: no jvm port for this source (spider never called / non-jar source) -> native resolve fallback: ${key}`);
        }
        const site = String(pan.site || '').toLowerCase();
        const miss: string[] = [];
        const order: Array<'baidu' | 'uc' | 'quark'> = site.startsWith('quark')
          ? ['quark', 'baidu', 'uc']
          : site.startsWith('baidu')
            ? ['baidu', 'uc', 'quark']
            : site.startsWith('uc')
              ? ['uc', 'baidu', 'quark']
              : ['baidu', 'uc', 'quark'];
        for (const ch of order) {
          const got =
            ch === 'baidu'
              ? await this.baiduFromPanUrl(r.url, flag, miss, jvmPort, id)
              : ch === 'uc'
                ? await this.ucFromPanUrl(r.url, flag, miss, id)
                : await this.quarkFromPanUrl(r.url, flag, miss, id);
          if (got) return got;
        }
        if (!miss.length) miss.push(`share link not recognized (site=${site || 'unknown'})`);
        const bindMiss = miss.find((m) => m.includes('no cookie')) || '';
        const prov = bindMiss.startsWith('baidu') ? 'baidu' : bindMiss.startsWith('uc') ? 'uc' : bindMiss.startsWith('quark') ? 'quark' : '';
        this.logger.w(`play: do=pan native resolve all failed (${miss.join('; ')}): ${key}`);
        return {
          ...r,
          url: '',
          parse: 1,
          playUrl: '',
          ...(prov ? { needDriveCookieBind: prov } : {}),
          message: prov
            ? `this line requires binding ${driveProviderLabel(prov)} to play (${miss.join('; ')})`
            : `this line requires cloud drive resolve but failed (${miss.join('; ')}) - usually expired share or source changed, please switch line/source`,
        };
      }
      const link = classifyPlayLink(r.url || '');
      if (link.unsupported) {
        if (link.kind === 'magnet') return this.tryMagnetPlay(link.externalLink || r.url || '', link.unsupported, r);
        this.logger.w(`play: link has no desktop carrier (${link.kind}) -> show guide: ${key}`);
        return { ...r, parse: 1, url: '', playUrl: '', message: link.unsupported, externalLink: link.externalLink };
      }
      if (link.url && link.url !== r.url) {
        this.logger.i(`play: thunder link resolved inner url (${link.url.slice(0, 60)}...): ${key}`);
        r = { ...r, url: link.url };
      }
      if (!r.url && r.message) {
        const prov = driveBindProviderFromText(String(r.message));
        if (prov) {
          this.markDriveBindNeeded(key);
          const bound = !!String((this.driveList() as Record<string, string>)[prov] || '').trim();
          if (bound && !retried) {
            this.logger.w(`play: spider says "need ${prov} login" but already bound -> reset pool and retry: ${key}`);
            this.syncDriveFiles();
            this.resetSpidersAfterDriveChange();
            return this.playInner(key, flag, id, true);
          }
          if (bound) {
            if (prov === 'uc' && /\[uc\]\(auth\)/i.test(String(r.message))) {
              return r;
            }
            this.logger.w(
              `play: after retry spider still says "need ${prov} login" -> show as is (no bind dialog): ${key} | raw=${String(r.message).slice(0, 300)}`,
            );
            return {
              ...r,
              parse: 1,
              message:
                `this source failed (${driveProviderLabel(prov)} already bound, no need to re-bind): ` +
                `${String(r.message).slice(0, 100)}. Usually expired share or episode not in share, switch line/source.`,
            };
          }
          this.logger.w(`play: spider returned empty url and says "need ${prov} login" -> show bind prompt: ${key}`);
          return {
            ...r,
            parse: 1,
            needDriveCookieBind: prov,
            message: `this source requires ${driveProviderLabel(prov)}: bind it in the vod page first (source says: ${r.message})`,
          };
        }
      }
      const single = /^https?:\/\//i.test(r.url || '') && !(r.url || '').includes('#');
      if (!single || !r.url) {
        if (!r.url) {
          const byId = classifyPlayLink(id);
          if (byId.unsupported) {
            if (byId.kind === 'magnet') return this.tryMagnetPlay(byId.externalLink || id, byId.unsupported, r);
            this.logger.w(`play: episode url has no desktop carrier (${byId.kind}) -> show guide: ${key}`);
            return { ...r, parse: 1, url: '', playUrl: '', message: byId.unsupported, externalLink: byId.externalLink };
          }
        }
        if (!r.url && quarkFail) {
          const needLogin = /401|403|not logged|login/i.test(quarkFail);
          if (needLogin) this.markDriveBindNeeded(key);
          this.logger.w(`play: quark transfer failed and spider has no url -> show: ${key} - ${quarkFail}`);
          return {
            ...r,
            parse: 1,
            url: '',
            playUrl: '',
            ...(needLogin ? { needDriveCookieBind: 'quark' } : {}),
            message: needLogin
              ? `quark login expired: re-login "quark" (transfer failed: ${quarkFail.slice(0, 80)})`
              : `quark transfer failed: ${quarkFail} (share may be expired/updated, or episode not in share - switch line/source)`,
          };
        }
        if (!r.url && ucFail) {
          const needLogin = /401|403|not logged|login/i.test(ucFail);
          if (needLogin) this.markDriveBindNeeded(key);
          this.logger.w(`play: uc resolve failed and spider has no url -> show: ${key} - ${ucFail}`);
          return {
            ...r,
            parse: 1,
            url: '',
            playUrl: '',
            ...(needLogin ? { needDriveCookieBind: 'uc' } : {}),
            message: needLogin
              ? `uc login expired: re-login "uc" (reason: ${ucFail.slice(0, 80)})`
              : `uc play failed: ${ucFail} (share may be expired/updated, or drive full - switch line/source)`,
          };
        }
        if (!r.url && bdFail) {
          const needLogin = /401|403|not logged|login|bdstoken/i.test(bdFail);
          if (needLogin) this.markDriveBindNeeded(key);
          this.logger.w(`play: baidu resolve failed and spider has no url -> show: ${key} - ${bdFail}`);
          return {
            ...r,
            parse: 1,
            url: '',
            playUrl: '',
            ...(needLogin ? { needDriveCookieBind: 'baidu' } : {}),
            message: needLogin
              ? `baidu login expired: re-login "baidu" (reason: ${bdFail.slice(0, 80)})`
              : `baidu play failed: ${bdFail} (share may be expired/updated, or drive full - switch line/source)`,
          };
        }
        return r;
      }
      if (r.header && Object.keys(r.header).length > 0) {
        r.url = wrapPlayUrlWithHeaders(r.url, r.header);
        return r;
      }
      const prov = matchDriveCookieProvider(r.url);
      if (prov) {
        this.markDriveBindNeeded(key);
        const tokens = this.driveList() as Record<string, string>;
        if (!tokens[prov]) {
          this.logger.w(`play: cloud drive direct link but "${prov}" not bound -> block and prompt bind: ${key}`);
          return {
            url: '',
            parse: 1,
            playUrl: '',
            flag,
            jx: 0,
            needDriveCookieBind: prov,
            message: `this resource is a "${driveProviderLabel(prov)}" direct link, bind its cookie first to play`,
          } as PlayResult;
        }
        r.url = wrapPlayUrl(r.url, prov);
      }
      return r;
    }).then((r) => this.resolveNeededParse(r)).catch((e) => {
      const msg = String((e as Error)?.message ?? e);
      if (looksLikeDriveBindFailure(msg)) {
        this.markDriveBindNeeded(key);
        const prov = driveBindProviderFromText(msg) || '';
        const bound = !!String((this.driveList() as Record<string, string>)[prov] || '').trim();
        this.logger.w(`play needs drive cookie (added to bind list${bound ? '; already bound' : ''}): ${key} - ${msg}`);
        return {
          url: '',
          parse: 1,
          playUrl: '',
          flag,
          jx: 0,
          message: bound
            ? `source failed (${driveProviderLabel(prov)} already bound, no need to re-bind): ${msg.slice(0, 120)}`
            : 'this source needs cloud drive cookie: bind in vod page (quark / uc / baidu / 115) and retry',
        } as PlayResult;
      }
      throw e;
    });
  }

  private async tryMagnetPlay(magnet: string, reason: string, r: PlayResult): Promise<PlayResult> {
    const engine = this.torrentPlay;
    const fallback = (why: string): PlayResult => {
      this.logger.w(`play: magnet cannot start (${why}) -> copy link fallback`);
      return {
        ...r,
        parse: 1,
        url: '',
        playUrl: '',
        message: `${why}. magnet link copied to clipboard, use qBittorrent / Thunder / Motrix to download`,
        externalLink: magnet,
      };
    };
    if (!engine) return fallback(reason);
    try {
      const out = await engine.open(magnet);
      if (out.kind === 'inline') {
        this.logger.i(`play: magnet inline (BT) "${out.title}" -> ${out.url}`);
        return { ...r, parse: 0, url: out.url, playUrl: '', header: undefined };
      }
      if (out.kind === 'external') {
        this.logger.i(`play: magnet external "${out.player}" "${out.title}"`);
        return {
          ...r,
          parse: 1,
          url: '',
          playUrl: '',
          message: `opened in "${out.player}" (browser cannot play this format, external player streams it)`,
        };
      }
      return fallback(out.reason);
    } catch (e) {
      return fallback(`BT engine exception (${(e as Error).message.slice(0, 60)})`);
    }
  }

  private async resolveNeededParse(r: PlayResult): Promise<PlayResult> {
    if (r.parse !== 1 || !r.url) return r;
    const target = r.url.split('#').filter(Boolean)[0] || r.url;
    try {
      const hit = await this.parseService.resolve(this.config?.parses || [], target);
      if (hit?.url) {
        this.logger.i(`parse: "${r.flag}" ok (${hit.via}) ${hit.url.slice(0, 100)}`);
        return {
          ...r,
          parse: 0,
          url: Object.keys(hit.headers).length ? wrapPlayUrlWithHeaders(hit.url, hit.headers) : hit.url,
          message: undefined,
        };
      }
    } catch (e) {
      this.logger.w(`parse: exception ${(e as Error).message}`);
    }
    return { ...r, message: 'this play url needs web resolve/sniffing, auto resolve failed (add parse endpoints or switch source)' };
  }

  async loadLive(index: number, opts: { forceRefresh?: boolean } = {}): Promise<LiveLoadResult> {
    if (!this.config || !this.config.lives.length) throw new Error('no live config');
    const live = this.config.lives[Math.min(index, this.config.lives.length - 1)];
    const cacheKey = live.url || live.api || `idx:${index}`;

    if (!opts.forceRefresh) {
      const hit = this.liveCache.get(cacheKey);
      if (hit && Date.now() - hit.at < SpiderHost.LIVE_CACHE_TTL_MS) {
        this.logger.i(
          `live source "${live.name}" cache hit (${Math.round((Date.now() - hit.at) / 1000)}s ago, ` +
            `${hit.result.groups.length} groups / ${hit.result.groups.reduce((n, g) => n + (g.channels?.length || 0), 0)} channels)`,
        );
        return hit.result;
      }
    }

    const t0 = Date.now();
    let text: string | number[];
    if (live.type === '3') {
      const api = live.api || live.url;
      const source = this.config.sites.find((s) => s.api === api || s.key === api);
      if (!source) throw new Error(`live spider missing: ${api}`);
      const spider = this.vm.spiderFactory.getCSP(source, this.host);
      const json = await Promise.resolve(spider.liveContent(live.api || live.url));
      text = json || '';
    } else {
      const localPath = SpiderHost.localLiveFilePath(live.url);
      if (localPath) {
        try {
          text = readFileSync(localPath, 'utf-8');
        } catch (e) {
          throw new Error(`local live file read failed: ${localPath} (${(e as Error).message})`);
        }
      } else {
        const res = await this.http.request({ url: live.url, method: 'get', timeoutMs: 30000 });
        text = res.content;
      }
    }
    const raw = Array.isArray(text) ? Buffer.from(text).toString('utf-8') : text;
    const groups = toLiveGroups(parseToJsonArray(raw));
    const result: LiveLoadResult = { groups, liveName: live.name };

    this.liveCache.set(cacheKey, { at: Date.now(), result });
    this.logger.i(
      `live source "${live.name}" loaded: ${groups.length} groups / ` +
        `${groups.reduce((n, g) => n + (g.channels?.length || 0), 0)} channels (${Date.now() - t0}ms)`,
    );
    return result;
  }

  invalidateLiveCache(url?: string): void {
    if (url) this.liveCache.delete(url);
    else this.liveCache.clear();
  }

  preloadLive(index: number): void {
    void this.loadLive(index, { forceRefresh: true }).catch((e) => {
      this.logger.w(`live source preload failed (index=${index}): ${(e as Error).message}`);
    });
  }

  private static localLiveFilePath(url: string): string {
    const u = (url || '').trim();
    const m = /^https?:\/\/127\.0\.0\.1:\d+\/file\/local-live\/([^?#]+)/i.exec(u);
    if (!m) return '';
    try {
      const fileName = decodeURIComponent(m[1]);
      if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) return '';
      return join(userDataDir(), 'local-live', fileName);
    } catch {
      return '';
    }
  }

  get lives() {
    return this.config?.lives ?? [];
  }

  async loadLiveEpg(index: number, refs: EpgChannelRef[]): Promise<LiveEpgResult> {
    const lives = this.config?.lives ?? [];
    const live = lives[Math.min(Math.max(index, 0), Math.max(lives.length - 1, 0))];
    const list = Array.isArray(refs) ? refs : [];
    if (!list.length) {
      this.logger.i(`EPG: live line "${live?.name || index}" channel refs empty, skip`);
      return { byKey: {} };
    }

    let urls = collectEpgUrls(live?.epg, list);
    if (!urls.length) {
      urls = [DEFAULT_EPG_URL];
      this.logger.i(
        `EPG: live line "${live?.name || index}" no EPG url configured, using default ${DEFAULT_EPG_URL}`,
      );
    }

    const mgr = this.ensureEpgManager();
    mgr.setEpgUrl(urls[0]);
    this.logger.i(`EPG: fetch ${urls[0]}`);

    const r = await mgr.refreshEpg();
    if (!r.ok) {
      this.logger.w(`EPG fetch failed (${urls[0]}): ${r.error || 'unknown'}`);
      return { byKey: {} };
    }
    this.logger.i(`EPG: fetched, resolving ${list.length} channel refs`);

    const channelNames: string[] = [];
    for (const ref of list) {
      for (const k of [ref.name, ref.tvgName, ref.tvgId]) {
        const n = (k || '').trim();
        if (n && !channelNames.includes(n)) channelNames.push(n);
      }
    }
    if (!channelNames.length) {
      this.logger.i('EPG: no channel names to match, skip');
      return { byKey: {} };
    }

    await mgr.loadChannelGroup(channelNames);

    const byKey: Record<string, LiveEpgEntry> = {};
    const now = Date.now();
    let hitCount = 0;
    for (const ref of list) {
      const entry = this.buildLiveEpgEntry(mgr, ref, now);
      if (!entry.current && !entry.next) continue;
      hitCount++;
      for (const k of [ref.tvgId, ref.tvgName, ref.name]) {
        if (k) byKey[k] = entry;
      }
    }
    this.logger.i(
      `EPG: url ${urls[0]} / hit ${hitCount} channels (byKey ${Object.keys(byKey).length} keys) (line "${live?.name || index}", requested ${channelNames.length})`,
    );
    return { byKey };
  }

  private buildLiveEpgEntry(mgr: EpgManager, ref: EpgChannelRef, now: number): LiveEpgEntry {
    const keys = [ref.tvgId, ref.tvgName, ref.name]
      .map((k) => (k || '').trim())
      .filter((k): k is string => !!k);

    let programs: EpgProgram[] = [];
    for (const k of keys) {
      const got = mgr.getProgramsForChannel(k);
      if (got.length) { programs = got; break; }
    }

    const fmt = (d: Date): string => {
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    };
    const toEntry = (p: EpgProgram | null) =>
      p
        ? {
            title: p.title || '',
            start: fmt(p.start),
            end: fmt(p.stop),
            startTime: p.start.getTime(),
            endTime: p.stop.getTime(),
            description: p.description || '',
          }
        : undefined;

    let cur: EpgProgram | null = null;
    let nxt: EpgProgram | null = null;
    for (const p of programs) {
      if (!cur && now >= p.start.getTime() && now < p.stop.getTime()) cur = p;
      else if (!nxt && p.start.getTime() > now) nxt = p;
      if (cur && nxt) break;
    }
    return { current: toEntry(cur), next: toEntry(nxt) };
  }

  private ensureEpgManager(): EpgManager {
    if (!this.epgMgr) {
      this.epgMgr = new EpgManager(userDataDir(), '');
      this.epgMgr.refreshEpgDataFromRemote().catch(() => undefined);
    }
    return this.epgMgr;
  }

  async getLiveEpgPrograms(channelNames: string | string[]): Promise<EpgProgram[]> {
    if (!this.epgMgr) {
      this.logger.w('[EPG] getLiveEpgPrograms: EpgManager not initialized');
      return [];
    }
    let list: string[];
    if (Array.isArray(channelNames)) list = channelNames;
    else list = String(channelNames || '').split(',');
    list = list.map((s) => String(s || '').trim()).filter((s) => !!s);
    if (!list.length) return [];
    try {
      await this.epgMgr.loadChannelGroup(list);
    } catch (e) {
      this.logger.w(`[EPG] loadChannelGroup failed: ${(e as Error).message}`);
    }
    return this.epgMgr.getProgramsForChannelMulti(list);
  }
  getLiveEpgCurrent(channelName: string) {
    return this.epgMgr ? this.epgMgr.getCurrentProgram(channelName) : null;
  }
  getLiveEpgNext(channelName: string) {
    return this.epgMgr ? this.epgMgr.getNextProgram(channelName) : null;
  }
  getLiveEpgIcon(channelName: string) {
    return this.epgMgr ? this.epgMgr.getChannelIconUrl(channelName) : '';
  }
  async refreshEpg() {
    const mgr = this.ensureEpgManager();
    mgr.refreshEpgDataFromRemote().catch(() => undefined);
    return mgr.refreshEpg();
  }

  private applyConfig(cfg: SiteConfig): void {
    this.sourceMap.clear();
    for (const s of cfg.sites) this.sourceMap.set(s.key, s);
    this.setSpiderJar(cfg.spider);
  }

  private setSpiderJar(url: string): void {
    const u = (url || '').trim();
    const normalized = normalizeJarUrl(u);
    if (normalized === this.lastSpiderJar) return;
    this.lastSpiderJar = normalized;
    this.bridge.setDefaultJar(normalized);
    if (normalized) this.bridge.warmup(normalized).catch(() => undefined);
  }

  private onUserConfigChange(snap: UserConfig, kind: ConfigChangeKind = 'content'): void {
    if (kind === 'ui') return;
    this.invalidateLiveCache();
    const base = snap.apiUrl || '';
    const cfg: SiteConfig = {
      sites: base ? snap.sources.map((s) => normalizeBeanPaths(s, base)) : snap.sources,
      parses: snap.parses || [],
      lives: snap.lives,
      flags: snap.global.flags,
      spider: base ? resolvePathValue(snap.global.spider, base) : snap.global.spider,
      jarCache: 'true',
      danmaku: '',
      wallpaper: '',
      hosts: {},
      rules: [],
      doh: [],
      ads: [],
      proxy: [],
    };
    this.config = cfg;
    this.applyConfig(cfg);
    this.vm.spiderFactory.clear();
    this.searchCache.clear();
    this.unsupportedSources.clear();
    setTimeout(() => {
      try { this.prewarmSpiders(3, 1); } catch { /* ignore */ }
      try { this.prewarmPythonSources(); } catch { /* ignore */ }
    }, 1000).unref?.();
  }
}

function normalizeBeanPaths(s: SourceBean, baseUrl: string): SourceBean {
  const jar = resolvePathValue(s.jar || '', baseUrl);
  const api = resolvePathValue(s.api || '', baseUrl);
  if (jar === s.jar && api === s.api) return s;
  return { ...s, jar, api };
}

function resolvePathValue(value: string, baseUrl: string): string {
  const v = (value || '').trim();
  if (!v || !/^\.\.?\//.test(v)) return value;
  if (!/^https?:\/\//i.test(baseUrl)) return value;
  const dir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  if (!dir) return value;
  const [head, ...tail] = v.split(';');
  let resolved: string;
  try {
    resolved = new URL(head, dir).toString();
  } catch {
    resolved = head.startsWith('../')
      ? dir.replace(/[^/]+\/$/, '')
      : dir + head.replace(/^\.\//, '');
  }
  return [resolved, ...tail].join(';');
}
