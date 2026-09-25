/**
 * serve 日志捕获/解析（从 opencode-server 拆出，单一职责：日志 ≠ 进程生命周期）。
 *
 * 背景（2026-09-17 实测）：opencode serve 默认把诊断日志写
 * `$XDG_DATA_HOME/opencode/log/opencode.log`（**文件，不是 stderr**），stdout/stderr 只有启动
 * banner（`listening on ...` 在 stdout）。因此必须靠 spawn 参数 `--print-logs` 把诊断行引到
 * stderr（进环形缓冲），并以日志文件为**次级**源兜底。
 *
 * 本模块只做无状态纯函数：错误行判定、会话归属过滤、文件尾部读取、默认路径推导。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * serve 日志中的模型调用错误关键词（**收集/证据口径，宽**）。serve 对部分 APIError
 * （Rate limit exceeded / Free usage exceeded 等）不透传 message.info.error——worker 靠该表
 * 收集候选行，供失败证据与基线使用。
 *
 * ⚠️ 粗筛单独用会产生误报：实测 34,139 行日志中裸 `429` 命中 161 条 **INFO** 行
 * （`messageID=msg_0a429eb…` 里的数字碰巧命中）。故 `isServeErrorLine` 追加**结构化错误门**。
 *
 * ⚠️ 本表**只决定"收集哪些行"**，不决定"是否 abort"——abort 判据是下方 SERVE_FATAL_KEYWORDS。
 * 保持宽口径：`stream error`（外层包装）、裸 `429`、`subscribe`（子域 share subscriber 失败）
 * 都收，供全局尸检；把宽表直接当 abort 判据会误杀健康会话（2026-09-22 线上事故）。
 */
export const SERVE_ERROR_KEYWORDS = /stream error|AI_APICallError|Rate limit|Free usage|quota|Invalid API key|Unauthorized|429|subscribe/i;

/**
 * 致命关键词（**abort 判据专用，严**，2026-09-22 误杀复查后从宽表中拆出）。
 * 只认**具体原因**，不认包装/泛化词——避免把仍在跑的会话 abort 掉：
 * - 不含 `stream error`：AI-SDK 通用外层包装，真原因在同行 `error.error="AI_APICallError: …"`；
 *   瞬时流中断被内核重试后会话照常继续产出（现象：`等待首字超时：模型调用报错：stream error`
 *   而会话仍在跑）；
 * - 不含 `subscribe`：唯一已知形态是子域 `share subscriber failed`，主循环存活可自恢复、
 *   永不 abort（线上 08:18 一行双杀 PM+architect 根因），故它只该进证据、不该致命；
 * - `429` 要求 HTTP 状态语义：结构化门只挡得住 INFO 行，`level=ERROR` 行里随机 id
 *   （`messageID=msg_0a429eb…`）碰巧含 `429` 仍会中招。
 */
export const SERVE_FATAL_KEYWORDS =
  /AI_APICallError|Rate limit|Free usage|quota|Invalid API key|Unauthorized|429\s+Too\s+Many\s+Requests|status(?:Code)?["'\s]*[:=]["'\s]*429\b/i;

/** 结构化错误门之一：opencode 日志级别字段（真实模型错误恒为 ERROR）。 */
const SERVE_ERROR_LEVEL_RE = /\blevel=ERROR\b/;
/** 结构化错误门之二：显式错误字段（`error.error="AI_APICallError: …"` 等）。 */
const SERVE_ERROR_FIELD_RE = /\berror\.(error|name|message|code)=/;
/** serve 会话归属字段（`session.id=ses_…`；prompt_async 失败行用 `sessionID=ses_…` 无点形态）；用于剔除其它会话的历史错误（stale 隔离）。 */
const SESSION_ID_RE = /session\.?id=(\S+)/i;
/** 日志文件尾部读取上限（只读最近 64KB，避免把 100MB+ 日志整体载入内存）。 */
export const SERVE_LOG_TAIL_BYTES = 64 * 1024;

/**
 * serve 日志文件的默认路径（次级错误源）：opencode 把诊断日志写
 * `$XDG_DATA_HOME/opencode/log/opencode.log`（XDG_DATA_HOME 缺省 `~/.local/share`）。
 * 文件缺失 → 读取静默返回空数组（降级不报错）。
 */
export function defaultServeLogFilePath(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base = xdg && xdg !== '' ? xdg : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode', 'log', 'opencode.log');
}

/**
 * 判断一行 serve 日志是否为**真正的模型调用错误**：关键词粗筛 + 结构化错误门。
 * 只靠关键词会误伤正常 INFO 行（见 SERVE_ERROR_KEYWORDS 注释）。
 */
export function isServeErrorLine(line: string): boolean {
  if (!SERVE_ERROR_KEYWORDS.test(line)) {
    return false;
  }
  return SERVE_ERROR_LEVEL_RE.test(line) || SERVE_ERROR_FIELD_RE.test(line);
}

/** 行是否属于指定会话：无 `session.id=` 的全局行与任何会话相关；指定会话时剔除其它会话行。 */
export function lineBelongsToSession(line: string, sessionID?: string): boolean {
  if (!sessionID) {
    return true;
  }
  const match = SESSION_ID_RE.exec(line);
  return match === null || match[1] === sessionID;
}

/**
 * 行是否明确归属指定会话（无归属字段 → false）。
 * recentErrors（abort 快检数据源）专用严格版：无 session.id/sessionID 的行
 * （如子 agent 的 share subscriber 失败行）不得通配到任意会话，否则一次子域
 * 失败会秒杀所有在途会话的主 agent（线上实测：08:18 一行无归属行双杀 PM+architect）。
 * recentLogTail（失败证据附原文）仍用宽松版；无 sessionID 参数时恒 true（全局尸检用）。
 */
export function lineBelongsToSessionStrict(line: string, sessionID?: string): boolean {
  if (!sessionID) {
    return true;
  }
  const match = SESSION_ID_RE.exec(line);
  return match !== null && match[1] === sessionID;
}

/** 无条件接受（原始日志尾部用：不过滤内容，只按会话归属）。 */
export function isAnyLine(): boolean {
  return true;
}

/**
 * 读取日志文件尾部若干行（最多 maxBytes 字节）。文件缺失/不可读/为空 → []（静默降级）。
 * 起始位置非 0 时丢弃首行（可能是被截断的半行）。
 */
export function readFileTailLines(filePath: string, maxBytes = SERVE_LOG_TAIL_BYTES): string[] {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) {
      return [];
    }
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, length, start);
    const lines = buf.toString('utf8').split(/\r?\n/);
    return start > 0 ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关闭失败不影响结果（只读句柄，进程退出即回收）
      }
    }
  }
}
