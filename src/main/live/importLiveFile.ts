// src/main/live/importLiveFile.ts
// 从**本地文件路径**导入一条直播源线路（TXT / M3U）。
// 抽出的公共逻辑：既被「配置页 · 导入直播源」按钮使用，也被「网络直播订阅源下载完成后」复用。
//
// ★ 关键：注册到 lives 的 api 必须是本机 /file 路由
//   （`http://127.0.0.1:9978/file/local-live/<文件名>`），
//   这条路径是直播页加载器唯一认得的本地直播源形态；直接用 `file:///` 会被引擎当成不支持的 url
//   （现象：直播页顶部下拉能看到线路名，但点进去「无直播（请先导入含 lives 的配置）」）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as iconv from 'iconv-lite';
import { LOCAL_PROXY_BASE } from '../../shared/constants';
import { parseLive } from '../../engine/config/LiveConfigParser';
import { localLiveUrl, looksLikeLiveSourceText, sanitizeLiveFileName } from '../../engine/live/localLive';
import { nameFromLocalFile } from '../util/importNaming';
import { userDataDir } from '../util/paths';
import type { LiveBean } from '../../shared/types';
import type { SpiderHost } from '../spider/SpiderHost';

export interface ImportLiveFileOptions {
  /** 覆盖默认 name（默认取源文件名去扩展名）；网络订阅源传 `【订阅】xxx` 以区分展示 */
  customName?: string;
  /**
   * 覆盖落到 <userData>/local-live/ 下的文件名（默认取 basename(srcPath)）；
   * 网络订阅源用稳定文件名 `sub-<id>.<ext>` 便于后续 replaced 命中同一线路。
   */
  stableFileName?: string;
}

export interface ImportLiveFileResult {
  ok: boolean;
  /** 注册的线路名（LiveBean.name） */
  name?: string;
  /** 写入的线路下标 */
  index?: number;
  /** true = 覆盖了同 url 已有条目（同一文件重导时命中） */
  replaced?: boolean;
  /** 当前 lives 总数 */
  total?: number;
  /** 注册到 lives 的 api（= `http://127.0.0.1:9978/file/local-live/<文件名>`） */
  api?: string;
  /** 失败原因 */
  error?: string;
}

/**
 * 从本地文件路径导入直播源。
 * - 校验内容形态（#EXTM3U / #genre# / 「频道,http…」至少其一）
 * - 统一转 UTF-8 落盘到 <userData>/local-live/<文件名>
 * - 走 host.cfgAddLive(parseLive({name, api:'', type:'0', url: localLiveUrl(...)}))
 *   → 同名 url 时覆盖（replaced=true），保证重复导入同一文件不会产生重复线路。
 */
export function importLiveFileFromPath(
  host: SpiderHost,
  srcPath: string,
  opts: ImportLiveFileOptions = {},
): ImportLiveFileResult {
  try {
    const buf = readFileSync(srcPath);
    if (!buf.length) return { ok: false, error: '文件为空' };
    // 编码检测：GBK 直播源被 UTF-8 解码后有两种表现——
    //   (a) 出现替换字符 \uFFFD（非法 UTF-8 序列）
    //   (b) 无替换字符，但解出的是拉丁扩展乱码（如「æµ‹è¯•」）
    // 因此不能只看 \uFFFD；改为比较 UTF-8 与 GB18030 解码结果中的 CJK 字符数，取更优者。
    let text = buf.toString('utf-8');
    const utf8Cjk = (text.match(/[\u4E00-\u9FFF]/g) || []).length;
    const utf8NonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
    if (utf8NonAscii > 0 && utf8Cjk / utf8NonAscii < 0.5) {
      try {
        const gbkText = iconv.decode(buf, 'gb18030');
        const gbkCjk = (gbkText.match(/[\u4E00-\u9FFF]/g) || []).length;
        if (gbkCjk > utf8Cjk) text = gbkText;
      } catch {
        /* 解码失败则保留 UTF-8 结果 */
      }
    }
    if (!looksLikeLiveSourceText(text)) {
      return {
        ok: false,
        error:
          '内容不像 TXT / M3U 直播源（需要 #EXTM3U 头、#genre# 分组行，或「频道名,http…」频道行）',
      };
    }
    const dir = join(userDataDir(), 'local-live');
    mkdirSync(dir, { recursive: true });
    const fileName = sanitizeLiveFileName(opts.stableFileName || basename(srcPath));
    // 归一化为 UTF-8 落盘（/file 路由固定按 text/plain; charset=utf-8 输出，
    // 若存原始 GBK 字节会在直播页解码成乱码；文本在上一段已统一解码）
    writeFileSync(join(dir, fileName), Buffer.from(text, 'utf-8'));
    const name = (opts.customName || '').trim() || nameFromLocalFile(srcPath);
    const api = localLiveUrl(LOCAL_PROXY_BASE, fileName);
    const bean: LiveBean = parseLive({ name, api: '', type: '0', url: api }, 0);
    const r = host.cfgAddLive(bean);
    return { ok: true, name, index: r.index, replaced: r.replaced, total: host.lives.length, api };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
