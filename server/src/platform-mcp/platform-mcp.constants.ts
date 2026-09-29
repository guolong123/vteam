/**
 * 平台 MCP 域常量（阶段 1：server 平台 MCP 端点，`.omo/plans/platform-mcp-implementation.md`）。
 *
 * 错误码命名沿用既有约定（大写 SNAKE，随异常响应 code 字段返回）：
 * - 缺少 x-worker-id header / 归属校验失败（该 worker 无对应任务的 Session）→ 403
 * - 任务/频道/产出物/版本不存在 → 404
 * - submit_artifact 参数非法（text 缺 content / doc/file 缺 fileRef）→ 400
 */
import { SECRET_INPUT_BUDGET_MS } from '../questions/questions.constants';

export const PLATFORM_MCP_ERRORS = {
  MISSING_WORKER_ID: 'PLATFORM_MCP_MISSING_WORKER_ID',
  FORBIDDEN: 'PLATFORM_MCP_FORBIDDEN',
  TASK_NOT_FOUND: 'PLATFORM_MCP_TASK_NOT_FOUND',
  CHANNEL_NOT_FOUND: 'PLATFORM_MCP_CHANNEL_NOT_FOUND',
  ARTIFACT_NOT_FOUND: 'PLATFORM_MCP_ARTIFACT_NOT_FOUND',
  VERSION_NOT_FOUND: 'PLATFORM_MCP_VERSION_NOT_FOUND',
  FILE_NOT_FOUND: 'PLATFORM_MCP_FILE_NOT_FOUND',
  ARTIFACT_INVALID: 'PLATFORM_MCP_ARTIFACT_INVALID',
  MEMORY_INVALID: 'PLATFORM_MCP_MEMORY_INVALID',
  /** 任务级/非法记忆 level（session-unification Todo 9：仅 team/global，余者 400，精确 code）。 */
  MEMORY_LEVEL_INVALID: 'MEMORY_LEVEL_INVALID',
  /** team_add_member：目标 Agent 已在团队（未移除）→ 400 重复加入。 */
  AGENT_ALREADY_IN_TEAM: 'PLATFORM_MCP_AGENT_ALREADY_IN_TEAM',
  /** team_add_member：该 Agent 已有 pending 增员申请未确认 → 409 冲突。 */
  PENDING_APPLICATION: 'PLATFORM_MCP_PENDING_APPLICATION',
  /** hook_cancel：hook 行不存在（id/dedupKey 双查均 miss）→ 404。 */
  HOOK_NOT_FOUND: 'PLATFORM_MCP_HOOK_NOT_FOUND',
  /**
   * notify_agent 主 Agent 路由门：非主成员直呼其他非主成员（含 self-notify）→ 403
   * 硬拦（消息不落库不广播）。调用方凭 code 与通用 FORBIDDEN 区分。
   */
  NOTIFY_ROUTING_VIOLATION: 'PLATFORM_MCP_NOTIFY_ROUTING_VIOLATION',
  /**
   * 平台工具权限门（opencode-native-permissions-and-fixes todo 3）：调用方绑定的
   * ExecutionPolicy `tools` 矩阵未授权该工具（显式 deny 或未列入）→ 403。
   *
   * 与通用 FORBIDDEN 区分：那个表示 **归属** 校验失败（worker↔团队↔任务绑定、
   * 实例冒充、DM 端点），本码表示 **能力** 拒绝。调用方（模型/审计）凭 code
   * 即可机器判别「越权」与「不属于我」。fail-closed 语义与理由见
   * `CONTRACT-tool-naming-and-identity.md` §4（身份/角色/矩阵不可解析一律本码 403）。
   */
  TOOL_NOT_PERMITTED: 'PLATFORM_MCP_TOOL_NOT_PERMITTED',
  /** vteam_todo action=done：planId+seq 定位不到步骤 → 404。 */
  PLAN_STEP_NOT_FOUND: 'PLATFORM_MCP_PLAN_STEP_NOT_FOUND',
  /**
   * secret_command 入参非法（模板占位符与 variables 声明不一致 / 变量重名 /
   * cwd 越界或绝对路径 / timeoutSec 越界）→ 400。
   */
  SECRET_COMMAND_INVALID: 'PLATFORM_MCP_SECRET_COMMAND_INVALID',
  /**
   * secret_command 单会话 in-flight 冲突（并发第二次调用）/ worker 幂等归属冲突 → 409。
   *
   * 报文带**上一次在飞请求的实时状态**（phase/已持续秒数/层次标识），因为绝大多数
   * 409 是「上一次请求在客户端等待超时（-32001）后仍在服务端存活」导致的盲目重发，
   * 不给状态调用方只会当成真冲突再重试 → 可能重复执行。处置口径见
   * `SECRET_COMMAND_TIMEOUT_LAYER` 层表与 docs/secret-command-tool.md。
   */
  SECRET_COMMAND_CONFLICT: 'PLATFORM_MCP_SECRET_COMMAND_CONFLICT',
  /** secret_command worker 执行端点不可用（网络/超时/5xx）→ 503。 */
  SECRET_COMMAND_UNAVAILABLE: 'PLATFORM_MCP_SECRET_COMMAND_UNAVAILABLE',
} as const;

export type PlatformMcpErrorCode =
  (typeof PLATFORM_MCP_ERRORS)[keyof typeof PLATFORM_MCP_ERRORS];

/**
 * secret_command 阻塞预算族（单位 ms，除 timeoutSec 外均为服务端常量）：
 * - `SECRET_COMMAND_INPUT_BUDGET_MS`（540s，在 questions 域）：等待用户填写敏感值的上限；
 * - 命令执行超时：入参 timeoutSec，缺省 60s、上限 300s；
 * - 总预算 = 540s + 300s + 5s 请求裕量 + 10s 传输裕量 = 855s（最坏），
 *   注入的 MCP 客户端 timeout 必须覆盖它（worker 注入点下限 900000ms）——
 *   见 `VTEAM_MCP_TIMEOUT_FLOOR_MS`；
 * - keepalive 周期 60s：等待与执行期间重臂静默看门狗；
 * - 请求侧裕量 5s：worker 客户端超时 = 命令超时 + 5s。
 */
export const SECRET_COMMAND_INPUT_BUDGET_MS = SECRET_INPUT_BUDGET_MS;
export const SECRET_COMMAND_TOTAL_BUDGET_MS = 855_000;
export const SECRET_COMMAND_KEEPALIVE_MS = 60_000;
export const SECRET_COMMAND_DEFAULT_TIMEOUT_SEC = 60;
export const SECRET_COMMAND_MAX_TIMEOUT_SEC = 300;
export const SECRET_COMMAND_REQUEST_SLACK_MS = 5_000;
/**
 * 传输/编排裕量 ms：总预算里除「输入 + 命令 + 请求侧 slack」之外的余量
 * （worker 调度、DB 往返、SSE 心跳首帧前的空窗）。写死而非隐式，使
 * `SECRET_COMMAND_TOTAL_BUDGET_MS` 可被逐项复核（`layerBudgetTable` 的对账基准）。
 */
export const SECRET_COMMAND_TRANSPORT_MARGIN_MS = 10_000;
/**
 * 服务端**可控**的最坏预算（输入 + 命令 + 请求侧 slack）。
 * 客户端/网关超时必须 ≥ 本值，否则先于服务端终态掐断连接 → 产生「假失败信号」
 * （is_0000000001 问题 3）。
 */
export const SECRET_COMMAND_SERVER_MAX_BUDGET_MS =
  SECRET_COMMAND_INPUT_BUDGET_MS +
  SECRET_COMMAND_MAX_TIMEOUT_SEC * 1000 +
  SECRET_COMMAND_REQUEST_SLACK_MS;
/**
 * MCP 客户端（opencode `mcp.vteam.timeout`）超时**下限** ms，与 worker 注入点
 * `VTEAM_MCP_TIMEOUT_FLOOR_MS` 必须同值。两侧各持一份常量（跨包不互相 import），
 * 由 `platform-mcp.service.spec.ts` 的跨包契约测试锁死漂移。
 */
export const SECRET_COMMAND_CLIENT_TIMEOUT_FLOOR_MS = 900_000;
/** worker 侧每流截断上限（双写 MAX_SENSITIVE_OUTPUT_BYTES）：服务端兜底再截一次。 */
export const SECRET_COMMAND_MAX_STREAM_BYTES = 32 * 1024;

/**
 * secret_command 超时层次标识（is_0000000001 问题 4）。
 *
 * 一次阻塞调用串行穿过 6 层，每层各有自己的超时与「超时后服务端是否仍在跑」的语义。
 * 层次标识同时出现在三处，保证「报错即可定位」：工具 description（模型可见）、
 * 409/503 错误 message、`x-vteam-secret-command-budget` 响应头。改任一层的生效值
 * 必须同步改本表（`layerBudgetTable` 是唯一口径，spec 逐项对账）。
 */
export const SECRET_COMMAND_TIMEOUT_LAYER = {
  /**
   * MCP 客户端等待超时：opencode `mcp.vteam.timeout` → MCP SDK
   * `RequestOptions.timeout`，超时报 **-32001 RequestTimeout**。
   *
   * **关键语义**：这是**客户端单方面放弃等待**，SDK 不关闭底层 HTTP 连接，
   * 因此服务端 `res.on('close')` 收不到断开信号 → 请求继续存活、命令照常执行，
   * 而调用方已拿到一个与事实相反的「失败」。见 `SECRET_COMMAND_DISPOSITION`。
   */
  CLIENT_WAIT: 'client_wait',
  /**
   * vteam-server 之前的网关/代理（部署侧，平台不可控）。与 CLIENT_WAIT 同类：
   * 超时不会取消服务端请求。
   */
  GATEWAY: 'gateway',
  /** vteam-server HTTP 挂起段：本身无硬超时，靠 ≤30s SSE 注释心跳保活。 */
  SERVER_HOLD: 'server_hold',
  /**
   * 服务端等待用户填写敏感值的输入预算（540s）。耗尽 → 主动取消 pending 问题并返回
   * `input_timeout`，**必定未执行**（唯一「服务端自己说的超时」层）。
   */
  INPUT_BUDGET: 'input_budget',
  /** worker 侧命令执行超时（timeoutSec，缺省 60s、上限 300s），进程组终止。 */
  COMMAND_EXEC: 'command_exec',
  /** server→worker 请求超时（命令超时 + 5s slack）→ 503 SECRET_COMMAND_UNAVAILABLE。 */
  WORKER_REQUEST: 'worker_request',
} as const;

export type SecretCommandTimeoutLayer =
  (typeof SECRET_COMMAND_TIMEOUT_LAYER)[keyof typeof SECRET_COMMAND_TIMEOUT_LAYER];

/** 超时层的可诊断序数（错误/日志里 `[layer=n/x]` 用，越大越靠近命令执行）。 */
const SECRET_COMMAND_TIMEOUT_LAYER_ORDER: readonly SecretCommandTimeoutLayer[] =
  [
    SECRET_COMMAND_TIMEOUT_LAYER.GATEWAY,
    SECRET_COMMAND_TIMEOUT_LAYER.CLIENT_WAIT,
    SECRET_COMMAND_TIMEOUT_LAYER.SERVER_HOLD,
    SECRET_COMMAND_TIMEOUT_LAYER.INPUT_BUDGET,
    SECRET_COMMAND_TIMEOUT_LAYER.COMMAND_EXEC,
    SECRET_COMMAND_TIMEOUT_LAYER.WORKER_REQUEST,
  ];

/**
 * `layer=i/n` 标签：把层次标识写进错误 message 与日志，使「-32001 到底断在哪一层」
 * 不再需要猜。n 为层总数（6），序数按上表从外到内。
 */
export function secretCommandLayerTag(
  layer: SecretCommandTimeoutLayer,
): string {
  const index = SECRET_COMMAND_TIMEOUT_LAYER_ORDER.indexOf(layer);
  return `layer=${index < 0 ? '?' : index + 1}/${SECRET_COMMAND_TIMEOUT_LAYER_ORDER.length}:${layer}`;
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

/** 单层预算表项（工具 description / 文档 / 响应头共用的渲染元数据）。 */
export interface SecretCommandTimeoutLayerSpec {
  layer: SecretCommandTimeoutLayer;
  /** 实际生效值的人读描述（已含单位）。 */
  effective: string;
  /** 谁控制这一层。 */
  owner: string;
  /** 超时后服务端请求是否仍可能执行（决定调用方能不能重发）。 */
  serverMayStillRun: boolean;
}

/**
 * 超时层表（唯一口径）：`tools.ts` 的工具 description、`docs/secret-command-tool.md`
 * 的层表、`x-vteam-secret-command-budget` 响应头三处同源渲染，杜绝「文档写 540s、
 * 实际不是」这类不可诊断。
 */
export function layerBudgetTable(): readonly SecretCommandTimeoutLayerSpec[] {
  return [
    {
      layer: SECRET_COMMAND_TIMEOUT_LAYER.GATEWAY,
      // 数值取自常量而非字面量：855s = SECRET_COMMAND_TOTAL_BUDGET_MS（手写会与
      // 预算常量漂移，且 doc 层表断言比的是这里的产物）。
      effective: `由部署侧决定（平台不可控），须 ≥ ${Math.round(
        SECRET_COMMAND_TOTAL_BUDGET_MS / 1000,
      )}s`,
      owner: '网关/代理',
      serverMayStillRun: true,
    },
    {
      layer: SECRET_COMMAND_TIMEOUT_LAYER.CLIENT_WAIT,
      effective: `opencode mcp.vteam.timeout（注入下限 ${SECRET_COMMAND_CLIENT_TIMEOUT_FLOOR_MS}ms）`,
      owner: '调用方客户端',
      serverMayStillRun: true,
    },
    {
      layer: SECRET_COMMAND_TIMEOUT_LAYER.SERVER_HOLD,
      effective: '无硬超时；≤30s SSE 注释心跳保活',
      owner: 'vteam-server',
      serverMayStillRun: true,
    },
    {
      layer: SECRET_COMMAND_TIMEOUT_LAYER.INPUT_BUDGET,
      // 显式带 ms：工具 description 是模型可见的，单写「540s」会让模型无法与
      // 预算头的毫秒值对齐。
      effective: `${SECRET_COMMAND_INPUT_BUDGET_MS}ms（${seconds(
        SECRET_COMMAND_INPUT_BUDGET_MS,
      )}）`,
      owner: 'vteam-server（questions 域）',
      serverMayStillRun: false,
    },
    {
      layer: SECRET_COMMAND_TIMEOUT_LAYER.COMMAND_EXEC,
      effective: `timeoutSec，缺省 ${SECRET_COMMAND_DEFAULT_TIMEOUT_SEC}s、上限 ${SECRET_COMMAND_MAX_TIMEOUT_SEC}s`,
      owner: '调用方入参 → worker',
      serverMayStillRun: true,
    },
    {
      layer: SECRET_COMMAND_TIMEOUT_LAYER.WORKER_REQUEST,
      effective: `命令超时 + ${SECRET_COMMAND_REQUEST_SLACK_MS}ms`,
      owner: 'vteam-server → worker',
      serverMayStillRun: true,
    },
  ];
}

/**
 * 预算自述响应头名（is_0000000001 问题 4）：`secret_command` 各层超时的实际生效值。
 * 与 `secretCommandBudgetHeaderValue()` 同源，值恒为服务端常量，不含任何入参。
 */
export const SECRET_COMMAND_BUDGET_HEADER = 'x-vteam-secret-command-budget';

/** 机器可读预算串（响应头）：`total=855000;server_max=845000;...`。 */
export function secretCommandBudgetHeaderValue(): string {
  return [
    `total=${SECRET_COMMAND_TOTAL_BUDGET_MS}`,
    `server_max=${SECRET_COMMAND_SERVER_MAX_BUDGET_MS}`,
    `client_floor=${SECRET_COMMAND_CLIENT_TIMEOUT_FLOOR_MS}`,
    `input_budget=${SECRET_COMMAND_INPUT_BUDGET_MS}`,
    `command_default=${SECRET_COMMAND_DEFAULT_TIMEOUT_SEC * 1000}`,
    `command_max=${SECRET_COMMAND_MAX_TIMEOUT_SEC * 1000}`,
    `worker_slack=${SECRET_COMMAND_REQUEST_SLACK_MS}`,
    `keepalive=${SECRET_COMMAND_KEEPALIVE_MS}`,
  ].join(';');
}

/**
 * secret_command 终态的**执行事实**（is_0000000001 问题 3 的核心诉求）。
 *
 * 客户端拿到的每个 envelope 都带它，把「服务端已判定未执行」与「跑过（无论成败）」
 * 机器可判地区分开；而「客户端等待超时、服务端可能仍在执行」这一态**不由服务端下发**
 * （结果无处可送），只能靠工具 description 的禁止重发规则 + 409 的实时状态兜底。
 */
export const SECRET_COMMAND_DISPOSITION = {
  /** 命令已下发 worker 并跑完（succeeded/failed/timeout 都是 executed）。 */
  EXECUTED: 'executed',
  /** 服务端确定**没有**执行：用户取消、输入预算耗尽、客户端断开于下发之前。 */
  NOT_EXECUTED: 'not_executed',
} as const;

export type SecretCommandDisposition =
  (typeof SECRET_COMMAND_DISPOSITION)[keyof typeof SECRET_COMMAND_DISPOSITION];

/**
 * notify_agent `type` 值集（reply-join）：区分执行答复 / 求助 / 普通通知，
 * 决定 fan-out JOIN 计数与唤醒策略。未知值 → tools/call -32602。
 */
export const NOTIFY_TYPE = {
  answer: 'answer',
  question: 'question',
  help: 'help',
} as const;

export type NotifyType = (typeof NOTIFY_TYPE)[keyof typeof NOTIFY_TYPE];

/**
 * notify_agent `stage` 值集（reply-join）：process=执行进行中（仅持久化），
 * end=已完工（触发 ACK + drain 检查）。未知值 → tools/call -32602。
 */
export const NOTIFY_STAGE = {
  process: 'process',
  end: 'end',
} as const;

export type NotifyStage = (typeof NOTIFY_STAGE)[keyof typeof NOTIFY_STAGE];

/**
 * 平台 MCP 工具名（SDK registerTool/tool 注册，tools/list 返回工具清单）。
 * chat_history / doclib / task_context / group_post / read_file / notify_agent
 * / submit_artifact（设计文档 §5 工具集 v1 + read_file + FR-13 notify_agent
 * + submit_artifact：agent 直接提交产出物）。
 */
export const PLATFORM_MCP_TOOLS = [
  'chat_history',
  'doclib',
  'task_context',
  'group_post',
  'read_file',
  'notify_agent',
  'submit_artifact',
  'channel_send',
  'skill_create',
  'memory_update',
  'git_repos_list',
] as const;

/** 平台 MCP server 标识（seed 阶段 2 的 mcp-servers 记录 name 对齐）。 */
export const PLATFORM_MCP_SERVER_NAME = 'vteam';
export const PLATFORM_MCP_SERVER_VERSION = '1.0.0';

const HOOK_RE =
  /\b(useState|useEffect|useRef|useMemo|useCallback|useContext|useReducer)\b/;
const HOOK_IMPORT_RE =
  /\bimport\s*[\s\S]*?\b(useState|useEffect|useRef|useMemo|useCallback|useContext|useReducer)\b[\s\S]*?\bfrom\s*['"]react['"]/;

export function validateTsxPrototype(source: string): string[] {
  const issues: string[] = [];
  const usedHooks = source.match(HOOK_RE);
  if (usedHooks && !HOOK_IMPORT_RE.test(source)) {
    const unique = [...new Set(usedHooks)];
    issues.push(
      `使用了 React hooks（${unique.join(', ')}）但缺少 import { ${unique.join(', ')} } from "react"`,
    );
  }
  if (!/export\s+const\s+meta\s*=/.test(source)) {
    issues.push('缺少 export const meta = { id, name } 声明');
  }
  if (!/export\s+default\s+function/.test(source)) {
    issues.push('缺少 export default function 组件导出');
  }
  return issues;
}
