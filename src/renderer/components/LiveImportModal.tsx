// src/renderer/components/LiveImportModal.tsx
// ★ 2026-10-13（用户要求）：导入直播源弹窗
//   —— 菜单：本地文件（复用原 doImportLiveLocal）/ 网络订阅源
//   —— 网络订阅源：名称 + 链接（支持 .txt / .m3u / .m3u8 / .json），添加后立即下载并注册到 lives
//   —— 管理表格：启用开关 / 上移 / 下移 / 修改 / 删除
import { useCallback, useEffect, useState } from 'react';
import type { LiveSubscription } from '../../shared/types';
import { ipcInvoke } from '../api/ipc';

const btn = (primary = false): React.CSSProperties => ({
  padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
  border: `1px solid ${primary ? '#4ec9ff' : '#3a4150'}`,
  background: primary ? 'rgba(78,201,255,0.12)' : 'rgba(255,255,255,0.06)',
  color: primary ? '#4ec9ff' : '#e6e6e6', whiteSpace: 'nowrap',
});
const inputStyle: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 6, border: '1px solid #333944',
  background: '#0f1218', color: '#e6e6e6', fontSize: 13,
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** ConfigPage 里原有的本地 TXT / M3U 导入函数（一行不改直接复用） */
  onImportLocalFile: () => void | Promise<void>;
}

export default function LiveImportModal({ open, onClose, onImportLocalFile }: Props) {
  const [view, setView] = useState<'menu' | 'network'>('menu');
  const [subs, setSubs] = useState<LiveSubscription[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string; url: string } | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await ipcInvoke<LiveSubscription[]>('live:subscription:list');
      setSubs(Array.isArray(list) ? list : []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!open) return;
    setView('menu');
    setMsg(null);
    setEditing(null);
    void load();
  }, [open, load]);

  // 主进程广播订阅变化时同步表格
  useEffect(() => {
    if (!open) return;
    const w = window as any;
    const off = w?.winboxIpc?.on?.('live:subscriptions-changed', () => { void load(); });
    return () => { if (typeof off === 'function') off(); };
  }, [open, load]);

  if (!open) return null;

  async function addNetwork() {
    const n = name.trim();
    const u = url.trim();
    if (!n) { setMsg({ text: '请填写名称', kind: 'err' }); return; }
    if (!/^https?:\/\//i.test(u)) { setMsg({ text: '链接必须以 http:// 或 https:// 开头', kind: 'err' }); return; }
    setAdding(true);
    setMsg({ text: '正在下载订阅源…', kind: 'ok' });
    try {
      await ipcInvoke('live:subscription:add', n, u);
      setName('');
      setUrl('');
      setMsg({ text: '✓ 已添加并注册到直播页线路下拉', kind: 'ok' });
      await load();
    } catch (e) {
      setMsg({ text: `添加失败：${(e as Error).message || String(e)}`, kind: 'err' });
    } finally {
      setAdding(false);
    }
  }

  async function remove(id: string, n: string) {
    if (!window.confirm(`确定删除「${n}」？将同时从直播页移除。`)) return;
    try {
      await ipcInvoke('live:subscription:remove', id);
      await load();
    } catch (e) {
      setMsg({ text: `删除失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  async function move(id: string, dir: 'up' | 'down') {
    try {
      const next = await ipcInvoke<LiveSubscription[]>('live:subscription:move', id, dir);
      if (Array.isArray(next)) setSubs(next);
    } catch (e) {
      setMsg({ text: `移动失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  async function toggle(id: string, enabled: boolean) {
    try {
      await ipcInvoke('live:subscription:toggle', id, enabled);
      await load();
    } catch (e) {
      setMsg({ text: `切换失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  async function saveEdit() {
    if (!editing) return;
    if (!editing.name.trim() || !editing.url.trim()) {
      setMsg({ text: '名称和链接不能为空', kind: 'err' });
      return;
    }
    try {
      await ipcInvoke('live:subscription:update', editing.id, {
        name: editing.name.trim(),
        url: editing.url.trim(),
      });
      setEditing(null);
      await load();
    } catch (e) {
      setMsg({ text: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  function handleLocalFile() {
    // 复用 ConfigPage 里原有的本地导入（内部会弹系统文件选择器）
    void Promise.resolve(onImportLocalFile()).finally(() => { onClose(); });
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 720, maxWidth: '94vw', maxHeight: '88vh', overflow: 'auto',
        background: '#14181f', border: '1px solid #2a2f3a', borderRadius: 10, padding: 20,
        color: '#e6e6e6',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>导入直播源</div>
          <button type="button" onClick={onClose} style={btn()}>关闭</button>
        </div>

        {/* 两个入口 */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 18 }}>
          <button type="button" style={{ ...btn(), flex: 1, padding: '22px 12px', fontSize: 14 }}
            onClick={handleLocalFile}>
            📁 本地文件<br />
            <span style={{ fontSize: 11, color: '#8a9099' }}>导入本地 .txt / .m3u / .m3u8 播放源</span>
          </button>
          <button type="button" style={{ ...btn(), flex: 1, padding: '22px 12px', fontSize: 14 }}
            onClick={() => setView(view === 'network' ? 'menu' : 'network')}>
            🌐 网络订阅源<br />
            <span style={{ fontSize: 11, color: '#8a9099' }}>添加 http/https 订阅（txt / m3u / json 等）</span>
          </button>
        </div>

        {/* 网络订阅源添加表单 */}
        {view === 'network' && (
          <div style={{
            display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14,
            padding: 12, border: '1px solid #2a2f3a', borderRadius: 8, background: '#0f1218',
          }}>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="自定义名称" style={{ ...inputStyle, flex: '1 1 150px' }} />
            <input value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="订阅链接（http/https，支持 .txt/.m3u/.m3u8/.json）"
              style={{ ...inputStyle, flex: '2 1 260px' }} />
            <button type="button" onClick={addNetwork} disabled={adding} style={btn(true)}>
              {adding ? '下载中…' : '确定'}
            </button>
          </div>
        )}

        {msg && (
          <div style={{
            marginBottom: 12, padding: '6px 10px', borderRadius: 6, fontSize: 12,
            background: msg.kind === 'err' ? 'rgba(255,118,118,0.1)' : 'rgba(78,201,255,0.1)',
            color: msg.kind === 'err' ? '#ff7676' : '#4ec9ff',
          }}>{msg.text}</div>
        )}

        {/* 管理表格 */}
        <div style={{ fontSize: 13, color: '#8a9099', margin: '4px 0 8px' }}>
          已添加的订阅源（{subs.length}）
        </div>
        <div style={{ border: '1px solid #2a2f3a', borderRadius: 8, overflow: 'hidden' }}>
          {subs.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#888', fontSize: 12 }}>暂无订阅源</div>
          ) : subs.map((s, i) => {
            const isEdit = editing?.id === s.id;
            return (
              <div key={s.id} style={{
                display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px',
                borderBottom: i < subs.length - 1 ? '1px solid #232833' : 'none',
                background: isEdit ? 'rgba(78,201,255,0.06)' : 'transparent',
              }}>
                <input type="checkbox" checked={s.enabled}
                  onChange={(e) => void toggle(s.id, e.target.checked)}
                  title="启用 / 停用" />
                {isEdit ? (
                  <>
                    <input value={editing!.name} style={{ ...inputStyle, flex: 1 }}
                      onChange={(e) => setEditing({ ...editing!, name: e.target.value })} />
                    <input value={editing!.url} style={{ ...inputStyle, flex: 2 }}
                      onChange={(e) => setEditing({ ...editing!, url: e.target.value })} />
                    <button type="button" onClick={saveEdit} style={btn(true)}>保存</button>
                    <button type="button" onClick={() => setEditing(null)} style={btn()}>取消</button>
                  </>
                ) : (
                  <>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13 }}>
                        【订阅】{s.name}
                        {!s.enabled && <span style={{ marginLeft: 6, fontSize: 11, color: '#888' }}>（已停用）</span>}
                        {s.lastError && <span style={{ marginLeft: 6, fontSize: 11, color: '#ff7676' }}>{s.lastError}</span>}
                      </div>
                      <div style={{
                        fontSize: 11, color: '#8a9099',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }} title={s.url}>{s.url}</div>
                    </div>
                    <button type="button" onClick={() => void move(s.id, 'up')}
                      disabled={i === 0} style={btn()}>上移</button>
                    <button type="button" onClick={() => void move(s.id, 'down')}
                      disabled={i === subs.length - 1} style={btn()}>下移</button>
                    <button type="button" onClick={() => setEditing({ id: s.id, name: s.name, url: s.url })}
                      style={btn()}>修改</button>
                    <button type="button" onClick={() => void remove(s.id, s.name)}
                      style={{ ...btn(), color: '#ff7676', borderColor: '#5a3038' }}>删除</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
