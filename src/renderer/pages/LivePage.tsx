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
} from '../../shared/types';
import { splitLine } from '../../engine/live/LiveUtils';

const LIVE_MEM_KEY = 'winbox-live-mem';
interface LiveMem { liveIdx?: number; groupName?: string; channelName?: string; lineIdx?: number }
function loadLiveMem(): LiveMem {
  try { return JSON.parse(localStorage.getItem(LIVE_MEM_KEY) || '{}') as LiveMem; } catch { return {}; }
}
function saveLiveMem(m: LiveMem): void {
  try { localStorage.setItem(LIVE_MEM_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

type EpgStatus = 'idle' | 'loading' | 'ok' | 'empty' | 'error';

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
          cbRef.current.onVideoError('HLS network error, retrying...');
          try { hls.startLoad(); } catch {}
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          cbRef.current.onVideoError('HLS media error, recovering...');
          try { hls.recoverMediaError(); } catch {}
        } else {
          cbRef.current.onVideoError(`HLS failed: ${data.details || data.type}`);
          destroyHls();
          cbRef.current.onReconnect();
        }
      });
    };

    const playMpegts = async (type: 'flv' | 'mpegts', sourceUrl: string) => {
      try {
        // @ts-ignore optional dep loaded dynamically
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
          cbRef.current.onVideoError(`stream error: ${errType}/${errDetail}`);
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
      const msg = code === 1 ? 'aborted' : code === 2 ? 'network error' : code === 3 ? 'decode error' : code === 4 ? 'unsupported source' : `error(${code ?? '?'})`;
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

  const [subCount, setSubCount] = useState(0);
  const [subEnabled, setSubEnabled] = useState(0);

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
      setReconnectMsg(`already reconnected ${MAX_RECONNECT} times, still failing, switch line`);
      return;
    }
    setReconnectMsg(`reconnecting... (${n})`);
    setReconnectKey((k) => k + 1);
    window.setTimeout(() => {
      setReconnectMsg((cur) => (cur.startsWith('reconnecting') ? '' : cur));
    }, 3000);
  }, []);

  const handleVideoError = useCallback((msg: string) => {
    if (msg) setReconnectMsg(msg);
  }, []);

  const reloadLives = useCallback(async () => {
    try {
      const cfg = await client.cfgGet();
      const m = await client.liveMeta();
      setLives(m);
      const idx = liveIdx < m.length ? liveIdx : 0;
      setLiveIdx(idx);
      if (m.length && idx !== liveIdx) {
        await loadLiveInternal(idx, m);
      }
    } catch (e) {
      console.warn('[Live] reload lives failed:', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIdx]);

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

  const loadSubStatus = useCallback(async () => {
    try {
      const list = await ipcInvoke<LiveSubscription[]>('live:subscription:list');
      const arr = Array.isArray(list) ? list : [];
      setSubCount(arr.length);
      setSubEnabled(arr.filter((s) => s.enabled).length);
    } catch { /* ignore */ }
  }, []);

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

  useEffect(() => {
    const w = window as any;
    const off = w?.winboxIpc?.on?.('live:subscriptions-changed', () => {
      void loadSubStatus();
      void reloadLives();
    });
    return () => { if (typeof off === 'function') off(); };
  }, [loadSubStatus, reloadLives]);

  // 2026-10-14: main broadcasts live:changed after import; reload the list and force-reload active line.
  useEffect(() => {
    const w = window as any;
    const off = w?.winboxIpc?.on?.('live:changed', (payload: { index?: number; name?: string; replaced?: boolean }) => {
      console.log('[Live] received live:changed:', payload);
      void (async () => {
        try {
          const m = await client.liveMeta();
          setLives(m);
          const idx = liveIdx < m.length ? liveIdx : 0;
          if (idx !== liveIdx) setLiveIdx(idx);
          if (m.length) {
            await loadLiveInternal(idx, m);
          }
        } catch (e) {
          console.warn('[Live] live:changed handling failed:', e);
        }
      })();
    });
    return () => { if (typeof off === 'function') off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIdx]);

  const curGroup = groups.find((g) => g.group === groupName);
  const curChannel = curGroup?.channels.find((c) => c.name === channelName);
  const curEpg = curChannel ? (epg[curChannel['tvg-id']] || epg[curChannel['tvg-name']] || epg[curChannel.name]) : undefined;
  const lines = curChannel ? curChannel.urls.map((u, i) => splitLine(u, i + 1)) : [];

  async function refreshEpg(index: number, gs: LiveGroup[], currentChannelName: string) {
    if (!currentChannelName) { setEpg({}); setEpgStatus('empty'); return; }
    const refs: EpgChannelRef[] = [];
    outer: for (const g of gs) {
      for (const c of g.channels) {
        if (c.name !== currentChannelName) continue;
        const r: EpgChannelRef = {
          tvgId: c['tvg-id'],
          tvgName: c['tvg-name'],
          name: c.name,
          epg: c.epg,
        };
        if (r.tvgId || r.tvgName || r.name) refs.push(r);
        break outer;
      }
    }
    if (!refs.length) { setEpg({}); setEpgStatus('empty'); return; }
    setEpgStatus('loading');
    try {
      const r = await client.liveEpg(index, refs);
      setEpg(r.byKey);
      setEpgStatus(Object.keys(r.byKey).length ? 'ok' : 'empty');
    } catch (e) {
      setEpg({});
      setEpgStatus('error');
      console.warn('[EPG] load failed:', e);
    }
  }

  useEffect(() => {
    if (!groups.length) return;
    void refreshEpg(liveIdx, groups, channelName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIdx, groups, channelName]);

  useEffect(() => {
    if (epgTimer.current != null) { window.clearTimeout(epgTimer.current); epgTimer.current = null; }
    if (!curChannel) return;
    const e = epg[curChannel['tvg-id']] || epg[curChannel['tvg-name']] || epg[curChannel.name];
    const at = e?.current?.endTime ?? e?.next?.startTime;
    if (!at) return;
    const delay = Math.max(1000, Math.min(at - Date.now() + 1000, 6 * 3600 * 1000));
    epgTimer.current = window.setTimeout(() => { void refreshEpg(liveIdx, groups, channelName); }, delay);
    return () => {
      if (epgTimer.current != null) { window.clearTimeout(epgTimer.current); epgTimer.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epg, groupName, channelName, liveIdx]);

  async function openPrograms(channel: { name: string; 'tvg-id'?: string; 'tvg-name'?: string }) {
    const name = (channel.name || '').trim();
    if (!name) return;
    const groupList = groups
      .map((g) => ({
        group: String(g.group || '').trim(),
        channels: g.channels
          .map((c) => ({
            name: String(c.name || '').trim(),
            tvgId: String(c['tvg-id'] || '').trim(),
            tvgName: String(c['tvg-name'] || '').trim(),
          }))
          .filter((c) => !!c.name),
      }))
      .filter((g) => !!g.group && g.channels.length > 0);
    try {
      await ipcInvoke('epg:openWindow', {
        channelName: name,
        tvgId: (channel['tvg-id'] || '').trim(),
        tvgName: (channel['tvg-name'] || '').trim(),
        groups: groupList,
        currentGroup: groupName,
      });
    } catch (e) {
      console.warn('[EPG] open programs window failed', e);
    }
  }

  const epgStatusText =
    epgStatus === 'loading' ? 'loading...'
      : epgStatus === 'ok' ? `${Object.keys(epg).length} keys`
        : epgStatus === 'empty' ? 'no data'
          : epgStatus === 'error' ? 'failed (see logs)'
            : 'idle';

  return (
    <>
      <div className="topbar">
        <select value={liveIdx} onChange={(e) => pickLive(Number(e.target.value))} disabled={loading}>
          {lives.map((l, i) => <option key={i} value={i}>{l.name}</option>)}
        </select>

        <span className="status" style={{ marginLeft: 'auto' }}>
          {loading ? 'loading...' : `${groups.length} groups`}
        </span>
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
          subs {subEnabled}/{subCount}
        </span>
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
          EPG: {epgStatusText}
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
                    title="double click for full EPG (standalone window)"
                  >
                    {c.name}
                  </span>
                ))}
              </div>
              {lines.length > 1 && (
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className="muted">lines:</span>
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
                  title="click for full EPG (standalone window)"
                >
                  {curEpg.current && (
                    <span className="live-epg-now">
                      <b>now</b> {curEpg.current.start}~{curEpg.current.end} {curEpg.current.title || '(no title)'}
                    </span>
                  )}
                  {curEpg.next && (
                    <span className="muted">
                      <b>next</b> {curEpg.next.start} {curEpg.next.title || '(no title)'}
                    </span>
                  )}
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>TV</span>
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
                    <div className="empty" style={{ width: '100%', height: '100%' }}>loading...</div>
                  )}
                  {reconnectMsg && (
                    <div
                      style={{
                        position: 'absolute', top: 12, left: 12,
                        padding: '6px 12px', borderRadius: 6,
                        background: 'rgba(0,0,0,0.7)', color: '#ffb74d', fontSize: 13,
                        pointerEvents: 'none', zIndex: 20,
                      }}
                    >{reconnectMsg
