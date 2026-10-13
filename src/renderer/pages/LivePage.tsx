import { useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import type { LiveGroup, LiveBean, LiveEpgEntry, EpgChannelRef } from '../../shared/types';
import VideoPlayer from '../components/VideoPlayer';
import { splitLine } from '../../engine/live/LiveUtils';

// ---- 频道选择记忆：切走再返回直播页时恢复上次浏览的分组/频道/线路（本地持久化）----
const LIVE_MEM_KEY = 'winbox-live-mem';
interface LiveMem { liveIdx?: number; groupName?: string; channelName?: string; lineIdx?: number }
function loadLiveMem(): LiveMem {
  try {
    return JSON.parse(localStorage.getItem(LIVE_MEM_KEY) || '{}') as LiveMem;
  } catch {
    return {};
  }
}
function saveLiveMem(m: LiveMem): void {
  try { localStorage.setItem(LIVE_MEM_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

type EpgStatus = 'idle' | 'loading' | 'ok' | 'empty' | 'error';

/** ★ 节目单条目（IPC 后 Date 会变成 ISO 字符串，这里统一成 Date） */
interface EpgProgramItem {
  title: string;
  description: string;
  start: Date;
  stop: Date;
}

/** ★ YYYY-MM-DD（本地时区） */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** ★ 把 IPC 返回的 start/stop（可能是 Date 或 ISO 字符串）统一成 Date */
function toDate(v: unknown): Date {
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') return new Date(v);
  return new Date();
}

/** ★ HH:mm */
function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function LivePage() {
  const [lives, setLives] = useState<LiveBean[]>([]);
  const [liveIdx, setLiveIdx] = useState(0);
  const [groups, setGroups] = useState<LiveGroup[]>([]);
  const [groupName, setGroupName] = useState('');
  const [channelName, setChannelName] = useState('');
  const [lineIdx, setLineIdx] = useState(0);
  const [playUrl, setPlayUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  /** ★ 2026-09-29 EPG：键（tvg-id / tvg-name / 频道名）→ 当前 / 下一档 */
  const [epg, setEpg] = useState<Record<string, LiveEpgEntry>>({});
  /** ★ 2026-10-13 EPG 状态提示 */
  const [epgStatus, setEpgStatus] = useState<EpgStatus>('idle');
  const epgTimer = useRef<number | null>(null);

  // ---- ★ 2026-10-13 完整节目单弹窗 ----
  const [programsOpen, setProgramsOpen] = useState(false);
  const [programsLoading, setProgramsLoading] = useState(false);
  const [programsList, setProgramsList] = useState<EpgProgramItem[]>([]);
  const [programsChannel, setProgramsChannel] = useState('');
  const [programsDate, setProgramsDate] = useState(''); // YYYY-MM-DD
  const programsScrollRef = useRef<HTMLDivElement>(null);

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
    return () => {
      cancelled = true;
    };
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

  const curGroup = groups.find((g) => g.group === groupName);
  const curChannel = curGroup?.channels.find((c) => c.name === channelName);
  const curEpg = curChannel ? (epg[curChannel['tvg-id']] || epg[curChannel['tvg-name']] || epg[curChannel.name]) : undefined;
  const lines = curChannel ? curChannel.urls.map((u, i) => splitLine(u, i + 1)) : [];

  // ★ EPG：换线路 / 分组变化后拉一次节目单（主进程负责 XMLTV 拉取、缓存与频道匹配）
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
      const n = Object.keys(r.byKey).length;
      setEpgStatus(n ? 'ok' : 'empty');
      // eslint-disable-next-line no-console
      console.info(`[EPG] 命中 ${n} 个键`);
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

  /** ★ 只在「当前节目结束 / 下一档开始」的时刻再拉一次（不做轮询） */
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

  // ---- ★ 打开完整节目单弹窗 ----
  async function openPrograms(name: string) {
    const channel = (name || '').trim();
    if (!channel) return;
    setProgramsChannel(channel);
    setProgramsOpen(true);
    setProgramsLoading(true);
    setProgramsList([]);
    try {
      const raw = await client.epgPrograms(channel);
      const list: EpgProgramItem[] = ((raw as any[]) || [])
        .map((p: any) => ({
          title: String(p?.title || ''),
          description: String(p?.description || ''),
          start: toDate(p?.start),
          stop: toDate(p?.stop),
        }))
        .sort((a, b) => a.start.getTime() - b.start.getTime());
      setProgramsList(list);
      // 默认选中今天（若今天没有节目，选第一条的日期）
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

  function closePrograms() {
    setProgramsOpen(false);
  }

  /** ★ 打开后自动滚动到当前节目 */
  useEffect(() => {
    if (!programsOpen || programsLoading) return;
    const el = programsScrollRef.current?.querySelector('[data-current="1"]') as HTMLElement | null;
    if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [programsOpen, programsLoading, programsList, programsDate]);

  /** ★ ESC 关闭弹窗 */
  useEffect(() => {
    if (!programsOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePrograms(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [programsOpen]);

  // ---- 从节目单里提取所有日期 tab ----
  const dateTabs = Array.from(new Set(programsList.map((p) => dayKey(p.start)))).sort();
  const dateList = programsDate ? programsList.filter((p) => dayKey(p.start) === programsDate) : programsList;
  const nowMs = Date.now();

  const epgStatusText =
    epgStatus === 'loading' ? '加载中…'
      : epgStatus === 'ok' ? `命中 ${Object.keys(epg).length} 键`
        : epgStatus === 'empty' ? '无节目单'
          : epgStatus === 'error' ? '失败（看日志）'
            : '未触发';

  /** ★ 日期 tab 显示：今天 / 明天 / 后天 / MM-DD 周X */
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
        <span className="status" style={{ marginLeft: 'auto' }}>{loading ? '加载中…' : `${groups.length} 组`}</span>
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
          EPG：{epgStatusText}
        </span>
      </div>
      <div className="layout-2 content" style={{ padding: 12 }}>
        <div className="left">
          {groups.map((g) => (
            <div key={g.group} className={`nav-item ${g.group === groupName ? 'active' : ''}`} onClick={() => { setGroupName(g.group); if (g.channels.length) pickChannel(g, g.channels[0].name, 0, groups); }}>
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
                    onDoubleClick={() => openPrograms(c.name)}
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
                    <span key={l.index} className={`tag ${l.index - 1 === lineIdx ? 'active' : ''}`} onClick={() => { setLineIdx(l.index - 1); setPlayUrl(l.url); saveLiveMem({ liveIdx, groupName, channelName, lineIdx: l.index - 1 }); }}>
                      {l.name}
                    </span>
                  ))}
                </div>
              )}
              {/* ★ EPG：当前 / 下一档；点击可打开完整节目单 */}
              {curEpg && (curEpg.current || curEpg.next) && (
                <div
                  className="live-epg"
                  onClick={() => openPrograms(channelName)}
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
                <div className="live-player">
                  <VideoPlayer url={playUrl} />
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

      {/* ================= ★ 完整节目单弹窗 ================= */}
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
              width: 'min(720px, 92vw)',
              maxHeight: '80vh',
              display: 'flex',
              flexDirection: 'column',
              background: '#1a1d24',
              color: '#e6e6e6',
              borderRadius: 12,
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              overflow: 'hidden',
            }}
          >
            {/* 标题栏 */}
            <div
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px', borderBottom: '1px solid #2a2f3a',
              }}
            >
              <div style={{ fontSize: 16, fontWeight: 600 }}>
                节目单 · <span style={{ color: '#4ec9ff' }}>{programsChannel || '-'}</span>
              </div>
              <button
                onClick={closePrograms}
                style={{
                  background: 'transparent', border: 'none', color: '#aaa',
                  fontSize: 20, cursor: 'pointer', padding: '0 4px',
                }}
                title="关闭 (Esc)"
              >×</button>
            </div>

            {/* 日期 tab */}
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

            {/* 节目列表 */}
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
