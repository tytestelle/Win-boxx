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
    const wd = ['日', '一', '二', '三',
