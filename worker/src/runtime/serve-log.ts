/**
 * serve 日志捕获/解析（从 opencode-server 拆出，单一职责：日志 ≠ 进程生命周期）。
 *
 * 背景（2026-09-17 实测）：opencode serve 默认把诊断日志写
 * `$XDG_DATA_HOME/opencode/log/opencode.log`（**文件，不是 stderr**），stdout/stderr 只有启动
 * banner（`listening on ...` 在 stdout）。因此必须靠 spawn 参数 `--print-logs` 把诊断行引到
 * stderr（进环形缓冲），并以日志文件为**次级**源兜底。
 *
 * 本模块只做无状态纯函数：错误行判定、会话归属过滤、文件尾部读取、默认路径推导。
 *
 * ⚠️ v2 的**配置归一化诊断**（本模块新增的一段能力）：opencode v2 接受 v1 形配置并
 * **静默归一化**——不支持的 legacy 键被丢弃，只在日志里留一行 `level=WARN`。
 * 对 vteam 而言这是最危险的降级信号（模型能力声明悄悄消失 → "模型可用但工具调用失败"），
 * 故单列一套识别（见下方 `parseConfigNormalizationDiagnostic`），
 * 与"模型 API 错误"（Rate limit / Free usage / 模型下架）**分类隔离**。
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
 *
 * 模型下架（ProviderModelNotFoundError / `Model not found`）也在此收集：serve 对
 * `prompt_async failed … cause="Cause([Die(ProviderModelNotFoundError: Model not found: …)])"`
 * 同样只写 stderr，worker 需先收集该行才能交给致命判定/失败证据（否则不识别 → 空等首字超时）。
 *
 * ⚠️ **不含** v2 配置归一化诊断——那不是模型调用错误，走独立识别
 * （`parseConfigNormalizationDiagnostic`），分类与处置口径都不同。
 */
export const SERVE_ERROR_KEYWORDS = /stream error|AI_APICallError|Rate limit|Free usage|quota|Invalid API key|Unauthorized|429|subscribe|ProviderModelNotFoundError|Model not found/i;

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
 * - `ProviderModelNotFoundError` / `Model not found`：模型在 provider 中已不存在
 *   （`prompt_async failed … cause="Cause([Die(ProviderModelNotFoundError: Model not found: …)])"`），
 *   重试同一模型必然继续失败，等满首字超时无意义——顶层（会话自身）命中即快速失败。
 *   子域 `share subscriber failed` 形态由下方 isServeFatalLine 排除（子 agent 域失败，主循环存活）。
 */
export const SERVE_FATAL_KEYWORDS =
  /AI_APICallError|Rate limit|Free usage|quota|Invalid API key|Unauthorized|ProviderModelNotFoundError|Model not found|429\s+Too\s+Many\s+Requests|status(?:Code)?["'\s]*[:=]["'\s]*429\b/i;

/** 结构化错误门之一：opencode 日志级别字段（真实模型错误恒为 ERROR）。 */
const SERVE_ERROR_LEVEL_RE = /\blevel=ERROR\b/;
/** 结构化错误门之二：显式错误字段（`error.error="AI_APICallError: …"` 等）。 */
const SERVE_ERROR_FIELD_RE = /\berror\.(error|name|message|code)=/;
/** serve 会话归属字段（`session.id=ses_…`；prompt_async 失败行用 `sessionID=ses_…` 无点形态）；用于剔除其它会话的历史错误（stale 隔离）。 */
const SESSION_ID_RE = /session\.?id=(\S+)/i;
/** 日志文件尾部读取上限（只读最近 64KB，避免把 100MB+ 日志整体载入内存）。 */
export const SERVE_LOG_TAIL_BYTES = 64 * 1024;

/* -------------------------------------------------------------------------- *
 * v2 配置归一化诊断（静默降级的唯一信号——计划 D12 / T7）
 * -------------------------------------------------------------------------- */

/**
 * v2 归一化诊断的**消息关键词**（宽松匹配——该日志文案未文档化，opencode 没给格式契约，
 * 只能"宁可多认不可漏认"，真正的兜底是注入期的写后断言，见 model-credential-injector）。
 */
const CONFIG_NORMALIZATION_MESSAGE_RE =
  /configuration\s+normalization|normalization\s+diagnostic/i;
/**
 * v2 归一化诊断的**动作关键词**（宽松匹配，二级信号）：v2 丢弃 legacy 键时的固定措辞。
 * 即使消息文案改了，只要还留着这句，仍能认出"配置被丢弃"这一事实。
 */
const CONFIG_NORMALIZATION_OMIT_RE =
  /omitted\s+unsupported\s+legacy\s+setting|unsupported\s+legacy\s+setting/i;
/** 日志级别字段（任意级别）——用于排除普通 INFO 行 + 判定诊断级别。 */
const SERVE_LOG_LEVEL_RE = /\blevel=([A-Za-z]+)/;
/** 归一化诊断的被丢弃键路径（`path=$.provider.x.models.y.reasoning`；值可带引号）。 */
const CONFIG_NORMALIZATION_PATH_RE = /\bpath=(?:"([^"]*)"|'([^']*)'|(\S+))/;
/** 归一化诊断的配置文件来源（`source=/path/opencode.json`）。 */
const CONFIG_NORMALIZATION_SOURCE_RE = /\bsource=(?:"([^"]*)"|'([^']*)'|(\S+))/;
/** 归一化诊断的种类（`kind=unsupported`）。 */
const CONFIG_NORMALIZATION_KIND_RE = /\bkind=(?:"([^"]*)"|'([^']*)'|(\S+))/;
/** 归一化诊断的处置动作（`action="omitted unsupported legacy setting"`）。 */
const CONFIG_NORMALIZATION_ACTION_RE = /\baction=(?:"([^"]*)"|'([^']*)'|(\S+))/;

/**
 * 一条 v2 配置归一化诊断（= 一个被静默丢弃的 legacy 配置键）。
 */
export interface ConfigNormalizationDiagnostic {
  /** 被丢弃的键路径（点号路径，如 `$.provider.keta-qwen.models.ornith-1.5:35b.reasoning`）；日志未带 `path=` 字段时为 null */
  keyPath: string | null;
  /** 诊断种类（如 `unsupported`）；缺失为 null */
  kind: string | null;
  /** 处置动作（如 `omitted unsupported legacy setting`）；缺失为 null */
  action: string | null;
  /** 触发归一化的配置文件路径（`source=`）；缺失为 null */
  source: string | null;
  /** 原始日志行（供证据附原文用） */
  raw: string;
}

/** 取 logfmt 字段值（双引号 / 单引号 / 裸值三态）；空值归 null（不返回空串噪声）。 */
function pickLogFieldValue(match: RegExpExecArray | null): string | null {
  if (!match) {
    return null;
  }
  const raw = match[1] ?? match[2] ?? match[3] ?? null;
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 识别一行 serve 日志是否为 **v2 配置归一化诊断**（= v2 静默丢弃了 legacy 配置键）。
 *
 * 真实形态（opencode v2.0.28 实测，逐字）：
 * ```
 * timestamp=2026-10-20T01:37:51.247Z level=WARN run=ce481823 message="configuration normalization diagnostic" source=/…/opencode.json path=$.provider.keta-qwen.models.ornith-1.5:35b.reasoning kind=unsupported action="omitted unsupported legacy setting" http.span=38 role=server
 * ```
 *
 * 判定口径（宽松匹配 + 结构化护栏）：
 * - 命中消息关键词（`configuration normalization` / `normalization diagnostic`）
 *   **或**动作关键词（`omitted unsupported legacy setting`）→ 视为归一化诊断；
 * - `level=INFO` 直接排除（普通 INFO 行不误报；v2 实测诊断为 WARN 级）；
 * - 键路径从 `path=` 字段提取（点号路径），**提取失败返回 null**（不抛错、不崩）。
 *
 * ⚠️ 该行**不是**模型 API 错误：它不表示本轮模型调用失败（模型可能跑得好好的，
 * 只是配置里某个键被静默丢了）。故本函数只负责"认出来 + 点名被丢的键"，
 * 致命判定（abort 口径）见 `isServeFatalLine`。
 */
export function parseConfigNormalizationDiagnostic(
  line: string,
): ConfigNormalizationDiagnostic | null {
  if (!line || typeof line !== 'string') {
    return null;
  }
  const level = SERVE_LOG_LEVEL_RE.exec(line)?.[1]?.toUpperCase() ?? null;
  if (level === 'INFO') {
    // 普通 INFO 行不误报（归一化诊断在 v2 是 WARN 级）
    return null;
  }
  const messageHit = CONFIG_NORMALIZATION_MESSAGE_RE.test(line);
  const actionHit = CONFIG_NORMALIZATION_OMIT_RE.test(line);
  if (!messageHit && !actionHit) {
    return null;
  }
  return {
    keyPath: pickLogFieldValue(CONFIG_NORMALIZATION_PATH_RE.exec(line)),
    kind: pickLogFieldValue(CONFIG_NORMALIZATION_KIND_RE.exec(line)),
    action: pickLogFieldValue(CONFIG_NORMALIZATION_ACTION_RE.exec(line)),
    source: pickLogFieldValue(CONFIG_NORMALIZATION_SOURCE_RE.exec(line)),
    raw: line,
  };
}

/** 该行是否是 v2 配置归一化诊断（`parseConfigNormalizationDiagnostic` 的布尔版）。 */
export function isConfigNormalizationLine(line: string): boolean {
  return parseConfigNormalizationDiagnostic(line) !== null;
}

/**
 * 把归一化诊断渲染成**可操作**的错误文案（点名被丢弃的键路径 + 给出修法）。
 *
 * 面向运维/开发：光说"配置被丢弃"没用，必须能直接照着改。
 */
export function formatConfigNormalizationError(
  diag: ConfigNormalizationDiagnostic,
): string {
  const target = diag.keyPath
    ? `被丢弃的配置键 ${diag.keyPath}`
    : '被丢弃的配置键（该日志行未给出 path= 字段，无法点名具体键）';
  const kind = diag.kind ? `（kind=${diag.kind}）` : '';
  const action = diag.action ? `处置动作：${diag.action}` : '处置动作：未知';
  const source = diag.source ? `；配置文件 ${diag.source}` : '';
  return (
    `opencode v2 配置归一化丢弃了 legacy 设置：${target}${kind}，${action}${source}。` +
    '该键在 v2 已失效——它声明的能力不会生效（模型能力声明消失后表现为"模型可用但工具调用失败"）。' +
    '请把注入的配置改成 v2 形态：provider 段用 package/settings，模型能力用 capabilities.tools/input/output。'
  );
}

/**
 * 顶层致命行判定（**abort 判据**，供 exec-server onServeError 使用）：
 *   1. 排除子域 `share subscriber failed` 行——子 agent 域失败，主循环存活可自恢复，
 *      **永不 abort**（线上 08:18 一行子域 Model-not-found 秒杀 PM+architect 根因）；
 *   2. 结构化错误门：`level=ERROR` 或显式 `error.<field>=` 字段（杜绝正常 INFO 行误触发）；
 *   3. SERVE_FATAL_KEYWORDS 命中具体致命原因。
 * 三段语义与 exec-server 原内联判据完全一致（拆出纯函数仅为可单测）。
 */
export function isServeFatalLine(text: string): boolean {
  if (/share subscriber/i.test(text)) {
    return false;
  }
  if (!SERVE_ERROR_LEVEL_RE.test(text) && !SERVE_ERROR_FIELD_RE.test(text)) {
    return false;
  }
  const fatal = SERVE_FATAL_KEYWORDS.test(text);
  // 配置归一化诊断属**配置错误**（v2 静默丢弃 legacy 键），不是瞬时模型错误：
  // 显式排除——绝不因它 abort 在跑的健康会话（重跑同一份配置必然同样被丢弃）。
  // ⚠️ 只在**没有**明确致命原因时排除：同一行若另带模型错误（error.error="AI_APICallError…"），
  //    以模型错误为准（它才是本轮失败的直接原因）。
  if (isConfigNormalizationLine(text) && !fatal) {
    return false;
  }
  return fatal;
}

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
 *
 * ⚠️ 例外：**v2 配置归一化诊断**（`level=WARN`）也算"错误行"——但它是**配置错误**，
 * 不是模型 API 错误。必须被收集（否则被静默吞掉，没人知道配置被丢了哪些键），
 * 同时又不得进致命口径（`isServeFatalLine` 显式排除），以免把在跑的健康会话误杀。
 */
export function isServeErrorLine(line: string): boolean {
  if (isConfigNormalizationLine(line)) {
    return true;
  }
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
