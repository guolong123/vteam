/**
 * opencode agent 职责约定（计划模式判定用）。
 *
 * 背景：opencode 的 agent 名不携带语义（GET /agent 无默认标记、无职责字段），
 * 但各 agent 的职责是既定约定，可与"计划/执行"一一对应：
 *   - 计划职责：plan（原生）、prometheus（OmO 约定）——只读分析、出计划
 *   - 执行职责：build（原生）、atlas（OmO 约定）——写文件、跑命令、交付
 * 未在表中的名字（含 null/空=跟随默认）一律按执行处理；显式的 task.planMode
 * 开关（plan_mode 工具 / PATCH）是另一条独立通道，两者取 OR（见 worker-dispatcher）。
 *
 * 注：`orchestrator` 不属于本表——它是 oh-my-opencode-slim（第三方精简 fork）的
 * primary agent，不在 OmO（oh-my-openagent）的 14 个 agent 里。如需支持该 fork，
 * 应连同其 agent 语义一起评估，不要凭名字猜职责。
 *
 * 本文件为纯函数、无任何 import，任何模块引用都不产生循环依赖。
 */

/** agent 职责：plan=出计划（只读分析），execute=动手执行。 */
export type OpencodeAgentDuty = 'plan' | 'execute';

/**
 * 约定为计划职责的 agent 名（**小写基底名**，大小写不敏感）。
 *
 * - `plan`：opencode 原生 plan agent
 * - `prometheus`：OmO 的 "Prometheus - Plan Builder"（出计划）
 * - `vteam-plan`：vteam 角色策略 agent（计划职责；Todo 13 dispatch 能力位门选中后，
 *   其下发 payload 同 plan 职责处理，见 .omo/plans/vteam-role-behavior-enforcement.md）
 */
const PLAN_DUTY_AGENTS: ReadonlySet<string> = new Set([
  'plan',
  'prometheus',
  'vteam-plan',
]);

/** 约定为执行职责的 agent 名（小写基底名；列出仅为文档完备性，判定只认 PLAN 集）。 */
const EXECUTE_DUTY_AGENTS: ReadonlySet<string> = new Set(['build', 'atlas']);

/**
 * 取 agent 名的"基底名"用于职责判定。
 *
 * OmO 注册的 agent 名是**展示名**，形如 `"Prometheus - Plan Builder"` /
 * `"Sisyphus - ultraworker"`（`<Name> - <描述>`），而配置文件里用的是小写键
 * （`prometheus`）。opencode 原生 agent 则是裸名（`plan`/`build`）。
 * 若按整串精确匹配，OmO 的 agent 永远命中不了职责表——表现为"选了计划 agent
 * 却不进计划模式"（实测踩坑）。故统一取 ` - ` 前的首段并转小写再判定。
 *
 * 只处理 OmO 这一种已知格式，不做模糊包含匹配（避免把 `my-prometheus-helper`
 * 之类用户自定义名误判为计划职责）。
 */
function baseAgentName(agentName: string): string {
  const head = agentName.split(' - ')[0]?.trim() ?? '';
  // OmO 的 Sisyphus-Junior 之类连字符名不在职责表内，保持原样即可
  return head.toLowerCase();
}

/**
 * 判定 agent 职责。null/空/未知名 → 'execute'（跟随默认=原生 build 语义；
 * 未知自定义计划 agent 请走显式的 task.planMode 开关，不要扩这张表——
 * 表只收双方确认过的约定，避免猜测）。
 */
export function getOpencodeAgentDuty(
  agentName: string | null | undefined,
): OpencodeAgentDuty {
  const name = (agentName ?? '').trim();
  if (!name) {
    return 'execute';
  }
  if (PLAN_DUTY_AGENTS.has(baseAgentName(name))) {
    return 'plan';
  }
  // EXECUTE 集与未知名统一走 execute（默认安全：不改变现有行为）。
  return 'execute';
}

/** 供测试/文档使用的约定表快照（只读）。 */
export function listPlanDutyAgents(): string[] {
  return [...PLAN_DUTY_AGENTS];
}

export function listExecuteDutyAgents(): string[] {
  return [...EXECUTE_DUTY_AGENTS];
}
