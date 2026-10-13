// src/renderer/pages/LivePage.tsx
import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { client } from '../api/client';
import { ipcInvoke } from '../api/ipc';
import type {
  LiveGroup,
  LiveBean,
  LiveEpgEntry,
  EpgChannelRef,
  LiveSubscription,
  LiveSubscriptionRefreshResult,
} from '../../shared/types';
import { splitLine } from '../../engine/live/LiveUtils';

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
      controls
      style={{ width: '100%', height: '100%', background: '#000', display: 'block' }}
    />
  );
}

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

  // 订阅源状态（仅用于顶栏展示与"刷新订阅"按钮）
  const [subCount, setSubCount] = useState(0);
  const [subEnabled, setSubEnabled] = useState(0);
  const [subRefreshing, setSubRefreshing] = useState(false);
  const [subMsg, setSubMsg] = useState('');

  const [programsOpen, setProgramsOpen] = useState(false);
  const [programsLoading, setProgramsLoading] = useState(false);
  const [programsList, setProgramsList] = useState<EpgProgramItem[]>([]);
  const [programsChannel, setProgramsChannel] = useState('');
  const [programsDate, setProgramsDate] = useState('');
  const programsScrollRef = useRef<HTMLDivElement>(null);

  const [reconnectKey, setReconnectKey] = useState(0);
  const [reconnectMsg, setReconnectMsg] = useState('');
  const reconnectCountRef = useRef(0);
  const lastReconnectAtRef = useRef(0);
  const MAX_RECONNECT = 50;

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

  // ====== 重新加载 lives（顶部下拉） ======
  const reloadLives = useCallback(async () => {
    try {
      const cfg = await client.cfgGet();
      const m = await client.liveMeta();
      setLives(m);
      // 保持当前选中索引（若超界则归零）
      const idx = liveIdx < m.length ? liveIdx : 0;
      setLiveIdx(idx);
      if (m.length && idx !== liveIdx) {
        await loadLiveInternal(idx, m);
      }
    } catch (e) {
      console.warn('[Live] reload lives 失败：', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIdx]);

  // ====== 加载某个线路 ======
  async function loadLiveInternal(index: number, meta?: LiveBean[]) {
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
          pickChannelInternal(group, ch.name, fromMem ? (mem.lineIdx || 0) : 0, r.groups, index);
        }
      } else {
        setGroups([]);
        setGroupName('');
        setChannelName('');
        setPlayUrl('');
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function pickLive(index: number, meta?: LiveBean[]) {
    const m = meta ?? lives;
    if (!m.length) return;
    setLiveIdx(index);
    client.cfgSetActiveLive(index).catch(() => undefined);
    void loadLiveInternal(index, m);
  }

  function pickChannelInternal(g: LiveGroup, name: string, li: number, all = groups, idx = liveIdx) {
    setGroupName(g.group);
    setChannelName(name);
    setLineIdx(li);
    saveLiveMem({ liveIdx: idx, groupName: g.group, channelName: name, lineIdx: li });
    const ch = g.channels.find((c) => c.name === name);
    if (ch && ch.urls.length) {
      const line = splitLine(ch.urls[li] || ch.urls[0], li + 1);
      setPlayUrl(line.url);
    }
    if (all !== groups) setGroups(all);
  }
  const pickChannel = pickChannelInternal;

  // ====== 订阅源状态 ======
  const loadSubStatus = useCallback(async () => {
    try {
      const list = await ipcInvoke<LiveSubscription[]>('live:subscription:list');
      const arr = Array.isArray(list) ? list : [];
      setSubCount(arr.length);
      setSubEnabled(arr.filter((s) => s.enabled).length);
    } catch { /* ignore */ }
  }, []);

  const refreshSubs = useCallback(async () => {
    setSubRefreshing(true);
    setSubMsg('正在重新下载订阅源…');
    try {
      const results = await ipcInvoke<LiveSubscriptionRefreshResult[]>('live:subscription:refreshAll');
      let ok = 0, fail = 0;
      for (const r of results || []) {
        if (r.ok) ok++;
        else if (r.error !== '已停用') fail++;
      }
      setSubMsg(`订阅刷新：成功 ${ok} / 失败 ${fail}`);
      await loadSubStatus();
      await reloadLives();
    } catch (e) {
      setSubMsg(`刷新失败：${(e as Error).message}`);
    } finally {
      setSubRefreshing(false);
      window.setTimeout(() => setSubMsg(''), 5000);
    }
  }, [loadSubStatus, reloadLives]);

  // ====== 初始化 ======
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
          await loadLiveInternal(start, m);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    void loadSubStatus();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监听配置页广播 → 重新拉 lives
  useEffect(() => {
    const handler = () => {
      void loadSubStatus();
      void reloadLives();
    };
    window.addEventListener('winbox:live-subscriptions-changed', handler);
    return () => window.removeEventListener('winbox:live-subscriptions-changed', handler);
  }, [loadSubStatus, reloadLives]);

  // ====== EPG / 节目单（与原版一致） ======
  const curGroup = groups.find((g) => g.group === groupName);
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
      const raw = await client.epgPrograms(keys);
      const list: EpgProgramItem[] = ((raw as any[]) || [])
        .map((p: any) => ({
          title: String(p?.title || ''),
          description: String(p?.description || ''),
          start: toDate(p?.start),
          stop: toDate(p?.stop),
        }))
        .sort((a, b) => a.start.getTime() - b.start.getTime());
      setProgramsList(list);
      const today = dayKey(new Date());
      if (list.some((p) => dayKey(p.start) === today)) setProgramsDate(today);
      else if (list.length) setProgramsDate(dayKey(list[0].start));
      else setProgramsDate(today);
    } catch (e) {
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

        <button
          type="button"
          onClick={() => void refreshSubs()}
          disabled={subRefreshing}
          title="重新下载全部启用的订阅源到本地并更新直播线路"
          style={{
            marginLeft: 8,
            padding: '4px 12px',
            borderRadius: 6,
            border: '1px solid #4ec9ff',
            background: 'rgba(78,201,255,0.12)',
            color: '#4ec9ff',
            cursor: subRefreshing ? 'not-allowed' : 'pointer',
            fontSize: 12,
            lineHeight: '20px',
            whiteSpace: 'nowrap',
            opacity: subRefreshing ? 0.6 : 1,
          }}
        >
          {subRefreshing ? '刷新订阅中…' : '刷新订阅'}
        </button>

        {subMsg && (
          <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.75 }}>{subMsg}</span>
        )}

        <span className="status" style={{ marginLeft: 'auto' }}>
          {loading ? '加载中…' : `${groups.length} 组`}
        </span>
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
          订阅 {subEnabled}/{subCount}
        </span>
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
          EPG：{epgStatusText}
        </span>
      </div>

      <div className="layout-2 content" style={{ padding: 12 }}>
        <div className="left">
          {groups.map((g) => (
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
                <div className="live-epg" onClick={() => openPrograms(curChannel)} style={{ cursor: 'pointer' }} title="点击查看完整节目单">
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
                  {reconnectMsg && (
                    <div
                      style={{
                        position: 'absolute', top: 12, left: 12,
                        padding: '6px 12px', borderRadius: 6,
                        background: 'rgba(0,0,0,0.7)', color: '#ffb74d', fontSize: 13,
                        pointerEvents: 'none', zIndex: 20,
                      }}
                    >{reconnectMsg}</div>
                  )}
                </div>
              ) : (
                <div className="empty">无播放地址</div>
              )}
            </>
          ) : (
            <div className="empty">{groups.length ? '选择左侧分组' : '无直播（请先导入含 lives 的配置）'}</div>
          )}
        </div>
      </div>

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
