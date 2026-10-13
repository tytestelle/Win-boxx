// src/renderer/components/LiveSubscriptionPanel.tsx
// 网络直播订阅源管理面板（挂在「配置页 → 直播订阅源」标签）。
// 支持：添加 / 编辑 / 删除 / 上移 / 下移 / 置顶 / 置底 / 启停 / 立即刷新。
import { useCallback, useEffect, useState } from 'react';
import type { LiveSubscription, LiveSubscriptionRefreshResult } from '../../shared/types';
import { ipcInvoke } from '../api/ipc';

interface EditState {
  id: string;
  name: string;
  url: string;
}

const btnStyle = (primary = false): React.CSSProperties => ({
  padding: '4px 10px',
  borderRadius: 6,
  border: `1px solid ${primary ? '#4ec9ff' : '#3a4150'}`,
  background: primary ? 'rgba(78,201,255,0.12)' : 'rgba(255,255,255,0.06)',
  color: primary ? '#4ec9ff' : '#e6e6e6',
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
});

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid #333944',
  background: '#0f1218',
  color: '#e6e6e6',
  fontSize: 13,
};

export default function LiveSubscriptionPanel() {
  const [subs, setSubs] = useState<LiveSubscription[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [editing, setEditing] = useState<EditState | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const list = await ipcInvoke<LiveSubscription[]>('live:subscription:list');
      setSubs(Array.isArray(list) ? list : []);
    } catch (e) {
      setErr((e as Error)?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function onAdd() {
    const name = formName.trim();
    const url = formUrl.trim();
    if (!name || !url) { window.alert('请填写「名称」与「订阅链接」'); return; }
    try {
      await ipcInvoke('live:subscription:add', name, url);
      setFormName('');
      setFormUrl('');
      await load();
    } catch (e) {
      window.alert(`添加失败：${(e as Error)?.message || String(e)}`);
    }
  }

  async function onRemove(id: string, name: string) {
    if (!window.confirm(`确定删除订阅源「${name}」？`)) return;
    try {
      await ipcInvoke('live:subscription:remove', id);
      await load();
    } catch (e) {
      window.alert(`删除失败：${(e as Error)?.message || String(e)}`);
    }
  }

  async function onToggle(id: string, enabled: boolean) {
    try {
      await ipcInvoke('live:subscription:toggle', id, enabled);
      await load();
    } catch (e) {
      window.alert(`切换失败：${(e as Error)?.message || String(e)}`);
    }
  }

  async function onMove(id: string, dir: 'up' | 'down' | 'top' | 'bottom') {
    try {
      const next = await ipcInvoke<LiveSubscription[]>('live:subscription:move', id, dir);
      setSubs(Array.isArray(next) ? next : subs);
    } catch (e) {
      window.alert(`移动失败：${(e as Error)?.message || String(e)}`);
    }
  }

  function startEdit(s: LiveSubscription) {
    setEditing({ id: s.id, name: s.name, url: s.url });
  }
  function cancelEdit() { setEditing(null); }

  async function saveEdit() {
    if (!editing) return;
    const name = editing.name.trim();
    const url = editing.url.trim();
    if (!name || !url) { window.alert('名称和链接都不能为空'); return; }
    try {
      await ipcInvoke('live:subscription:update', editing.id, { name, url });
      setEditing(null);
      await load();
    } catch (e) {
      window.alert(`保存失败：${(e as Error)?.message || String(e)}`);
    }
  }

  async function onRefreshAll() {
    setRefreshing(true);
    setMsg('');
    try {
      const results = await ipcInvoke<LiveSubscriptionRefreshResult[]>('live:subscription:refreshAll');
      let ok = 0, fail = 0;
      for (const r of results || []) {
        if (r.ok) ok++;
        else if (r.error !== '已停用') fail++;
      }
      setMsg(`刷新完成：成功 ${ok} / 失败 ${fail}`);
      await load();
    } catch (e) {
      setMsg(`刷新失败：${(e as Error)?.message || String(e)}`);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div style={{ color: '#e6e6e6' }}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>网络直播订阅源</div>
      <div style={{ fontSize: 12, color: '#8a9099', marginBottom: 14, lineHeight: 1.6 }}>
        自定义名称 + 订阅链接，支持 <code>.m3u / .m3u8 / .txt / .json</code>（无后缀默认按 m3u 解析）。
        每次进入「直播」页会自动联网刷新全部启用的订阅源；列表顺序即频道展示顺序。
      </div>

      {err && (
        <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,90,90,0.12)', color: '#ff7676', fontSize: 13, marginBottom: 12 }}>
          {err}
        </div>
      )}

      {/* 添加表单 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          value={formName}
          onChange={(e) => setFormName(e.target.value)}
          placeholder="自定义名称（如：我的央视源）"
          style={{ ...inputStyle, flex: '1 1 180px', minWidth: 140 }}
        />
        <input
          value={formUrl}
          onChange={(e) => setFormUrl(e.target.value)}
          placeholder="订阅链接（http/https，支持 .m3u / .m3u8 / .txt / .json）"
          style={{ ...inputStyle, flex: '2 1 320px', minWidth: 220 }}
        />
        <button type="button" onClick={onAdd} style={btnStyle(true)}>添加</button>
      </div>

      {/* 列表 */}
      <div style={{ border: '1px solid #2a2f3a', borderRadius: 8, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#888', fontSize: 13 }}>加载中…</div>
        ) : subs.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#888', fontSize: 13 }}>
            暂无订阅源。填写上方「名称 + 链接」后点「添加」。
          </div>
        ) : (
          subs.map((s, i) => {
            const isEditing = editing?.id === s.id;
            return (
              <div
                key={s.id}
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'center',
                  padding: '10px 12px',
                  borderBottom: i < subs.length - 1 ? '1px solid #232833' : 'none',
                  background: isEditing ? 'rgba(78,201,255,0.06)' : 'transparent',
                }}
              >
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={(e) => onToggle(s.id, e.target.checked)}
                  title={s.enabled ? '已启用，点击停用' : '已停用，点击启用'}
                  style={{ flex: '0 0 auto' }}
                />

                {isEditing ? (
                  <>
                    <input
                      value={editing!.name}
                      onChange={(e) => setEditing({ ...editing!, name: e.target.value })}
                      style={{ ...inputStyle, flex: '1 1 140px', minWidth: 100 }}
                    />
                    <input
                      value={editing!.url}
                      onChange={(e) => setEditing({ ...editing!, url: e.target.value })}
                      style={{ ...inputStyle, flex: '2 1 220px', minWidth: 160 }}
                    />
                    <button type="button" onClick={saveEdit} style={btnStyle(true)}>保存</button>
                    <button type="button" onClick={cancelEdit} style={btnStyle()}>取消</button>
                  </>
                ) : (
                  <>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13 }}>
                        {s.name}
                        {!s.enabled && <span style={{ marginLeft: 8, fontSize: 11, color: '#888' }}>（已停用）</span>}
                      </div>
                      <div
                        style={{ fontSize: 11, color: '#8a9099', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={s.url}
                      >
                        {s.url}
                      </div>
                      <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                        {s.lastUpdated ? `更新于 ${new Date(s.lastUpdated).toLocaleString()}` : '尚未更新'}
                        {s.lastError ? ` · 错误：${s.lastError}` : ''}
                      </div>
                    </div>

                    {/* 排序与操作按钮组 */}
                    <div style={{ display: 'flex', gap: 4, flex: '0 0 auto' }}>
                      <button type="button" onClick={() => onMove(s.id, 'up')} disabled={i === 0} style={{ ...btnStyle(), opacity: i === 0 ? 0.4 : 1 }} title="上移">↑</button>
                      <button type="button" onClick={() => onMove(s.id, 'down')} disabled={i === subs.length - 1} style={{ ...btnStyle(), opacity: i === subs.length - 1 ? 0.4 : 1 }} title="下移">↓</button>
                      <button type="button" onClick={() => onMove(s.id, 'top')} disabled={i === 0} style={{ ...btnStyle(), opacity: i === 0 ? 0.4 : 1 }} title="置顶">⤒</button>
                      <button type="button" onClick={() => onMove(s.id, 'bottom')} disabled={i === subs.length - 1} style={{ ...btnStyle(), opacity: i === subs.length - 1 ? 0.4 : 1 }} title="置底">⤓</button>
                      <button type="button" onClick={() => startEdit(s)} style={btnStyle()}>编辑</button>
                      <button
                        type="button"
                        onClick={() => onRemove(s.id, s.name)}
                        style={{ ...btnStyle(), borderColor: '#5a2a2a', background: 'rgba(255,90,90,0.12)', color: '#ff7676' }}
                      >删除</button>
                    </div>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 底部操作 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
        <button
          type="button"
          onClick={onRefreshAll}
          disabled={refreshing || subs.length === 0}
          style={{ ...btnStyle(true), padding: '6px 16px', fontSize: 13, opacity: subs.length === 0 ? 0.5 : 1 }}
        >
          {refreshing ? '刷新中…' : '立即刷新全部'}
        </button>
        {msg && <span style={{ fontSize: 12, color: '#8a9099' }}>{msg}</span>}
      </div>
    </div>
  );
}
