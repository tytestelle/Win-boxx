// src/renderer/components/LiveImportModal.tsx
// ★ 2026-10-13（用户要求）：导入直播源弹窗
//   —— 顶部三个 tab：导入 / 网络订阅源 / 本地源
//   —— 导入：本地文件（复用 ConfigPage 原有 doImportLiveLocal）/ 网络订阅源入口
//   —— 网络订阅源：添加表单 + 管理表格（启用开关 / 上移 / 下移 / 修改 / 删除）
//   —— 本地源：列出「配置页 · 导入本地 TXT/M3U」写入的 lives 条目 + 删除按钮
import { useCallback, useEffect, useState } from 'react';
import type { LiveSubscription } from '../../shared/types';
import { ipcInvoke } from '../api/ipc';

/** 主进程 listLocalLiveSources 返回项（与 LiveSubscriptionManager 的 interface 保持一致） */
interface LocalLiveSource {
  name: string;
  api: string;
  fileName: string;
  fileExists: boolean;
}

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

type TabId = 'import' | 'sub' | 'local';

const TAB_LABELS: Array<{ id: TabId; label: string }> = [
  { id: 'import', label: '导入' },
  { id: 'sub', label: '网络订阅源' },
  { id: 'local', label: '本地源' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  /** ConfigPage 里原有的本地 TXT / M3U 导入函数（一行不改直接复用） */
  onImportLocalFile: () => void | Promise<void>;
}

export default function LiveImportModal({ open, onClose, onImportLocalFile }: Props) {
  const [tab, setTab] = useState<TabId>('import');
  const [subs, setSubs] = useState<LiveSubscription[]>([]);
  const [locals, setLocals] = useState<LocalLiveSource[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string; url: string } | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);

  const loadSubs = useCallback(async () => {
    try {
      const list = await ipcInvoke<LiveSubscription[]>('live:subscription:list');
      setSubs(Array.isArray(list) ? list : []);
    } catch { /* ignore */ }
  }, []);

  const loadLocals = useCallback(async () => {
    try {
      const list = await ipcInvoke<LocalLiveSource[]>('live:local:list');
      setLocals(Array.isArray(list) ? list : []);
    } catch { /* ignore */ }
  }, []);

  const reloadAll = useCallback(async () => {
    await Promise.all([loadSubs(), loadLocals()]);
  }, [loadSubs, loadLocals]);

  useEffect(() => {
    if (!open) return;
    setTab('import');
    setMsg(null);
    setEditing(null);
    void reloadAll();
  }, [open, reloadAll]);

  // 主进程广播订阅/本地源变化时同步两个表格
  useEffect(() => {
    if (!open) return;
    const w = window as any;
    const off = w?.winboxIpc?.on?.('live:subscriptions-changed', () => { void reloadAll(); });
    return () => { if (typeof off === 'function') off(); };
  }, [open, reloadAll]);

  if (!open) return null;

  // ---------- 网络订阅源 ----------
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
      await loadSubs();
    } catch (e) {
      setMsg({ text: `添加失败：${(e as Error).message || String(e)}`, kind: 'err' });
    } finally {
      setAdding(false);
    }
  }

  async function removeSub(id: string, n: string) {
    if (!window.confirm(`确定删除订阅源「${n}」？将同时从直播页移除。`)) return;
    try {
      await ipcInvoke('live:subscription:remove', id);
      await loadSubs();
    } catch (e) {
      setMsg({ text: `删除失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  async function moveSub(id: string, dir: 'up' | 'down') {
    try {
      const next = await ipcInvoke<LiveSubscription[]>('live:subscription:move', id, dir);
      if (Array.isArray(next)) setSubs(next);
    } catch (e) {
      setMsg({ text: `移动失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  async function toggleSub(id: string, enabled: boolean) {
    try {
      await ipcInvoke('live:subscription:toggle', id, enabled);
      await loadSubs();
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
      await loadSubs();
    } catch (e) {
      setMsg({ text: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  // ---------- 本地源 ----------
  async function removeLocal(api: string, n: string) {
    if (!window.confirm(`确定删除本地源「${n}」？将同时删除本地文件并从直播页移除。`)) return;
    try {
      await ipcInvoke('live:local:remove', api);
      await loadLocals();
    } catch (e) {
      setMsg({ text: `删除失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  function handleLocalFile() {
    // 复用 ConfigPage 里原有的本地导入（内部会弹系统文件选择器）
    void Promise.resolve(onImportLocalFile()).finally(() => {
      // 导入完成后切到「本地源」tab 展示结果（更直观）
      setTab('local');
      void loadLocals();
    });
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 760, maxWidth: '94vw', maxHeight: '88vh', overflow: 'auto',
        background: '#14181f', border: '1px solid #2a2f3a', borderRadius: 10, padding: 20,
        color: '#e6e6e6',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>直播源管理</div>
          <button type="button" onClick={onClose} style={btn()}>关闭</button>
        </div>

        {/* tab 切换 */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #2a2f3a' }}>
          {TAB_LABELS.map((t) => {
            const active = tab === t.id;
            const count = t.id === 'sub' ? subs.length : t.id === 'local' ? locals.length : null;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => { setTab(t.id); setMsg(null); }}
                style={{
                  padding: '8px 16px', cursor: 'pointer', fontSize: 13,
                  background: active ? 'rgba(78,201,255,0.1)' : 'transparent',
                  border: 'none',
                  borderBottom: active ? '2px solid #4ec9ff' : '2px solid transparent',
                  color: active ? '#4ec9ff' : '#c6c6c6',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {t.label}{count !== null ? `（${count}）` : ''}
              </button>
            );
          })}
        </div>

        {/* msg 条 */}
        {msg && (
          <div style={{
            marginBottom: 12, padding: '6px 10px', borderRadius: 6, fontSize: 12,
            background: msg.kind === 'err' ? 'rgba(255,118,118,0.1)' : 'rgba(78,201,255,0.1)',
            color: msg.kind === 'err' ? '#ff7676' : '#4ec9ff',
          }}>{msg.text}</div>
        )}

        {/* ===== tab: 导入 ===== */}
        {tab === 'import' && (
          <>
            <div style={{ display: 'flex', gap: 12, marginBottom: 18 }}>
              <button type="button" style={{ ...btn(), flex: 1, padding: '22px 12px', fontSize: 14 }}
                onClick={handleLocalFile}>
                📁 本地文件<br />
                <span style={{ fontSize: 11, color: '#8a9099' }}>导入本地 .txt / .m3u / .m3u8 播放源</span>
              </button>
              <button type="button" style={{ ...btn(), flex: 1, padding: '22px 12px', fontSize: 14 }}
                onClick={() => setTab('sub')}>
                🌐 网络订阅源<br />
                <span style={{ fontSize: 11, color: '#8a9099' }}>添加 http/https 订阅（txt / m3u / json 等）</span>
              </button>
            </div>
            <div style={{ fontSize: 12, color: '#8a9099', lineHeight: 1.7 }}>
              · 本地文件导入：选择一个本地 TXT / M3U 播放源文件，会复制到应用数据目录并在直播页线路下拉出现一条线路。<br />
              · 网络订阅源：填写名称 + 链接，会下载到本地并自动注册到直播页线路下拉；启动应用时会自动检查更新。<br />
              · 已导入的本地源可在「本地源」标签页查看并删除；网络订阅源可在「网络订阅源」标签页管理。
            </div>
          </>
        )}

        {/* ===== tab: 网络订阅源 ===== */}
        {tab === 'sub' && (
          <>
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
                {adding ? '下载中…' : '添加'}
              </button>
            </div>

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
                      onChange={(e) => void toggleSub(s.id, e.target.checked)}
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
                        <button type="button" onClick={() => void moveSub(s.id, 'up')}
                          disabled={i === 0} style={btn()}>上移</button>
                        <button type="button" onClick={() => void moveSub(s.id, 'down')}
                          disabled={i === subs.length - 1} style={btn()}>下移</button>
                        <button type="button" onClick={() => setEditing({ id: s.id, name: s.name, url: s.url })}
                          style={btn()}>修改</button>
                        <button type="button" onClick={() => void removeSub(s.id, s.name)}
                          style={{ ...btn(), color: '#ff7676', borderColor: '#5a3038' }}>删除</button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ===== tab: 本地源 ===== */}
        {tab === 'local' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 13, color: '#8a9099' }}>
                已导入的本地源（{locals.length}）
              </div>
              <button type="button" onClick={() => void loadLocals()} style={btn()}>刷新</button>
            </div>
            <div style={{ border: '1px solid #2a2f3a', borderRadius: 8, overflow: 'hidden' }}>
              {locals.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: '#888', fontSize: 12 }}>
                  暂无本地源。可在「导入」标签页点「📁 本地文件」导入。
                </div>
              ) : locals.map((s, i) => (
                <div key={s.api} style={{
                  display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px',
                  borderBottom: i < locals.length - 1 ? '1px solid #232833' : 'none',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13 }}>
                      {s.name}
                      {!s.fileExists && (
                        <span style={{ marginLeft: 6, fontSize: 11, color: '#ffb74d' }}>
                          （本地文件已缺失，建议删除）
                        </span>
                      )}
                    </div>
                    <div style={{
                      fontSize: 11, color: '#8a9099',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={s.api}>
                      文件：{s.fileName}
                    </div>
                  </div>
                  <button type="button" onClick={() => void removeLocal(s.api, s.name)}
                    style={{ ...btn(), color: '#ff7676', borderColor: '#5a3038' }}>删除</button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
