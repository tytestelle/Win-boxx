// src/main/player/RouteWindow.ts
// ★ 2026-10-14（用户要求）：导航点击 → 打开包含该路由的**独立窗口**（多开）。
//   · 独立于主窗口（不建立 parent 关系）—— 可自由拖动、独立缩放/最小化
//   · 按路由去重：同一路由最多一个窗口（已开 → 聚焦；未开 → 新建）
//   · 白名单：/、/home、/history、/live、/storage、/config、/about
//   · 渲染层每次路由变化时通过 NOTIFY_ROUTE_CHANGE 上报 → 主进程维护「路由 → 窗口」注册表
import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
import { applyWindowCorner } from '../util/windowCorner';

declare const __dirname: string;

function isDev(): boolean {
  return !app.isPackaged && process.env.NODE_ENV !== 'production';
}

/** 顶层可多开的路由白名单（与渲染层 App.tsx 的 NAV 对应）。 */
const TOP_ROUTES = new Set(['/', '/home', '/history', '/live', '/storage', '/config', '/about']);

/**
 * 从 pathname 或完整 hash 标准化为顶层路由。
 *   `/`、`#/`、`/home`、`#/home`、`/home?x=1`、`/home/` → 归一；非白名单 → null。
 */
export function normalizeTopRoute(route: string): string | null {
  const raw = String(route || '').trim();
  if (!raw) return null;
  let p = raw.replace(/^#/, '');
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  const h = p.indexOf('#');
  if (h >= 0) p = p.slice(0, h);
  if (p === '' || p === '/') return '/';
  p = p.replace(/\/$/, '') || '/';
  return TOP_ROUTES.has(p) ? p : null;
}

/** 窗口 → 当前顶层路由（渲染层每次路由变化时上报）。 */
const winRoutes = new WeakMap<BrowserWindow, string>();

/** 渲染层上报：更新该窗口的当前顶层路由；非顶层路由 → 清除。 */
export function setWindowRoute(win: BrowserWindow, route: string): void {
  const n = normalizeTopRoute(route);
  if (n) winRoutes.set(win, n);
  else winRoutes.delete(win);
}

/**
 * 打开（或聚焦已开）一个包含指定路由的独立窗口。
 * @param route 顶层路由（如 `/home`、`/live`）；非白名单路由抛错。
 * @returns `{ ok, reused }`：`reused=true` = 复用了已开的窗口。
 */
export function openRouteWindow(route: string): { ok: boolean; reused: boolean } {
  const normalized = normalizeTopRoute(route);
  if (!normalized) throw new Error(`不支持的路由：${route}`);

  // 已开 → 聚焦（含被最小化的情况）；不重载页面，保留窗口位置/尺寸
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    if (winRoutes.get(w) === normalized) {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      return { ok: true, reused: true };
    }
  }

  // 新建
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'Win-Box',
    frame: false,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0c10' : '#dce4ec',
    ...(process.platform === 'win32' ? { backgroundMaterial: 'mica' as const } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 初始路由即为本次打开的路由（渲染层挂载后也会上报一次，双保险）
  winRoutes.set(win, normalized);

  win.on('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  // 最大化 / 还原：圆角偏好 + 强制重绘（与主窗口同款修复）
  const setCorner = (round: boolean) => {
    if (!win.isDestroyed()) applyWindowCorner(win, round);
  };
  const refreshContent = () => {
    if (!win.isDestroyed()) {
      try { win.webContents.invalidate(); } catch { /* ignore */ }
    }
  };
  win.on('maximize', () => { setCorner(false); refreshContent(); });
  win.on('unmaximize', () => { setCorner(true); refreshContent(); });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    winRoutes.delete(win);
  });

  if (isDev()) {
    void win.loadURL(`http://localhost:5173/#${normalized}`);
  } else {
    void win.loadFile(join(__dirname, 'renderer', 'index.html'), { hash: normalized });
  }

  return { ok: true, reused: false };
}
