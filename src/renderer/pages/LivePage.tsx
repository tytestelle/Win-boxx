// src/renderer/pages/LivePage.tsx
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import Hls from 'hls.js';
import { client } from '../api/client';
import type {
  LiveGroup,
  LiveBean,
  LiveEpgEntry,
  EpgChannelRef,
  LiveSubscription,
  LiveSubscriptionRefreshResult,
} from '../../shared/types';
import { splitLine } from '../../engine/live/LiveUtils';

// =========================================================================
// IPC 桥（兼容常见 preload 暴露方式）
// =========================================================================
function ipcInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const w = window as any;
  const bridge =
    (w?.electron?.ipcRenderer?.invoke && w.electron.ipcRenderer.invoke.bind(w.electron.ipcRenderer)) ||
    (w?.api?.invoke && w.api.invoke.bind(w.api)) ||
    (w?.electronAPI?.invoke && w.electronAPI.invoke.bind(w.electronAPI)) ||
    (w?.ipcRenderer?.invoke && w.ipcRenderer.invoke.bind(w.ipcRenderer));
  if (!bridge) {
    return Promise.reject(
      new Error(`IPC 桥不可用：无法调用 ${channel}（请在 preload 中通过 contextBridge 暴露 ipcRenderer.invoke）`),
    );
  }
  return bridge(channel, ...args) as Promise<T>;
}

// ---- 频道选择记忆 ----
const LIVE_MEM_KEY = 'winbox-live-mem';
interface LiveMem { liveIdx?: number; groupName?: string; channelName?: string; lineIdx?: number }
function loadLiveMem(): LiveMem {
  try { return JSON.parse(localStorage.getItem(LIVE_MEM_KEY) || '{}') as LiveMem; } catch { return {}; }
}
function saveLiveMem(m: LiveMem): void {
  try { localStorage.setItem(LIVE_MEM_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

type EpgStatus = 'idle' | 'loading' | 'ok' | 'empty' | 'error';

interface EpgProgramItem {
  title: string;
  description: string;
  start: Date;
  stop: Date;
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toDate(v: unknown): Date {
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') return new Date(v);
  return new Date();
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// =========================================================================
// 流类型探测器
// =========================================================================
class StreamDetector {
  static async detect(url: string): Promise<'hls' | 'flv' | 'ts' | 'native' | 'unknown'> {
    const lower = url.toLowerCase();
    if (lower.includes('.m3u8')) return 'hls';
    if (lower.includes('.flv')) return 'flv';
    if (/\.ts(\?|#|$)/.test(lower)) return 'ts';
    if (/\.(mp4|mkv|mov|webm|m4v|avi)(\?|#|$)/.test(lower)) return 'native';
    try {
      const res = await fetch(url, { method: 'HEAD', mode: 'cors' });
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('mpegurl') || ct.includes('m3u8')) return 'hls';
      if (ct.includes('flv')) return 'flv';
      if (ct.includes('mp2t') || ct.includes('mpegts')) return 'ts';
      if (ct.includes('video/') || ct.includes('audio/')) return 'native';
    } catch {
      try {
        const res = await fetch(url, { method: 'GET', mode: 'cors' });
        const text = await res.text();
        if (text.trim().startsWith('#EXTM3U')) return 'hls';
        if (text.includes('FLV')) return 'flv';
        return 'hls';
      } catch {
        return 'unknown';
      }
    }
    return 'hls';
  }
}

// =========================================================================
// 播放器组件（带原生控件 + 断线重连监听）
// =========================================================================
function LiveVideoPlayer({
  url,
  onReconnect,
  onVideoError,
}: {
  url: string;
  onReconnect: () => void;
  onVideoError: (msg: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<any>(null);
  const mpegtsRef = useRef<any>(null);
  const cbRef = useRef({ onReconnect, onVideoError });
  cbRef.current = { onReconnect, onVideoError };

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !url) return;

    let destroyed = false;
    const destroyHls = () => { if (hlsRef.current) { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; } };
    const destroyMpegts = () => { if (mpegtsRef.current) { try { mpegtsRef.current.destroy(); } catch {} mpegtsRef.current = null; } };

    const safePlay = () => {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => undefined);
    };

    const playNative = () => {
      v.src = url;
      v.load();
      safePlay();
    };

    const playHls = (sourceUrl: string) => {
      if (!Hls.isSupported()) { playNative(); return; }
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 20,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 6,
        manifestLoadingRetryDelay: 500,
        levelLoadingTimeOut: 15000,
        fragLoadingTimeOut: 30000,
        xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = false; },
      });
      hlsRef.current = hls;
      hls.loadSource(sourceUrl);
      hls.attachMedia(v);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (destroyed) return;
        safePlay();
      });

      hls.on(Hls.Events.ERROR, (_evt: unknown, data: any) => {
        if (destroyed) return;
        if (!data?.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          cbRef.current.onVideoError('HLS 网络错误，尝试恢复…');
          try { hls.startLoad(); } catch {}
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          cbRef.current.onVideoError('HLS 解码错误，尝试恢复…');
          try { hls.recoverMediaError(); } catch {}
        } else {
          cbRef.current.onVideoError(`HLS 失败：${data.details || data.type}`);
          destroyHls();
          cbRef.current.onReconnect();
        }
      });
    };

    const playMpegts = async (type: 'flv' | 'mpegts', sourceUrl: string) => {
      try {
        // @ts-ignore 动态加载可选依赖
        const mod = await import(/* @vite-ignore */ 'mpegts.js').catch(() => null);
        const mpegts: any = (mod as any)?.default || (mod as any);
        if (!mpegts || typeof mpegts.isSupported !== 'function' || !mpegts.isSupported()) {
          playNative();
          return;
        }
        const player = mpegts.createPlayer(
          { type, url: sourceUrl, isLive: true },
          { enableWorker: true, enableStashBuffer: false, stashInitialSize: 128, lazyLoad: false },
        );
        mpegtsRef.current = player;
        player.attachMediaElement(v);
        player.load();
        try { player.play(); } catch {}
        player.on(mpegts.Events?.ERROR || 'error', (errType: unknown, errDetail: unknown) => {
          cbRef.current.onVideoError(`流错误：${errType}/${errDetail}`);
          cbRef.current.onReconnect();
        });
      } catch {
        playNative();
      }
    };

    (async () => {
      const kind = await StreamDetector.detect(url);
      if (destroyed) return;
      if (kind === 'hls') playHls(url);
      else if (kind === 'flv') void playMpegts('flv', url);
      else if (kind === 'ts') void playMpegts('mpegts', url);
      else if (kind === 'native') playNative();
      else playHls(url);
    })();

    const onEnded = () => cbRef.current.onReconnect();
    const onErr = () => {
      const err = v.error;
      const code = err?.code;
      const msg = code === 1 ? '用户中止' : code === 2 ? '网络错误' : code === 3 ? '解码错误' : code === 4 ? '源不支持' : `错误(${code ?? '?'})`;
      cbRef.current.onVideoError(msg);
      if (code === 2 || code === 4) cbRef.current.onReconnect();
    };
    const onPlaying = () => cbRef.current.onVideoError('');
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', onErr);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('play', onPlaying);

    return () => {
      destroyed = true;
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('error', onErr);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('play', onPlaying);
      destroyHls();
      destroyMpegts();
      try { v.removeAttribute('src'); v.load(); } catch {}
    };
  }, [url]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      controls  /* ← 开启浏览器原生控件（全屏、音量、暂停等） */
      style={{ width: '100%', height: '100%', background: '#000', display: 'block' }}
    />
  );
}

// =========================================================================
// 主组件
// =========================================================================
export default function LivePage() {
  const [lives, setLives] = useState<LiveBean[]>([]);
  const [liveIdx, setLiveIdx] = useState(0);
  const [groups, setGroups] = useState<LiveGroup[]>([]);
  const [groupName, setGroupName] = useState('');
  const [channelName, setChannelName] = useState('');
  const [lineIdx, setLineIdx] = useState(0);
  const [playUrl, setPlayUrl] = useState('');
  const [playbackUrl, setPlaybackUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [epg, setEpg] = useState<Record<string, LiveEpgEntry>>({});
  const [epgStatus, setEpgStatus] = useState<EpgStatus>('idle');
  const epgTimer = useRef<number | null>(null);

  // ---- 网络直播订阅源状态（★ 新增） ----
  const [subs, setSubs] = useState<LiveSubscription[]>([]);
  const [subGroups, setSubGroups] = useState<LiveGroup[]>([]);
  const [subLoading, setSubLoading] = useState(false);
  const [subMsg, setSubMsg] = useState('');
  const [subPanelOpen, setSubPanelOpen] = useState(false);
  const [subFormName, setSubFormName] = useState('');
  const [subFormUrl, setSubFormUrl] = useState('');

  // 完整节目单弹窗
  const [programsOpen, setProgramsOpen] = useState(false);
  const [programsLoading, setProgramsLoading] = useState(false);
  const [programsList, setProgramsList] = useState<EpgProgramItem[]>([]);
  const [programsChannel, setProgramsChannel] = useState('');
  const [programsDate, setProgramsDate] = useState('');
  const programsScrollRef = useRef<HTMLDivElement>(null);

  // 断线重连
  const [reconnectKey, setReconnectKey] = useState(0);
  const [reconnectMsg, setReconnectMsg] = useState('');
  const reconnectCountRef = useRef(0);
  const lastReconnectAtRef = useRef(0);
  const MAX_RECONNECT = 50;

  // 换频道 → 直接把原始 URL 交给内联播放器
  useEffect(() => {
    if (!playUrl) { setPlaybackUrl(''); return; }
    setPlaybackUrl(playUrl);
    reconnectCountRef.current = 0;
    lastReconnectAtRef.current = 0;
    setReconnectMsg('');
  }, [playUrl]);

  const doReconnect = useCallback(() => {
    const now = Date.now();
    if (now - lastReconnectAtRef.current < 3000) return;
    lastReconnectAtRef.current = now;
    reconnectCountRef.current += 1;
    const n = reconnectCountRef.current;
    if (n > MAX_RECONNECT) {
      setReconnectMsg(`已连续重连 ${MAX_RECONNECT} 次仍失败，请切换线路`);
      return;
    }
    setReconnectMsg(`断线重连中…（第 ${n} 次）`);
    setReconnectKey((k) => k + 1);
    window.setTimeout(() => {
      setReconnectMsg((cur) => (cur.startsWith('断线重连中') ? '' : cur));
    }, 3000);
  }, []);

  const handleVideoError = useCallback((msg: string) => {
    if (msg) setReconnectMsg(msg);
  }, []);

  // ====== 订阅源：加载列表 ======
  const loadSubs = useCallback(async (): Promise<LiveSubscription[]> => {
    try {
      const list = await ipcInvoke<LiveSubscription[]>('live:subscription:list');
      const safe = Array.isArray(list) ? list : [];
      setSubs(safe);
      return safe;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[LiveSub] 加载订阅列表失败：', e);
      return [];
    }
  }, []);

  // ====== 订阅源：刷新全部（拉网络 → 解析 → 合并） ======
  const refreshSubs = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setSubLoading(true);
    setSubMsg('');
    try {
      const results = await ipcInvoke<LiveSubscriptionRefreshResult[]>('live:subscription:refreshAll');
      const merged: LiveGroup[] = [];
      let ok = 0, fail = 0;
      for (const r of results || []) {
        if (r.ok && r.groups && r.groups.length) {
          merged.push(...r.groups);
          ok++;
        } else if (!r.ok && r.error !== '已停用') {
          fail++;
        }
      }
      setSubGroups(merged);
      // 刷新 lastUpdated / lastError 的显示
      await loadSubs();
      if (ok || fail) setSubMsg(`订阅：成功 ${ok} / 失败 ${fail}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[LiveSub] 刷新订阅失败：', e);
      setSubMsg(`订阅刷新失败：${(e as Error)?.message || String(e)}`);
    } finally {
      if (!opts.silent) setSubLoading(false);
    }
  }, [loadSubs]);

  // ====== 挂载时：加载订阅列表 + 自动刷新（不阻塞首屏） ======
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await loadSubs();
      if (cancelled) return;
      if (list.some((s) => s.enabled)) {
        void refreshSubs({ silent: true });
      }
    })();
    return () => { cancelled = true; };
  }, [loadSubs, refreshSubs]);

  // ====== 合并：本地（客户端）直播 + 网络订阅源 ======
  const allGroups = useMemo<LiveGroup[]>(() => {
    const map = new Map<string, LiveGroup>();
    for (const g of groups) {
      map.set(g.group, { group: g.group, channels: [...g.channels] });
    }
    for (const g of subGroups) {
      const exist = map.get(g.group);
      if (exist) exist.channels.push(...g.channels);
      else map.set(g.group, { group: g.group, channels: [...g.channels] });
    }
    return [...map.values()];
  }, [groups, subGroups]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await client.cfgGet();
        const m = await client.liveMeta();
        if (cancelled) return;
        setLives(m);
        if (m.length) {
          const start = cfg.ui.activeLiveIndex < m.length ? cfg.ui.activeLiveIndex : 0;
          setLiveIdx(start);
          await loadLive(start, m);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickLive(index: number, meta?: LiveBean[]) {
    const m = meta ?? lives;
    if (!m.length) return;
    setLiveIdx(index);
    client.cfgSetActiveLive(index).catch(() => undefined);
    void loadLive(index, m);
  }

  async function loadLive(index: number, meta?: LiveBean[]) {
    const m = meta ?? lives;
    if (!m.length) return;
    setLoading(true);
    setErr('');
    try {
      const r = await client.loadLive(index);
      setGroups(r.groups);
      if (r.groups.length) {
        const mem = loadLiveMem();
        const fromMem = mem.liveIdx === index;
        const g = fromMem && mem.groupName ? r.groups.find((x) => x.group === mem.groupName) : undefined;
        const group = g || r.groups[0];
        setGroupName(group.group);
        const ch = fromMem && mem.channelName && group.channels.some((c) => c.name === mem.channelName)
          ? group.channels.find((c) => c.name === mem.channelName)!
          : group.channels[0];
        if (group.channels.length && ch) {
          pickChannel(group, ch.name, fromMem ? (mem.lineIdx || 0) : 0, r.groups);
        }
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function pickChannel(g: LiveGroup, name: string, li: number, all = groups) {
    setGroupName(g.group);
    setChannelName(name);
    setLineIdx(li);
    saveLiveMem({ liveIdx, groupName: g.group, channelName: name, lineIdx: li });
    const ch = g.channels.find((c) => c.name === name);
    if (ch && ch.urls.length) {
      const line = splitLine(ch.urls[li] || ch.urls[0], li + 1);
      setPlayUrl(line.url);
    }
    if (all !== groups) setGroups(all);
  }

  const curGroup = allGroups.find((g) => g.group === groupName);
  const curChannel = curGroup?.channels.find((c) => c.name === channelName);
  const curEpg = curChannel ? (epg[curChannel['tvg-id']] || epg[curChannel['tvg-name']] || epg[curChannel.name]) : undefined;
  const lines = curChannel ? curChannel.urls.map((u, i) => splitLine(u, i + 1)) : [];

  async function refreshEpg(index: number, gs: LiveGroup[]) {
    const refs: EpgChannelRef[] = gs
      .flatMap((g) => g.channels)
      .map((c) => ({ tvgId: c['tvg-id'], tvgName: c['tvg-name'], name: c.name, epg: c.epg }))
      .filter((r) => !!(r.tvgId || r.tvgName || r.name));
    if (!refs.length) { setEpg({}); setEpgStatus('empty'); return; }
    setEpgStatus('loading');
    try {
      const r = await client.liveEpg(index, refs);
      setEpg(r.byKey);
      setEpgStatus(Object.keys(r.byKey).length ? 'ok' : 'empty');
    } catch (e) {
      setEpg({});
      setEpgStatus('error');
      // eslint-disable-next-line no-console
      console.warn('[EPG] 加载失败：', e);
    }
  }

  useEffect(() => {
    if (!groups.length) return;
    void refreshEpg(liveIdx, groups);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIdx, groups]);

  useEffect(() => {
    if (epgTimer.current != null) { window.clearTimeout(epgTimer.current); epgTimer.current = null; }
    if (!curChannel) return;
    const e = epg[curChannel['tvg-id']] || epg[curChannel['tvg-name']] || epg[curChannel.name];
    const at = e?.current?.endTime ?? e?.next?.startTime;
    if (!at) return;
    const delay = Math.max(1000, Math.min(at - Date.now() + 1000, 6 * 3600 * 1000));
    epgTimer.current = window.setTimeout(() => { void refreshEpg(liveIdx, groups); }, delay);
    return () => {
      if (epgTimer.current != null) { window.clearTimeout(epgTimer.current); epgTimer.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epg, groupName, channelName, liveIdx]);

  async function openPrograms(channel: { name: string; 'tvg-id'?: string; 'tvg-name'?: string }) {
    const keys = [channel['tvg-id'], channel['tvg-name'], channel.name]
      .map((k) => (k || '').trim())
      .filter((k) => !!k);
    if (!keys.length) return;
    setProgramsChannel(channel.name);
    setProgramsOpen(true);
    setProgramsLoading(true);
    setProgramsList([]);
    try {
      // eslint-disable-next-line no-console
      console.info('[EPG] 弹窗查询 keys =', keys);
      const raw = await client.epgPrograms(keys);
      const list: EpgProgramItem[] = ((raw as any[]) || [])
        .map((p: any) => ({
          title: String(p?.title || ''),
          description: String(p?.description || ''),
          start: toDate(p?.start),
          stop: toDate(p?.stop),
        }))
        .sort((a, b) => a.start.getTime() - b.start.getTime());
      // eslint-disable-next-line no-console
      console.info(`[EPG] 弹窗返回 ${list.length} 条`);
      setProgramsList(list);
      const today = dayKey(new Date());
      if (list.some((p) => dayKey(p.start) === today)) setProgramsDate(today);
      else if (list.length) setProgramsDate(dayKey(list[0].start));
      else setProgramsDate(today);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[EPG] 拉取完整节目单失败', e);
    } finally {
      setProgramsLoading(false);
    }
  }

  function closePrograms() { setProgramsOpen(false); }

  useEffect(() => {
    if (!programsOpen || programsLoading) return;
    const el = programsScrollRef.current?.querySelector('[data-current="1"]') as HTMLElement | null;
    if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [programsOpen, programsLoading, programsList, programsDate]);

  useEffect(() => {
    if (!programsOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePrograms(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [programsOpen]);

  // ====== 订阅源管理：增 / 删 / 启停 ======
  async function onAddSub() {
    const name = subFormName.trim();
    const url = subFormUrl.trim();
    if (!name || !url) { window.alert('请填写「名称」与「订阅链接」'); return; }
    try {
      await ipcInvoke('live:subscription:add', name, url);
      setSubFormName('');
      setSubFormUrl('');
      await loadSubs();
      await refreshSubs({ silent: true });
    } catch (e) {
      window.alert(`添加失败：${(e as Error)?.message || String(e)}`);
    }
  }

  async function onRemoveSub(id: string, name: string) {
    if (!window.confirm(`确定删除订阅源「${name}」？`)) return;
    try {
      await ipcInvoke('live:subscription:remove', id);
      await loadSubs();
      await refreshSubs({ silent: true });
    } catch (e) {
      window.alert(`删除失败：${(e as Error)?.message || String(e)}`);
    }
  }

  async function onToggleSub(id: string, enabled: boolean) {
    try {
      await ipcInvoke('live:subscription:toggle', id, enabled);
      await loadSubs();
      await refreshSubs({ silent: true });
    } catch (e) {
      window.alert(`切换失败：${(e as Error)?.message || String(e)}`);
    }
  }

  const dateTabs = Array.from(new Set(programsList.map((p) => dayKey(p.start)))).sort();
  const dateList = programsDate ? programsList.filter((p) => dayKey(p.start) === programsDate) : programsList;
  const nowMs = Date.now();

  const epgStatusText =
    epgStatus === 'loading' ? '加载中…'
      : epgStatus === 'ok' ? `命中 ${Object.keys(epg).length} 键`
        : epgStatus === 'empty' ? '无节目单'
          : epgStatus === 'error' ? '失败（看日志）'
            : '未触发';

  function dateLabel(key: string): string {
    const [y, m, d] = key.split('-').map((s) => parseInt(s, 10));
    const date = new Date(y, m - 1, d);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tmr = new Date(today); tmr.setDate(tmr.getDate() + 1);
    const dat = new Date(today); dat.setDate(dat.getDate() + 2);
    if (date.getTime() === today.getTime()) return '今天';
    if (date.getTime() === tmr.getTime()) return '明天';
    if (date.getTime() === dat.getTime()) return '后天';
    const wd = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
    return `${m}-${d} 周${wd}`;
  }

  return (
    <>
      <div className="topbar">
        <select value={liveIdx} onChange={(e) => pickLive(Number(e.target.value))} disabled={loading}>
          {lives.map((l, i) => <option key={i} value={i}>{l.name}</option>)}
        </select>

        {/* ★ 订阅源按钮：全部使用内联样式，不依赖 .btn 等外部 class，保证一定可见 */}
        <button
          type="button"
          onClick={() => setSubPanelOpen(true)}
          title="管理网络直播订阅源（自定义名称 + 链接）"
          style={{
            marginLeft: 8,
            padding: '4px 14px',
            borderRadius: 6,
            border: '1px solid #4ec9ff',
            background: 'rgba(78,201,255,0.12)',
            color: '#4ec9ff',
            cursor: 'pointer',
            fontSize: 13,
            lineHeight: '20px',
            whiteSpace: 'nowrap',
            flex: '0 0 auto',
          }}
        >
          订阅源{subs.length ? ` (${subs.length})` : ''}
        </button>
        <button
          type="button"
          onClick={() => refreshSubs()}
          disabled={subLoading}
          title="立即联网刷新全部启用的订阅源"
          style={{
            marginLeft: 6,
            padding: '4px 14px',
            borderRadius: 6,
            border: '1px solid #3a4150',
            background: subLoading ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.08)',
            color: subLoading ? '#777' : '#e6e6e6',
            cursor: subLoading ? 'not-allowed' : 'pointer',
            fontSize: 13,
            lineHeight: '20px',
            whiteSpace: 'nowrap',
            flex: '0 0 auto',
          }}
        >
          {subLoading ? '刷新中…' : '刷新订阅'}
        </button>

        <span className="status" style={{ marginLeft: 'auto' }}>
          {loading ? '加载中…' : `${allGroups.length} 组`}
        </span>
        {subMsg && (
          <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.75 }}>
            {subMsg}
          </span>
        )}
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
          EPG：{epgStatusText}
        </span>
      </div>

      <div className="layout-2 content" style={{ padding: 12 }}>
        <div className="left">
          {allGroups.map((g) => (
            <div
              key={g.group}
              className={`nav-item ${g.group === groupName ? 'active' : ''}`}
              onClick={() => {
                setGroupName(g.group);
                if (g.channels.length) pickChannel(g, g.channels[0].name, 0, groups);
              }}
            >
              {g.group} <span className="muted">({g.channels.length})</span>
            </div>
          ))}
        </div>
        <div className="right">
          {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
          {curGroup ? (
            <>
              <div className="row" style={{ marginBottom: 10, maxHeight: 180, overflow: 'auto' }}>
                {curGroup.channels.map((c) => (
                  <span
                    key={c.name}
                    className={`tag ${c.name === channelName ? 'active' : ''}`}
                    onClick={() => pickChannel(curGroup, c.name, 0, groups)}
                    onDoubleClick={() => openPrograms(c)}
                    title="双击查看完整节目单"
                  >
                    {c.name}
                  </span>
                ))}
              </div>
              {lines.length > 1 && (
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className="muted">线路：</span>
                  {lines.map((l) => (
                    <span
                      key={l.index}
                      className={`tag ${l.index - 1 === lineIdx ? 'active' : ''}`}
                      onClick={() => {
                        setLineIdx(l.index - 1);
                        setPlayUrl(l.url);
                        saveLiveMem({ liveIdx, groupName, channelName, lineIdx: l.index - 1 });
                      }}
                    >
                      {l.name}
                    </span>
                  ))}
                </div>
              )}
              {curEpg && (curEpg.current || curEpg.next) && curChannel && (
                <div
                  className="live-epg"
                  onClick={() => openPrograms(curChannel)}
                  style={{ cursor: 'pointer' }}
                  title="点击查看完整节目单"
                >
                  {curEpg.current && (
                    <span className="live-epg-now">
                      <b>正在播</b> {curEpg.current.start}~{curEpg.current.end} {curEpg.current.title || '（无标题）'}
                    </span>
                  )}
                  {curEpg.next && (
                    <span className="muted">
                      <b>下一档</b> {curEpg.next.start} {curEpg.next.title || '（无标题）'}
                    </span>
                  )}
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>📺</span>
                </div>
              )}

              {playUrl ? (
                <div className="live-player" style={{ position: 'relative' }}>
                  {playbackUrl ? (
                    <LiveVideoPlayer
                      key={`${playbackUrl}__${reconnectKey}`}
                      url={playbackUrl}
                      onReconnect={doReconnect}
                      onVideoError={handleVideoError}
                    />
                  ) : (
                    <div className="empty" style={{ width: '100%', height: '100%' }}>加载中…</div>
                  )}

                  {/* 断线重连提示（左上角浮层，不可点击） */}
                  {reconnectMsg && (
                    <div
                      style={{
                        position: 'absolute', top: 12, left: 12,
                        padding: '6px 12px', borderRadius: 6,
                        background: 'rgba(0,0,0,0.7)', color: '#ffb74d', fontSize: 13,
                        pointerEvents: 'none', zIndex: 20,
                      }}
                    >
                      {reconnectMsg}
                    </div>
                  )}
                </div>
              ) : (
                <div className="empty">无播放地址</div>
              )}
            </>
          ) : (
            <div className="empty">{allGroups.length ? '选择左侧分组' : '无直播（请先导入含 lives 的配置）'}</div>
          )}
        </div>
      </div>

      {/* ★ 新增：订阅源管理弹窗 */}
      {subPanelOpen && (
        <div
          onClick={() => setSubPanelOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
            zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(760px, 92vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
              background: '#1a1d24', color: '#e6e6e6', borderRadius: 12,
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)', overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #2a2f3a' }}>
              <div style={{ fontSize: 16, fontWeight: 600 }}>网络直播订阅源</div>
              <button
                onClick={() => setSubPanelOpen(false)}
                style={{ background: 'transparent', border: 'none', color: '#aaa', fontSize: 20, cursor: 'pointer', padding: '0 4px' }}
                title="关闭"
              >×</button>
            </div>

            {/* 添加表单 */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #232833', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                value={subFormName}
                onChange={(e) => setSubFormName(e.target.value)}
                placeholder="自定义名称（如：我的央视源）"
                style={{ flex: '1 1 180px', minWidth: 140, padding: '6px 10px', borderRadius: 6, border: '1px solid #333944', background: '#0f1218', color: '#e6e6e6', fontSize: 13 }}
              />
              <input
                value={subFormUrl}
                onChange={(e) => setSubFormUrl(e.target.value)}
                placeholder="订阅链接（支持 .m3u / .m3u8 / .txt / .json）"
                style={{ flex: '2 1 320px', minWidth: 220, padding: '6px 10px', borderRadius: 6, border: '1px solid #333944', background: '#0f1218', color: '#e6e6e6', fontSize: 13 }}
              />
              <button
                onClick={onAddSub}
                style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid #4ec9ff', background: 'rgba(78,201,255,0.12)', color: '#4ec9ff', cursor: 'pointer', fontSize: 13 }}
              >添加</button>
            </div>

            {/* 列表 */}
            <div style={{ overflowY: 'auto', padding: '8px 12px 14px' }}>
              {subs.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: '#888' }}>
                  暂无订阅源。填写上方「名称 + 链接」后点「添加」即可。
                </div>
              ) : (
                subs.map((s) => (
                  <div
                    key={s.id}
                    style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 8px', borderBottom: '1px solid #232833' }}
                  >
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={(e) => onToggleSub(s.id, e.target.checked)}
                      title={s.enabled ? '已启用，点击停用' : '已停用，点击启用'}
                      style={{ flex: '0 0 auto' }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14 }}>
                        {s.name}
                        {!s.enabled && <span style={{ marginLeft: 8, fontSize: 11, color: '#888' }}>（已停用）</span>}
                      </div>
                      <div
                        style={{
                          fontSize: 12, color: '#8a9099',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                        title={s.url}
                      >
                        {s.url}
                      </div>
                      <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                        {s.lastUpdated
                          ? `更新于 ${new Date(s.lastUpdated).toLocaleString()}`
                          : '尚未更新'}
                        {s.lastError ? ` · 错误：${s.lastError}` : ''}
                      </div>
                    </div>
                    <button
                      onClick={() => onRemoveSub(s.id, s.name)}
                      style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #5a2a2a', background: 'rgba(255,90,90,0.12)', color: '#ff7676', cursor: 'pointer', fontSize: 12 }}
                    >删除</button>
                  </div>
                ))
              )}
            </div>

            {/* 底部操作 */}
            <div style={{ padding: '10px 16px', borderTop: '1px solid #232833', display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => refreshSubs()}
                disabled={subLoading}
                style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #4ec9ff', background: 'rgba(78,201,255,0.12)', color: '#4ec9ff', cursor: 'pointer', fontSize: 13 }}
              >
                {subLoading ? '刷新中…' : '立即刷新全部'}
              </button>
              {subMsg && <span style={{ fontSize: 12, color: '#8a9099' }}>{subMsg}</span>}
            </div>
          </div>
        </div>
      )}

      {/* 完整节目单弹窗（保持原样） */}
      {programsOpen && (
        <div
          onClick={closePrograms}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
            zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(720px, 92vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
              background: '#1a1d24', color: '#e6e6e6', borderRadius: 12,
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)', overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #2a2f3a' }}>
              <div style={{ fontSize: 16, fontWeight: 600 }}>
                节目单 · <span style={{ color: '#4ec9ff' }}>{programsChannel || '-'}</span>
              </div>
              <button
                onClick={closePrograms}
                style={{ background: 'transparent', border: 'none', color: '#aaa', fontSize: 20, cursor: 'pointer', padding: '0 4px' }}
                title="关闭 (Esc)"
              >×</button>
            </div>

            {dateTabs.length > 0 && (
              <div style={{ display: 'flex', gap: 6, padding: '10px 16px 0', flexWrap: 'wrap' }}>
                {dateTabs.map((d) => (
                  <button
                    key={d}
                    onClick={() => setProgramsDate(d)}
                    style={{
                      padding: '5px 12px', borderRadius: 16, fontSize: 13, cursor: 'pointer',
                      border: '1px solid ' + (d === programsDate ? '#4ec9ff' : '#333944'),
                      background: d === programsDate ? 'rgba(78,201,255,0.15)' : 'transparent',
                      color: d === programsDate ? '#4ec9ff' : '#ccc',
                    }}
                  >{dateLabel(d)}</button>
                ))}
              </div>
            )}

            <div ref={programsScrollRef} style={{ overflowY: 'auto', padding: '10px 8px 14px' }}>
              {programsLoading ? (
                <div style={{ padding: 32, textAlign: 'center', color: '#888' }}>加载中…</div>
              ) : dateList.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: '#888' }}>这一天暂无节目单</div>
              ) : (
                dateList.map((p, i) => {
                  const isCurrent = nowMs >= p.start.getTime() && nowMs < p.stop.getTime();
                  const isPast = nowMs >= p.stop.getTime();
                  return (
                    <div
                      key={i}
                      data-current={isCurrent ? '1' : '0'}
                      style={{
                        display: 'flex', gap: 12, padding: '10px 12px', borderRadius: 8,
                        background: isCurrent ? 'rgba(78,201,255,0.12)' : 'transparent',
                        borderLeft: isCurrent ? '3px solid #4ec9ff' : '3px solid transparent',
                        opacity: isPast ? 0.5 : 1,
                      }}
                    >
                      <div style={{ minWidth: 100, color: isCurrent ? '#4ec9ff' : '#9aa0a6', fontSize: 13, paddingTop: 2 }}>
                        {hhmm(p.start)} - {hhmm(p.stop)}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: isCurrent ? 600 : 400 }}>
                          {p.title || '（无标题）'}
                          {isCurrent && (
                            <span style={{
                              marginLeft: 8, fontSize: 11, padding: '1px 6px',
                              borderRadius: 4, background: '#4ec9ff', color: '#0b1016',
                            }}>正在播</span>
                          )}
                        </div>
                        {p.description && (
                          <div style={{ fontSize: 12, color: '#8a9099', marginTop: 4, lineHeight: 1.5 }}>
                            {p.description}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
