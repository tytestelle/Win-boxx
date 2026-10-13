// src/main/ipc/index.ts — 注册所有 IPC handler
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
// 独立播放器窗口
import { openPlayerWindow, playerSwitchEpisode, isPlayerOpen, closePlayerWindow, playerSetMini, playerIsMini, playerWindow, playerResendInit, onPlayerWindowClosed, isPlayerWindow, playerSetFullscreen, playerIsFullscreen, playerSetResizable } from '../player/PlayerWindow';
// ★ 2026-10-08 MPV 高兼容播放内核（独立播放器窗口内嵌 --wid）
import { MpvController } from '../player/MpvController';
// ★ 2026-10-08 详情页独立窗口（外观开关控制；见 renderer/lib/detailWin.ts）
import { openDetailWindow, detailWindowReady } from '../player/DetailWindow';
import { openSearchWindow, searchWindowReady } from '../player/SearchWindow';
import type { MpvCommand, MpvStartOptions } from '../../shared/player';
// 老板键
import { bossKey, BOSS_DEFAULT_ACCEL } from '../bossKey';
import { playerSettings } from '../player/playerSettings';
import { detectPlayers, launchPlayer, seekArgs } from '../torrent/externalPlayer';
import { ok } from '../../shared/ipc-result';
import type { IpcMainInvokeEvent } from 'electron';
import type { BossKeySettings, EpgChannelRef, ImportReport, MultiConfigEntry, SiteConfig, SourceBean, SourceMoveDirection, SourceUpdatePatch } from '../../shared/types';
import type { MetaSettings } from '../../shared/meta';
import type { PlayerSettings } from '../../shared/player';
// ★ 2026-10-13：本地文件导入直播源（抽出的公共函数；网络订阅源下载完成后走同一条链路）
import { importLiveFileFromPath } from '../live/importLiveFile';
// ★ 2026-10-14（用户要求）：通用路由窗口（导航点击 → 独立新窗口，多开）
import { openRouteWindow, setWindowRoute } from '../player/RouteWindow';

function winOf(e: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender);
}

/** ★ 本次主进程启动的会话标识（模块求值 = 应用启动一次；重启必变） */
const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function registerIpc(host: SpiderHost, dav: DavService, dlna: DlnaService, updater: UpdateService, pkgs: LocalPkgStore): void {
  const log = fileLogger;
  /** ★ 2026-10-08 MPV 播放内核（单会话；播放器窗口关闭/退出应用会 dispose） */
  const mpv = new MpvController(fileLogger);

  // 自定义无边框窗口控制
  ipcMain.handle(IPC.WIN_MINIMIZE, (e) => winOf(e)?.minimize());
  ipcMain.handle(IPC.WIN_MAXIMIZE, (e) => {
    const w = winOf(e);
    if (!w) return;
    // Transparent player windows can report false from isFullScreen() on Windows;
    // use the event-backed player state so a maximize click always exits player fullscreen.
    if (isPlayerWindow(w) && playerIsFullscreen()) { void playerSetFullscreen(false); return; }
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.handle(IPC.WIN_CLOSE, (e) => winOf(e)?.close());
  ipcMain.handle(IPC.WIN_IS_MAXIMIZED, (e) => !!winOf(e)?.isMaximized());
  /**
   * ★ 2026-09-30（用户要求）：播放器「置顶」按钮 —— 把**发起窗口**设为始终置顶。
   *   level 用 'floating'（HWND_TOPMOST 语义：压过所有普通窗口，但不与任务栏/系统 UI 抢层级）。
   *   ★ 必须走 registerHandler（IpcResult 信封）—— 渲染层 client 的 unwrap 只认 {ok,data}。
   */
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
  /**
   * ★ 2026-09-30（用户要求「软件关闭后，所有的墓碑机制都应该脱钩」）：
   *   本次**主进程启动**的唯一会话标识（每次启动必变）——渲染层用它判定「新一次启动」，
   *   决定是否丢弃页面状态类记忆（搜索态/浏览态/详情态）。见 renderer/lib/uiMemory.ts。
   */
  registerHandler(IPC.SYSTEM_SESSION_ID, () => SESSION_ID, log);
  // 退出整个应用（免责声明「拒绝」等场景）
  registerHandler(IPC.APP_QUIT, () => {
    app.quit();
    return { ok: true };
  }, log);
  // 亮/深色模式：同步到原生主题（影响 Mica 背景与窗口底色），并更新当前窗口背景色
  registerHandler(IPC.THEME_SET, (_e: any, theme: string) => {
    nativeTheme.themeSource = theme === 'light' ? 'light' : theme === 'dark' ? 'dark' : 'system';
    const w = winOf(_e as IpcMainInvokeEvent);
    // ★ 不透明底色：对齐主窗口 createWindow 的修复（透明背景在放大/最大化时残影异形）
    // ★★ 2026-10-08（用户报「b蓝光 / 自建 4K-2 有声音无图像」根因修复）★★：
    //   **播放器窗口是透明窗**（mpv 画面从播放区透明处透出），它自己也跑主题引导 → 会走到这里；
    //   一旦给它设不透明底色，mpv 画面被整块盖住（实测复现 + `setBackgroundColor` 最小复现）。
    //   该窗口的底色必须保持 `#00000000`（构造项），其「最大化残影」由 PlayerWindow 自身的
    //   maximize/unmaximize → invalidate + 圆角处理兜底。
    const dark = nativeTheme.shouldUseDarkColors;
    if (w && !isPlayerWindow(w)) w.setBackgroundColor(dark ? '#0a0c10' : '#dce4ec');
  }, log);
  // 应用图标 dataURL（标题栏/窗口内展示与进程图标一致）
  registerHandler(IPC.APP_ICON, () => {
    const p = join(resourcesDir(), 'ui', 'icon32.png');
    if (!existsSync(p)) return '';
    return 'data:image/png;base64,' + readFileSync(p).toString('base64');
  }, log);
  // ★ 2026-09-30（用户要求）：数据目录信息（安装目录/data；老用户迁移结果 / 回退原因）——配置页展示 + 排障
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

  // 用户配置持久化 + 源管理（任务 B）
  registerHandler(IPC.CFG_GET, () => host.cfgSnapshot(), log);
  // ★ 2026-09-27：已学到的「需要网盘绑定」源 key（学习点 = play() 命中网盘直链，见 SpiderHost.markDriveBindNeeded）
  registerHandler(IPC.DRIVE_BIND_KEYS, () => host.driveBindLearned(), log);
  registerHandler(IPC.CFG_ADD_SOURCE, (_e: any, bean: SourceBean) => host.cfgAddSource(bean), log);
  registerHandler(IPC.CFG_UPDATE_SOURCE, (_e: any, a: { key: string; patch: SourceUpdatePatch }) =>
    host.cfgUpdateSource(a.key, a.patch || {}), log);
  registerHandler(IPC.CFG_DELETE_SOURCE, (_e: any, key: string) => host.cfgDeleteSource(key), log);
  registerHandler(IPC.CFG_MOVE_SOURCE, (_e: any, a: { key: string; direction: SourceMoveDirection }) =>
    host.cfgMoveSource(a.key, a.direction), log);
  registerHandler(IPC.CFG_SET_ACTIVE_SOURCE, (_e: any, key: string) => host.cfgSetActiveSource(key), log);
  registerHandler(IPC.CFG_SET_ACTIVE_LIVE, (_e: any, index: number) => host.cfgSetActiveLive(index), log);
  registerHandler(IPC.CFG_IMPORT_URL, async (_e: any, a: { url: string; name?: string }) => {
    const r = await host.importConfig({ url: a.url, name: a.name });
    return { config: r.config, report: r.report, warnings: r.warnings, urls: r.urls };
  }, log);
  registerHandler(IPC.CFG_PROFILES, () => host.cfgProfiles(), log);
  registerHandler(IPC.CFG_PROFILE_SAVE, (_e: any, name: string) => host.cfgSaveAsProfile(name), log);
  registerHandler(IPC.CFG_PROFILE_ACTIVATE, (_e: any, id: string) => host.cfgActivateProfile(id), log);
  registerHandler(IPC.CFG_PROFILE_DELETE, (_e: any, id: string) => host.cfgDeleteProfile(id), log);
  registerHandler(IPC.CFG_PROFILE_UPDATE_NAME, (_e: any, a: { id: string; name: string }) => host.cfgUpdateProfileName(a.id, a.name), log);
  /**
   * ★ 2026-09-30（用户要求）：换源弹层「左订阅 / 右源」视图 —— 每份档案的源 key/name 清单。
   * 当前生效档案取运行期真实源列表；其余档案解析其存档 JSON（坏档给空清单，不阻塞弹层）。
   */
  registerHandler(IPC.CFG_PROFILE_SITES, () => host.cfgProfileSites(), log);
  /** ★ 2026-09-30（用户要求）：一步完成「切换档案 + 选中该档案下的源」（单次 apply，避免两轮宿主重活） */
  registerHandler(IPC.CFG_SWITCH_PROFILE_SOURCE, (_e: any, a: { profileId: string; key: string }) =>
    host.cfgSwitchProfileSource(String(a?.profileId || ''), String(a?.key || '')), log);
  // 清理缓存：只删可重建的纯缓存（Chromium 缓存 / jar 转换缓存），绝不动配置/历史/绑定
  //   ★ 2026-09-24：清完立刻在后台重建蜘蛛运行时（重新转换 jar + 重启热进程），
  //     否则用户下一次进源要在请求里现付 30~40s 的「下载 + dex2jar」并被超时打断。
  registerHandler(IPC.CACHE_CLEAR, async () => {
    const r = clearAppCache(userDataDir(), spiderCacheDir());
    try { host.rewarmAfterCacheClear(); } catch { /* 预热失败不影响清理结果 */ }
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

  // 外挂字幕（多源：assrt（需 token）/ SubtitleCat（免 token））
  registerHandler(IPC.SUBTITLE_GET, () => host.subtitleGetSettings(), log);
  registerHandler(IPC.SUBTITLE_SET, (_e: any, patch: any) => host.subtitleSetSettings(patch || {}), log);
  registerHandler(IPC.SUBTITLE_PROVIDERS, () => host.subtitleProviderView(), log);
  registerHandler(IPC.SUBTITLE_SEARCH, (_e: any, name: string) => host.subtitleSearch(String(name)), log);
  registerHandler(IPC.SUBTITLE_FETCH, (_e: any, cand: any) => host.subtitleFetch(cand), log);
  // 弹幕（外部接口清单）
  registerHandler(IPC.DANMAKU_GET, () => host.danmakuGetSettings(), log);
  registerHandler(IPC.DANMAKU_SET, (_e: any, patch: any) => host.danmakuSetSettings(patch || {}), log);
  // ★ 2026-09-26：season = 资源名提取的季号（同季条目优先）
  registerHandler(IPC.DANMAKU_SEARCH, (_e: any, name: string, season?: number) =>
    host.danmakuSearch(String(name), Number.isFinite(Number(season)) && Number(season) > 0 ? Number(season) : undefined), log);
  // ★ 2026-09-26：source = 接口基础地址（候选项自带来源，透传回来即可）
  registerHandler(IPC.DANMAKU_EPISODES, (_e: any, bangumiId: number, animeTitle?: string, source?: string) =>
    host.danmakuEpisodes(Number(bangumiId), animeTitle ? String(animeTitle) : undefined, source ? String(source) : ''), log);
  registerHandler(IPC.DANMAKU_FETCH, (_e: any, episodeId: number, source?: string) =>
    host.danmakuFetch(Number(episodeId), source ? String(source) : ''), log);
  // TMDB 元数据补全（缺封面/缺简介兜底；凭据内置密文，仅查询）
  registerHandler(IPC.META_SEARCH, (_e: any, name: string, year?: string, provider?: string) => host.metaSearch(String(name || ''), year ? String(year) : undefined, provider === 'tmdb' || provider === 'douban' ? provider : undefined), log);
  // ★ 2026-09-24：详情页增强（演职员/类型/相关推荐）与发现页榜单（无源默认主页）
  registerHandler(IPC.META_EXTRA, (_e: any, name: string, year?: string) => host.metaExtra(String(name || ''), year ? String(year) : undefined), log);
  registerHandler(IPC.META_DISCOVER, (_e: any, refresh?: boolean) => host.metaDiscover(!!refresh), log);
  registerHandler(IPC.META_MOVIE_HOT, () => host.metaMovieHot(), log);
  registerHandler(IPC.META_DISCOVER_IMAGES, (_e: any, name: string, mediaType: string, year?: string, kind?: string) =>
    host.metaDiscoverImages(String(name || ''), mediaType === 'tv' ? 'tv' : 'movie', /^\d{4}$/.test(String(year)) ? String(year) : undefined, kind === 'poster' ? 'poster' : 'backdrop'), log);
  // ★ 2026-09-24：发现页「分类」（TMDB 类型清单 + 按类型翻页）
  registerHandler(IPC.META_GENRES, () => host.metaGenres(), log);
  registerHandler(IPC.META_GENRE_PAGE, (_e: any, mediaType: string, genreId: number, page: number) => host.metaGenrePage(String(mediaType || 'movie'), Number(genreId) || 0, Number(page) || 1), log);
  // ★ 2026-09-24：元数据来源配置（TMDB Key/代理/镜像 + 策略）与搜索面板联想
  registerHandler(IPC.META_GET_SETTINGS, () => host.metaGetSettings(), log);
  registerHandler(IPC.META_SET_SETTINGS, (_e: any, patch: unknown) => host.metaSetSettings((patch || {}) as Partial<MetaSettings>), log);
  registerHandler(IPC.META_SUGGEST, (_e: any, q: string) => host.metaSuggest(String(q || '')), log);
  // ★ 发现页 Hero 轮播：取某部片的横版剧照/竖版海报（TMDB images）
  registerHandler(IPC.META_IMAGES, (_e: any, mediaType: string, tmdbId: number) =>
    host.metaImages(String(mediaType || 'movie') === 'tv' ? 'tv' : 'movie', Number(tmdbId) || 0), log);
  registerHandler(IPC.CFG_MERGE_EXPORT, (_e: any, ids: string[]) => host.mergeProfilesExport(ids), log);
  registerHandler(IPC.CFG_EXPORT_SAVE, async (_e: any, a: { content: string; defaultName?: string }) => {
    const w = winOf(_e as IpcMainInvokeEvent);
    const r = await dialog.showSaveDialog(w ?? undefined!, {
      title: '另存为',
      defaultPath: a.defaultName || 'merged-subscription.json',
      filters: [{ name: 'JSON 配置', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { saved: false, path: '' };
    writeFileSync(r.filePath, a.content, 'utf-8'); // 只写新文件，绝不改动任何原始文件
    return { saved: true, path: r.filePath };
  }, log);
  /**
   * ★ 2026-09-29 设置备份（导出）：宿主设置与凭据 + 播放偏好 + 代理 + 老板键 + 渲染层 localStorage → 单个 JSON。
   * ★ 凭据为**明文**（口径见 shared/backup.ts）：换机/重装后也能还原；文件由用户自行保管。
   */
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
      title: '导出设置备份',
      defaultPath: `win-box-backup-${stamp}.json`,
      filters: [{ name: 'Win-Box 备份',
