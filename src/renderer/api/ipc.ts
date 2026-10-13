// src/renderer/api/ipc.ts
// 通用 IPC 桥。优先 winboxIpc（我们在 preload 里新加的），兼容其它常见命名。
export function ipcInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const w = window as any;
  const bridge =
    (w?.winboxIpc?.invoke && w.winboxIpc.invoke.bind(w.winboxIpc)) ||
    (w?.electron?.ipcRenderer?.invoke && w.electron.ipcRenderer.invoke.bind(w.electron.ipcRenderer)) ||
    (w?.api?.invoke && w.api.invoke.bind(w.api)) ||
    (w?.electronAPI?.invoke && w.electronAPI.invoke.bind(w.electronAPI)) ||
    (w?.ipcRenderer?.invoke && w.ipcRenderer.invoke.bind(w.ipcRenderer)) ||
    (w?.fm?.invoke && w.fm.invoke.bind(w.fm));
  if (!bridge) {
    return Promise.reject(
      new Error(
        `IPC 桥不可用：无法调用 ${channel}。请在 preload 里通过 contextBridge 暴露 winboxIpc.invoke（见下方说明）。`,
      ),
    );
  }
  return bridge(channel, ...args) as Promise<T>;
}
