// src/main/player/EpgWindow.ts
// EPG（节目单）独立窗口控制器。
//   · 单例复用（切换频道时通知渲染层换参数）
//   · 无边框 + 可拖动到屏幕任意位置
//   · 默认置顶（渲染层标题栏 📌 可切换）
//   · 不与主窗口建立父子关系 → 可拖出主窗口范围
//   · 主窗口关闭时由 main/index.ts 调用 closeEpgWindow() 一并关闭
import { app, BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { applyWindowCorner } from '../util/windowCorner';
import { IPC } from '../../shared/ipc-channels';
import { epgWindowRoute, type EpgWindowParams } from '../../shared/epgWin';

declare const __dirname: string;

export interface EpgChannelItem {
  name: string;
  tvgId?: string;
  tvgName?: string;
}

export interface EpgGroupItem {
  group: string;
  channels: EpgChannelItem[];
}

export interface EpgOpenPayload extends EpgWindowParams {
  groups?: EpgGroupItem[];
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
