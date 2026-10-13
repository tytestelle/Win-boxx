// src/main/player/EpgWindow.ts
// EPG（节目单）独立窗口控制器。
//   特性（用户口径）：
//     · 单例复用（不堆窗口；切换频道时通知渲染层换参数）
//     · 无边框 + 可拖动到屏幕任意位置（CSS `-webkit-app-region: drag`，见 EpgWinPage.tsx）
//     · **默认置顶**（alwaysOnTop；渲染层标题栏 📌 可切换）
//     · 不与主窗口建立父子关系 —— 因此可以拖出主窗口范围，甚至拖到别的显示器
//     · 主窗口关闭时由 main/index.ts 主动调用 closeEpgWindow() 一并关闭
import { app, BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { applyWindowCorner } from '../util/windowCorner';
import { IPC } from '../../shared/ipc-channels';
import { epgWindowRoute, type EpgWindowParams } from '../../shared/epgWin';

declare const __dirname: string;

let epgWin: BrowserWindow | null = null;
/** 待推给渲染层的 query（无 `#/epg-window?` 前缀，只保留 `name=…&tvgId=…`） */
let pendingQuery = '';
let ready = false;

function isDev(): boolean {
  return !app.isPackaged && process.env.NODE_ENV !== 'production';
}

function pushPendingQuery(): void {
  if (epgWin && !epgWin.isDestroyed() && ready && !epgWin.webContents.isLoading()) {
    epgWin.webContents.send(IPC.EPG_WINDOW_UPDATE, pendingQuery);
  }
}

/** 渲染层通知就绪（挂载完成）→ 把最新的参数发过去 */
export function epgWindowReady(senderId: number): void {
  if (!epgWin || epgWin.isDestroyed() || epgWin.webContents.id !== senderId) return;
  ready = true;
  if (pendingQuery) epgWin.webContents.send(IPC.EPG_WINDOW_UPDATE, pendingQuery);
}

/**
 * 打开（或复用）EPG 窗口。
 * 复用路径：聚焦 + `EPG_WINDOW_UPDATE` 让渲染层换频道并重新拉节目单（不重载页面，保留窗口位置/尺寸/置顶状态）。
 */
export function openEpgWindow(payload: EpgWindowParams): { ok: boolean; reused: boolean } {
  const name = String(payload?.channelName || '').trim();
  if (!name) throw new Error('频道名不能为空');
  const hash = epgWindowRoute({ ...payload, channelName: name });
  // 只把 query 部分留作更新载荷（主进程 loadFile 需要完整 hash，后续更新只需要 query）
  const qIndex = hash.indexOf('?');
  pendingQuery = qIndex >= 0 ? hash.slice(qIndex + 1) : '';

  if (epgWin && !epgWin.isDestroyed()) {
    if (epgWin.isMinimized()) epgWin.restore();
    epgWin.show();
    epgWin.focus();
    if (ready) {
      pushPendingQuery();
      setTimeout(pushPendingQuery, 80).unref();
    }
    return { ok: true, reused: true };
  }

  ready = false;

  // 初始位置：屏幕工作区上方居中（用户口径「视频上方」；用户可拖动到任何位置）
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const width = 420;
  const height = 640;
  const x = Math.round(wa.x + Math.max(0, (wa.width - width) / 2));
  const y = Math.round(wa.y + 60);

  epgWin = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 320,
    minHeight: 400,
    frame: false,
    autoHideMenuBar: true,
    show: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    /** ★ 默认置顶：节目单始终浮在视频上方；用户可点标题栏 📌 取消 */
    alwaysOnTop: true,
    backgroundColor: '#1a1d24',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // 置顶层级用 'floating'（HWND_TOPMOST 语义：压过普通窗口，不与任务栏/系统 UI 抢层级）
  try { epgWin.setAlwaysOnTop(true, 'floating'); } catch { /* ignore */ }

  epgWin.on('ready-to-show', () => {
    epgWin?.show();
    setTimeout(pushPendingQuery, 80).unref();
  });
  // 圆角偏好（保持与其它窗口一致；不涉及最大化，仅首次创建时套用一次）
  try { applyWindowCorner(epgWin, true); } catch { /* ignore */ }
  epgWin.on('closed', () => {
    epgWin = null;
    ready = false;
  });

  if (isDev()) {
    epgWin.loadURL(`http://localhost:5173/#${hash}`);
  } else {
    epgWin.loadFile(join(__dirname, 'renderer', 'index.html'), { hash });
  }
  return { ok: true, reused: false };
}

/** 主动关闭（供 main/index.ts 在主窗口关闭时调用） */
export function closeEpgWindow(): void {
  if (epgWin && !epgWin.isDestroyed()) {
    try { epgWin.close(); } catch { /* ignore */ }
  }
  epgWin = null;
  ready = false;
}
