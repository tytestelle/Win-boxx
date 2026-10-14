import { NavLink, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import TitleBar from './components/TitleBar';
import SearchPanel from './components/SearchPanel';
import PageErrorBoundary from './components/PageErrorBoundary';
import SourcePicker from './components/SourcePicker';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import ConfigPage from './pages/ConfigPage';
import HomePage from './pages/HomePage';
import DiscoverPage from './pages/DiscoverPage';
import DetailPage from './pages/DetailPage';
import PlayerPage from './pages/PlayerPage';
import LivePage from './pages/LivePage';
// ★ 2026-09-29：WebDAV 存储（只读浏览/播放）
import StoragePage from './pages/StoragePage';
import HistoryPage from './pages/HistoryPage';
import AboutPage from './pages/AboutPage';
/** ★ 2026-09-29：启动强制更新门禁（本地版本低于 GitHub 最新 Release 时遮挡全界面） */
import UpdateGate from './components/UpdateGate';
import { loadUiMemory, sameEpProgress, saveUiMemory, markHistoryOnlyWriter } from './lib/uiMemory';
// ★ 2026-09-30（用户要求）：显式绑定第三方播放器时点播直接由它播放（详见 lib/externalPlay.ts）
import { playVodExternal } from './lib/externalPlay';
import { useShowDiscover } from './lib/uiPrefs';
// 详情打开方式统一入口 + 固定窗口身份判定。
import { isDetailWindow, openDetailRoute } from './lib/detailWin';
import { isSearchWindow, openSearchWindow } from './lib/searchWin';
import { useTheme } from './lib/theme';
import { client } from './api/client';
// ★ 2026-10-14（用户要求）：导航点击 → 独立新窗口（多开）走通用 IPC 桥
import { ipcInvoke } from './api/ipc';
// ★ 2026-10-14（用户要求）：EPG 节目单独立窗口（可拖到屏幕任意位置、默认置顶）
import EpgWinPage from './pages/EpgWinPage';
import type { Episode } from '../shared/types';

/**
 * ★ 2026-10-08（用户要求「详情页独立窗口」）：详情窗口与主窗口共享同一份 localStorage 的 uiMem，
 *   若整份写盘会把主窗口已清掉的状态复活（与播放器窗口同款问题，见 PlayerPage 顶部那段）。
 *   这里在**模块求值期**声明：本窗口只写历史与进度（任何页面挂载前的第一件事）。
 */
if (isDetailWindow() || isSearchWindow()) markHistoryOnlyWriter();

const NAV = [
  // ★ 2026-09-24（用户定稿）：**发现放第一位，且打开软件默认进发现页**；「点播」= 源主页，移到 /home
  { to: '/', label: '发现', ico: '🧭', end: true },
  { to: '/home', label: '点播', ico: '▶' },
  { to: '/history', label: '历史', ico: '🕘' },
  { to: '/live', label: '直播', ico: '📡' },
  // ★ 2026-09-29（WebDAV 存储）：把自建 OpenList/AList/Nextcloud 等当媒体库浏览播放
  { to: '/storage', label: '存储', ico: '🗄' },
  { to: '/config', label: '配置', ico: '⚙' },
  // 说明页（详细免责声明 + GitHub / 支持作者入口）
  { to: '/about', label: '说明', ico: 'ℹ' },
];

/**
 * ★ 2026-09-29：Apple 皮肤侧边栏图标 —— SF Symbols 风格**单色线性 SVG**（16px / 1.6 描边）。
 * 不使用 emoji（emoji 会破坏 macOS 侧边栏观感）；其余皮肤仍用 NAV 里的 emoji。
 */
const AP_ICONS: Record<string, React.ReactNode> = {
  '/': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.6 7.1 8 2.8l5.4 4.3v5.2a.9.9 0 0 1-.9.9H3.5a.9.9 0 0 1-.9-.9V7.1Z" />
    </svg>
  ),
  '/home': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.9" y="3.3" width="12.2" height="9.4" rx="2.3" />
      <path d="M6.7 6.2v3.6l3.2-1.8-3.2-1.8Z" fill="currentColor" stroke="none" />
    </svg>
  ),
  '/history': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5.1V8l2.1 1.4" />
    </svg>
  ),
  '/live': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="10.6" r="1.5" fill="currentColor" stroke="none" />
      <path d="M5.1 8.1a4.3 4.3 0 0 1 5.8 0M3 5.9a7.1 7.1 0 0 1 10 0" />
    </svg>
  ),
  '/config': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.9v1.5M8 12.6v1.5M1.9 8h1.5M12.6 8h1.5M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1" />
    </svg>
  ),
  '/storage': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.1" y="3.4" width="11.8" height="9.2" rx="2.2" />
      <path d="M2.1 9.6h11.8" />
      <path d="M5.1 11.8h1.6" />
    </svg>
  ),
  '/about': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 7.3v3.4M8 5.2h.01" />
    </svg>
  ),
};

/** Apple 皮肤侧边栏的**分组**（HIG：侧边栏最多两级、分组标签要简短） */
const AP_GROUPS: { label: string; items: typeof NAV }[] = [
  { label: '媒体', items: NAV.filter((n) => ['/', '/home', '/history', '/live', '/storage'].includes(n.to)) },
  { label: '其他', items: NAV.filter((n) => ['/config', '/about'].includes(n.to)) },
];

function PageShell() {
  const loc = useLocation();
  return (
    <div className="page-anim" key={loc.pathname}>
      <PageErrorBoundary><Outlet /></PageErrorBoundary>
    </div>
  );
}

export default function App() {
  return (
    <UpdateGate>
      <AppShell />
    </UpdateGate>
  );
}

function AppShell() {
  const nav = useNavigate();
  const loc = useLocation();
  const theme = useTheme();
  const douban = theme === 'douban';
  const apple = theme === 'apple';
  const showDiscover = useShowDiscover();
  const navItems = showDiscover ? NAV : NAV.filter((n) => n.to !== '/');
  const apGroups = AP_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((n) => showDiscover || n.to !== '/') }))
    .filter((g) => g.items.length > 0);
  const backHome = showDiscover ? '/' : '/home';

  /**
   * ★ 2026-10-14（用户要求）：导航点击 → **独立新窗口**（多开），不影响当前窗口。
   *
   * ★★ 2026-10-14 修正（用户报「直播时点播，直播被干掉」）★★
   *   上一版用 IS_CHILD_WINDOW + sessionStorage 判定「主窗口/子窗口」——
   *   Electron 多窗口环境下 sessionStorage 疑似共享，导致主窗口被误判为子窗口
   *   → handleNavClick 直接 return → NavLink 走默认行为 → **当前窗口路由被切换**
   *   （表现就是：直播时点「点播」，直播被替换成 /home）。
   *
   *   现改为**所有窗口行为一致**：
   *     · 点导航 → 主进程按路由去重（同路由已开则聚焦，未开则新建独立窗口）
   *     · 当前窗口**始终不动**（直播继续播放）
   *     · 当前路由 == 目标路由 → 忽略（避免无意义的聚焦）
   */
  const handleNavClick = (e: React.MouseEvent, route: string) => {
    e.preventDefault();
    if (loc.pathname === route) return;
    void ipcInvoke('win:openRouteWindow', route).catch(() => undefined);
  };

  /**
   * ★ 2026-10-14：每次路由变化上报给主进程 —— 主进程据此维护「路由 → 窗口」注册表，
   *   使 openRouteWindow 能正确去重（同一顶层路由不重复开窗）。
   *   非顶层路由（/detail/:key/:id、/player 等）主进程会忽略。
   */
  useEffect(() => {
    void ipcInvoke('win:notifyRouteChange', loc.pathname).catch(() => undefined);
  }, [loc.pathname]);

  useEffect(() => {
    if (!showDiscover && loc.pathname === '/') nav('/home', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDiscover, loc.pathname]);
  const [appIcon, setAppIcon] = useState('');
  useEffect(() => {
    if (!apple && !douban) return;
    client.appIcon().then((d) => { if (d) setAppIcon(d); }).catch(() => undefined);
  }, [apple, douban]);
  /** 工具栏标题（= 当前页面名，macOS 统一工具栏的居中标题位） */
  const pageTitle =
    loc.pathname === '/' ? '发现'
      : loc.pathname.startsWith('/home') ? '点播'
        : loc.pathname.startsWith('/search') ? '全源搜索'
          : loc.pathname.startsWith('/detail') ? '影片详情'
            : loc.pathname.startsWith('/history') ? '观看历史'
              : loc.pathname.startsWith('/live') ? '直播'
                : loc.pathname.startsWith('/config') ? '配置'
                  : loc.pathname.startsWith('/about') ? '说明'
                    : 'Win-Box';
  const goBack = (): void => {
    if (window.history.length > 1) nav(-1);
    else if (isDetailWindow() || isSearchWindow()) void client.winClose();
    else nav(backHome, { replace: true });
  };
  const [disclaim, setDisclaim] = useState(() => {
    try {
      return localStorage.getItem('winbox-disclaim-agreed') !== '1';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (typing) return;
      const altLeft = e.altKey && e.key === 'ArrowLeft';
      const backspace = e.key === 'Backspace';
      if ((altLeft || backspace) && loc.pathname !== backHome) {
        e.preventDefault();
        goBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);

  useEffect(() => {
    loadUiMemory();
    const flush = () => saveUiMemory();
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
      else if (!isPlayerWin) {
        loadUiMemory();
      }
    });
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      saveUiMemory();
    };
  }, []);

  useEffect(() => {
    if (loc.pathname === '/player') return;
    return client.onNavDriveBind(() => {
      nav('/home');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);

  const isPlayerWin = loc.pathname === '/player';

  useEffect(() => {
    if (!isDetailWindow() && !isSearchWindow()) return;
    const off = client.winOnNavigate((route) => nav(route));
    const timer = window.setTimeout(() => { void client.winRouteReady().catch(() => undefined); }, 0);
    return () => { window.clearTimeout(timer); off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isPlayerWin) return;
    const onFocus = () => {
      loadUiMemory();
      window.dispatchEvent(new Event('winbox:history-refresh'));
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [isPlayerWin]);

  const agreeDisclaim = () => {
    try {
      localStorage.setItem('winbox-disclaim-agreed', '1');
    } catch {
      /* ignore */
    }
    setDisclaim(false);
    if (!isPlayerWin && !isDetailWindow() && !isSearchWindow()) nav('/about', { replace: true });
  };

  const DisclaimerModal = (
    <div
      className="modal-scrim"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(4px)',
      }}
    >
      <div
        className="card modal-in"
        style={{
          width: 520, maxWidth: '92vw', maxHeight: '80vh', overflow: 'auto', padding: 22,
          background: 'var(--bg)', boxShadow: '0 18px 60px rgba(0,0,0,.5)',
        }}
      >
        <h3 style={{ margin: '0 0 6px' }}>Win-Box 使用声明</h3>
        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>请在使用前阅读以下内容：</div>
        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
          <p style={{ margin: '0 0 8px' }}>
            Win-Box 是一个<b>开源（Open Source）学习项目</b>，本质上仅为一个通用的影片播放工具。
          </p>
          <p style={{ margin: '0 0 8px' }}>
            本项目<b>不含任何盈利行为</b>，不提供服务、不存储、不推送任何影视资源与内容，主要用途是个人学习研究，尤其是「Vibe Coding」编程体验。
          </p>
          <p style={{ margin: 0 }}>
            你在使用过程中自行配置/导入的播放源与资源均来自<b>第三方</b>，与本软件及作者无关。
            因使用第三方来源所引发的一切后果（含版权、侵权、内容合法性）由用户与第三方自行承担，作者免责。
          </p>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          <button style={{ flex: 0 }} onClick={() => void client.appQuit()}>拒绝</button>
          <button className="primary" style={{ flex: 0 }} onClick={agreeDisclaim}>同意</button>
        </div>
      </div>
    </div>
  );

  const onDetailPlay = (
    _url: string,
    name: string,
    fromKey: string,
    id: string,
    meta?: {
      pic?: string;
      remarks?: string;
      sourceName?: string;
      title?: string;
      vodId?: string;
      episodes?: Episode[];
      epIndex?: number;
      flag?: string;
      profileId?: string;
    },
  ) => {
    const eps = meta?.episodes || [];
    const idx = Math.max(0, Math.min(meta?.epIndex ?? 0, eps.length - 1));
    const target = eps[idx];
    const base = (meta?.title?.trim() || name.split(' - ')[0] || '').trim();
    const openBuiltin = async (): Promise<void> => {
      try {
        const switched = await client.playerSwitchEp({
          key: fromKey,
          vodId: meta?.vodId || id,
          flag: meta?.flag || '',
          episodes: eps,
          epIndex: idx,
          profileId: meta?.profileId,
        });
        if (switched) return;
      } catch {
        /* ignore */
      }
      await client.playerOpen({
        key: fromKey,
        flag: meta?.flag || '',
        episodes: eps,
        epIndex: idx,
        title: base,
        subtitleTitle: base,
        lastUrl: _url,
        lastName: target ? `${base} - ${target.name}` : name,
        meta: {
          pic: meta?.pic,
          remarks: meta?.remarks,
          sourceName: meta?.sourceName,
          profileId: meta?.profileId,
          vodId: meta?.vodId,
          fromKey,
          id,
        },
      });
    };
    const rawUrl = target?.url || _url;
    void playVodExternal({
      key: fromKey,
      flag: meta?.flag || '',
      rawUrl,
      display: target ? `${base} - ${target.name}` : name,
      pic: meta?.pic,
      remarks: meta?.remarks,
      sourceName: meta?.sourceName,
      profileId: meta?.profileId,
      vodId: meta?.vodId,
      seek: sameEpProgress(fromKey, meta?.vodId, rawUrl, meta?.profileId),
    }).then((out) => {
      if (!out.played) void openBuiltin();
    });
  };

  const openDetail = (k: string, id: string, pic?: string, name?: string) => {
    const qs = new URLSearchParams();
    if (pic) qs.set('pic', pic);
    if (name) qs.set('name', name);
    void openDetailRoute((to) => nav(to), k, id, qs.toString());
  };

  if (isPlayerWin) {
    return (
      <div className="app pwin pvwin">
        {disclaim && DisclaimerModal}
        <main className="main">
          <Routes>
            <Route path="/player" element={<PlayerPage />} />
          </Routes>
        </main>
      </div>
    );
  }

  /**
   * 路由表 —— Apple / 豆风 / 经典外壳共用。
   * ★ 2026-10-14：新增 `/epg-window` 路由（EPG 独立窗口专用页面）。
   */
  const routesNode = (
    <Routes>
      <Route element={<PageShell />}>
        <Route path="/" element={<DiscoverPage />} />
        <Route path="/home" element={<HomePage onOpenDetail={openDetail} />} />
        <Route path="/search" element={<HomePage onOpenDetail={openDetail} />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/detail/:key/:id" element={<DetailPage onPlay={onDetailPlay} />} />
        <Route path="/live" element={<LivePage />} />
        <Route path="/storage" element={<StoragePage />} />
        <Route path="/config" element={<ConfigPage />} />
        <Route path="/about" element={<AboutPage />} />
        {/* ★ 2026-10-14（用户要求）：EPG 独立窗口页面（可拖到屏幕任意位置、默认置顶） */}
        <Route path="/epg-window" element={<EpgWinPage />} />
      </Route>
    </Routes>
  );

  // 详情 / 搜索窗口：极简外壳（无侧栏），但路由仍共享
  if (isDetailWindow() || isSearchWindow()) {
    return (
      <div className="app pwin">
        {disclaim && DisclaimerModal}
        <main className="main">
          <TitleBar title={isSearchWindow() ? '搜索结果' : '影片详情'} />
          {routesNode}
        </main>
      </div>
    );
  }

  /**
   * ★ 2026-10-14：EPG 独立窗口 —— 极简外壳（无导航、无侧栏），
   *   页面自身渲染标题栏（含拖动 / 📌 置顶 / × 关闭）。
   */
  if (loc.pathname === '/epg-window') {
    return (
      <div className="app pwin">
        <main className="main">
          <Routes>
            <Route path="/epg-window" element={<EpgWinPage />} />
          </Routes>
        </main>
      </div>
    );
  }

  if (apple) {
    return (
      <div className="app ap-app">
        {disclaim && DisclaimerModal}
        <header className="ap-toolbar">
          <TitleBar variant="mac" />
          <button className="ap-navbtn" title="返回" aria-label="返回" disabled={loc.pathname === '/'} onClick={goBack}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9.8 3.4 5.2 8l4.6 4.6" />
            </svg>
          </button>
          <span className="ap-toolbar-title">{pageTitle}</span>
          <span className="ap-spacer" />
          <SearchPanel />
          <SourcePicker />
        </header>
        <div className="ap-body">
          <aside className="ap-sidebar">
            <div className="ap-brand" title="Win-Box">
              {appIcon ? <img className="ap-brand-ico" src={appIcon} alt="" draggable={false} /> : <span className="ap-brand-dot" />}
              <span className="ap-brand-name">Win-Box</span>
            </div>
            {apGroups.map((g) => (
              <div key={g.label} className="ap-group">
                <div className="ap-group-label">{g.label}</div>
                {g.items.map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.end}
                    className={({ isActive }) => 'ap-nav' + (isActive ? ' active' : '')}
                    onClick={(e) => handleNavClick(e, n.to)}
                  >
                    <span className="ap-nav-ico">{AP_ICONS[n.to]}</span>
                    <span className="ap-nav-txt">{n.label}</span>
                  </NavLink>
                ))}
              </div>
            ))}
            <div className="ap-side-spacer" />
            <SourcePicker variant="sidebar" />
          </aside>
          <main className="ap-main">{routesNode}</main>
        </div>
      </div>
    );
  }

  if (douban) {
    return (
      <div className="app db-app">
        {disclaim && DisclaimerModal}
        <header className="db-head">
          <div className="db-topbar">
            <span className="db-brand" title="Win-Box">
              {appIcon ? <img className="db-brand-ico" src={appIcon} alt="" draggable={false} /> : <span className="db-brand-dot" />}
              WIN-BOX
            </span>
            <span className="db-title">{pageTitle}</span>
            <SearchPanel bar />
            <span className="db-spacer" />
            <SourcePicker />
            <TitleBar />
          </div>
          <nav className="db-nav">
            {navItems.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) => 'db-chip' + (isActive ? ' active' : '')}
                onClick={(e) => handleNavClick(e, n.to)}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        </header>
        <main className="db-main">{routesNode}</main>
      </div>
    );
  }

  return (
    <div className={`app nf ${theme}`.trim()}>
      {disclaim && DisclaimerModal}
      <main className="main">
        <nav className="nf-nav">
          <span className="nf-logo">WIN-BOX</span>
          {navItems.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => 'nf-link' + (isActive ? ' active' : '')}
              onClick={(e) => handleNavClick(e, n.to)}
            >
              {n.label}
            </NavLink>
          ))}
          <span className="nf-spacer" />
          <SearchPanel />
          <SourcePicker />
          <TitleBar />
        </nav>
        {routesNode}
      </main>
    </div>
  );
}
