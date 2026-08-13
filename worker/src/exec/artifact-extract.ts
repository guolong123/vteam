/**
 * worker 侧 doc/file 产出物文件收集（P2/P3：产出物自动归档链路闭环）。
 *
 * worker 零 server 依赖铁律——协议双写，仅实现 doc/file 类型提取（text 类型
 * 内容已在回复 text 中，由 server 端 extractArtifacts 提取即可，worker 无需上送）。
 *
 * 链路：任务完成时从回复文本提取 doc/file 声明 → 解析 fileRef（绝对路径或相对
 * 工作目录）→ 读取文件内容（大小上限防撑爆事件通道）→ 随 task.completed 上送
 * {type, title, fileRef, content}，server 端落盘 uploads 生成可访问 URL。
 */

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/** 单文件读取大小上限（超出跳过内容上送，仅保留 fileRef 占位——server 端/前端降级）。 */
export const MAX_ARTIFACT_FILE_BYTES = 1024 * 1024;

/** 收集到的产出物声明（doc/file，携带读取的文件内容）。 */
export interface FileArtifactDeclaration {
  type: string;
  title: string;
  fileRef: string;
  content?: string;
}

/** XML 实体反转义（<artifact> 标签属性解析）。 */
function decodeXml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * 从回复文本提取 doc/file 产出物声明（JSON 对象 / <artifact> 标签）。
 * 按 type+title+fileRef 去重；仅命中合法声明，普通文本不误报。
 */
export function extractFileArtifacts(text: string): FileArtifactDeclaration[] {
  const out: FileArtifactDeclaration[] = [];
  const seen = new Set<string>();
  const push = (d: FileArtifactDeclaration): void => {
    const key = `${d.type}:${d.title}:${d.fileRef}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(d);
    }
  };
  const jsonRe = /(?<![\w])\{[\s\S]*?"type"\s*:\s*"(?:doc|file)"[\s\S]*?\}/g;
  for (const m of text.matchAll(jsonRe)) {
    try {
      const p = JSON.parse(m[0]) as Record<string, unknown>;
      if (
        p &&
        (p.type === 'doc' || p.type === 'file') &&
        typeof p.title === 'string' &&
        p.title.trim() &&
        typeof p.fileRef === 'string' &&
        p.fileRef.trim()
      ) {
        push({ type: p.type, title: p.title, fileRef: p.fileRef });
      }
    } catch {
      // 非合法 JSON：丢弃不误报
    }
  }
  const tagRe = /<artifact\s+([^>]*)>[\s\S]*?<\/artifact>/g;
  for (const m of text.matchAll(tagRe)) {
    const attrs = new Map<string, string>();
    for (const a of m[1].matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) {
      attrs.set(a[1], decodeXml(a[2]));
    }
    const type = attrs.get('type');
    const title = attrs.get('title');
    const fileRef = attrs.get('fileRef');
    if ((type === 'doc' || type === 'file') && title && fileRef) {
      push({ type, title, fileRef });
    }
  }
  return out;
}

/** 读取声明文件内容：外部 URL/已落盘引用/不存在/超限 → null（跳过内容上送）。 */
async function readArtifactFile(
  fileRef: string,
  directory?: string,
): Promise<string | null> {
  if (/^https?:\/\//i.test(fileRef) || fileRef.startsWith('/uploads/')) {
    return null;
  }
  const candidate = isAbsolute(fileRef)
    ? fileRef
    : join(directory ?? process.cwd(), fileRef);
  try {
    const info = await stat(candidate);
    if (!info.isFile() || info.size > MAX_ARTIFACT_FILE_BYTES) {
      return null;
    }
    return await readFile(candidate, 'utf8');
  } catch {
    return null;
  }
}

/** 提取 doc/file 声明并读取文件内容（读取失败保留 fileRef 占位，不阻断完成回流）。 */
export async function collectFileArtifacts(
  text: string,
  directory?: string,
): Promise<FileArtifactDeclaration[]> {
  const decls = extractFileArtifacts(text);
  const out: FileArtifactDeclaration[] = [];
  for (const d of decls) {
    const content = await readArtifactFile(d.fileRef, directory);
    out.push(content !== null ? { ...d, content } : d);
  }
  return out;
}
