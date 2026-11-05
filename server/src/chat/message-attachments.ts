/**
 * 消息附件统一形状与归一化（多附件，UX-10 扩展）。
 *
 * 落库双轨：
 * - `messages.attachments`（Json 数组）是新链路**唯一真相**：`[{url,name,size,ext}]`
 * - 旧三字段 attachmentUrl/Name/Type 保留为「首个附件」的兼容投影（旧前端 / 旧 MCP
 *   消费者、以及 2026-11-05 之前的历史行不受影响）
 *
 * 所有读取方（chat DTO / platform-mcp chat_history / worker-dispatcher）**必须**经
 * normalizeMessageAttachments 取数组，禁止各自手搓三字段回退——否则形状漂移（本列优先、
 * 三字段兜底）会在某一条链路上静默丢附件。
 *
 * @module chat/message-attachments
 */
import type { Prisma } from '@prisma/client';
import { repairMultipartText } from '../uploads/filename-encoding';

/** 单条消息最多附件数（服务端硬上限；前端 message-input 用同值先行拦截）。 */
export const MAX_MESSAGE_ATTACHMENTS = 10;

/** 消息附件元数据（与 POST /uploads 响应 `{url,name,size,ext}` 同形）。 */
export interface MessageAttachmentMeta {
  /** 可访问 URL：/uploads/... 相对路径（外链 http(s) 原样保留）。 */
  url: string;
  /** 原始文件名（含扩展名；拿不到时回落 url basename）。 */
  name: string;
  /** 字节数；来源拿不到字节数时缺省（不落 0，避免前端显示 0 B）。 */
  size?: number;
  /** 小写扩展名（无扩展名 → 空串，供前端判定图片内嵌/文件下载）。 */
  ext: string;
}

/** 参与归一化的消息行子集（Prisma Message row / 任何 DTO 都可传入）。 */
export interface MessageAttachmentRow {
  attachments?: Prisma.JsonValue | null;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  attachmentType?: string | null;
}

/** 显式扩展名优先；缺失/非法时从文件名派生（`报告.PDF` → `pdf`）。 */
function normalizeExt(ext: unknown, name: string): string {
  if (typeof ext === 'string') {
    const cleaned = ext.trim().toLowerCase().replace(/^\./, '');
    if (cleaned) return cleaned;
  }
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 显式附件数组 → 规范化数组：
 * - 非法条目（非对象 / 缺 url）丢弃；
 * - 按 url 去重（同文件重复上传只保留一条）；
 * - 截断到 MAX_MESSAGE_ATTACHMENTS。
 */
export function normalizeAttachmentList(
  list: unknown,
): MessageAttachmentMeta[] {
  if (!Array.isArray(list)) return [];
  const out: MessageAttachmentMeta[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!url || seen.has(url)) continue;
    // 文件名修复（latin1/UTF-8 错位）：multipart 中文名曾以乱码形态落库/落广播，
    // 读取侧统一修复 ⇒ 历史脏数据刷新后即恢复正常（新写路径在 uploads.describe 已修）。
    const rawName =
      typeof item.name === 'string' && item.name.trim()
        ? item.name.trim()
        : url.split(/[\\/]/).pop() || 'attachment';
    const name = repairMultipartText(rawName);
    const meta: MessageAttachmentMeta = {
      url,
      name,
      ext: normalizeExt(item.ext ?? item.type, name),
    };
    if (
      typeof item.size === 'number' &&
      Number.isFinite(item.size) &&
      item.size > 0
    ) {
      meta.size = Math.trunc(item.size);
    }
    out.push(meta);
    seen.add(url);
    if (out.length >= MAX_MESSAGE_ATTACHMENTS) break;
  }
  return out;
}

/**
 * 消息行 → 附件数组：`attachments` 列优先；列缺失/非法/为空时回退旧三字段单元素；
 * 两者都没有 → `[]`（无附件消息零成本）。
 */
export function normalizeMessageAttachments(
  row: MessageAttachmentRow,
): MessageAttachmentMeta[] {
  const fromColumn = normalizeAttachmentList(row.attachments);
  if (fromColumn.length > 0) return fromColumn;
  const url =
    typeof row.attachmentUrl === 'string' ? row.attachmentUrl.trim() : '';
  if (!url) return [];
  return normalizeAttachmentList([
    {
      url,
      name: row.attachmentName ?? undefined,
      ext: row.attachmentType ?? undefined,
    },
  ]);
}

/**
 * 附件数组 → Prisma Json 写入值（undefined 字段显式剔除，避免 Prisma JSON 序列化踩
 * `undefined`）。空数组 → undefined（不写列）。
 */
export function toStoredAttachments(
  list: MessageAttachmentMeta[],
): Prisma.InputJsonValue | undefined {
  if (list.length === 0) return undefined;
  return list.map((item) => {
    const stored: Record<string, string | number> = {
      url: item.url,
      name: item.name,
      ext: item.ext,
    };
    if (item.size !== undefined) stored.size = item.size;
    return stored;
  }) as Prisma.InputJsonValue;
}

/**
 * 附件数组 → 旧三字段投影（= 首个附件；create 时与新列**双写**，保证旧读路径不炸）。
 * 空数组 → 空对象（调用方用 spread 决定是否携带）。
 */
export function legacyAttachmentFields(list: MessageAttachmentMeta[]): {
  attachmentUrl?: string;
  attachmentName?: string;
  attachmentType?: string;
} {
  const first = list[0];
  if (!first) return {};
  return {
    attachmentUrl: first.url,
    attachmentName: first.name,
    attachmentType: first.ext,
  };
}
