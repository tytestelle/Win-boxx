// src/shared/epgWin.ts
// EPG（节目单）独立窗口的 URL 构造（纯函数，主进程与渲染层共用）。
// 与 detailWin/searchWin 同一约定：主进程 loadFile 时把返回值塞到 `hash` 参数里。
export interface EpgWindowParams {
  channelName: string;
  tvgId?: string;
  tvgName?: string;
}

/** 生成 `#/epg-window?...` 的 hash（不含 `#`） */
export function epgWindowRoute(p: EpgWindowParams): string {
  const q = new URLSearchParams();
  q.set('name', String(p.channelName || '').trim());
  const id = String(p.tvgId || '').trim();
  const tn = String(p.tvgName || '').trim();
  if (id) q.set('tvgId', id);
  if (tn) q.set('tvgName', tn);
  return `/epg-window?${q.toString()}`;
}
