// src/renderer/pages/EpgWinPage.tsx
// EPG 独立窗口的渲染层页面。
//   · 路由：`#/epg-window?name=…&tvgId=…&tvgName=…`
//   · 挂载后：拉节目单 → 自动滚到「正在播」；每 30s 刷一次高亮
//   · 标题栏 `-webkit-app-region: drag` → 整窗拖动；📌 切换置顶、× 关闭
//   · 监听主进程 `epg:windowUpdate` → 换频道时重新拉数据（不重载窗口）
import { useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import { ipcInvoke } from '../api/ipc';

interface ProgramItem {
  title: string;
  description: string;
  start: Date;
  stop: Date;
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

  const loadFromQuery = async (qs: string) => {
    const params = new URLSearchParams(qs);
    const name = (params.get('name') || '').trim();
    const tvgId = (params.get('tvgId') || '').trim();
    const tvgName = (params.get('tvgName') || '').trim();
    setChannelName(name);
    const keys = [tvgId, tvgName, name].filter((s) => !!s);
    if (!keys.length) return;
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

  // 首次挂载：从 hash 解析参数 + 通知主进程就绪 + 读取当前置顶状态
  useEffect(() => {
    const hash = window.location.hash || '';
    const qIndex = hash.indexOf('?');
    void loadFromQuery(qIndex >= 0 ? hash.slice(qIndex + 1) : '');
    void ipcInvoke('epg:windowReady').catch(() => undefined);
    void (async () => {
      try {
        const on = await client.winIsAlwaysOnTop();
        if (typeof on === 'boolean') setAlwaysOnTop(on);
      } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监听主进程更新参数（切换频道时不重载窗口）
  useEffect(() => {
    const w = window as any;
    const off = w?.winboxIpc?.on?.('epg:windowUpdate', (qs: unknown) => {
      if (typeof qs === 'string') void loadFromQuery(qs);
    });
    return () => { if (typeof off === 'function') off(); };
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
