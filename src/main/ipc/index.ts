// src/main/ipc/index.ts — register all IPC handlers
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHandler } from '../util/ipcGuard';
import { fileLogger } from '../util/logger';
import { SpiderHost } from '../spider/SpiderHost';
import { resourcesDir, userDataDir, spiderCacheDir } from '../util/paths';
import type { LocalPkgStore } from '../store/LocalPkgStore';
import { pkgSubUrl } from '../../engine/config/localPkg';
import {
  openWebHomeWindow,
  webHomeReq,
  webHomeCookie,
  webHomePlay,
  type FmReqPayload,
  type WebHomeOpenInit,
} from '../webbridge/WebHomeWindow';
import { clearAppCache } from '../util/cacheClean';
import { nameFromLocalFile } from '../util/importNaming';
import { join, basename } from 'node:path';
import { IPC } from '../../shared/ipc-channels';
import { dataDirReport } from '../util/dataDirBootstrap';
import { proxySettingsView, setProxySettings, getProxySettings, type ProxySettings } from '../net/proxy';
import { buildBackupFile, parseBackupFile } from '../settings/backup';
import type { BackupExportResult, BackupImportResult, BackupSettingsState } from '../../shared/backup';
import type { DavServer } from '../../shared/webdav';
import type { DavService } from '../webdav/DavService';
import type { DlnaCastTarget, DlnaDevice } from '../../shared/dlna';
import type { DlnaService } from '../dlna/DlnaService';
import type { UpdateProgress } from '../../shared/update';
import type { UpdateService } from '../update/UpdateService';
// Independent player window
import { openPlayerWindow, playerSwitchEpisode, isPlayerOpen, closePlayerWindow, playerSetMini, playerIsMini, playerWindow, playerResendInit, onPlayerWindowClosed, isPlayerWindow, playerSetFullscreen, playerIsFullscreen, playerSetResizable } from '../player/PlayerWindow';
import { MpvController } from '../player/MpvController';
import { openDetailWindow, detailWindowReady } from '../player/DetailWindow';
import { openSearchWindow, searchWindowReady } from '../player/SearchWindow';
import {
  openEpgWindow,
  epgWindowReady,
  getPendingGroups,
  type EpgChannelItem,
  type EpgGroupItem,
} from '../player/EpgWindow';
import type { MpvCommand, MpvStartOptions } from '../../shared/player';
// Boss key
import { bossKey, BOSS_DEFAULT_ACCEL } from '../bossKey';
import { playerSettings } from '../player/playerSettings';
import { detectPlayers, launchPlayer, seekArgs } from '../torrent/externalPlayer';
import { ok } from '../../shared/ipc-result';
import type { IpcMainInvokeEvent } from 'electron';
import type { BossKeySettings, EpgChannelRef, ImportReport, MultiConfigEntry, SiteConfig, SourceBean, SourceMoveDirection, SourceUpdatePatch } from '../../shared/types';
import type { MetaSettings } from '../../shared/meta';
import type { PlayerSettings } from '../../shared/player';
// Local file live-source import (shared with network subscription download path)
import { importLiveFileFromPath } from '../live/importLiveFile';
// Generic route window
import { openRouteWindow, setWindowRoute } from '../player/RouteWindow';

function winOf(e: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender);
}

// 2026-10-14: broadcast live:changed to every window (including standalone live windows).
// Triggered after successful local TXT/M3U import and after network subscription import
// (subscription may carry `lives`). Live page listens and auto-reloads the active line.
function broadcastLiveChanged(payload: { index?: number; name?: string; replaced?: boolean }): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      w.webContents.send(IPC.LIVE_CHANGED, payload);
    } catch {
      // window already closed, ignore
    }
  }
}

// Session id generated once per main-process boot (changes on each restart).
const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function registerIpc(host: SpiderHost, dav: DavService, dlna: DlnaService, updater: UpdateService, pkgs: LocalPkgStore): void {
  const log = fileLogger;
  const mpv = new MpvController(fileLogger);

  // Custom frameless window controls
  ipcMain.handle(IPC.WIN_MINIMIZE, (e) => winOf(e)?.minimize());
  ipcMain.handle(IPC.WIN_MAXIMIZE, (e) => {
    const w = winOf(e);
    if (!w) return;
    if (isPlayerWindow(w) && playerIsFullscreen()) { void playerSetFullscreen(false); return; }
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.handle(IPC.WIN_CLOSE, (e) => winOf(e)?.close());
  ipcMain.handle(IPC.WIN_IS_MAXIMIZED, (e) => !!winOf(e)?.isMaximized());
  registerHandler(IPC.WIN_SET_ALWAYS_ON_TOP, (e: IpcMainInvokeEvent, on: unknown) => {
    const w = winOf(e);
    if (!w) return false;
    const flag = !!on;
    try {
      w.setAlwaysOnTop(flag, 'floating');
    } catch {
      w.setAlwaysOnTop(flag);
    }
    return w.isAlwaysOnTop();
  }, log);
  registerHandler(IPC.WIN_IS_ALWAYS_ON_TOP, (e: IpcMainInvokeEvent) => !!winOf(e)?.isAlwaysOnTop(), log);

  registerHandler(IPC.SYSTEM_PING, () => 'pong', log);
  registerHandler(IPC.SYSTEM_SESSION_ID, () => SESSION_ID, log);
  registerHandler(IPC.APP_QUIT, () => {
    app.quit();
    return { ok: true };
  }, log);
  registerHandler(IPC.THEME_SET, (_e: any, theme: string) => {
    nativeTheme.themeSource = theme === 'light' ? 'light' : theme === 'dark' ? 'dark' : 'system';
    const w = winOf(_e as IpcMainInvokeEvent);
    const dark = nativeTheme.shouldUseDarkColors;
    if (w && !isPlayerWindow(w)) w.setBackgroundColor(dark ? '#0a0c10' : '#dce4ec');
  }, log);
  registerHandler(IPC.APP_ICON, () => {
    const p = join(resourcesDir(), 'ui', 'icon32.png');
    if (!existsSync(p)) return '';
    return 'data:image/png;base64,' + readFileSync(p).toString('base64');
  }, log);
  registerHandler(IPC.SYSTEM_DATA_DIR, () => ({
    path: userDataDir(),
    mode: dataDirReport.mode,
    planned: dataDirReport.planned,
    reason: dataDirReport.reason,
    migration: dataDirReport.migration,
  }), log);

  registerHandler(IPC.CONFIG_IMPORT, async (e: any, args: { url?: string; json?: string; name?: string }) => {
    const r = await host.importConfig(args || {});
    return { config: r.config, report: r.report, warnings: r.warnings, urls: r.urls };
  }, log);

  registerHandler(IPC.CONFIG_LIST_SITES, () => host.sites, log);
  registerHandler(IPC.CONFIG_DIAGNOSE, () => host.importReport, log);

  registerHandler(IPC.CFG_GET, () => host.cfgSnapshot(), log);
  registerHandler(IPC.DRIVE_BIND_KEYS, () => host.driveBindLearned(), log);
  registerHandler(IPC.CFG_ADD_SOURCE, (_e: any, bean: SourceBean) => host.cfgAddSource(bean), log);
  registerHandler(IPC.CFG_UPDATE_SOURCE, (_e: any, a: { key: string; patch: SourceUpdatePatch }) =>
    host.cfgUpdateSource(a.key, a.patch || {}), log);
  registerHandler(IPC.CFG_DELETE_SOURCE, (_e: any, key: string) => host.cfgDeleteSource(key), log);
  registerHandler(IPC.CFG_MOVE_SOURCE, (_e: any, a: { key: string; direction: SourceMoveDirection }) =>
    host.cfgMoveSource(a.key, a.direction), log);
  registerHandler(IPC.CFG_SET_ACTIVE_SOURCE, (_e: any, key: string) => host.cfgSetActiveSource(key), log);
  registerHandler(IPC.CFG_SET_ACTIVE_LIVE, (_e: any, index: number) => host.cfgSetActiveLive(index), log);

  // 2026-10-14: after network subscription import, broadcast live:changed too
  // (subscription may carry lives). Renderer only refreshes list, no side effect if empty.
  registerHandler(IPC.CFG_IMPORT_URL, async (_e: any, a: { url: string; name?: string }) => {
    const r = await host.importConfig({ url: a.url, name: a.name });
    broadcastLiveChanged({ name: a.name });
    return { config: r.config, report: r.report, warnings: r.warnings, urls: r.urls };
  }, log);

  registerHandler(IPC.CFG_PROFILES, () => host.cfgProfiles(), log);
  registerHandler(IPC.CFG_PROFILE_SAVE, (_e: any, name: string) => host.cfgSaveAsProfile(name), log);
  registerHandler(IPC.CFG_PROFILE_ACTIVATE, (_e: any, id: string) => host.cfgActivateProfile(id), log);
  registerHandler(IPC.CFG_PROFILE_DELETE, (_e: any, id: string) => host.cfgDeleteProfile(id), log);
  registerHandler(IPC.CFG_PROFILE_UPDATE_NAME, (_e: any, a: { id: string; name: string }) => host.cfgUpdateProfileName(a.id, a.name), log);
  registerHandler(IPC.CFG_PROFILE_SITES, () => host.cfgProfileSites(), log);
  registerHandler(IPC.CFG_SWITCH_PROFILE_SOURCE, (_e: any, a: { profileId: string; key: string }) =>
    host.cfgSwitchProfileSource(String(a?.profileId || ''), String(a?.key || '')), log);

  registerHandler(IPC.CACHE_CLEAR, async () => {
    const r = clearAppCache(userDataDir(), spiderCacheDir());
    try { host.rewarmAfterCacheClear(); } catch { /* ignore */ }
    return r;
  }, log);
  registerHandler(IPC.VOD_DEBUG, (_e: any, key: string) => host.debug(key), log);
  registerHandler(IPC.VOD_AUDIT, () => host.auditAll(), log);
  registerHandler(IPC.DRIVE_GET, () => host.driveList(), log);
  registerHandler(IPC.DRIVE_SET, (_e: any, a: { provider: string; token: string }) => host.driveSet(a.provider, a.token), log);
  registerHandler(IPC.DRIVE_REMOVE, (_e: any, provider: string) => host.driveRemove(provider), log);
  registerHandler(IPC.DRIVE_QR_CREATE, (_e: any, provider?: string) => host.driveQrCreate(provider), log);
  registerHandler(IPC.DRIVE_QR_POLL, (_e: any, provider: string, sid: string) => host.driveQrPoll(provider, sid), log);
  registerHandler(IPC.DRIVE_WEB_LOGIN, (_e: any, provider: string) => host.driveWebLogin(provider), log);

  registerHandler(IPC.SUBTITLE_GET, () => host.subtitleGetSettings(), log);
  registerHandler(IPC.SUBTITLE_SET, (_e: any, patch: any) => host.subtitleSetSettings(patch || {}), log);
  registerHandler(IPC.SUBTITLE_PROVIDERS, () => host.subtitleProviderView(), log);
  registerHandler(IPC.SUBTITLE_SEARCH, (_e: any, name: string) => host.subtitleSearch(String(name)), log);
  registerHandler(IPC.SUBTITLE_FETCH, (_e: any, cand: any) => host.subtitleFetch(cand), log);
  registerHandler(IPC.DANMAKU_GET, () => host.danmakuGetSettings(), log);
  registerHandler(IPC.DANMAKU_SET, (_e: any, patch: any) => host.danmakuSetSettings(patch || {}), log);
  registerHandler(IPC.DANMAKU_SEARCH, (_e: any, name: string, season?: number) =>
    host.danmakuSearch(String(name), Number.isFinite(Number(season)) && Number(season) > 0 ? Number(season) : undefined), log);
  registerHandler(IPC.DANMAKU_EPISODES, (_e: any, bangumiId: number, animeTitle?: string, source?: string) =>
    host.danmakuEpisodes(Number(bangumiId), animeTitle ? String(animeTitle) : undefined, source ? String(source) : ''), log);
  registerHandler(IPC.DANMAKU_FETCH, (_e: any, episodeId: number, source?: string) =>
    host.danmakuFetch(Number(episodeId), source ? String(source) : ''), log);
  registerHandler(IPC.META_SEARCH, (_e: any, name: string, year?: string, provider?: string) => host.metaSearch(String(name || ''), year ? String(year) : undefined, provider === 'tmdb' || provider === 'douban' ? provider : undefined), log);
  registerHandler(IPC.META_EXTRA, (_e: any, name: string, year?: string) => host.metaExtra(String(name || ''), year ? String(year) : undefined), log);
  registerHandler(IPC.META_DISCOVER, (_e: any, refresh?: boolean) => host.metaDiscover(!!refresh), log);
  registerHandler(IPC.META_MOVIE_HOT, () => host.metaMovieHot(), log);
  registerHandler(IPC.META_DISCOVER_IMAGES, (_e: any, name: string, mediaType: string, year?: string, kind?: string) =>
    host.metaDiscoverImages(String(name || ''), mediaType === 'tv' ? 'tv' : 'movie', /^\d{4}$/.test(String(year)) ? String(year) : undefined, kind === 'poster' ? 'poster' : 'backdrop'), log);
  registerHandler(IPC.META_GENRES, () => host.metaGenres(), log);
  registerHandler(IPC.META_GENRE_PAGE, (_e: any, mediaType: string, genreId: number, page: number) => host.metaGenrePage(String(mediaType || 'movie'), Number(genreId) || 0, Number(page) || 1), log);
  registerHandler(IPC.META_GET_SETTINGS, () => host.metaGetSettings(), log);
  registerHandler(IPC.META_SET_SETTINGS, (_e: any, patch: unknown) => host.metaSetSettings((patch || {}) as Partial<MetaSettings>), log);
  registerHandler(IPC.META_SUGGEST, (_e: any, q: string) => host.metaSuggest(String(q || '')), log);
  registerHandler(IPC.META_IMAGES, (_e: any, mediaType: string, tmdbId: number) =>
    host.metaImages(String(mediaType || 'movie') === 'tv' ? 'tv' : 'movie', Number(tmdbId) || 0), log);
  registerHandler(IPC.CFG_MERGE_EXPORT, (_e: any, ids: string[]) => host.mergeProfilesExport(ids), log);
  registerHandler(IPC.CFG_EXPORT_SAVE, async (_e: any, a: { content: string; defaultName?: string }) => {
    const w = winOf(_e as IpcMainInvokeEvent);
    const r = await dialog.showSaveDialog(w ?? undefined!, {
      title: 'Save As',
      defaultPath: a.defaultName || 'merged-subscription.json',
      filters: [{ name: 'JSON Config', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { saved: false, path: '' };
    writeFileSync(r.filePath, a.content, 'utf-8');
    return { saved: true, path: r.filePath };
  }, log);
  registerHandler(IPC.BACKUP_EXPORT, async (_e: any, renderer: Record<string, string>): Promise<BackupExportResult> => {
    const w = winOf(_e as IpcMainInvokeEvent);
    const settings: BackupSettingsState = {
      ...host.settingsSnapshot(),
      player: playerSettings.settings,
      proxy: getProxySettings(),
      bossKey: bossKey.settings,
    };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const file = buildBackupFile(settings, renderer || {}, {
      exportedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
    });
    const r = await dialog.showSaveDialog(w ?? undefined!, {
      title: 'Export Backup',
      defaultPath: `win-box-backup-${stamp}.json`,
      filters: [{ name: 'Win-Box Backup', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { saved: false, path: '' };
    writeFileSync(r.filePath, JSON.stringify(file, null, 2), 'utf-8');
    log.i(`backup export: sources=${settings.userConfig.sources.length} tokens=${Object.keys(settings.driveTokens).length} ls=${Object.keys(file.renderer).length} -> ${r.filePath}`);
    return { saved: true, path: r.filePath };
  }, log);
  registerHandler(IPC.BACKUP_IMPORT, async (_e: any): Promise<BackupImportResult> => {
    const w = winOf(_e as IpcMainInvokeEvent);
    const picked = await dialog.showOpenDialog(w ?? undefined!, {
      title: 'Import Backup',
      properties: ['openFile'],
      filters: [{ name: 'Win-Box Backup', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: false, canceled: true };
    const path = picked.filePaths[0];
    let text = '';
    try {
      text = readFileSync(path, 'utf-8');
    } catch (e) {
      return { ok: false, error: `read failed: ${(e as Error).message}` };
    }
    const parsed = parseBackupFile(text);
    if (!parsed.ok) {
      log.w(`backup import failed: ${parsed.error}`);
      return { ok: false, error: parsed.error };
    }
    const s = parsed.file.settings;
    host.restoreSettings(s);
    if (s.player) playerSettings.settings = s.player;
    if (s.proxy) {
      setProxySettings(s.proxy);
      host.resetSpidersForProxyChange();
    }
    if (s.bossKey) {
      bossKey.settings = s.bossKey;
      bossKey.apply();
    }
    log.i(`backup import ok: sources=${s.userConfig?.sources?.length ?? 0} tokens=${Object.keys(s.driveTokens || {}).length} ls=${Object.keys(parsed.file.renderer).length} <- ${path}`);
    return { ok: true, path, renderer: parsed.file.renderer };
  }, log);
  registerHandler(IPC.UI_GOTO_DRIVE_BIND, () => {
    const pwin = playerWindow();
    for (const w of BrowserWindow.getAllWindows()) {
      if (w === pwin || w.isDestroyed()) continue;
      try {
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
        w.webContents.send(IPC.NAV_DRIVE_BIND);
      } catch { /* ignore */ }
      break;
    }
    return true;
  }, log);
  registerHandler(IPC.CFG_IMPORT_JSON_LOCAL, async (e: any, customName?: string): Promise<{
    ok: boolean; file?: string; name?: string; error?: string;
    result?: { config: SiteConfig; report: ImportReport; warnings: string[]; urls?: MultiConfigEntry[] };
  }> => {
    const win = winOf(e);
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile'],
      filters: [{ name: 'JSON Subscription', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: false };
    const filePath = picked.filePaths[0];
    try {
      const text = readFileSync(filePath, 'utf-8');
      if (!text.trim()) return { ok: false, error: 'selected .json is empty' };
      const name = nameFromLocalFile(filePath, customName);
      const r = await host.importConfig({ json: text, name });
      return {
        ok: true,
        file: basename(filePath),
        name,
        result: { config: r.config, report: r.report, warnings: r.warnings, urls: r.urls },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, log);

  registerHandler(IPC.CFG_IMPORT_PY_LOCAL, async (e: any): Promise<{ ok: boolean; key?: string; error?: string }> => {
    const win = winOf(e);
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile'],
      filters: [{ name: 'Python Spider', extensions: ['py'] }],
    });
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: false };
    const srcPath = picked.filePaths[0];
    let importedApi = '';
    try {
      const name = nameFromLocalFile(srcPath);
      const api = importedApi = pkgs.importPython(srcPath);
      const bean = host.cfgAddSource({ key: name, name, type: 3, api, ext: '', jar: '' } as SourceBean);
      return { ok: true, key: bean.key };
    } catch (err) {
      if (importedApi) {
        try { pkgs.discardImport(importedApi, host.cfgSnapshot()); }
        catch (cleanup) { log.w(`import cleanup failed: ${String(cleanup)}`); }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, log);

  registerHandler(IPC.CFG_IMPORT_PACKAGE, async (e: any, customName?: string): Promise<{
    ok: boolean; root?: string; rel?: string; sites?: number; name?: string; error?: string;
    warnings?: string[];
    result?: { config: SiteConfig; report: ImportReport; warnings: string[]; urls?: MultiConfigEntry[] };
  }> => {
    const win = winOf(e);
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory'],
      title: 'Select local package directory',
    });
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: false };
    const root = picked.filePaths[0];
    let importedUrl = '';
    try {
      const found = pkgs.importSubscription(root);
      if (!found) {
        return {
          ok: false,
          error: 'no usable subscription JSON found in this directory',
        };
      }
      const name = nameFromLocalFile(root, customName);
      const url = importedUrl = pkgSubUrl(found.index, found.rel);
      const r = await host.importConfig({ url, name });
      return {
        ok: true,
        root: pkgs.rootOf(found.index) || root,
        rel: found.rel,
        sites: found.sites,
        name,
        warnings: found.warnings,
        result: { config: r.config, report: r.report, warnings: r.warnings, urls: r.urls },
      };
    } catch (err) {
      if (importedUrl) {
        try { pkgs.discardImport(importedUrl, host.cfgSnapshot()); }
        catch (cleanup) { log.w(`import cleanup failed: ${String(cleanup)}`); }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, log);

  // 2026-10-14: after local TXT/M3U live import, broadcast + preload.
  registerHandler(IPC.CFG_IMPORT_LIVE_LOCAL, async (e: any): Promise<{
    ok: boolean; name?: string; index?: number; replaced?: boolean; total?: number; error?: string;
  }> => {
    const win = winOf(e);
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openFile'],
      filters: [{ name: 'Live Source (TXT / M3U)', extensions: ['txt', 'm3u', 'm3u8'] }],
    });
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: false };
    const r = importLiveFileFromPath(host, picked.filePaths[0]);
    if (r.ok) {
      broadcastLiveChanged({ index: r.index, name: r.name, replaced: r.replaced });
      if (typeof r.index === 'number' && r.index >= 0) host.preloadLive(r.index);
    }
    return r;
  }, log);

  registerHandler(IPC.WEBHOME_OPEN, (_e: any, init: WebHomeOpenInit) => openWebHomeWindow(init || { url: '' }), log);
  registerHandler(IPC.WEBHOME_FM_REQ, (_e: any, payload: FmReqPayload) => webHomeReq(payload || { url: '' }), log);
  registerHandler(IPC.WEBHOME_FM_PLAY, (_e: any, payload: { url?: string; title?: unknown }) => webHomePlay(payload || {}), log);
  registerHandler(IPC.WEBHOME_FM_COOKIE, (_e: any, domain: string) => webHomeCookie(domain), log);

  registerHandler(IPC.VOD_HOME, (_e: any, key: string) => host.home(key), log);
  registerHandler(IPC.VOD_CATEGORY, (_e: any, a: { key: string; tid: string; pg: string; extend?: Record<string, string> }) =>
    host.category(a.key, a.tid, a.pg, a.extend || {}), log);
  registerHandler(IPC.VOD_DETAIL, (_e: any, a: { key: string; ids: string[] }) => host.detail(a.key, a.ids), log);
  registerHandler(IPC.VOD_SEARCH, (_e: any, a: { key: string; wd: string }) => host.search(a.key, a.wd), log);
  registerHandler(IPC.VOD_SEARCH_ALL, async (e: any, a: { wd: string; refresh?: boolean } | string) => {
    const arg = typeof a === 'string' ? { wd: a, refresh: false } : a || { wd: '', refresh: false };
    const w = winOf(e as IpcMainInvokeEvent);
    host.onSearchAllProgress = (ev) => {
      try { w?.webContents.send(IPC.VOD_SEARCH_ALL_PROGRESS, ev); } catch { /* ignore */ }
    };
    try {
      return await host.searchAll(arg.wd, { refresh: !!arg.refresh });
    } finally {
      host.onSearchAllProgress = undefined;
    }
  }, log);
  registerHandler(IPC.VOD_PLAY, async (_e: any, a: { key: string; flag: string; id: string }) => {
    const r = await host.play(a.key, a.flag, a.id);
    if (r.externalLink) {
      try { clipboard.writeText(r.externalLink); } catch { /* ignore */ }
    }
    return r;
  }, log);

  registerHandler(IPC.PLAYER_OPEN, (_e: any, init: any) => {
    openPlayerWindow(init);
    return { ok: true };
  }, log);
  registerHandler(IPC.PLAYER_SWITCH_EP, (_e: any, request: number | import('../../shared/playerEpisode').PlayerEpisodeSwitch) => {
    return { switched: playerSwitchEpisode(request) };
  }, log);
  registerHandler(IPC.PLAYER_IS_OPEN, () => ({ open: isPlayerOpen() }), log);
  registerHandler(IPC.PLAYER_GET_INIT, () => ({ open: isPlayerOpen() }), log);
  registerHandler(IPC.PLAYER_READY, () => {
    playerResendInit();
    return { ok: true };
  }, log);
  registerHandler(IPC.PLAYER_SET_MINI, (_e: any, isMini: boolean) => {
    playerSetMini(!!isMini);
    return { mini: playerIsMini() };
  }, log);
  registerHandler(IPC.PLAYER_IS_MINI, () => ({ mini: playerIsMini() }), log);
  registerHandler(IPC.PLAYER_SET_FULLSCREEN, async (_e: any, fullscreen: boolean) => ({ fullscreen: await playerSetFullscreen(!!fullscreen) }), log);
  registerHandler(IPC.PLAYER_IS_FULLSCREEN, () => ({ fullscreen: playerIsFullscreen() }), log);
  registerHandler(IPC.PLAYER_SET_RESIZABLE, (_e: any, resizable: boolean) => ({ resizable: playerSetResizable(!!resizable) }), log);
  registerHandler('player:close', () => {
    closePlayerWindow();
    return { ok: true };
  }, log);

  registerHandler(IPC.WIN_OPEN_DETAIL, (_e: any, a: { key?: string; id?: string; query?: string }) =>
    openDetailWindow(a || {}), log);
  registerHandler(IPC.WIN_OPEN_SEARCH, (_e: any, term: string) => openSearchWindow(term), log);
  registerHandler(IPC.WIN_ROUTE_READY, (e: any) => {
    searchWindowReady(e.sender.id);
    detailWindowReady(e.sender.id);
    return { ok: true };
  }, log);
  registerHandler(IPC.WIN_REPORT_ERROR, (e: any, message: string) => {
    log.w(`renderer-error wc=${e.sender.id}: ${String(message).replace(/https?:\/\/\S+/gi, '[url]').slice(0, 3000)}`);
    return { ok: true };
  }, log);

  registerHandler(IPC.OPEN_ROUTE_WINDOW, (_e: any, route: string) =>
    openRouteWindow(String(route || '')), log);
  registerHandler(IPC.NOTIFY_ROUTE_CHANGE, (e: any, route: string) => {
    const w = winOf(e as IpcMainInvokeEvent);
    if (w && !w.isDestroyed()) setWindowRoute(w, String(route || ''));
    return { ok: true };
  }, log);

  registerHandler(IPC.MPV_STATUS, () => mpv.status(), log);
  registerHandler(IPC.MPV_START, (e: any, opts: MpvStartOptions) => {
    const w = winOf(e as IpcMainInvokeEvent);
    if (!w) throw new Error('player window missing');
    return mpv.start(w, opts || ({ url: '' } as MpvStartOptions));
  }, log);
  registerHandler(IPC.MPV_CMD, (_e: any, cmd: MpvCommand) => ({ ok: mpv.command(cmd) }), log);
  registerHandler(IPC.MPV_STOP, () => {
    mpv.stop();
    return { ok: true };
  }, log);
  onPlayerWindowClosed(() => mpv.dispose());
  app.on('will-quit', () => {
    try {
      mpv.dispose();
    } catch {
      /* ignore */
    }
  });

  registerHandler(IPC.BOSS_GET, () => bossKey.settings, log);
  registerHandler(IPC.BOSS_SET, (_e: any, patch: Partial<BossKeySettings>) => {
    const cur = bossKey.settings;
    bossKey.settings = {
      enabled: patch?.enabled ?? cur.enabled,
      accel: (patch?.accel ?? cur.accel).trim() || BOSS_DEFAULT_ACCEL,
    };
    const registered = bossKey.apply();
    return { settings: bossKey.settings, registered: registered || !bossKey.settings.enabled };
  }, log);
  registerHandler(IPC.QUARK_CLEANUP, () => {
    void host.quarkDeletePending().catch(() => undefined);
    return true;
  }, log);

  registerHandler(IPC.PROXY_GET, () => proxySettingsView(), log);
  registerHandler(IPC.PROXY_SET, (_e: any, patch: Partial<ProxySettings>) => {
    const next = setProxySettings(patch || {});
    host.resetSpidersForProxyChange();
    return next;
  }, log);

  registerHandler(IPC.PLAYER_PREFS_GET, () => playerSettings.settings, log);
  registerHandler(IPC.PLAYER_PREFS_SET, (_e: any, patch: Partial<PlayerSettings>) => playerSettings.update(patch || {}), log);
  registerHandler(
    IPC.BT_DETECT_PLAYERS,
    () => detectPlayers(playerSettings.settings.btExternalPlayer).map((p) => ({ id: p.id, name: p.name, path: p.path })),
    log,
  );
  registerHandler(
    IPC.VOD_DETECT_PLAYERS,
    () => detectPlayers(playerSettings.settings.vodExternalPlayer).map((p) => ({ id: p.id, name: p.name, path: p.path })),
    log,
  );
  registerHandler(IPC.VOD_OPEN_EXTERNAL, (_e: any, a: { url?: string; path?: string; seek?: number }) => {
    if (!playerSettings.settings.vodExternalPlayerEnabled) {
      return { ok: false, error: 'vod external player disabled' };
    }
    const u = String(a?.url || '').trim();
    if (!u) return { ok: false, error: 'empty url' };
    const pick = String(a?.path || '').trim();
    const players = detectPlayers(pick || playerSettings.settings.vodExternalPlayer);
    if (!players.length) return { ok: false, error: 'no player detected' };
    const p = players[0];
    const seek = Math.max(0, Math.floor(Number(a?.seek) || 0));
    const started = launchPlayer(p.path, u, seekArgs(p.id, seek));
    log.i(`vod: external "${p.name}"${seek > 0 ? ` seek=${seek}s` : ''} -> ${u.slice(0, 120)}`);
    return started ? { ok: true, player: p.name } : { ok: false, error: `cannot launch "${p.name}"` };
  }, log);

  registerHandler(IPC.DAV_LIST, () => dav.list(), log);
  registerHandler(IPC.DAV_SET, (_e: any, s: DavServer) => dav.set(s || ({} as DavServer)), log);
  registerHandler(IPC.DAV_REMOVE, (_e: any, id: string) => {
    dav.remove(String(id || ''));
  }, log);
  registerHandler(
    IPC.DAV_BROWSE,
    (_e: any, a: { id: string; path?: string }) => dav.browse(String(a?.id || ''), a?.path || '/'),
    log,
  );
  registerHandler(IPC.DAV_OPEN_EXTERNAL, (_e: any, url: string) => {
    const u = String(url || '').trim();
    if (!u) return { ok: false, error: 'empty url' };
    const players = detectPlayers(playerSettings.settings.btExternalPlayer);
    if (!players.length) return { ok: false, error: 'no player detected' };
    const p = players[0];
    const started = launchPlayer(p.path, u);
    log.i(`webdav: external "${p.name}" -> ${u.slice(0, 120)}`);
    return started ? { ok: true, player: p.name } : { ok: false, error: `cannot launch "${p.name}"` };
  }, log);

  registerHandler(IPC.DLNA_DISCOVER, () => dlna.discover(), log);
  registerHandler(IPC.DLNA_CAST, (_e: any, a: { device: DlnaDevice; target: DlnaCastTarget }) =>
    dlna.cast(a?.device, a?.target || ({ url: '', name: '', positionMs: 0 } as DlnaCastTarget)), log);

  registerHandler(IPC.UPDATE_CHECK, () => updater.check(), log);
  registerHandler(IPC.UPDATE_DOWNLOAD, async () => {
    const push = (p: UpdateProgress): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(IPC.UPDATE_PROGRESS, p);
      }
    };
    return updater.download(push);
  }, log);
  registerHandler(IPC.UPDATE_INSTALL, async () => {
    const path = updater.downloadedPath();
    if (!path) throw new Error('installer missing');
    const r = await updater.launch(path);
    if (!r.ok) throw new Error(r.error || 'cannot launch installer');
    setTimeout(() => app.quit(), 1500);
    return { ok: true, path };
  }, log);

  registerHandler(IPC.LIVE_LOAD, (_e: any, index: number) => host.loadLive(index), log);
  registerHandler(
    IPC.LIVE_EPG,
    (_e: any, a: { index: number; channels: EpgChannelRef[] }) => host.loadLiveEpg(Number(a?.index) || 0, a?.channels || []),
    log,
  );
  registerHandler(
    IPC.EPG_PROGRAMS,
    (_e: any, channelNames: string | string[]) => host.getLiveEpgPrograms(channelNames),
    log,
  );

  ipcMain.handle(IPC.EPG_OPEN_WINDOW, (_e, p: {
    channelName: string;
    tvgId?: string;
    tvgName?: string;
    groups?: Array<{ group?: string; channels?: Array<{ name?: string; tvgId?: string; tvgName?: string }> }>;
    currentGroup?: string;
  }) => {
    const groups: EpgGroupItem[] = Array.isArray(p?.groups)
      ? p!.groups!
          .map((g) => {
            const channels: EpgChannelItem[] = Array.isArray(g?.channels)
              ? g!.channels!
                  .map((c) => ({
                    name: String(c?.name || '').trim(),
                    tvgId: c?.tvgId ? String(c.tvgId).trim() : undefined,
                    tvgName: c?.tvgName ? String(c.tvgName).trim() : undefined,
                  }))
                  .filter((c) => !!c.name)
              : [];
            return { group: String(g?.group || '').trim(), channels };
          })
          .filter((g) => !!g.group && g.channels.length > 0)
      : [];
    return openEpgWindow({
      channelName: String(p?.channelName || ''),
      tvgId: p?.tvgId ? String(p.tvgId) : undefined,
      tvgName: p?.tvgName ? String(p.tvgName) : undefined,
      groups,
      currentGroup: String(p?.currentGroup || ''),
    });
  });
  ipcMain.handle(IPC.EPG_WINDOW_READY, (e) => {
    epgWindowReady(e.sender.id);
    return { ok: true };
  });
  ipcMain.handle(IPC.EPG_GET_CHANNELS, () => getPendingGroups());

  registerHandler('live:meta', () => host.lives, log);
}
