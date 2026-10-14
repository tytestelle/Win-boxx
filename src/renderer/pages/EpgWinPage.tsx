// src/renderer/pages/EpgWinPage.tsx
// EPG 独立窗口的渲染层页面。
//   · 布局：左侧「分组 → 频道」两级列表 + 右侧节目单
//   · 点分组展开 / 折叠；点频道 → 右侧刷新该频道节目预告
//   · 标题栏「↩ 当前」按钮 → 一键切回**主窗口当前播放的频道**
//   · 搜索框：按频道名 / 分组名过滤左侧列表
//   · `-webkit-app-region: drag` 拖动整窗；📌 切换置顶、× 关闭
//   · 监听主进程 `epg:windowUpdate` / `epg:getChannels` → 主窗口切频道/分组时同步
import { useEffect, useMemo, useRef, useState } from 'react';
import { client } from '../api/client';
import { ipcInvoke } from '../api/ipc';

interface ProgramItem {
  title: string;
  description: string;
  start: Date;
  stop: Date;
}

interface ChannelItem {
  name: string;
  tvgId?: string;
  tvgName?: string;
}

interface GroupItem {
  group: string;
  channels: ChannelItem[];
}

interface InitialChannel {
  name: string;
  tvgId: string;
  tvgName: string;
  group: string;
}

function toDate(v: unknown): Date {
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') return new Date(v);
  return new Date();
}
function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
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

export default function EpgWinPage() {
  const [channelName, setChannelName] = useState('');
  const [tvgId, setTvgId] = useState('');
  const [tvgName, setTvgName] = useState('');
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [currentGroupName, setCurrentGroupName] = useState('');
  const [list, setList] = useState<ProgramItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [date, setDate] = useState('');
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [nowMs, setNowMs] = useState(Date.now());
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** ★ 主窗口当前播放的频道（「↩ 当前」按钮用） */
  const [initial, setInitial] = useState<InitialChannel | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /** 按 (name/tvgId/tvgName) 拉节目单 */
  const loadPrograms = async (name: string, id: string, tn: string) => {
    const keys = [id, tn, name].map((s) => (s || '').trim()).filter((s) => !!s);
    if (!keys.length) { setList([]); return; }
    setLoading(true);
    setList([]);
    try {
      const raw = await client.epgPrograms(keys);
      const items: ProgramItem[] = ((raw as any[]) || [])
        .map((p: any) => ({
          title: String(p?.title || ''),
          description: String(p?.description || ''),
          start: toDate(p?.start),
          stop: toDate(p?.stop),
        }))
        .sort((a, b) => a.start.getTime() - b.start.getTime());
      setList(items);
      const today = dayKey(new Date());
      if (items.some((p) => dayKey(p.start) === today)) setDate(today);
      else if (items.length) setDate(dayKey(items[0].start));
      else setDate(today);
    } catch (e) {
      console.warn('[EPG Win] 加载失败', e);
    } finally {
      setLoading(false);
    }
  };

  /** 从 hash query 解析参数（URL 里带 name/tvgId/tvgName）；同时更新 initial（= 主窗口正在播的频道） */
  const loadFromQuery = async (qs: string, opts?: { updateInitial?: boolean }) => {
    const params = new URLSearchParams(qs);
    const name = (params.get('name') || '').trim();
    const id = (params.get('tvgId') || '').trim();
    const tn = (params.get('tvgName') || '').trim();
    if (!name) return;
    setChannelName(name);
    setTvgId(id);
    setTvgName(tn);
    // 每次主窗口切频道（更新 query）时，initial 也跟着更新
    if (opts?.updateInitial !== false) {
      // 找到该频道所在分组（用于「切回」时展开）
      let group = '';
      for (const g of groups) {
        if (g.channels.some((c) => c.name === name)) { group = g.group; break; }
      }
      setInitial({ name, tvgId: id, tvgName: tn, group });
      if (group) setExpanded((prev) => ({ ...prev, [group]: true }));
    }
    await loadPrograms(name, id, tn);
  };

  /** ★ 点击左侧频道切换（只影响本窗口显示，不影响主窗口播放） */
  const switchChannel = (name: string) => {
    for (const g of groups) {
      const hit = g.channels.find((c) => c.name === name);
      if (hit) {
        setChannelName(name);
        setTvgId(hit.tvgId || '');
        setTvgName(hit.tvgName || '');
        setCurrentGroupName(g.group);
        setExpanded((prev) => ({ ...prev, [g.group]: true }));
        void loadPrograms(name, hit.tvgId || '', hit.tvgName || '');
        return;
      }
    }
    // 兜底：直接在 groups 里找不到（名字可能有微妙差异）→ 直接按名字查
    setChannelName(name);
    setTvgId('');
    setTvgName('');
    void loadPrograms(name, '', '');
  };

  /** ★ 一键切回主窗口当前播放的频道 */
  const backToLive = () => {
    if (!initial) return;
    switchChannel(initial.name);
  };

  // 首次挂载
  useEffect(() => {
    const hash = window.location.hash || '';
    const qIndex = hash.indexOf('?');
    void (async () => {
      // 先拉分组/频道列表
      try {
        const data = await ipcInvoke<{ groups: GroupItem[]; currentGroup: string }>('epg:getChannels');
        if (data && Array.isArray(data.groups) && data.groups.length > 0) {
          setGroups(data.groups);
          setCurrentGroupName(data.currentGroup || '');
          setExpanded({ [data.currentGroup || '']: true });
        }
      } catch (e) {
        console.warn('[EPG Win] 拉取频道列表失败', e);
      }
      setLoadingGroups(false);
      // 再加载初始频道节目单（会尝试从 groups 里找到分组）
      void loadFromQuery(qIndex >= 0 ? hash.slice(qIndex + 1) : '', { updateInitial: true });
    })();
    void ipcInvoke('epg:windowReady').catch(() => undefined);
    void (async () => {
      try {
        const on = await client.winIsAlwaysOnTop();
        if (typeof on === 'boolean') setAlwaysOnTop(on);
      } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监听主进程更新
  useEffect(() => {
    const w = window as any;
    const off1 = w?.winboxIpc?.on?.('epg:windowUpdate', (qs: unknown) => {
      if (typeof qs === 'string') void loadFromQuery(qs, { updateInitial: true });
    });
    const off2 = w?.winboxIpc?.on?.('epg:getChannels', (data: unknown) => {
      const d = data as { groups?: GroupItem[]; currentGroup?: string } | null;
      if (d && Array.isArray(d.groups)) {
        setGroups(d.groups);
        if (d.currentGroup) {
          setCurrentGroupName(d.currentGroup);
          setExpanded((prev) => ({ ...prev, [d.currentGroup as string]: true }));
        }
        // 分组更新后，尝试补全 initial.group
        setInitial((prev) => {
          if (!prev) return prev;
          if (prev.group) return prev;
          for (const g of d.groups!) {
            if (g.channels.some((c) => c.name === prev.name)) {
              return { ...prev, group: g.group };
            }
          }
          return prev;
        });
      }
    });
    return () => {
      if (typeof off1 === 'function') off1();
      if (typeof off2 === 'function') off2();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数据就绪后自动滚到「正在播」
  useEffect(() => {
    if (loading) return;
    const el = scrollRef.current?.querySelector('[data-current="1"]') as HTMLElement | null;
    if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [loading, list, date]);

  const dateTabs = Array.from(new Set(list.map((p) => dayKey(p.start)))).sort();
  const dateList = date ? list.filter((p) => dayKey(p.start) === date) : list;

  const toggleTop = async () => {
    try {
      const next = await client.winSetAlwaysOnTop(!alwaysOnTop);
      if (typeof next === 'boolean') setAlwaysOnTop(next);
    } catch { /* ignore */ }
  };

  const close = () => {
    void client.winClose().catch(() => undefined);
  };

  // 按过滤关键字筛选分组（分组名或频道名命中）
  const filteredGroups = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    if (!kw) return groups;
    return groups
      .map((g) => ({
        group: g.group,
        channels: g.channels.filter(
          (c) => c.name.toLowerCase().includes(kw) || g.group.toLowerCase().includes(kw),
        ),
      }))
      .filter((g) => g.channels.length > 0);
  }, [groups, filter]);

  const isInitial = !!(initial && channelName === initial.name);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      background: '#1a1d24', color: '#e6e6e6',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      {/* 标题栏 */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 12px', borderBottom: '1px solid #2a2f3a',
          // @ts-ignore
          WebkitAppRegion: 'drag',
          cursor: 'move',
          userSelect: 'none',
          flexShrink: 0,
          gap: 8,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          节目单 · <span style={{ color: '#4ec9ff' }}>{channelName || '-'}</span>
          {currentGroupName && (
            <span style={{ marginLeft: 8, fontSize: 11, color: '#8a9099', fontWeight: 400 }}>
              （{currentGroupName}）
            </span>
          )}
        </div>
        <div
          style={{
            display: 'flex', gap: 4, flexShrink: 0,
            // @ts-ignore
            WebkitAppRegion: 'no-drag',
            alignItems: 'center',
          }}
        >
          {/* ★「切回当前播放频道」按钮：只在当前显示的不是初始频道时可点 */}
          {initial && (
            <button
              onClick={backToLive}
              disabled={isInitial}
              title={isInitial ? '已在显示当前播放频道' : `切回主窗口正在播放的频道：${initial.name}`}
              style={{
                background: isInitial ? 'transparent' : 'rgba(78,201,255,0.12)',
                border: '1px solid ' + (isInitial ? '#333944' : '#4ec9ff'),
                color: isInitial ? '#666' : '#4ec9ff',
                cursor: isInitial ? 'not-allowed' : 'pointer',
                borderRadius: 6,
                padding: '3px 8px',
                fontSize: 12,
                whiteSpace: 'nowrap',
              }}
            >
              ↩ 当前
            </button>
          )}
          <button
            onClick={toggleTop}
            title={alwaysOnTop ? '取消置顶（可与视频并排看）' : '置顶（浮在视频上方）'}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: alwaysOnTop ? '#4ec9ff' : '#888', fontSize: 15, padding: '2px 6px',
            }}
          >📌</button>
          <button
            onClick={close}
            title="关闭"
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: '#aaa', fontSize: 18, padding: '0 6px', lineHeight: 1,
            }}
          >×</button>
        </div>
      </div>

      {/* 主体：左频道列表 + 右节目单 */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* 左：分组 → 频道 */}
        <aside style={{
          width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column',
          borderRight: '1px solid #2a2f3a', background: '#16191f',
        }}>
          <div style={{ padding: '8px 8px 6px', borderBottom: '1px solid #232833' }}>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索频道 / 分组…"
              style={{
                width: '100%', boxSizing: 'border-box',
                background: '#0f1218', color: '#e6e6e6',
                border: '1px solid #333944', borderRadius: 6,
                padding: '5px 8px', fontSize: 12, outline: 'none',
              }}
            />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 8px' }}>
            {loadingGroups ? (
              <div style={{ padding: 16, textAlign: 'center', color: '#666', fontSize: 12 }}>
                正在加载频道列表…
              </div>
            ) : filteredGroups.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', color: '#666', fontSize: 12 }}>
                {groups.length === 0 ? '无频道（直播源为空？）' : '无匹配频道'}
              </div>
            ) : (
              filteredGroups.map((g) => {
                const open = filter.trim() ? true : !!expanded[g.group];
                return (
                  <div key={g.group}>
                    <button
                      onClick={() => setExpanded((prev) => ({ ...prev, [g.group]: !open }))}
                      style={{
                        width: '100%', textAlign: 'left',
                        background: 'transparent', border: 'none',
                        color: '#a6adb8', cursor: 'pointer',
                        padding: '6px 10px', fontSize: 12,
                        display: 'flex', alignItems: 'center', gap: 6,
                      }}
                    >
                      <span style={{ fontSize: 10, color: '#666' }}>{open ? '▼' : '▶'}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {g.group}
                      </span>
                      <span style={{ color: '#666', fontSize: 11 }}>{g.channels.length}</span>
                    </button>
                    {open && g.channels.map((c) => {
                      const active = c.name === channelName;
                      const isInit = !!(initial && initial.name === c.name);
                      return (
                        <button
                          key={c.name}
                          onClick={() => switchChannel(c.name)}
                          title={isInit ? `${c.name}（主窗口正在播放）` : c.name}
                          style={{
                            width: '100%', textAlign: 'left',
                            background: active ? 'rgba(78,201,255,0.14)' : 'transparent',
                            border: 'none',
                            borderLeft: active ? '3px solid #4ec9ff' : '3px solid transparent',
                            color: active ? '#4ec9ff' : '#d0d4da',
                            cursor: 'pointer',
                            padding: '5px 10px 5px 24px',
                            fontSize: 12,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            display: 'flex', alignItems: 'center', gap: 6,
                          }}
                        >
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                          {isInit && (
                            <span style={{ fontSize: 10, color: '#4ec9ff', flexShrink: 0 }}>▶</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* 右：节目单 */}
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {dateTabs.length > 0 && (
            <div style={{ display: 'flex', gap: 6, padding: '8px 12px 0', flexWrap: 'wrap', flexShrink: 0 }}>
              {dateTabs.map((d) => (
                <button
                  key={d}
                  onClick={() => setDate(d)}
                  style={{
                    padding: '4px 10px', borderRadius: 14, fontSize: 12, cursor: 'pointer',
                    border: '1px solid ' + (d === date ? '#4ec9ff' : '#333944'),
                    background: d === date ? 'rgba(78,201,255,0.15)' : 'transparent',
                    color: d === date ? '#4ec9ff' : '#ccc',
                  }}
                >{dateLabel(d)}</button>
              ))}
            </div>
          )}
          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '8px 12px 14px' }}>
            {loading ? (
              <div style={{ padding: 32, textAlign: 'center', color: '#888', fontSize: 13 }}>加载中…</div>
            ) : dateList.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: '#888', fontSize: 13 }}>这一天暂无节目单</div>
            ) : (
              dateList.map((p, i) => {
                const isCurrent = nowMs >= p.start.getTime() && nowMs < p.stop.getTime();
                const isPast = nowMs >= p.stop.getTime();
                return (
                  <div
                    key={i}
                    data-current={isCurrent ? '1' : '0'}
                    style={{
                      display: 'flex', gap: 10, padding: '8px 10px', borderRadius: 6,
                      background: isCurrent ? 'rgba(78,201,255,0.12)' : 'transparent',
                      borderLeft: isCurrent ? '3px solid #4ec9ff' : '3px solid transparent',
                      opacity: isPast ? 0.5 : 1,
                    }}
                  >
                    <div style={{ minWidth: 92, color: isCurrent ? '#4ec9ff' : '#9aa0a6', fontSize: 12, paddingTop: 2 }}>
                      {hhmm(p.start)} - {hhmm(p.stop)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: isCurrent ? 600 : 400, wordBreak: 'break-word' }}>
                        {p.title || '（无标题）'}
                        {isCurrent && (
                          <span style={{
                            marginLeft: 6, fontSize: 10, padding: '1px 5px',
                            borderRadius: 3, background: '#4ec9ff', color: '#0b1016',
                          }}>正在播</span>
                        )}
                      </div>
                      {p.description && (
                        <div style={{ fontSize: 11, color: '#8a9099', marginTop: 3, lineHeight: 1.5, wordBreak: 'break-word' }}>
                          {p.description}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
