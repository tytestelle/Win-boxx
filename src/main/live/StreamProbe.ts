// src/main/live/StreamProbe.ts
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export type StreamKind = 'hls' | 'flv' | 'mp4' | 'ts' | 'rtmp' | 'rtsp' | 'unknown';

export interface ProbeResult {
  kind: StreamKind;
  contentType?: string;
  error?: string;
}

/**
 * 使用 ffprobe 探测流地址的真实类型
 * 超时 8 秒，失败不抛异常，返回 { kind: 'unknown' } 让上层决定如何处理
 */
export async function probeStream(url: string): Promise<ProbeResult> {
  const timeoutMs = 8000;
  try {
    // -v quiet: 不输出日志；-print_format json: 输出 JSON；-show_streams: 显示流信息
    // -analyzeduration / -probesize: 控制探测精度，直播流建议调小以加快速度
    const { stdout } = await execAsync(
      `ffprobe -v quiet -print_format json -show_streams -analyzeduration 2000000 -probesize 2048000 "${url}"`,
      { timeout: timeoutMs },
    );

    const info = JSON.parse(stdout);
    const streams = info.streams || [];
    if (streams.length === 0) {
      return { kind: 'unknown', error: 'ffprobe 未返回任何流信息' };
    }

    // 1. 优先看容器格式
    const formatName = (info.format?.format_name || '').toLowerCase();
    if (formatName.includes('m3u8') || formatName.includes('hls')) {
      return { kind: 'hls', contentType: 'application/vnd.apple.mpegurl' };
    }
    if (formatName.includes('flv')) {
      return { kind: 'flv' };
    }
    if (formatName.includes('mp4') || formatName.includes('mov')) {
      return { kind: 'mp4' };
    }
    if (formatName.includes('mpegts')) {
      return { kind: 'ts' };
    }

    // 2. 看编码器/流类型（兜底）
    const hasVideo = streams.some((s: any) => s.codec_type === 'video');
    const hasAudio = streams.some((s: any) => s.codec_type === 'audio');
    if (hasVideo || hasAudio) {
      // 有音视频流但格式未知，先当 TS 处理（很多 IPTV 裸流是 MPEG-TS）
      return { kind: 'ts' };
    }

    return { kind: 'unknown' };
  } catch (e) {
    const err = e as Error & { stderr?: string };
    // ffprobe 常见错误：Protocol not found（协议不支持）、Connection refused（连不上）
    const msg = err.stderr || err.message || String(e);
    if (msg.includes('Protocol not found')) {
      // 可能是 rtmp/rtsp 等 ffprobe 不直接支持的协议，让上层用扩展名判断
      if (/^rtmp:/i.test(url)) return { kind: 'rtmp' };
      if (/^rtsp:/i.test(url)) return { kind: 'rtsp' };
    }
    return { kind: 'unknown', error: msg.slice(0, 200) };
  }
}
