// src/renderer/pages/EpgWinPage.tsx
// EPG 独立窗口的渲染层页面。
//   · 路由：`#/epg-window?name=…&tvgId=…&tvgName=…`
//   · 挂载后：拉频道列表 → 拉当前频道节目单 → 自动滚到「正在播」
//   · ★ 2026-10-14（用户要求）：顶栏下方加「频道下拉」—— 可在 EPG 窗口内直接切频道
//   · 标题栏 `-webkit-app-region: drag` → 整窗拖动；📌 切换置顶、× 关闭
//   · 监听主进程 `epg:windowUpdate` → 从直播页切频道时同步刷新
import { useEffect, useRef, useState } from 'react';
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
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState<ProgramItem[]>([]);
  const [date, setDate] = useState('');
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [nowMs, setNowMs] = useState(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);

  // 每 30 秒刷新一次“当前时间”用于高亮
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /** 按 (name/tvgId/tvgName) 拉节目单 */
  const loadPrograms = async (name: string, id: string, tn: string) => {
    const keys = [id, tn, name].map((s) => (s || '').trim()).filter((s) => !!s);
    if (!keys.length) {
      setList([]);
      return;
    }
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

  /** 从 hash 解析参数并加载 */
  const loadFromQuery = async (qs: string) => {
    const params = new URLSearchParams(qs);
    const name = (params.get('name') || '').trim();
    const id = (params.get('tvgId') || '').trim();
    const tn = (params.get('tvgName') || '').trim();
    setChannelName(name);
    setTvgId(id);
    setTvgName(tn);
    await loadPrograms(name, id, tn);
  };

  /**
   * ★ 2026-10-14（用户要求）：EPG 窗口内切换频道。
   *   切换后：
   *     · 更新本窗口的 channelName / tvgId / tvgName
   *     · 重新请求该频道的节目单（只请求这一个频道，与主窗口「只加载当前频道」策略一致）
   *     · 不通知主进程（主窗口的当前播放频道不跟着变）
   */
  const switchChannel = (name: string) => {
    const hit = channels.find((c) => c.name === name);
    const id = hit?.tvgId || '';
    const tn = hit?.tvgName || '';
    setChannelName(name);
    setTvgId(id);
    setTvgName(tn);
    void loadPrograms(name, id, tn);
  };

  // 首次挂载：从 hash 解析参数 + 通知主进程就绪 + 拉频道列表 + 读置顶状态
  useEffect(() => {
    const hash = window.location.hash || '';
    const qIndex = hash.indexOf('?');
    void loadFromQuery(qIndex >= 0 ? hash.slice(qIndex + 1) : '');
    void ipcInvoke('epg:windowReady').catch(() => undefined);
    // ★ 拉频道列表（当前分组的全部频道）
    void (async () => {
      try {
        const list = await ipcInvoke<ChannelItem[]>('epg:getChannels');
        setChannels(Array.isArray(list) ? list : []);
      } catch { /* ignore */ }
    })();
    // 读当前置顶状态
    void (async () => {
      try {
        const on = await client.winIsAlwaysOnTop();
        if (typeof on === 'boolean') setAlwaysOnTop(on);
      } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监听主进程更新参数（从主窗口切频道再点 EPG 时）
  useEffect(() => {
    const w = window as any;
    const off = w?.winboxIpc?.on?.('epg:windowUpdate', (qs: unknown) => {
      if (typeof qs === 'string') void loadFromQuery(qs);
    });
    // 主进程推送新的频道列表（切分组后）
    const off2 = w?.winboxIpc?.on?.('epg:getChannels', (list: unknown) => {
      if (Array.isArray(list)) setChannels(list as ChannelItem[]);
    });
    return () => {
      if (typeof off === 'function') off();
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

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      background: '#1a1d24', color: '#e6e6e6',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      {/* 标题栏 —— 拖动区（按钮区不拖动） */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 12px', borderBottom: '1px solid #2a2f3a',
          // @ts-ignore Electron 拖动整窗
          WebkitAppRegion: 'drag',
          cursor: 'move',
          userSelect: 'none',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          节目单 · <span style={{ color: '#4ec9ff' }}>{channelName || '-'}</span>
        </div>
        <div
          style={{
            display: 'flex', gap: 4, flexShrink: 0,
            // @ts-ignore 按钮区不拖动
            WebkitAppRegion: 'no-drag',
          }}
        >
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

      {/* ★ 2026-10-14：频道切换器（当前分组的全部频道） */}
      {channels.length > 0 && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 12px', borderBottom: '1px solid #232833',
            // @ts-ignore
            WebkitAppRegion: 'no-drag',
          }}
        >
          <span style={{ fontSize: 12, color: '#8a9099', flexShrink: 0 }}>频道：</span>
          <select
            value={channelName}
            onChange={(e) => switchChannel(e.target.value)}
            style={{
              flex: 1, minWidth: 0,
              background: '#0f1218', color: '#e6e6e6',
              border: '1px solid #333944', borderRadius: 6,
              padding: '4px 8px', fontSize: 12, cursor: 'pointer',
            }}
          >
            {channels.map((c) => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* 日期 tab */}
      {dateTabs.length > 0 && (
        <div style={{ display: 'flex', gap: 6, padding: '8px 12px 0', flexWrap: 'wrap' }}>
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

      {/* 列表 */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '8px 6px 12px' }}>
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
                  display: 'flex', gap: 8, padding: '8px 10px', borderRadius: 6,
                  background: isCurrent ? 'rgba(78,201,255,0.12)' : 'transparent',
                  borderLeft: isCurrent ? '3px solid #4ec9ff' : '3px solid transparent',
                  opacity: isPast ? 0.5 : 1,
                }}
              >
                <div style={{ minWidth: 88, color: isCurrent ? '#4ec9ff' : '#9aa0a6', fontSize: 12, paddingTop: 2 }}>
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
    </div>
  );
}
