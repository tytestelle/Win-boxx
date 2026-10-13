// src/main/preload.ts — contextBridge 暴露 window.api
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcResult } from '../shared/ipc-result';
import { IPC } from '../shared/ipc-channels';
import type { SiteConfig, ImportReport, SourceBean, SourceMoveDirection, SourceUpdatePatch, UserConfig, UserProfile, MetaHit, MetaExtra, DiscoverSection, DiscoverGenre, DiscoverGenrePage, MetaImages } from '../shared/types';
import type { SubtitleFetchResult } from '../shared/subtitle';
import type { MetaSettings, MetaSettingsView, MetaSuggestion } from '../shared/meta';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> =>
  ipcRenderer.invoke(channel, ...args);

const api = {
  system: { ping: () => invoke<string>(IPC.SYSTEM_PING), icon: () => invoke<string>(IPC.APP_ICON), setTheme: (t: string) => invoke<void>(IPC.THEME_SET, t), quit: () => invoke<void>(IPC.APP_QUIT), dataDir: () => invoke(IPC.SYSTEM_DATA_DIR), sessionId: () => invoke<string>(IPC.SYSTEM_SESSION_ID) },
  config: {
    import: (args: { url?: string; json?: string }) => invoke(IPC.CONFIG_IMPORT, args),
    listSites: () => invoke(IPC.CONFIG_LIST_SITES),
    diagnose: () => invoke(IPC.CONFIG_DIAGNOSE),
    cfgGet: () => invoke<UserConfig>(IPC.CFG_GET),
    addSource: (bean: SourceBean) => invoke<SourceBean>(IPC.CFG_ADD_SOURCE, bean),
    updateSource: (key: string, patch: SourceUpdatePatch) => invoke<SourceBean>(IPC.CFG_UPDATE_SOURCE, { key, patch }),
    deleteSource: (key: string) => invoke<void>(IPC.CFG_DELETE_SOURCE, key),
    moveSource: (key: string, direction: SourceMoveDirection) => invoke<void>(IPC.CFG_MOVE_SOURCE, { key, direction }),
    setActiveSource: (key: string) => invoke<void>(IPC.CFG_SET_ACTIVE_SOURCE, key),
    setActiveLive: (index: number) => invoke<void>(IPC.CFG_SET_ACTIVE_LIVE, index),
    importUrl: (url: string, name?: string) => invoke(IPC.CFG_IMPORT_URL, { url, name }),
    importJsonLocal: (name?: string) =>
      invoke<{
        ok: boolean;
        file?: string;
        name?: string;
        error?: string;
        result?: { config: SiteConfig; report: ImportReport; warnings: string[]; urls?: { name: string; url: string }[] };
      }>(IPC.CFG_IMPORT_JSON_LOCAL, name),
    importPyLocal: () => invoke<{ ok: boolean; key?: string; error?: string }>(IPC.CFG_IMPORT_PY_LOCAL),
    importLiveLocal: () =>
      invoke<{ ok: boolean; name?: string; index?: number; replaced?: boolean; total?: number; error?: string }>(IPC.CFG_IMPORT_LIVE_LOCAL),
    importPackage: (name?: string) =>
      invoke<{
        ok: boolean;
        root?: string;
        rel?: string;
        sites?: number;
        name?: string;
        error?: string;
        warnings?: string[];
        result?: { config: SiteConfig; report: ImportReport; warnings: string[]; urls?: { name: string; url: string }[] };
      }>(IPC.CFG_IMPORT_PACKAGE, name),
    webHomeOpen: (init: { url: string; title?: string; site?: Record<string, string | undefined> }) =>
      invoke<{ ok: boolean; error?: string }>(IPC.WEBHOME_OPEN, init),
    saveAsProfile: (name: string) => invoke<UserProfile>(IPC.CFG_PROFILE_SAVE, name),
    activateProfile: (id: string) => invoke<void>(IPC.CFG_PROFILE_ACTIVATE, id),
    deleteProfile: (id: string) => invoke<void>(IPC.CFG_PROFILE_DELETE, id),
    updateProfileName: (a: { id: string; name: string }) => invoke<void>(IPC.CFG_PROFILE_UPDATE_NAME, a),
    cfgProfiles: () => invoke(IPC.CFG_PROFILES),
    profileSites: () => invoke(IPC.CFG_PROFILE_SITES),
    switchProfileSource: (a: { profileId: string; key: string }) => invoke<void>(IPC.CFG_SWITCH_PROFILE_SOURCE, a),
    vodDebug: (key: string) => invoke(IPC.VOD_DEBUG, key),
    audit: () => invoke(IPC.VOD_AUDIT),
    cacheClear: () => invoke<{ freedBytes: number; cleared: string[]; failed: string[] }>(IPC.CACHE_CLEAR),
    driveBindKeys: () => invoke<string[]>(IPC.DRIVE_BIND_KEYS),
    gotoDriveBind: () => invoke<void>(IPC.UI_GOTO_DRIVE_BIND),
    onNavDriveBind: (cb: () => void) => {
      const l = () => cb();
      ipcRenderer.on(IPC.NAV_DRIVE_BIND, l);
      return () => ipcRenderer.removeListener(IPC.NAV_DRIVE_BIND, l);
    },
  },
  vod: {
    home: (key: string) => invoke(IPC.VOD_HOME, key),
    category: (a: { key: string; tid: string; pg: string; extend?: Record<string, string> }) => invoke(IPC.VOD_CATEGORY, a),
    detail: (a: { key: string; ids: string[] }) => invoke(IPC.VOD_DETAIL, a),
    search: (a: { key: string; wd: string }) => invoke(IPC.VOD_SEARCH, a),
    searchAll: (wd: string, opts?: { refresh?: boolean }) => invoke(IPC.VOD_SEARCH_ALL, { wd, refresh: !!opts?.refresh }),
    onSearchAllProgress: (cb: (ev: unknown) => void) => {
      const l = (_e: unknown, ev: unknown) => cb(ev);
      ipcRenderer.on(IPC.VOD_SEARCH_ALL_PROGRESS, l);
      return () => { ipcRenderer.removeListener(IPC.VOD_SEARCH_ALL_PROGRESS, l); };
    },
    play: (a: { key: string; flag: string; id: string }) => invoke(IPC.VOD_PLAY, a),
    detectPlayers: () => invoke<Array<{ id: string; name: string; path: string }>>(IPC.VOD_DETECT_PLAYERS),
    openExternal: (a: { url: string; path?: string; seek?: number }) =>
      invoke<{ ok: boolean; player?: string; error?: string }>(IPC.VOD_OPEN_EXTERNAL, a),
  },
  live: {
    load: (index: number) => invoke(IPC.LIVE_LOAD, index),
    meta: () => invoke('live:meta'),
    /** ★ 2026-09-29 EPG：传入该线路的频道引用，返回各键的当前/下一档 */
    epg: (index: number, channels: unknown) => invoke(IPC.LIVE_EPG, { index, channels }),
    /** ★ 2026-10-13 EPG 直查：某频道完整节目单（支持单 key 或多 key 数组，按顺序尝试） */
    epgPrograms: (channelNames: string | string[]) => invoke(IPC.EPG_PROGRAMS, channelNames),
    epgCurrent: (channelName: string) => invoke(IPC.EPG_CURRENT, channelName),
    epgNext: (channelName: string) => invoke(IPC.EPG_NEXT, channelName),
    epgIcon: (channelName: string) => invoke(IPC.EPG_ICON, channelName),
    epgRefresh: () => invoke(IPC.EPG_REFRESH),
  },
  backup: {
    export: (renderer: unknown) => invoke(IPC.BACKUP_EXPORT, renderer),
    import: () => invoke(IPC.BACKUP_IMPORT),
  },
  dav: {
    list: () => invoke(IPC.DAV_LIST),
    set: (s: unknown) => invoke(IPC.DAV_SET, s),
    remove: (id: string) => invoke(IPC.DAV_REMOVE, id),
    browse: (a: { id: string; path?: string }) => invoke(IPC.DAV_BROWSE, a),
    openExternal: (url: string) => invoke(IPC.DAV_OPEN_EXTERNAL, url),
  },
  dlna: {
    discover: () => invoke(IPC.DLNA_DISCOVER),
    cast: (a: unknown) => invoke(IPC.DLNA_CAST, a),
  },
  subtitle: {
    get: () => invoke(IPC.SUBTITLE_GET),
    set: (patch: unknown) => invoke(IPC.SUBTITLE_SET, patch),
    providers: () => invoke(IPC.SUBTITLE_PROVIDERS),
    search: (name: string) => invoke(IPC.SUBTITLE_SEARCH, name),
    fetch: (cand: unknown) => invoke<SubtitleFetchResult>(IPC.SUBTITLE_FETCH, cand),
  },
  danmaku: {
    get: () => invoke(IPC.DANMAKU_GET),
    set: (patch: unknown) => invoke(IPC.DANMAKU_SET, patch),
    search: (name: string, season?: number) => invoke(IPC.DANMAKU_SEARCH, name, season),
    episodes: (bangumiId: number, animeTitle?: string, source?: string) => invoke(IPC.DANMAKU_EPISODES, bangumiId, animeTitle, source),
    fetch: (episodeId: number, source?: string) => invoke(IPC.DANMAKU_FETCH, episodeId, source),
  },
  meta: {
    search: (name: string, year?: string, provider?: 'tmdb' | 'douban') => invoke<MetaHit | null>(IPC.META_SEARCH, name, year, provider),
    extra: (name: string, year?: string) => invoke<MetaExtra | null>(IPC.META_EXTRA, name, year),
    discover: (refresh?: boolean) => invoke<DiscoverSection[]>(IPC.META_DISCOVER, !!refresh),
    movieHot: () => invoke(IPC.META_MOVIE_HOT),
    discoverImages: (name: string, mediaType: 'movie' | 'tv', year?: string, kind?: 'backdrop' | 'poster') => invoke<MetaImages>(IPC.META_DISCOVER_IMAGES, name, mediaType, year, kind),
    genres: () => invoke<{ movie: DiscoverGenre[]; tv: DiscoverGenre[] }>(IPC.META_GENRES),
    genrePage: (mediaType: 'movie' | 'tv', genreId: number, page: number) =>
      invoke<DiscoverGenrePage>(IPC.META_GENRE_PAGE, mediaType, genreId, page),
    getSettings: () => invoke<MetaSettingsView>(IPC.META_GET_SETTINGS),
    setSettings: (patch: Partial<MetaSettings>) => invoke<MetaSettingsView>(IPC.META_SET_SETTINGS, patch),
    suggest: (q: string) => invoke<MetaSuggestion[]>(IPC.META_SUGGEST, q),
    images: (mediaType: 'movie' | 'tv', tmdbId: number) => invoke<MetaImages>(IPC.META_IMAGES, mediaType, tmdbId),
  },
  drives: {
    get: () => invoke(IPC.DRIVE_GET),
    set: (a: { provider: string; token: string }) => invoke(IPC.DRIVE_SET, a),
    remove: (provider: string) => invoke(IPC.DRIVE_REMOVE, provider),
    qrCreate: (provider?: string) => invoke(IPC.DRIVE_QR_CREATE, provider),
    qrPoll: (provider: string, sid: string) => invoke(IPC.DRIVE_QR_POLL, provider, sid),
    webLogin: (provider: string) => invoke(IPC.DRIVE_WEB_LOGIN, provider),
  },
  win: {
    minimize: () => invoke(IPC.WIN_MINIMIZE),
    maximize: () => invoke(IPC.WIN_MAXIMIZE),
    close: () => invoke(IPC.WIN_CLOSE),
    isMaximized: () => invoke<boolean>(IPC.WIN_IS_MAXIMIZED),
    setAlwaysOnTop: (on: boolean) => invoke<boolean>(IPC.WIN_SET_ALWAYS_ON_TOP, !!on),
    isAlwaysOnTop: () => invoke<boolean>(IPC.WIN_IS_ALWAYS_ON_TOP),
    openDetail: (a: { key: string; id: string; query?: string }) => invoke(IPC.WIN_OPEN_DETAIL, a),
    openSearch: (term: string) => invoke(IPC.WIN_OPEN_SEARCH, term),
    routeReady: () => invoke(IPC.WIN_ROUTE_READY),
    reportError: (message: string) => invoke(IPC.WIN_REPORT_ERROR, message),
    onNavigate: (cb: (route: string) => void) => {
      const l = (_e: unknown, route: unknown) => cb(String(route || ''));
      ipcRenderer.on(IPC.WIN_NAVIGATE, l);
      return () => ipcRenderer.removeListener(IPC.WIN_NAVIGATE, l);
    },
  },
  net: {
    onSpeed: (cb: (kbs: number) => void) => {
      const l = (_e: unknown, kbs: number) => cb(kbs);
      ipcRenderer.on('net:speed', l);
      return () => ipcRenderer.removeListener('net:speed', l);
    },
    proxyGet: () => invoke(IPC.PROXY_GET),
    proxySet: (patch: { enabled?: boolean; url?: string }) => invoke(IPC.PROXY_SET, patch),
  },
  player: {
    open: (init: unknown) => invoke(IPC.PLAYER_OPEN, init),
    switchEp: (request: number | import('../shared/playerEpisode').PlayerEpisodeSwitch) => invoke<{ switched: boolean }>(IPC.PLAYER_SWITCH_EP, request),
    ready: () => invoke(IPC.PLAYER_READY),
    isOpen: () => invoke<{ open: boolean }>(IPC.PLAYER_IS_OPEN),
    close: () => invoke('player:close'),
    setMini: (isMini: boolean) => invoke<{ mini: boolean }>(IPC.PLAYER_SET_MINI, isMini),
    isMini: () => invoke<{ mini: boolean }>(IPC.PLAYER_IS_MINI),
    setFullscreen: (fullscreen: boolean) => invoke<{ fullscreen: boolean }>(IPC.PLAYER_SET_FULLSCREEN, fullscreen),
    isFullscreen: () => invoke<{ fullscreen: boolean }>(IPC.PLAYER_IS_FULLSCREEN),
    setResizable: (resizable: boolean) => invoke<{ resizable: boolean }>(IPC.PLAYER_SET_RESIZABLE, resizable),
    onInit: (cb: (init: unknown) => void) => {
      const l = (_e: unknown, init: unknown) => cb(init);
      ipcRenderer.on('player:init', l);
      return () => ipcRenderer.removeListener('player:init', l);
    },
    onSwitchEp: (cb: (epIndex: number) => void) => {
      const l = (_e: unknown, epIndex: number) => cb(epIndex);
      ipcRenderer.on('player:switchEp', l);
      return () => ipcRenderer.removeListener('player:switchEp', l);
    },
    onMini: (cb: (mini: boolean) => void) => {
      const l = (_e: unknown, mini: boolean) => cb(!!mini);
      ipcRenderer.on('player:mini', l);
      return () => ipcRenderer.removeListener('player:mini', l);
    },
    onFullscreen: (cb: (fullscreen: boolean) => void) => {
      const l = (_e: unknown, fullscreen: boolean) => cb(!!fullscreen);
      ipcRenderer.on('player:fullscreen', l);
      return () => ipcRenderer.removeListener('player:fullscreen', l);
    },
  },
  boss: {
    get: () => invoke(IPC.BOSS_GET),
    set: (patch: unknown) => invoke(IPC.BOSS_SET, patch),
    onEnter: (cb: () => void) => {
      const l = () => cb();
      ipcRenderer.on('boss:enter', l);
      return () => ipcRenderer.removeListener('boss:enter', l);
    },
    onExit: (cb: () => void) => {
      const l = () => cb();
      ipcRenderer.on('boss:exit', l);
      return () => ipcRenderer.removeListener('boss:exit', l);
    },
  },
  merge: {
    export: (ids: string[]) => invoke(IPC.CFG_MERGE_EXPORT, ids),
    save: (a: { content: string; defaultName?: string }) => invoke<{ saved: boolean; path: string }>(IPC.CFG_EXPORT_SAVE, a),
  },
  playerPrefs: {
    get: () => invoke(IPC.PLAYER_PREFS_GET),
    set: (patch: unknown) => invoke(IPC.PLAYER_PREFS_SET, patch),
  },
  mpv: {
    status: () => invoke(IPC.MPV_STATUS),
    start: (opts: unknown) => invoke(IPC.MPV_START, opts),
    cmd: (cmd: unknown) => invoke(IPC.MPV_CMD, cmd),
    stop: () => invoke(IPC.MPV_STOP),
    onState: (cb: (s: unknown) => void) => {
      const l = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on(IPC.MPV_STATE, l);
      return () => ipcRenderer.removeListener(IPC.MPV_STATE, l);
    },
  },
  bt: {
    detectPlayers: () => invoke<Array<{ id: string; name: string; path: string }>>(IPC.BT_DETECT_PLAYERS),
  },
  update: {
    check: () => invoke(IPC.UPDATE_CHECK),
    download: () => invoke(IPC.UPDATE_DOWNLOAD),
    install: () => invoke(IPC.UPDATE_INSTALL),
    onProgress: (cb: (p: unknown) => void) => {
      const l = (_e: unknown, p: unknown) => cb(p);
      ipcRenderer.on(IPC.UPDATE_PROGRESS, l);
      return () => ipcRenderer.removeListener(IPC.UPDATE_PROGRESS, l);
    },
  },
  quark: {
    cleanup: () => invoke<void>(IPC.QUARK_CLEANUP),
  },
};

contextBridge.exposeInMainWorld('api', api);
export type Api = typeof api;
