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
//   · openEpgWindow 增加 `channels` 参数 —— 当前分组的全部频道（渲染层传过来）
//   · 保存到模块级 pendingChannels；EPG 窗口渲染层通过 IPC `epg:getChannels` 拉取
//   · 切换频道时再次调用 openEpgWindow（单例复用，只更新内容）
import { app, BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { applyWindowCorner } from '../util/windowCorner';
import { IPC } from '../../shared/ipc-channels';
import { epgWindowRoute, type EpgWindowParams } from '../../shared/epgWin';

declare const __dirname: string;

/** ★ 频道列表项（EPG 窗口内下拉用） */
export interface EpgChannelItem {
  name: string;
  tvgId?: string;
  tvgName?: string;
}

/** ★ 打开 EPG 窗口的完整参数（含分组频道列表） */
export interface EpgOpenPayload extends EpgWindowParams {
  channels?: EpgChannelItem[];
}

let epgWin: BrowserWindow | null = null;
/** 待推给渲染层的 query（无 `#/epg-window?` 前缀，只保留 `name=…&tvgId=…`） */
let pendingQuery = '';
/** ★ 当前分组可切换的频道列表（渲染层通过 IPC 拉取） */
let pendingChannels: EpgChannelItem[] = [];
let ready = false;

function isDev(): boolean {
  return !app.isPackaged && process.env.NODE_ENV !== 'production';
}

function pushPendingQuery(): void {
  if (epgWin && !epgWin.isDestroyed() && ready && !epgWin.webContents.isLoading()) {
    epgWin.webContents.send(IPC.EPG_WINDOW_UPDATE, pendingQuery);
  }
}

/** 渲染层通知就绪（挂载完成）→ 把最新参数发过去 */
export function epgWindowReady(senderId: number): void {
  if (!epgWin || epgWin.isDestroyed() || epgWin.webContents.id !== senderId) return;
  ready = true;
  if (pendingQuery) epgWin.webContents.send(IPC.EPG_WINDOW_UPDATE, pendingQuery);
}

/** ★ 渲染层请求当前分组可切换的频道列表 */
export function getPendingChannels(): EpgChannelItem[] {
  return pendingChannels;
}

/**
 * 打开（或复用）EPG 窗口。
 * 复用路径：聚焦 + `EPG_WINDOW_UPDATE` 让渲染层换频道并重新拉节目单
 *   （不重载页面，保留窗口位置/尺寸/置顶状态）。
 */
export function openEpgWindow(payload: EpgOpenPayload): { ok: boolean; reused: boolean } {
  const name = String(payload?.channelName || '').trim();
  if (!name) throw new Error('频道名不能为空');
  const hash = epgWindowRoute({ ...payload, channelName: name });
  const qIndex = hash.indexOf('?');
  pendingQuery = qIndex >= 0 ? hash.slice(qIndex + 1) : '';
  // ★ 保存频道列表（渲染层通过 IPC 拉取）
  pendingChannels = Array.isArray(payload.channels) ? payload.channels : [];

  if (epgWin && !epgWin.isDestroyed()) {
    if (epgWin.isMinimized()) epgWin.restore();
    epgWin.show();
    epgWin.focus();
    if (ready) {
      pushPendingQuery();
      setTimeout(pushPendingQuery, 80).unref();
      // ★ 同步推送新的频道列表（切分组后 EPG 窗口里的下拉要跟着更新）
      try { epgWin.webContents.send(IPC.EPG_GET_CHANNELS, pendingChannels); } catch { /* ignore */ }
    }
    return { ok: true, reused: true };
  }

  ready = false;

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
    pendingChannels = [];
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
  pendingChannels = [];
}
