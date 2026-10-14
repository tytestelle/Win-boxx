// src/main/player/EpgWindow.ts
// EPG（节目单）独立窗口控制器。
//   特性：
//     · 单例复用（切换频道时通知渲染层换参数）
//     · 无边框 + 可拖动到屏幕任意位置
//     · 默认置顶（渲染层标题栏 📌 可切换）
//     · 不与主窗口建立父子关系 → 可拖出主窗口范围
//     · 主窗口关闭时由 main/index.ts 调用 closeEpgWindow() 一并关闭
//
// ★ 2026-10-14 追加（用户要求）：EPG 窗口内支持切换频道
//   · openEpgWindow 传入 `groups`（直播源**所有分组**的频道列表）+ `currentGroup`（当前分组名）
//   · EPG 窗口渲染层通过 IPC `epg:getChannels` 拉取 → 左侧渲染「分组 → 频道」列表，点击切换
//   · 切换只改 EPG 窗口显示，不影响主窗口正在播放的频道
import { app, BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { applyWindowCorner } from '../util/windowCorner';
import { IPC } from '../../shared/ipc-channels';
import { epgWindowRoute, type EpgWindowParams } from '../../shared/epgWin';

declare const __dirname: string;

/** ★ 频道列表项 */
export interface EpgChannelItem {
  name: string;
  tvgId?: string;
  tvgName?: string;
}

/** ★ 分组（含该分组的频道列表） */
export interface EpgGroupItem {
  group: string;
  channels: EpgChannelItem[];
}

/** ★ 打开 EPG 窗口的完整参数 */
export interface EpgOpenPayload extends EpgWindowParams {
  /** 直播源**所有分组**的频道列表（左侧列表用） */
  groups?: EpgGroupItem[];
  /** 当前分组名（默认展开该分组） */
  currentGroup?: string;
}

let epgWin: BrowserWindow | null = null;
let pendingQuery = '';
let pendingGroups: EpgGroupItem[] = [];
let pendingCurrentGroup = '';
let ready = false;

function isDev(): boolean {
  return !app.isPackaged && process.env.NODE_ENV !== 'production';
}

function pushPendingQuery(): void {
  if (epgWin && !epgWin.isDestroyed() && ready && !epgWin.webContents.isLoading()) {
    epgWin.webContents.send(IPC.EPG_WINDOW_UPDATE, pendingQuery);
  }
}

export function epgWindowReady(senderId: number): void {
  if (!epgWin || epgWin.isDestroyed() || epgWin.webContents.id !== senderId) return;
  ready = true;
  if (pendingQuery) epgWin.webContents.send(IPC.EPG_WINDOW_UPDATE, pendingQuery);
}

/** ★ 渲染层请求当前直播源的「分组 → 频道」列表 */
export function getPendingGroups(): { groups: EpgGroupItem[]; currentGroup: string } {
  return { groups: pendingGroups, currentGroup: pendingCurrentGroup };
}

export function openEpgWindow(payload: EpgOpenPayload): { ok: boolean; reused: boolean } {
  const name = String(payload?.channelName || '').trim();
  if (!name) throw new Error('频道名不能为空');
  const hash = epgWindowRoute({ ...payload, channelName: name });
  const qIndex = hash.indexOf('?');
  pendingQuery = qIndex >= 0 ? hash.slice(qIndex + 1) : '';
  pendingGroups = Array.isArray(payload.groups) ? payload.groups : [];
  pendingCurrentGroup = String(payload.currentGroup || '').trim();

  if (epgWin && !epgWin.isDestroyed()) {
    if (epgWin.isMinimized()) epgWin.restore();
    epgWin.show();
    epgWin.focus();
    if (ready) {
      pushPendingQuery();
      setTimeout(pushPendingQuery, 80).unref();
      // ★ 同步推送新的分组/频道列表（切分组后 EPG 窗口里的左侧列表要跟着更新）
      try {
        epgWin.webContents.send(IPC.EPG_GET_CHANNELS, {
          groups: pendingGroups,
          currentGroup: pendingCurrentGroup,
        });
      } catch { /* ignore */ }
    }
    return { ok: true, reused: true };
  }

  ready = false;

  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const width = 820;
  const height = 680;
  const x = Math.round(wa.x + Math.max(0, (wa.width - width) / 2));
  const y = Math.round(wa.y + 60);

  epgWin = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 560,
    minHeight: 400,
    frame: false,
    autoHideMenuBar: true,
    show: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    backgroundColor: '#1a1d24',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  try { epgWin.setAlwaysOnTop(true, 'floating'); } catch { /* ignore */ }

  epgWin.on('ready-to-show', () => {
    epgWin?.show();
    setTimeout(pushPendingQuery, 80).unref();
  });
  try { applyWindowCorner(epgWin, true); } catch { /* ignore */ }
  epgWin.on('closed', () => {
    epgWin = null;
    ready = false;
    pendingGroups = [];
    pendingCurrentGroup = '';
  });

  if (isDev()) {
    epgWin.loadURL(`http://localhost:5173/#${hash}`);
  } else {
    epgWin.loadFile(join(__dirname, 'renderer', 'index.html'), { hash });
  }
  return { ok: true, reused: false };
}

export function closeEpgWindow(): void {
  if (epgWin && !epgWin.isDestroyed()) {
    try { epgWin.close(); } catch { /* ignore */ }
  }
  epgWin = null;
  ready = false;
  pendingGroups = [];
  pendingCurrentGroup = '';
}
