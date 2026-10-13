import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { client } from '../api/client';
import type { LiveGroup, LiveBean, LiveEpgEntry, EpgChannelRef } from '../../shared/types';
import VideoPlayer from '../components/VideoPlayer';
import { splitLine } from '../../engine/live/LiveUtils';

// ... 记忆相关
// ... 日期相关

// 归一化辅助
function looksLikeStreamEndpoint(url: string): boolean { ... }
function normalizeLiveUrl(url: string): string { ... }

// LiveVideoWrapper：监听 video 事件

export default function LivePage() {
  // ... 状态

  // URL 状态：原始 vs 归一化
  const [playbackUrl, setPlaybackUrl] = useState(playUrl);
  const triedNormalizedRef = useRef(false);
  const normalizedCandidate = useMemo(() => normalizeLiveUrl(playUrl), [playUrl]);

  useEffect(() => {
    setPlaybackUrl(playUrl);
    triedNormalizedRef.current = false;
  }, [playUrl]);

  // 播放错误处理
  const handleVideoError = useCallback((msg: string) => {
    if (msg.includes('SRC_NOT_SUPPORTED') && !triedNormalizedRef.current && normalizedCandidate !== playUrl) {
      console.warn('[LIVE] 源不支持，尝试归一化 URL 重试');
      triedNormalizedRef.current = true;
      setPlaybackUrl(normalizedCandidate);
      return;
    }
    if (msg) setReconnectMsg(msg);
  }, [playUrl, normalizedCandidate]);

  // EPG 弹窗
  async function openPrograms(channel: { name: string; 'tvg-id'?: string; 'tvg-name'?: string }) {
    const keys = [channel['tvg-id'], channel['tvg-name'], channel.name]
      .map((k) => (k || '').trim())
      .filter((k) => !!k);
    if (!keys.length) return;
    setProgramsChannel(channel.name);
    setProgramsOpen(true);
    setProgramsLoading(true);
    setProgramsList([]);
    try {
      const raw = await client.epgPrograms(keys);
      // ...
    }
  }

  // 手动重连
  const manualReconnect = useCallback(() => {
    reconnectCountRef.current = 0;
    lastReconnectAtRef.current = 0;
    triedNormalizedRef.current = false;
    setReconnectMsg('手动重连中…');
    setPlaybackUrl(playUrl);
    setReconnectKey((k) => k + 1);
    setTimeout(() => setReconnectMsg(''), 1500);
  }, [playUrl]);

  // 自动重连
  const doReconnect = useCallback(() => {
    const now = Date.now();
    if (now - lastReconnectAtRef.current < 3000) return;
    lastReconnectAtRef.current = now;
    reconnectCountRef.current += 1;
    const n = reconnectCountRef.current;
    if (n > MAX_RECONNECT) {
      setReconnectMsg(`已连续重连 ${MAX_RECONNECT} 次仍失败，请手动刷新`);
      return;
    }
    setReconnectMsg(`断线重连中…（第 ${n} 次）`);
    setReconnectKey((k) => k + 1);
    setTimeout(() => {
      setReconnectMsg((cur) => (cur.startsWith('断线重连中') ? '' : cur));
    }, 3000);
  }, []);

  // render
}
