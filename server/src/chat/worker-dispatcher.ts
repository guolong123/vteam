import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { WecomAibotAdapter } from '../message-channels/adapters/wecom-aibot.adapter';
import { Prisma } from '@prisma/client';
import { validateArtifactDeclaration } from '../artifacts/artifacts.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { DEFAULT_TASK_WORK_DIR, taskDirOf } from '../tasks/work-dir.util';
import { PlanLifecycleService } from '../tasks/plan-lifecycle.service';
import { FileStorageService } from '../uploads/uploads.service';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
  SESSION_STATUS,
} from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import {
  AGENT_KEY_PATTERN,
  type VteamAgentName,
} from '../common/constants/agent.constants';
import {
  canonicalizeCorrection,
  ExecutionPolicyService,
  resolveConstantPolicySource,
  type AgentToolState,
} from '../execution-policies/execution-policy.service';
import { capabilityMatrixToToolStates } from '../common/constants/platform-capability.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WORKER_STATUS } from '../workers/workers.constants';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import {
  ExecuteAttachment,
  WorkerClient,
  WorkerEndpointRef,
  WorkerUnavailableException,
} from '../workers/worker.client';
import {
  AgentStatusPayload,
  SessionActivityPayload,
  TaskCompletedPayload,
  WorkerEventIngress,
} from '../workers/worker-event.ingress';
import {
  AssignmentRequirement,
  workerSupportsAgentPolicies,
  WorkersService,
} from '../workers/workers.service';
import { renderPersonaSection } from '../agents/persona.constants';
import {
  DispatchRequest,
  DispatchResult,
  MessageDispatcher,
} from './message-dispatcher';
import { inferErrorType, isQuotaError } from '../workers/infer-error-type';
import {
  buildStalePlanHashHint,
  isStalePlanHash,
  normalizePlanHash,
  selectFrozenPlanHash,
} from '../issues/plan-hash-gate';
import { normalizeParts } from './message-parts';
import {
  TRIGGER_KIND,
  buildTriggerDedupKey,
} from '../common/constants/trigger.constants';
import {
  TriggerFireContext,
  TriggerOutcome,
  TriggerService,
} from '../timers/trigger.service';

/** 消息主键前缀：与 ChatService 共享 IdGeneratorService 的 'm' 计数（重启续号同源）。 */
const MESSAGE_ID_PREFIX = 'm';

/** 首次 bind 的 instanceRef 占位（opencode 会话尚未创建；第二次 bind 写入真实 sessionId）。 */
export const PENDING_INSTANCE_REF = 'pending';

/**
 * 派发执行分类（plan-review-execution-gates Todo 4，门禁分类依据）。
 *
 * - execution：计划执行派发（默认）——任务维度下比对冻结计划哈希，过期即抛错；
 *   review/nudge/wake 豁免。
 * - review：评审派发；nudge：催办；wake：内部唤醒/轮次通知——三者永不经过
 *   计划门禁，且永不写入账本行。
 */
export type DispatchExecutionKind = 'execution' | 'review' | 'nudge' | 'wake';

/**
 * vteam 注册的 opencode agent 名全集（`vteam-<role>` / `vteam-plan`）。
 * 与 Todo 2 的 `VteamAgentName` + `ROLE_BOUNDARIES` 键严格一致（单一命名空间来源）。
 */
const VTEAM_AGENT_NAMES: readonly VteamAgentName[] = [
  'vteam-product',
  'vteam-architect',
  'vteam-developer',
  'vteam-tester',
  'vteam-project_manager',
  'vteam-plan',
  'vteam-librarian',
];

/**
 * 是否为 vteam 注册的 opencode agent 名（Todo 4）。
 * 仅已知角色命名空间（`vteam-<role>` / `vteam-plan`）才注入【职责边界】段；
 * 未知 agent 名 → false，调用方省略 boundarySection（保持基线输出字节不变）。
 */
export function isVteamAgentName(x: unknown): x is VteamAgentName {
  return (
    typeof x === 'string' &&
    (VTEAM_AGENT_NAMES as readonly string[]).includes(x)
  );
}

/**
 * 由 Agent 的绑定 key（`agents.agent_key`）解析 opencode agent 名
 * （`agentKey` → `vteam-<agentKey>`，vteam-custom-agent-opencode Todo 4）。
 * 目标成员未显式绑定 `opencodeAgentName` 时按 key 回退；未知/空 key 返回 null
 * （调用方据此省略 boundarySection，与引入前逐字节一致）。
 */
export function agentKeyToVteamAgentName(
  agentKey: string | null | undefined,
): VteamAgentName | null {
  if (!agentKey) {
    return null;
  }
  const candidate = `vteam-${agentKey}`;
  return isVteamAgentName(candidate) ? candidate : null;
}

/**
 * 由 Agent 行解析策略 agent 候选名（vteam-custom-agent-opencode Todo 4；
 * agent-role-decommission todo 10 收窄为规则 4）。
 *
 * 唯一来源 `agentKey` → `vteam-<agentKey>`（模板行 `agentKey = role`，与引入前同值）；
 * `agentKey` 缺席/非法（`AGENT_KEY_PATTERN` 未命中 → 视为缺席，绝不拼出非法 agent 名）
 * 时返回 **null**——不做任何按名回退（`Agent.role` 列已随 todo 7 删除）。
 * 该收窄即 todo 1 声明的规则 4（无 `agentKey` 者无策略候选），调用方据此回退现状：
 * `opencodeAgentName` 或省略 `agent` 键。
 * 纯函数；worker 能力位门控由调用方执行（此处不判定）。
 */
export function resolvePolicyAgentCandidate(
  row: { agentKey?: string | null } | null | undefined,
): string | null {
  const key = row?.agentKey;
  if (typeof key === 'string' && new RegExp(AGENT_KEY_PATTERN).test(key)) {
    return `vteam-${key}`;
  }
  return null;
}

/**
 * 装配用「角色」标签（agent-role-decommission todo 10）：仅当 `agentKey` 命中内置
 * vteam 注册名空间（`agentKeyToVteamAgentName` 即 `vteam-<agentKey>` ∈ `VTEAM_AGENT_NAMES`）
 * 时返回其 key——模板行 `agentKey = role`，与旧 `Agent.role` 值逐字节一致；
 * 自定义/克隆（如 `myagent`）与缺席 → 空串（旧 `Agent.role` 为 null，`?? ''` 后即空串）。
 *
 * **不读取任何 DB 列**：本函数是身份行（`buildSystemInstructions`）与团队成员名册行的
 * 唯一标签来源，两者都只消费该 key-derived 值。
 */
export function roleLabelOfAgentKey(
  agentKey: string | null | undefined,
): string {
  if (!agentKey) {
    return '';
  }
  return agentKeyToVteamAgentName(agentKey) ? agentKey : '';
}

/**
 * 解析出的策略 `correction`（层② guard 越界纠正数据）。
 *
 * 字段故意声明为 `unknown`：数据源是 DB `config.correction`（任意 JSON），此处做
 * 运行时收敛而非信任 DB 形状（与 `execution-policy.service.ts` 的防御式解析一致）。
 * 形如 `{scopeSummary, handoff, denyTemplate}`——`denyTemplate` 由 worker guard 消费，
 * 本渲染器只用 `scopeSummary` + `handoff`。
 */
export interface BoundaryCorrection {
  scopeSummary?: unknown;
  handoff?: unknown;
  denyTemplate?: unknown;
}

/** `handoff` 收敛为 `Record<string,string>`：非对象/非字符串值丢弃，保留键声明序。 */
function normalizeHandoff(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [scope, target] of Object.entries(value)) {
    if (typeof target === 'string' && target.length > 0) {
      out[scope] = target;
    }
  }
  return out;
}

/**
 * 由解析出的策略 `correction` 渲染【职责边界】提示段（Todo 4，vteam-role-behavior-abstraction
 * Todo 11 改由策略提供）。
 *
 * 纯函数：`scopeSummary` 缺席/非字符串/空串 → 返回空串（调用方不注入，无边界时系统
 * 提示字节不变）；否则输出
 * `【职责边界】<scopeSummary>\n越界处理：超出上述职责范围的请求必须拒绝（不要执行），
 * 说明你的职责边界，并通过 vteam_notify_agent 或群聊 @ 转交对应角色（<scope→target、…>）。`
 * 出厂态的 `correction` 与 `ROLE_BOUNDARIES` 常量逐字段相同 → 输出与按名读取常量逐字节一致。
 * 不再按 agent 名 gating：自定义 agent 的策略 `correction` 同样得到边界段。
 */
export function renderBoundarySection(
  correction: BoundaryCorrection | null | undefined,
): string {
  const scopeSummary = correction?.scopeSummary;
  if (typeof scopeSummary !== 'string' || scopeSummary.length === 0) {
    return '';
  }
  const handoff = Object.entries(normalizeHandoff(correction?.handoff))
    .map(([scope, target]) => `${scope}→${target}`)
    .join('、');
  return (
    `【职责边界】${scopeSummary}\n` +
    `越界处理：超出上述职责范围的请求必须拒绝（不要执行），说明你的职责边界，` +
    `并通过 vteam_notify_agent 或群聊 @ 转交对应角色（${handoff}）。`
  );
}

/** C7：baseAgentId 链向上遍历的最大深度（防御异常链/环导致的无限查询）。 */
const MAX_BASE_AGENT_CHAIN_DEPTH = 20;

/** 单文档正文截断上限（12 篇 §8.1：默认 32KB/文档，超出以摘要替代——本版直接截断）。 */
export const DEFAULT_DOCLIB_MAX_BYTES = 32 * 1024;
/** doclib 块整体大小上限（多产出物防御：正常场景 32KB/文档 × 少量文档远低于此）。 */
export const DEFAULT_DOCLIB_TOTAL_BYTES = 128 * 1024;
/** 群聊历史上下文注入上限（对齐 doclib 单文档 32KB 语义：按条截断 + 总量截断，防超长 prompt）。 */
export const DEFAULT_CHAT_HISTORY_MAX_BYTES = 32 * 1024;

/**
 * P7：全局系统提示（注入 prompt_async 顶层 system 字段，serve 拼入 LLM system message）：
 * 产出物协议 + @定向机制说明——Agent 默认知晓如何声明可归档产出物，无需每条消息显式要求。
 * 经 system 通道注入（非 parts 文本）→ 不进入会话 user 消息，不会出现在聊天记录回复中。
 *
 * 【记忆管理】2 行独立为 MEMORY_INSTRUCTION 常量：plan 角色（toolAllows 无
 * vteam_memory_save，教了会被 guard 拒）由 buildSystemInstructions 按 role 跳过该块，
 * 其余角色照常注入；GLOBAL_SYSTEM_INSTRUCTIONS 导出值保持不变。
 */
export const MEMORY_INSTRUCTION =
  '【记忆管理】只存可复用经验：怎么做（howto）、坑与规避（pitfall）、平台硬约束（constraint），不存会话总结。\n' +
  '开始任务/需要经验时调 vteam_memory_search 检索，沉淀时调 vteam_memory_save 保存；参数细节查工具 schema，文档查 doclib。';

/** GLOBAL 前 6 行（【记忆管理】之前的不变段；与 MEMORY_INSTRUCTION 拼出完整 GLOBAL）。 */
const GLOBAL_BASE_LINES = [
  '你是 AI 协作平台的 Agent，请遵守以下平台协议：',
  '【群聊通知】私聊默认不公开，需公开结论/进展时调用 vteam MCP 的 vteam_group_post 发布。',
  '【@ 定向机制】群聊中 @ 你的消息会定向分发给你。需要定向触发/通知任务内的其他 Agent 时，' +
    '调用 vteam MCP 的 vteam_notify_agent 工具' +
    '——目标实例会收到你的消息并开始执行；回复时也可用 @用户名 在群聊中定向回复特定成员。\n\n' +
    '【@用户】需要用户确认/决策或完成后通知时，在 vteam_group_post 的 content 中写 @user 或 @all（系统动态注入当前任务相关用户，无需写死 @admin），也可写 @用户名 精确@某人；命中后消息对该用户高亮（蓝底+左蓝条+★@你）。',
  '【Issue协作】任务内 issue 协作经 vteam MCP 的 vteam_issue_* 工具（创建/查询/更新/流转），详见 task_context。',
  '【持久化目录】唯一持久化位置以【运行时工作目录】注入的实际路径为准，仅该目录重启后保留，工作产物与产出物文件请写入该目录。',
  '【通知重发】vteam_notify_agent 返回 triggered:false 不是投递失败：该次调用未在群聊发布任何消息，请勿重发；请按 reason 与 hint 处理（节流稍后按需重派，计划门禁待放行，三元组缺失先补齐，重复/幂等说明已有在途或已发送）。',
  '【@ 定向机制｜回执】vteam_notify_agent 新增 type 与 stage 参数（默认 type=answer、stage=process）：' +
    'answer+process=常规进度汇报，不唤醒主Agent；answer+end=本次派发完工，清除回执，主Agent在所有派发均完工时一次性唤醒；' +
    'question/help=需主Agent立即介入，中断唤醒，不计为完工。进度汇报不再按条唤醒，完工必须传 stage=end。',
];

export const GLOBAL_SYSTEM_INSTRUCTIONS = [
  ...GLOBAL_BASE_LINES,
  MEMORY_INSTRUCTION,
].join('\n\n');

/**
 * P0：条件注入段（原 GLOBAL 内【任务状态】/【托管模式】/【企业微信】下沉为独立常量）。
 * task_transition / question_confirm 仅主实例可调（服务端 403），故仅当
 * opts.isMainAgent=true 时由 buildSystemInstructions 注入；非主成员改注 NON_MAIN_AGENT_NOTE。
 * 企微段仅当 opts.isWecomChannel=true 时注入（缺省不注入，字节兼容：不传即无此段）。
 */
export const TASK_TRANSITION_INSTRUCTION =
  '【任务状态】主 Agent 可调用 vteam MCP 的 vteam_task_transition 工具流转任务状态（start 开始 / mark-pending-review 提交验收 / reject 驳回，参数细节查工具 schema）。仅主实例可调用，其余成员调用将返回 403 提示（请知会主实例或由管理员在任务管理界面操作）。注意：accept 验收完成与 archive 归档仅人类用户可在管理界面操作，Agent 不可调用（调用将被拒绝）；任务就绪后请向用户报告等待人工验收，不要重复调用。';

export const HOSTED_CONFIRM_INSTRUCTION =
  '【托管模式】若当前任务开启托管（任务设置 managedMode=on），团队成员的 question/permission 请求不再弹窗给用户，改由主 Agent 确认：收到【托管确认】消息时，调用 vteam MCP 的 vteam_question_confirm 工具决策（参数细节查工具 schema）。仅主实例可调用 vteam_question_confirm。';

export const HOSTED_PLAN_TODO_INSTRUCTION =
  '【执行步骤｜计划 Tab 执行步骤卡的数据源】计划拆解后必须用 vteam_todo(action:"write", title, content?, assignee?, seq 按 1..n 缺省自增) 把步骤写入平台（落 plan_tasks，跨会话持久），完成自己负责的那一步时调 vteam_todo(action:"done", seq) 标记完成——只建 issues 不写 vteam_todo，执行步骤卡会永远是「暂无执行步骤」。步骤与 issue 的分工：步骤=有序执行序列（谁做第几步、完成态），issue=可流转的工作项。';

export const HOSTED_PLAN_SIGNOFF_INSTRUCTION =
  '【计划签署】托管模式（managedMode=on）下计划由你（主 Agent）代用户签署：定稿用 vteam_plan_finalize（pending_final→approved，托管模式额外允许 draft→approved），开始执行用 vteam_plan_confirm（approved→executing，托管模式额外允许 draft/pending_final 直推）。派发执行类工作前必须先 vteam_plan_confirm 把计划推进到 executing，否则计划会卡在 draft，且后续 vteam_plan_complete 必然报错（仅 executing 可完工）。托管模式未开启时这两个工具返回 403，此时须提示用户在计划 Tab 人工确认（确认定稿 / 确认开始执行）；若你岗位未被授予 task.complete 能力（工具返回未获授权），请 @项目经理 或 @计划员 执行。';

export const HOSTED_PLAN_REVIEW_INSTRUCTION =
  '【计划评审派发｜决定计划状态能否动】计划文档产出后，评审必须用 vteam_notify_agent 且 kind=review 派发（不带 issueId 即可绕开工单门），派发词必须带三元组：round=第几轮（首轮 1）、planVersion=版本（如 v1；已落盘的再带 planHash）、expected=评审人名单（如 架构师-1、产品经理-1）。缺任一项 reason=review-triplet 会拦截且不落库不广播。评审回执 N/N 收敛后平台自动把计划 draft→reviewing→pending_final，【计划 Tab】才会出现「确认定稿」按钮；⚠️ 只在群聊里口头说 VERDICT: APPROVE 不算收敛——没有三元组账本，状态永远停在草稿、按钮永远不出现，你和用户都会卡住。到 pending_final 后请提示用户点「确认定稿」→ approved → 再点「确认开始执行」→ executing。';

/** 非主成员协作指引（替代【任务状态】/【托管模式】工具段，避免教非主成员调用必 403 的工具）。 */
export const NON_MAIN_AGENT_NOTE =
  '【协作说明】状态流转/托管确认由主Agent操作，有事@主Agent（相关工具 vteam_task_transition / vteam_question_confirm 仅主实例可调，误调返回 403）。定向通知仅可直达主Agent，需触达其他成员时请主Agent中转，成员间直连调用将被拒绝。' +
  '回执节奏：进度汇报用 vteam_notify_agent（type=answer, stage=process，不唤醒主Agent）；' +
  '完工必须传 stage=answer+end（清除回执，主Agent在所有派发完工后一次性唤醒）；' +
  '遇阻塞/决策/依赖缺失用 type=question 或 help（立即中断唤醒主Agent，不计完工）。' +
  '执行步骤：认领的任务步骤由主 Agent 用 vteam_todo 写入，你**自己完成时**调用 vteam_todo(action:"done", seq) 标记完成（计划 Tab 执行步骤卡据此显示进度）；先 vteam_todo(action:"list") 可查 seq。';

/** 企微系统段（仅企微渠道注入；dispatch 侧按正文 [WeCom:] 标记判定后经 opts.isWecomChannel 传入）。 */
export const WECOM_SYSTEM_INSTRUCTION =
  '【企业微信】当消息来自企业微信（正文含 [WeCom:用户名] 标记）时，请使用 vteam_wecom_reply 工具回复，不要用 vteam_group_post；vteam_wecom_reply 会同时发送到企微会话（群聊自动@该用户，私聊直回）并同步到任务群聊，确保用户在企微端收到回复。';

/**
 * 平台级共享块（agent-role-entity 计划 todo 3）：原在 seed 的 7 个 prompt 内各抄一份，
 * 现上提为唯一常量、由 buildSystemInstructions 对**全部内置 Agent 无条件注入**。
 * 逐行取自 `prisma/seed.ts` 的原样文本（仅移动位置，字节不变）：
 * - 团队协作规约 7 处（product/PM/architect/developer/tester/plan/librarian）→
 *   TEAM_COLLABORATION_CHARTER_INSTRUCTION。
 * - 回执铁律 4 处（product/architect/developer/tester）→ AGENT_RECEIPT_IRON_LAW_INSTRUCTION。
 */
export const TEAM_COLLABORATION_CHARTER_LINES = [
  '- 团队协作规约（全文见 docs/agent-platform/30-团队协作规约.md）：',
  '- 求助带三要素：背景（一句话）+ 要什么（具体交付物）+ 期望（谁、何时）；要素不全先追问，不开工。',
  '- 责任转交落 issue：转交带事项 + 已有材料（issue/产出物 id）+ 期望动作，被转交人须回执；转交链超 3 轮未闭环则升级协调，改派或落 issue 跟踪，并提示成员介入。',
  '- 广播纪律：@all 仅用于全员需知的结论/决策或紧急阻塞；私域问答定向问对口角色，与己无关的 @all 不回复。',
  '- 定向 @ 超时升级：被 @ 后 10 分钟无回执，发起人再点名一次，仍无响应则升级协调，改派或落 issue 跟踪；调用失败不伪造成功，核对后汇报并给替代路径。',
];

export const TEAM_COLLABORATION_CHARTER_INSTRUCTION =
  TEAM_COLLABORATION_CHARTER_LINES.join('\n');

/**
 * 回执铁律块（4 处副本合一）。
 *
 * **有意的行为变更（agent-role-entity todo 3 决策）**：本块原只出现在 product/architect/
 * developer/tester 的 prompt（4 个角色）。上提为平台常量后**对全部 7 个内置 Agent 无条件
 * 注入**——project_manager/plan/librarian 现在也收到回执铁律。这是刻意选择「普遍性」而非
 * 「按名条件注入」的结果：避免在装配处再加一个按 agent 名/角色分支的硬编码特例（plan 4
 * 的目标正是删除这类特例），且回执规则本就是全体 vteam Agent 应遵守的平台级策略。
 */
export const AGENT_RECEIPT_IRON_LAW_LINES = [
  '## 回执铁律（优先级：平台校验 > 本铁律 > 上文原文风）',
  '- 回执必@派发人：任务回执消息必须 @ 派发人定向发送，禁止只发群聊消息充当回执；无 @ 的回执视为未送达。',
  '- 回执参数：进度汇报 type=answer+stage=process（不唤醒主Agent）；完工必须 stage=answer+end（主Agent汇总唤醒）；阻塞用 type=question/help（立即唤醒主Agent）。',
  '- 冲突裁决：平台校验 > 本铁律 > 上文原文风。',
];

export const AGENT_RECEIPT_IRON_LAW_INSTRUCTION =
  AGENT_RECEIPT_IRON_LAW_LINES.join('\n');

/**
 * P8：分派时动态构建系统提示——在 GLOBAL_SYSTEM_INSTRUCTIONS 基础上注入当前 Agent 的完整
 * 身份（id + 名称 + 角色 + 用户设置的 prompt 职责），供 MCP 工具调用的 selfInstanceId 参数
 * 填写（服务端按 session.teamMemberId 校验后精确落库 senderId/senderInstanceId，
 * 修复"@测试 触发但回复显示开发者"）。
 * GLOBAL_SYSTEM_INSTRUCTIONS 常量保持不动（其他调用方兼容），本函数仅在 dispatch 下发时
 * 拼接身份段；agent 行查询不到时由调用方降级（name/role/prompt 置 null，回退用 agentId）。
 */
export interface AgentIdentityInfo {
  id: string;
  name: string | null;
  /**
   * 装配用角色标签（identity 行 / 名册行渲染）。dispatch 装配处由 `agent.agentKey`
   * 经 `roleLabelOfAgentKey` 派生：内置 key 原样（模板行即角色 key），自定义/缺席为空串。
   * 它只是 key 派生的**渲染标签**——从不读取任何 DB 列（`Agent.role` 已删除），
   * 是身份行与名册行的唯一标签来源。
   */
  role: string | null;
  prompt: string | null;
  /** Agent 性格 key（PERSONA_LIBRARY 预设 key；null=无性格）。运行时按此拼接【性格】段进系统提示。 */
  persona: string | null;
  /** Agent machine-safe 标识（agents.agent_key；模板行 = role；存量自定义/克隆行为 null）。分派策略候选名即 `vteam-<agentKey>`。 */
  agentKey: string | null;
}

/**
 * 分派目标成员绑定的**岗位权威**（2026-09-21 role-owned capability model：平台 `vteam_*`
 * 工具权限属于岗位，不属于执行者）。
 *
 * 装配来源：`TeamMember.roleId → AgentRole`（dispatch 名册查询一次取回，与 rolePrompt 同源）。
 * 记忆/产出物段屏蔽（tools）由 `capabilities`（业务能力点矩阵）推导；边界段（correction）
 * 是 prompt 关注点，仍由 `resolveByRole`（roleKey → 内置策略行/常量）提供。
 * `Agent.policyId` 只服务 worker injector 的原生层①（`buildAgentPolicies()` 不动）。
 * 成员未绑角色（`roleId` NULL）→ 传 null：无岗位权威，回退 `agent.agentKey` 常量派生
 * （存量兼容路径；live 数据 0 命中，平台工具门对未绑角色 fail-closed 403）。
 */
export interface MemberRoleAuthority {
  /** 岗位 id（`AgentRole.id`；仅记账/调试，解析不使用）。 */
  id: string | null;
  /** 岗位机器键（`AgentRole.key`）：常量回退命名为 `vteam-<key>`，即 `resolveByRole.roleKey`。 */
  key: string | null;
  /**
   * 岗位业务能力点矩阵（`AgentRole.capabilities`；键 ∈ 能力目录，缺失键 ⇒ 允许）。
   * NULL 等同 `{}`（全放行）；仅驱动记忆/产出物段屏蔽，不做授权判定。
   */
  capabilities: Record<string, boolean> | null;
}

/** 团队成员信息（dispatch 时从 TeamMember→Agent 组装，注入全局上下文供 agent 判断与谁协作）。
 *  TeamMember 维度：instanceId 为团队成员 id（tmm_ 前缀，TeamMember.id），alias/seq 来自团队模板；
 *  id/name 来自模板 agent；role 为 agentKey 派生的装配标签（同 `AgentIdentityInfo.role`）。 */
export interface TeamMemberInfo {
  /** 模板 agent id（继承 name/prompt/model）。 */
  id: string;
  name: string | null;
  /** 装配用角色标签（agentKey 派生，同 `AgentIdentityInfo.role`）。 */
  role: string | null;
  /** 团队成员 id（TeamMember.id，tmm_ 前缀）——团队成员唯一身份（@/指派/主实例判定依据）。 */
  instanceId: string;
  /** 实例别名（默认「<角色中文名>-<seq>」）；缺省回退 name。 */
  alias: string | null;
  /** 同 agent 同团队内序号（服务端生成，唯一键 teamId+agentId+seq）。 */
  seq: number;
}

/**
 * 产出物提交引导段（dispatch 时对所有任务注入；P1 与 GLOBAL 内【产出物声明】合并后的唯一详版）。
 *
 * 计划文档与任意交付物统一走 vteam MCP 既有 `submit_artifact` 工具（type=text 直传
 * content；type=doc/file 传 fileRef，控制面自动从 worker 工作区拉取并归档为产出物版本），
 * 无需专用"提交计划"工具——计划文档只是 doc 类型产出物的一种。
 * 只有经 group_post 发布的内容才会显示在群聊（群聊同步另行使用 group_post）。
 */
export const ARTIFACT_SUBMISSION_INSTRUCTION =
  '【公开与归档】工作产出用 vteam MCP 的 vteam_submit_artifact 提交归档（text/doc/file 三类，参数细节查工具 schema，文件由控制面自动拉取归档）。' +
  '只有经 vteam_group_post 发布的内容才会显示在群聊。';

/**
 * P1：issue 完整版（创建+指派+流转 action 列表），仅 product/tester/developer
 * 注入（dispatch 按目标角色经 opts.issueDetail 传入，缺省只收 GLOBAL 一句版）。
 */
export const ISSUE_FULL_INSTRUCTION =
  '【Issue管理】任务内 issue 协作：创建 issue 调 vteam MCP 的 vteam_issue_create' +
  '（参数细节查工具 schema）；' +
  '查询 vteam_issue_list/vteam_issue_get；更新 vteam_issue_update；' +
  '状态流转 vteam_issue_transition（action: start/resolve/close/reopen/reject）。' +
  '产品/测试负责创建需求或缺陷 issue 并指派（assigneeInstanceId 为目标实例 id），' +
  '研发处理指派给自己的 issue 并流转状态。issue 标签（tags）标识类型（如 需求/缺陷/优化）。';

/**
 * P1：issue 完整版注入判定——仅 product/tester/developer 需要创建+指派+流转全版；
 * architect/project_manager/plan 及未知角色只收 GLOBAL 一句版。兼容中文角色名。
 */
const ISSUE_DETAIL_ROLE_KEYS = new Set(['product', 'tester', 'developer']);
export function roleNeedsIssueDetail(role: string | null | undefined): boolean {
  if (!role) {
    return false;
  }
  const r = role.toLowerCase();
  if (ISSUE_DETAIL_ROLE_KEYS.has(r)) {
    return true;
  }
  return r.includes('产品') || r.includes('测试') || r.includes('开发');
}

/**
 * 已解析策略 `tools` 是否放行某工具（agent-role-decommission todo 2）：
 * `allow`/`ask` 视为放行，`deny`/缺项视为不放行——与 worker guard 的
 * `isToolAllowed` 同口径。**这是记忆段/产出物段屏蔽的唯一判据**：
 * 指令里教了工具却被 guard 拒（或反过来）才是真实错误，故只认工具本身，
 * 不认 duty/角色名。
 */
export function toolAllowed(
  tools: Record<string, AgentToolState> | null | undefined,
  name: string,
): boolean {
  if (!tools) {
    return false;
  }
  const effect = tools[name];
  return effect === 'allow' || effect === 'ask';
}

export interface BuildSystemInstructionsOptions {
  /** 当前 agent 是否团队主成员（session.teamMemberId === team.mainAgentMemberId）→ true 时追加主 Agent 职责段。 */
  isMainAgent?: boolean;
  /** 任务团队成员（实例 id/别名/序号 + 模板 agent id/名称/角色）；空/缺省则不注入【团队成员】段。 */
  team?: TeamMemberInfo[];
  /** 团队主成员 id（用于团队成员段中标注主成员；无主成员时为 null）。 */
  mainAgentMemberId?: string | null;
  /** 当前 agent 的实例身份（TeamMember.id，tmm_ 前缀）；缺省（存量会话未绑实例）回退 agent.id 保持兼容。 */
  selfInstanceId?: string;
  /** 任务实例 id（TeamMember.id，tmm_ 前缀）：团队会话按团队成员（tmm_）调度时，
   * selfInstanceId 为团队成员 id，此时用本字段明确其在本任务中的实例身份。
   * 缺省表示与 selfInstanceId 一致。 */
  taskInstanceId?: string | null;
  /** 当前 agent 的实例别名（默认「<角色中文名>-<seq>」）；缺省回退 agent.name。 */
  selfAlias?: string | null;
  /** 任务级独立工作目录（<WORK_DIR>/tasks/<taskId>，prompt_async directory）；注入
   *  提示词作为运行时持久化目录（k8s 只有该目录重启后保留），引导 agent 把工作文件写入。 */
  persistentWorkDir?: string;
  /** 可用记忆索引块（team/global 计数+Top tags+description 列表，已按预算截断 <400 token）；缺省不注入。 */
  memoryIndex?: string | null;
  /** team-mode 接待员模式（无任务团队直聊）：分派侧在 taskId 为空时置 true，追加【团队接待】话术段；缺省 = task-mode，系统文本字节不变。 */
  teamMode?: boolean;
  /** 当前任务 id（team-mode 传空串；仅 teamMode=true 且 taskId 为空时触发接待段，task-mode 调用方不传本字段）。 */
  taskId?: string | null;
  /**
   * 角色职责边界段（Todo 4）：调用方先由目标 Agent 的角色/opencode agent 名渲染
   * （renderBoundarySection）后传入；非空时追加【职责边界】段，空/缺省不注入
   * （系统提示与引入前逐字节一致）。
   */
  boundarySection?: string;
  /**
   * 企微渠道标记（P0 条件注入）：true 时追加【企业微信】段（WECOM_SYSTEM_INSTRUCTION）；
   * false/缺省不注入（默认不注入；可选字段，存量调用不传时行为不变）。
   * dispatch 侧按触发正文是否含 [WeCom:] 标记判定后传入。
   */
  isWecomChannel?: boolean;
  /**
   * P1：issue 完整版开关——true 时追加 ISSUE_FULL_INSTRUCTION
   * （创建+指派+流转 action 列表）；false/缺省只收 GLOBAL【Issue协作】一句版
   * （兼容存量调用）。dispatch 调用方按目标 `agentKey` 传入
   * （`roleNeedsIssueDetail(agentIdentity.agentKey)`：模板 key product/tester/developer
   * → true；自定义 agentKey 为小写 ASCII，永不命中中文子串检查 → false）。
   */
  issueDetail?: boolean;
  /**
   * 已解析策略 `tools`（allowlist）——记忆段/产出物段屏蔽的**唯一判据**
   * （agent-role-decommission todo 2）。dispatch 调用方传入与边界段同一次解析的
   * `tools`；`null/undefined` = 未知来源，**不屏蔽**（存量调用/未知自定义 agent 行为不变）。
   *
   * 屏蔽语义：`!toolAllowed(resolvedTools,'vteam_memory_save')` 时不注入 GLOBAL 内
   * 【记忆管理】2 行；`vteam_submit_artifact` 同理控制产出物段。故意**不**按 duty/角色名
   * 判定：同样持有该工具的“计划员”照常注入，同样缺该工具的非计划员照常屏蔽——指令
   * 必须与实际工具可用性一致，否则教了会被 guard 拒。
   */
  resolvedTools?: Record<string, AgentToolState> | null;
  /**
   * 绑定的岗位角色指令（`AgentRole.rolePrompt`，"这个岗位是什么"）——todo 5 装配连接。
   *
   * **来源（唯一生产路径）**：团队成员维度分派（`dispatchForTeamTarget`）由
   * `TeamMember.roleId` → `AgentRole.rolePrompt` 连接而来（成员查询 `teamMember.findMany`
   * 已 include `role.rolePrompt`）。注意：agent 行的 `role` 标签（todo 10 起由 `agentKey`
   * 派生，列 `Agent.role` 随 todo 7 删除）**不是**角色绑定；角色绑定挂在
   * `TeamMember.roleId` 上。
   * 直接调用本函数的其他路径（测试/工具）显式传 `opts.rolePrompt`；不传 = 不注入。
   *
   * 非空时在身份段之后、`【职责】` agent 段之前注入 `【岗位职责】${rolePrompt}` 块
   * （岗位=框架，agent=细节，框架先行）；空串/null/缺省不注入（无空标题，存量调用
   * 输出逐字节不变）。
   */
  rolePrompt?: string | null;
}

/**
 * 主 Agent 动态职责段（dispatch 时仅注入被选为主 Agent 的成员）：模板 prompt 不再写死
 * "主 Agent"职责（见 seed.ts），改由运行时按 team.mainAgentMemberId 判定后动态下发——
 * 牵头分工、协调产出衔接、群聊进度提示、必要时 @ 成员协调、可汇总验收材料。
 * 语义对齐 FR-08（推进/进度同步）、FR-11（@ 触发响应）、FR-13（成员互 @ 协调，不超 3 轮）。
 */
export const MAIN_AGENT_INSTRUCTION =
  '【主 Agent 职责】你是本任务的主 Agent（牵头人）。除角色本职外，还需承担任务组织职责：' +
  '牵头拆解工作并分派给团队成员，协调各角色产出衔接，环节切换或产出完成时主动在群聊提示进度（FR-08）；' +
  '推进受阻或需要协作时，通过 vteam_notify_agent / 群聊 @ 定向协调成员（FR-13，互 @ 不超 3 轮）；' +
  '收尾时可汇总各角色产出与验收材料，供成员验收判定（FR-11）。' +
  '唤醒节奏：你不在每条进度汇报时被唤醒；仅当某成员传 stage=answer+end（派发完工）且你所有外派均回执完毕时，平台一次性唤醒你确认进度；' +
  '成员传 type=question/help 则立即中断唤醒你。因此唤醒后先汇总所有已收回报再行动，不要逐条处理。';

/**
 * P8：分派时动态构建系统提示——在 GLOBAL_SYSTEM_INSTRUCTIONS 基础上注入当前 Agent 的完整
 * 身份（id + 名称 + 角色 + 用户设置的 prompt 职责），供 MCP 工具调用的 selfInstanceId 参数
 * 填写（服务端按 session.teamMemberId 校验后精确落库 senderId/senderInstanceId，
 * 修复"@测试 触发但回复显示开发者"）。
 * opts.isMainAgent=true → 追加主 Agent 职责段；opts.team 非空 → 追加【团队成员】段
 * （id/名称/角色，主 Agent 成员标注），使 agent 直接读取全局上下文即可了解团队构成，
 * 无需再经 task_context MCP 工具拉取。
 * GLOBAL_SYSTEM_INSTRUCTIONS 常量保持不动（其他调用方兼容），本函数仅在 dispatch 下发时
 * 拼接身份段；agent 行查询不到时由调用方降级（name/role/prompt 置 null，回退用 agentId）。
 */
export function buildSystemInstructions(
  agent: AgentIdentityInfo,
  opts?: BuildSystemInstructionsOptions,
): string {
  const selfInstanceId = opts?.selfInstanceId ?? agent.id;
  const selfName = opts?.selfAlias ?? agent.name ?? agent.id;
  // 装配用角色标签：dispatch 装配处已把该字段由 `agentKey` 派生，此处只读内存 DTO，
  // 不触碰任何 DB 列。解构读取以避免 `agent.role` 字面量残留（todo 10 的 grep 闸门）。
  const { role: agentRoleLabel } = agent;
  // 双维度身份：团队会话按团队成员（tmm_）调度时，另行明确其任务实例 id，
  // 避免 agent 拿成员 id 去任务成员表自查时误判"不是任务团队成员"
  const taskInstanceId =
    opts?.taskInstanceId && opts.taskInstanceId !== selfInstanceId
      ? opts.taskInstanceId
      : null;
  const identityLine = taskInstanceId
    ? `【你的身份】你是本任务的 ${selfName}（团队成员 id: ${selfInstanceId}，任务实例 id: ${taskInstanceId}，角色: ${agentRoleLabel ?? ''}）。` +
      `你在本任务团队中的实例就是 ${taskInstanceId}（【团队成员】段中标"主 Agent"的那一位若是你，请直接认领）；` +
      `调用 vteam MCP 工具时 selfInstanceId 参数必须填写你的任务实例 id（${taskInstanceId}）。`
    : `【你的身份】你是本任务的 ${selfName}（实例 id: ${selfInstanceId}，角色: ${agentRoleLabel ?? ''}）。` +
      `调用 vteam MCP 工具时 selfInstanceId 参数必须填写你的实例 id（${selfInstanceId}）。`;
  // 记忆段屏蔽（agent-role-decommission todo 2）：判据 = 已解析策略 tools 是否放行
  // vteam_memory_save，**不再按角色名/duty**。`resolvedTools` 缺省（null/undefined）
  // 时不屏蔽——存量调用与未知自定义 agent 行为逐字节不变。
  // 与「计划模式判定」是两条独立推导：这里回答“这个 agent 有没有这个工具”，
  // 计划模式回答“这个 agent 是不是计划职责”，二者故意解耦（见 opencode-agent-duty）。
  const resolvedTools = opts?.resolvedTools;
  const suppressMemory =
    resolvedTools != null && !toolAllowed(resolvedTools, 'vteam_memory_save');
  const globalText = suppressMemory
    ? GLOBAL_BASE_LINES.join('\n\n')
    : GLOBAL_SYSTEM_INSTRUCTIONS;
  const blocks = [
    globalText,
    identityLine,
    // 岗位角色段来源：TeamMember.roleId → AgentRole.rolePrompt（非 agent 行的 Agent.role，
    // 后者只是标签 key，供策略候选）。仅 rolePrompt 非空时注入；空串被下方
    // filter 剔除 → 无空【岗位职责】标题。顺序：岗位=框架，agent=细节，框架先行。
    opts?.rolePrompt ? `【岗位职责】${opts.rolePrompt}` : '',
    agent.prompt ? `【职责】${agent.prompt}` : '',
    agent.persona ? renderPersonaSection(agent.persona) : '',
    // P0 条件注入：主 Agent 追加【任务状态】+【托管模式】工具段；非主成员仅给协作指引
    // （不再教非主成员调用必 403 的 vteam_task_transition / vteam_question_confirm）。
    opts?.isMainAgent
      ? `${TASK_TRANSITION_INSTRUCTION}\n\n${HOSTED_CONFIRM_INSTRUCTION}\n\n${HOSTED_PLAN_TODO_INSTRUCTION}\n\n${HOSTED_PLAN_REVIEW_INSTRUCTION}\n\n${HOSTED_PLAN_SIGNOFF_INSTRUCTION}`
      : NON_MAIN_AGENT_NOTE,
    // P0 条件注入：企微渠道才追加【企业微信】段，缺省不注入。
    opts?.isWecomChannel === true ? WECOM_SYSTEM_INSTRUCTION : '',
    opts?.persistentWorkDir
      ? `【运行时工作目录】本任务为你分配的实际持久化工作目录为：${opts.persistentWorkDir}。` +
        '工作产物、脚本、中间文件等请写入该目录（提交 doc/file 产出物时 fileRef 使用该目录下的路径）。'
      : '',
    // Todo 4：非空才注入（空串被下方 filter 剔除 → 无边界时输出字节不变）
    opts?.boundarySection ?? '',
  ];
  if (opts?.isMainAgent) {
    blocks.push(MAIN_AGENT_INSTRUCTION);
  }
  // team-mode 接待段：显式 teamMode=true，或显式传入空 taskId；task-mode 调用方
  // 从不传 taskId 字段（undefined 且无 key），文本字节保持不变
  const isTeamMode =
    opts?.teamMode === true ||
    (opts !== undefined && 'taskId' in opts && !opts.taskId);
  if (isTeamMode) {
    blocks.push(TEAM_SYSTEM_RECEPTION_INSTRUCTION);
  }
  // 平台级共享块（agent-role-entity todo 3）：对全部 7 个内置 Agent 无条件注入，
  // 无任何 agent 名/角色分支——普遍性优先于按名条件注入。
  blocks.push(TEAM_COLLABORATION_CHARTER_INSTRUCTION);
  blocks.push(AGENT_RECEIPT_IRON_LAW_INSTRUCTION);
  // 产出物段屏蔽：与记忆段同判据（resolvedTools 是否放行 vteam_submit_artifact）——
  // 计划正文落盘 `.opencode/plans/` 即交付，无该工具者教了会被 guard 拒。
  // `resolvedTools` 缺省 → 不屏蔽（存量/未知调用者字节不变）。
  const suppressArtifact =
    resolvedTools != null &&
    !toolAllowed(resolvedTools, 'vteam_submit_artifact');
  if (!suppressArtifact) {
    blocks.push(ARTIFACT_SUBMISSION_INSTRUCTION);
  }
  // P1：issue 完整版仅显式开关时注入（dispatch 按目标角色传入；缺省一句版，字节兼容）。
  if (opts?.issueDetail === true) {
    blocks.push(ISSUE_FULL_INSTRUCTION);
  }
  if (opts?.team && opts.team.length > 0) {
    const teamLines = opts.team.map(
      (m) =>
        `- ${m.alias ?? m.name ?? m.id}（实例 id: ${m.instanceId}，角色: ${m.role ?? ''}）` +
        (m.instanceId === opts.mainAgentMemberId ? ' —— 主 Agent' : ''),
    );
    blocks.push(
      `【团队成员】本次任务的团队成员（据此判断与谁协作、@ 谁）：\n${teamLines.join('\n')}`,
    );
  }
  if (opts?.memoryIndex) {
    blocks.push(opts.memoryIndex);
  }
  return blocks.filter((b) => b.length > 0).join('\n\n');
}

/**
 * 群聊触发强化指令（dispatch 动态注入，仅来源为群聊频道时）：用户在群聊 @ 你 →
 * 默认应在群聊中公开回复结论（像真人被群聊点名后当众回应）。私聊触发不注入
 * （保持私密独白）。经 group_post 工具发布控制公开内容——模型通过工具发布的内容才会被群聊显示。
 * 互斥优先级：wecom 优先——同一条触发若已注入企微指令（正文含 [WeCom:] 标记），
 * 则不再注入本指令（dispatch 组装处实现），避免模型同时走 group_post 与 wecom_reply 双通道。
 */
export const GROUP_TRIGGER_INSTRUCTION =
  '【群聊回复要求】本条消息来自任务群聊，你被 @ 定向分发。请在群聊中公开回复你的结论' +
  '——调用 vteam MCP 的 vteam_group_post 工具发布到群聊。' +
  '群聊只会显示你通过 vteam_group_post 发布的内容，完整处理过程保留在你的私聊会话。' +
  '如需向群聊发送文件：直接调用 vteam_group_post 并携带 fileRef，文件将作为群聊附件并自动归档为产出物。';

/**
 * 团队直聊群聊触发指令（仅 dispatchForTeamTarget 的 team_group 频道注入）：
 * 团队维度传参（group_post、notify_agent、chat_history 均传 teamId；selfInstanceId
 * 为 system 身份段中的团队成员 id，tmm_ 前缀）；团队直聊无 taskId，禁传 taskId；
 * 需任务上下文的工具在团队直聊下不可用（先 task_create 建任务）。
 */
export const TEAM_GROUP_TRIGGER_INSTRUCTION =
  '【群聊回复要求】本条消息来自团队直聊（无任务），你被 @ 定向分发。请在群聊中公开回复你的结论' +
  '——调用 vteam MCP 的 vteam_group_post 工具发布到群聊（selfInstanceId 填写 system 身份段中的团队成员 id，tmm_ 前缀）。' +
  '群聊只会显示你通过 vteam_group_post 发布的内容，完整处理过程保留在你的私聊会话。' +
  '如需通知其他成员：调用 vteam_notify_agent；' +
  '需要群聊历史时调用 vteam_chat_history（传 teamId）。' +
  '团队直聊没有 taskId，禁止传递 taskId 参数（传了必 403）。' +
  'vteam_my_profile、vteam_team_view、vteam_doclib、vteam_issue_*、vteam_task_transition 类工具需要任务上下文，团队直聊下不要调用（如需任务，先调用 vteam_task_create 创建真实任务）。' +
  '如需向群聊发送文件：直接调用 vteam_group_post 并携带 fileRef，文件将作为群聊附件。';

export const WECOM_TRIGGER_INSTRUCTION =
  '【企微消息】此消息来自企业微信用户 via WeCom，请务必使用 vteam_wecom_reply 工具回复，不要使用 vteam_group_post，以确保用户在企微端收到@回复。' +
  '回复会同时同步到任务群聊。' +
  '（互斥优先级：wecom 优先——已注入本指令时不再注入 GROUP_TRIGGER_INSTRUCTION，见 dispatch 组装处。）';

/**
 * team-mode 团队接待话术段（无任务团队直聊，仅 teamMode 分派时注入 system）：
 * 主 Agent 接待员身份 + 开工三步（挖目标→问明确→问开始→建任务流转）+
 * 意图不明→追问且禁建任务、禁 QuestionModal。task-mode 文本不受影响。
 */
export const TEAM_SYSTEM_RECEPTION_INSTRUCTION =
  '【团队接待】你是本团队的主 Agent 接待员（团队直聊，当前无任务上下文）。' +
  '在任务开始前，用户只能和你沟通，你是唯一的开工入口；子 agent 未被派活，不得主动 @ 其它成员派活。' +
  '开工仪式三步，缺一不可：' +
  '① 挖目标：用户表述不清时追问到底——做什么、为什么做、做到什么样算成；' +
  '② 问明确吗：把理解复述一遍（含目标/范围/验收标准），问用户“这么理解对吗”，不对继续挖；' +
  '③ 问开始吗：明确后必须再问一句“可以开始了吗”，用户点头才算数。' +
  '用户确认开始 → 立刻调用 vteam MCP 的 `vteam_task_create` 创建真实任务' +
  '（团队由当前会话解析、无需传归属），再用 task_transition 流转到进行中，并在群里宣布开门' +
  '（之后才允许派活给子 agent）；所在团队不明确 → 先问用户用哪个团队，绝不猜测归属、绝不创建任务；' +
  '用户意图不明 → 普通回复追问（做什么/验收标准），禁止创建任务、' +
  '禁止走 QuestionModal（问题确认弹窗仅任务内可用）。' +
  '参数规则：vteam_chat_history、vteam_group_post、vteam_notify_agent、vteam_memory_save、vteam_memory_search 这 5 个工具在团队直聊下传 teamId，绝不传 taskId' +
  '（团队直聊没有 taskId，传了必 403）；selfInstanceId 填写 system 身份段中的团队成员 id（tmm_ 前缀）；' +
  'vteam_my_profile、vteam_team_view 与 delivery 相关工具需要任务上下文，团队直聊下不可用（如需任务，先 vteam_task_create 建任务）。';

/**
 * 分派后等待回流的默认超时（D8 总超时；F3 MINOR-3：架构师 5 轮 tool 调用实测 72s > 60s，
 * 复杂任务多轮工具调用易超时 → 默认放宽至 120s，env DISPATCH_TIMEOUT_MS 可配）。
 * 配置项默认值（实例字段 dispatchTimeoutMs 从 ConfigService 读取，缺省回落本值）。
 */
export const DISPATCH_TIMEOUT_MS = 120_000;

/**
 * 事件静默自愈窗口（滑动语义）：dispatch 后距「最近一次回流事件」超过该时长
 * （无 session.updated/delta/agent.status/task.completed；每个非终态事件重武装，
 * 度量「距最近事件」而非「距 dispatch」）→ 判一次「静默」：先查 worker 心跳——
 * 已 offline 则立即失败不唤醒；在线则经既有 tryAutoRestart 唤醒重试（最多
 * MAX_SILENT_WAKE_ATTEMPTS 次，每次重武装全新窗口）；唤醒耗尽仍无响应才
 * emitError + agent.error（silent_session_timeout）。env SILENT_SESSION_WAKE_MS 可配。
 *
 * 三条探活路径各司其职（见 startPendingWatchdog 处武装注释）：
 * ① worker 首字 300s（worker env `WORKER_*_TOKEN…` 见 worker/src/config.ts，唯一 token 探测，worker/src/driver/prompt-await.ts:267）；
 * ② server 事件静默 600s 滑动 ×3（本常量；600000 > 300000 不抢跑 worker 诊断，
 *    覆盖「首字出现后无完成超时」的中途静默——worker/src/exec/exec-server.ts:171 +
 *    AGENT_IDLE_TIMEOUT_MS=0 时无其它兜底）；
 * ③ 心跳 10s 上报 / 30s 判离线（WORKER_HEARTBEAT_INTERVAL_MS=10_000，
 *    server/src/workers/workers.constants.ts，workers.service.ts HealthChecker）。
 */
export const DEFAULT_SILENT_SESSION_WAKE_MS = 600_000;

/**
 * 事件静默唤醒重试上限：每次 deadline 到期且持续静默 → wake 一次（同一【自动恢复】文案）
 * 并重武装全新窗口；第 MAX 次唤醒后仍静默 → 走失败路径（pending 删除 + failedSessions
 * 标记 + 注销 + emitError + agent.error）。
 */
export const MAX_SILENT_WAKE_ATTEMPTS = 3;

/** 空闲判死：session 进入 running 后无任何输出活动（delta/agent.status/task.completed）超时 →
 *  判死（session 标 failed + agent.error）。env AGENT_IDLE_TIMEOUT_MS 可配。 */
export const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 30 * 60_000;

/** 空闲判死扫描周期（定期执行 DB 侧扫描，检查超时会话）。 */
export const IDLE_SCAN_INTERVAL_MS = 60_000;

/**
 * 超时类 env 解析（plain ConfigModule 无 schema，读到的是 STRING）：
 * 十进制整数；"0" → 0（disabled 路径保留）；空/垃圾/负数/非有限数 → fallback。
 */
export function parseTimeoutMs(raw: unknown, fallback: number): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return fallback;
    }
    const n = Math.trunc(raw);
    return n >= 0 ? n : fallback;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s || !/^\d+$/.test(s)) {
      return fallback;
    }
    return Number.parseInt(s, 10);
  }
  return fallback;
}

/** F3 MINOR-3：任务工作目录根（env WORK_DIR，默认 /data/vteam-worker）。
 *  任务级独立工作目录 = <根>/tasks/<taskId>（server 侧 mkdir -p 保证存在），
 *  作为 prompt_async 的 directory 传入——防模型在仓库根真实写文件污染（F4 零污染关键）。
 *  实现与常量已下沉到 ../tasks/work-dir.util（plan-docs.service 要用同一拼法，
 *  从本文件导入会造成 tasks ↔ chat 循环依赖）；此处 re-export 保持既有导入方兼容。 */
export { DEFAULT_TASK_WORK_DIR };

/** 自持轮询间隔 ms（F2 C1：对齐 worker 侧 prompt-await.ts pollMs=500，计划 D8）。 */
export const POLL_INTERVAL_MS = 500;

/** opencode serve GET /session/{id}/message 消息最小形状（判定/聚合只取所需字段）。 */
interface PollMessageShape {
  info?: { role?: string; id?: string };
  parts?: Array<{
    type?: string;
    reason?: string;
    text?: string;
    synthetic?: boolean;
    tokens?: unknown;
    cost?: number;
    time?: { start?: number };
    /** step-finish(reason=error) 携带的模型错误详情（OBS-009：无凭据/401 时 serve 产出）。 */
    error?: { name?: string; message?: string };
  }>;
}

/** OBS-009：模型调用失败时的兜底错误文案（serve 未携带具体错误信息时使用）。 */
export const MODEL_FAILURE_FALLBACK_MESSAGE =
  '模型调用失败（serve 返回 error）';

/**
 * F2 C1：step-finish(reason=stop) 完成判定（移植 worker prompt-await.ts findFinish）。
 * 只认 assistant 消息（user 消息带 step-finish 不算）+ reason===stop。
 */
export function findFinish(
  messages: unknown[],
): PollMessageShape['parts'][number] | undefined {
  for (const raw of messages) {
    const m = raw as PollMessageShape;
    if (m.info?.role !== 'assistant') {
      continue;
    }
    for (const p of m.parts ?? []) {
      if (p.type === 'step-finish' && p.reason === 'stop') {
        return p;
      }
    }
  }
  return undefined;
}

/**
 * OBS-009 快速失败检测：模型调用失败（无凭据/401 等）时 serve 产出
 * step-finish(reason=error)（或 error part）——findFinish 只认 reason=stop，
 * 该形状此前被轮询忽略 → 静默等 120s 超时。本函数遍历 assistant 消息命中即返回
 * 错误文案（error.message 优先，回退 part.text，再回退兜底文案）；无错误 → undefined。
 */
export function findError(messages: unknown[]): string | undefined {
  for (const raw of messages) {
    const m = raw as PollMessageShape;
    if (m.info?.role !== 'assistant') {
      continue;
    }
    for (const p of m.parts ?? []) {
      if (p.type === 'step-finish' && p.reason === 'error') {
        return p.error?.message || p.text || MODEL_FAILURE_FALLBACK_MESSAGE;
      }
      if (p.type === 'error') {
        return p.error?.message || p.text || MODEL_FAILURE_FALLBACK_MESSAGE;
      }
    }
  }
  return undefined;
}

/**
 * F2 C1：文本聚合（移植 worker prompt-await.ts aggregateText）：assistant 消息 +
 * type=text 且非 synthetic（工具调用占位排除）+ 按 part.time.start 升序串接。
 */
export function aggregateText(messages: unknown[]): string {
  const texts = (messages as PollMessageShape[])
    .filter((m) => m.info?.role === 'assistant')
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === 'text' && !p.synthetic)
    .sort((a, b) => (a.time?.start ?? 0) - (b.time?.start ?? 0));
  return texts.map((p) => p.text ?? '').join('');
}

/** XML 实体反转义（F3 MAJOR-2：产出物声明标签正文/属性解析）。 */
export function decodeXml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** 模块级纯解析函数（extractArtifacts/extractJsonByType/extractAllJsonObjects）共用的 logger（类外无 this.logger）。 */
const parseLogger = new Logger('WorkerDispatcher');

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * F3 MAJOR-2：从 agent 回复文本提取产出物声明（12 篇 §3.1 声明形状，兼容 §8.2 注入格式）：
 * ① `<artifact type title>正文</artifact>` 标签（§8.2 格式对称复用，text 类型取正文为 content）；
 * ② 内嵌 JSON 声明对象 `{type, title, content, fileRef}`（§3.1）；
 * ③ `[artifact]...[/artifact]` 包裹的 JSON 声明。
 * 每个候选经 validateArtifactDeclaration 过滤——非法/格式不符直接丢弃（不误报）；
 * 回复无声明 → 返回空数组（正常，不触发归档）。
 */
export function extractArtifacts(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const push = (decl: Record<string, unknown>): void => {
    // 同一声明可能被多种格式命中（如 [artifact] 包裹的 JSON 也被 JSON 正则捕获）→ 去重
    const key = JSON.stringify(decl);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(decl);
    }
  };
  // ① <artifact type="..." title="...">正文</artifact>（§8.2）
  const tagRe = /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/g;
  for (const m of text.matchAll(tagRe)) {
    const attrs = new Map<string, string>();
    for (const attr of m[1].matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) {
      attrs.set(attr[1], decodeXml(attr[2]));
    }
    const type = attrs.get('type');
    const title = attrs.get('title');
    if (type && title) {
      const decl: Record<string, unknown> = {
        type,
        title,
        content: decodeXml(m[2].trim()),
      };
      if (validateArtifactDeclaration(decl).valid) {
        push(decl);
      }
    }
  }
  // ② 内嵌 JSON 声明对象（type 限三态枚举，避免误匹配普通文本）。
  // 定位法（extractAllJsonObjects，按文本出现顺序）：多声明并存（如 [artifact] + 产出物）
  // 时，旧正则 `\{[\s\S]*?"type"` 会从第一个 `{` 跨对象匹配到混合串导致解析失败。
  for (const parsed of extractAllJsonObjects(text, ['text', 'doc', 'file'])) {
    if (validateArtifactDeclaration(parsed).valid) {
      push(parsed);
    }
  }
  // ③ [artifact]...[/artifact] 包裹的 JSON 声明
  const bracketRe = /\[artifact\]([\s\S]*?)\[\/artifact\]/g;
  for (const m of text.matchAll(bracketRe)) {
    try {
      const parsed = JSON.parse(m[1].trim()) as Record<string, unknown>;
      if (
        parsed &&
        typeof parsed === 'object' &&
        validateArtifactDeclaration(parsed).valid
      ) {
        push(parsed);
      }
    } catch (e) {
      // 同上：丢弃
      parseLogger.debug(
        `artifact 声明 JSON 非法已跳过: ${formatErrorMessage(e)}`,
      );
    }
  }
  return out;
}

/** 待回流会话（watchdog 超时用）：key = `<scope>:<agentId>`（scope 恒为
 *  `team:<teamId>`，单团队入口统一团队域；任务只作数据透传，不参与键）。 */
interface PendingDispatch {
  /** 执行作用域（恒 `team:<teamId>`）。 */
  scope: string;
  agentId: string;
  /** 执行实例 id（恒 teamMemberId，tmm_ 前缀；单成员单会话下同成员二次分派复用同一键）。 */
  instanceId: string;
  /** 平台 Session 主键（活动事件回调据此反查静默 watchdog）。 */
  sessionId: string;
  /** 执行 worker id（静默超时注销活跃执行用）。 */
  workerId: string;
  timer: ReturnType<typeof setTimeout>;
  /**
   * 本轮注册时刻（ms epoch）：与 durable payload.dispatchedAt 同值，作为本轮世代号。
   * durable handler 凭它识别「被重武装取代的旧行」——旧行迟到 firing 时不得收割新一轮。
   * 事件滑动重武装不改写它（只推 timer/deadlineAt），世代语义不变。
   */
  dispatchedAt: number;
  /**
   * 当前内存窗口 deadline（ms epoch）：注册/唤醒重武装 = dispatchedAt + 窗口；
   * 每个非终态事件滑动重武装 = now + 窗口。durable 行 dueAt 落后于它时（事件滑动过）
   * handler 顺延 durable 行而不收割（见 handleSilenceTrigger）。
   */
  deadlineAt: number;
  /** 是否已收到过非终态回流事件（false = 仍在等首事件）。空闲判死在该状态否决（veto）。 */
  activitySeen: boolean;
  /**
   * 静默 deadline 的 durable trigger 行 dedupKey（trigger-unification todo-9：
   * per-dispatch 唯一，窗口重注册/顺延时经 TriggerService.cancel 取消；
   * 缺省（TriggerService 未装配）时无 durable 行，仅内存 timer 生效）。
   */
  triggerDedupKey?: string;
}

/**
 * 事件静默 deadline trigger payload（kind 复用 SESSION_IDLE_SCAN，
 * reason 作 payload 内鉴别；见 handleSilenceTrigger）。
 */
interface SilentSessionTriggerPayload {
  reason: 'silent-session';
  scope: string;
  agentId: string;
  sessionId: string;
  workerId: string;
  teamMemberId: string;
  /** watchdog 注册时刻（ms epoch，世代号；内存条目 dispatchedAt 同值）。 */
  dispatchedAt: number;
  /** 本 durable 行的到期时刻（ms epoch）= 注册/顺延时的窗口 deadline。 */
  dueAt: number;
}

/** 事件静默 deadline trigger payload 鉴别（与同 kind 的空闲扫描载荷共存）。 */
function isSilenceTriggerPayload(
  payload: unknown,
): payload is SilentSessionTriggerPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { reason?: unknown }).reason === 'silent-session' &&
    typeof (payload as { sessionId?: unknown }).sessionId === 'string'
  );
}

/**
 * 会话故障恢复的通用唤醒文案（无快照时的 legacy 回退，保持原字节）。
 * 有快照时 tryAutoRestart 在本行之后追加【原始任务重放】段（见 buildWakeText）。
 */
export const FALLBACK_WAKE_TEXT =
  '【自动恢复】检测到会话意外中断，已自动重试，请继续执行未完成的任务';

/**
 * 原始分派快照 TTL（ms）：dispatch 202 受理后内存暂存，超时视为过期（防泄漏）。
 * 取 2h：覆盖空闲判死 30min + 静默窗口 600s×3 的全部恢复窗口；重启后内存丢失
 * 即按无快照回退通用文案（见 tryAutoRestart）。
 */
export const DISPATCH_SNAPSHOT_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * 原始分派快照（is_7 会话故障吞原始 dispatch 修复）：
 * dispatch fire-and-forget 202 受理后暂存原始 payload，会话故障恢复
 * （tryAutoRestart 经 markSessionIdleDead / attemptSilenceWake 触发）时重放
 * 快照文本而非仅通用唤醒语——/execute 立返后模型会话崩溃，原始任务不再丢失。
 */
export interface DispatchSnapshot {
  /** 原始触发正文（request.text，未经 prompt 块拼装；重放时由分派链路重新拼装上下文）。 */
  text: string;
  /** 触发分派的用户消息主键（m_ 前缀）。 */
  messageId: string;
  /** 触发来源频道 id。 */
  channelId: string;
  /** 任务 id（团队直聊为空串）。 */
  taskId: string;
  teamId: string;
  /** 目标成员 id（TeamMember.id，tmm_ 前缀）。 */
  teamMemberId: string;
  agentId: string;
  /** 快照时刻（ms epoch，TTL 依据）。 */
  createdAt: number;
}

/** 快照键（团队维度：同一成员的新一轮分派覆盖旧快照）。 */
export function dispatchSnapshotKey(
  teamId: string,
  teamMemberId: string,
): string {
  return `team:${teamId}:member:${teamMemberId}`;
}

/**
 * 从文本定位 type 字段值并提取完整 JSON 对象：先找 `"type":"<value>"` 位置 → 向前
 * 回溯最近的 `{` → 向后深度配对 `}`（支持字段乱序/嵌套/多对象并存）。
 * 修复：旧正则 `\{[\s\S]*?"type"` 从第一个 `{` 开始匹配，多声明并存时（如 artifact +
 * group_post）会跨对象匹配到混合串导致 JSON.parse 失败——定位法杜绝。
 */
export function extractJsonByType(
  text: string,
  typeValue: string,
): Record<string, unknown> | null {
  if (!text) {
    return null;
  }
  const typeRe = new RegExp(`"type"\\s*:\\s*"${typeValue}"`);
  const tm = typeRe.exec(text);
  if (!tm) {
    return null;
  }
  const start = text.lastIndexOf('{', tm.index);
  if (start < 0) {
    return null;
  }
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') {
      depth += 1;
    } else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as Record<
            string,
            unknown
          >;
        } catch (e) {
          parseLogger.debug(
            `extractJsonByType 回退 type=${typeValue} start=${start}: ${formatErrorMessage(e)}`,
          );
          return null;
        }
      }
    }
  }
  return null;
}

/** 从文本移除 type=<typeValue> 的 JSON 对象块（定位法；返回清理后文本）。 */
export function stripJsonByType(text: string, typeValue: string): string {
  if (!text) {
    return text;
  }
  const typeRe = new RegExp(`"type"\\s*:\\s*"${typeValue}"`);
  const tm = typeRe.exec(text);
  if (!tm) {
    return text;
  }
  const start = text.lastIndexOf('{', tm.index);
  if (start < 0) {
    return text;
  }
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') {
      depth += 1;
    } else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const cleaned = `${text.slice(0, start)}${text.slice(i + 1)}`;
        // 递归处理剩余声明（text 中可能多个同 type 对象）
        return stripJsonByType(cleaned, typeValue);
      }
    }
  }
  return text;
}

/** 群聊通知声明（agent 自主决策，像真人判断是否在群里公开回应）：回复含
 *  `{"type":"group_post","content":"..."}` / `<group_post>...</group_post>` 声明 →
 *  返回 {content, fileRef?}（要转发到群聊的对外消息；fileRef 指向随产出物归档的文件，
 *  用于群聊消息附带附件）；无声明 → null（回复留在私聊独白，不自动公开）。
 */
export function extractGroupPost(
  text: string,
): { content: string; fileRef?: string } | null {
  if (!text) {
    return null;
  }
  const json = extractJsonByType(text, 'group_post');
  if (json && typeof json.content === 'string' && json.content.trim()) {
    return {
      content: json.content.trim(),
      ...(typeof json.fileRef === 'string' && json.fileRef.trim()
        ? { fileRef: json.fileRef.trim() }
        : {}),
    };
  }
  const tagRe = /<group_post\s*([^>]*)>([\s\S]*?)<\/group_post>/g;
  for (const m of text.matchAll(tagRe)) {
    if (m[2].trim()) {
      const attrs = new Map<string, string>();
      for (const a of m[1].matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) {
        attrs.set(a[1], decodeXml(a[2]));
      }
      const fileRef = attrs.get('fileRef');
      return {
        content: decodeXml(m[2].trim()),
        ...(fileRef ? { fileRef } : {}),
      };
    }
  }
  return null;
}

/** 从回复文本移除 group_post 声明块（私聊独白不显示协议标签，仅保留对外内容）。 */
export function stripGroupPostDeclarations(text: string): string {
  if (!text) {
    return text;
  }
  return stripJsonByType(text, 'group_post')
    .replace(/<group_post\s*[^>]*>[\s\S]*?<\/group_post>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 提取文本中所有 type ∈ types 的 JSON 对象（按文本出现位置排序；定位法，防多声明跨对象）。 */
function extractAllJsonObjects(
  text: string,
  types: readonly string[],
): Array<Record<string, unknown>> {
  const found: Array<{ pos: number; obj: Record<string, unknown> }> = [];
  const typeRe = new RegExp(`"type"\\s*:\\s*"(${types.join('|')})"`, 'g');
  for (const tm of text.matchAll(typeRe)) {
    const start = text.lastIndexOf('{', tm.index);
    if (start < 0) {
      continue;
    }
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') {
        depth += 1;
      } else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            found.push({
              pos: start,
              obj: JSON.parse(text.slice(start, i + 1)) as Record<
                string,
                unknown
              >,
            });
          } catch (e) {
            // 非合法 JSON：跳过
            parseLogger.debug(
              `extractAllJsonObjects 跳过非合法 JSON pos=${start}: ${formatErrorMessage(e)}`,
            );
          }
          break;
        }
      }
    }
  }
  return found.sort((a, b) => a.pos - b.pos).map((x) => x.obj);
}

/** 消息行（messages 表；content/mentions 为 Json 列），对齐 chat.service 的 MessageRow 契约。 */
type MessageRow = {
  id: string;
  channelId: string;
  senderType: string;
  senderId: string | null;
  content: Prisma.JsonValue;
  mentions: Prisma.JsonValue | null;
  status: string;
  createdAt: Date;
};

/**
 * 按 UTF-8 字节数截断文本（32KB 语义按字节计）：内容已不超限原样返回；
 * 否则二分查找最长不超限前缀（避免切裂多字节字符）。
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
}

/** XML 文本转义（doclib 注入块内 artifact 属性/正文，防特殊字符破坏结构）。 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 执行作用域（team-free-chat team-mode key 隔离）：
 * 统一入口恒传 `team:<teamId>`（单团队分派/回流全链路同一键；任务只作数据透传，
 * 不参与键，key 碰撞即 bug）。taskId 非空分支仅供存量任务回流路径过渡
 * （归 Todo 7/10，收敛后删除），新代码一律传 scope。
 */
export function toExecutionScope(
  taskId: string | null | undefined,
  teamId?: string | null,
): string {
  if (taskId) {
    return taskId;
  }
  return `team:${teamId ?? ''}`;
}

/**
 * Phase 4 真实分派器（18 篇 §8.3，替换 Phase 2 mock 分派器的核心，M4 主链路心脏）：
 * dispatch → 定位/分配 worker（T12 bindSessionToWorker）→ doclib 上下文注入（12 篇 §8）
 * → WorkerClient 下发（T8 createSession/promptAsync）→ 回流处理（D5：落库 + broadcast
 * chat.message.new + emitFinal 归本类）。
 *
 * 与 Phase 2 mock 分派器的关键差异：
 * - **回复不在此处生成**：dispatch 返回 `{replies: []}`，真实回复经 worker task.completed
 *   回流（09 篇 §4.3）→ handleTaskCompleted 落库 + 广播 + emitFinal（D5 防双写）；
 * - **无 worker 报错不降级**（D3）：assignWorker 无可用 → emitError + 广播 agent.error；
 *   mock 降级仅 WORKER_MOCK_FALLBACK 开关（本类不实现）；
 * - **loading 广播对齐 Phase 2 mock 分派时序**：dispatch 成功后 thinking → operating 两阶段；
 * - **T9 接线**：构造时向 WorkerEventIngress 注册 onTaskCompleted / onAgentStatus 回调。
 *   task.completed 回调做落库+广播+emitFinal；agent.status 回调仅做 emitLoading/emitError
 *   本地通知（SSE 的 agent.loading/agent.error emit 由 T9 ingress 完成，此处不重复广播防双写）。
 */
@Injectable()
export class WorkerDispatcher
  extends MessageDispatcher
  implements OnModuleDestroy
{
  private readonly logger = new Logger(WorkerDispatcher.name);

  /** doclib 注入上限（12 篇 §8.3 可配；公开字段便于测试覆盖）。 */
  public doclibMaxBytes: number;
  public doclibTotalBytes: number;
  /** 群聊历史注入上限（对齐 doclib 32KB 语义；公开字段便于测试覆盖）。 */
  public chatHistoryMaxBytes: number;

  /** 待回流 watchdog：`<scope>:<agentId>` → 条目（事件静默滑动窗口：600s 无事件 → 唤醒重试 ×3）。 */
  private readonly pending = new Map<string, PendingDispatch>();

  /** sessionId → watchdog key 反查（ingress 活动事件回调按 sessionId 滑动重武装/终态清除）。 */
  private readonly pendingBySession = new Map<string, string>();

  /** 空闲判死扫描定时器（惰性启动：首个 dispatch 注册 watchdog 时）。 */
  private idleScanTimer: ReturnType<typeof setInterval> | null = null;

  /** F2 C1 幂等：已落库回流的会话（自持轮询与 ingress task.completed 双通道防重）。
   *  F3 MAJOR-1：新一轮 dispatch 会清除目标会话标记（跨轮回流允许），仍防同轮双写。 */
  private readonly completedSessions = new Set<string>();
  /** F2 MINOR：watchdog/轮询已超时的会话（迟到回流跳过落库，防用户同时见错误+消息）。 */
  private readonly failedSessions = new Set<string>();

  /**
   * 事件静默唤醒计数（sessionId → 已发 wake 次数）：deadline 到期且持续静默 +1 并重武装；
   * 仅在完成/判败/换会话时清 0（非终态活动事件不清——计数跨事件保留）；达到
   * MAX_SILENT_WAKE_ATTEMPTS 后仍静默 → 走失败路径。teardown 清空。
   */
  private readonly silentWakeAttempts = new Map<string, number>();

  /**
   * 原始分派快照（is_7）：快照键 → 快照（dispatch 202 受理后暂存，恢复重放用）。
   * 内存 Map + TTL（DISPATCH_SNAPSHOT_TTL_MS）：与 pending 等恢复态一致——本包
   * 无 Redis/外部 store（package.json 无相关依赖），durable
   * trigger 行只带 deadline 元数据不带全量 prompt；重启丢失即回退通用文案。
   */
  private readonly dispatchSnapshots = new Map<string, DispatchSnapshot>();
  /** 平台 sessionId → 快照键（活动/完成事件按 sessionId 清除快照用）。 */
  private readonly snapshotSessionIndex = new Map<string, string>();

  /**
   * 执行中注册表（workerId:scope → 活跃执行集合）：dispatch 调 worker execute 前登记，
   * task.completed / agent.status error / watchdog 超时注销。platform-mcp 的落库类工具
   * （group_post / notify_agent / submit_artifact）经 assertWorkerTask 用本表校验
   * selfInstanceId 必须为当前活跃执行实例。scope 恒 `team:<teamId>`，
   * 登记 ref 恒 teamMemberId（tmm_ 前缀）。
   */
  private readonly activeExecutions = new Map<
    string,
    { agents: Set<string>; at: number }
  >();
  /** 执行注册 TTL（ms）：worker 崩溃/回流丢失时防活跃记录泄漏，超时视为不活跃。 */
  private readonly executionTtlMs = 30 * 60 * 1000;
  private executionKey(workerId: string, scope: string): string {
    return `${workerId}:${scope}`;
  }

  /**
   * dispatch 下发 execute 前登记活跃执行（防冒充校验依据）。
   * 登记集合存 teamMemberId（tmm_ 前缀），由调用方传入团队成员 id；scope 恒
   * `team:<teamId>`（经 toExecutionScope(null, teamId) 取）。
   */
  registerExecution(
    workerId: string,
    scope: string,
    teamMemberId: string,
  ): void {
    const key = this.executionKey(workerId, scope);
    const entry = this.activeExecutions.get(key);
    if (entry) {
      entry.agents.add(teamMemberId);
      entry.at = Date.now();
    } else {
      this.activeExecutions.set(key, {
        agents: new Set([teamMemberId]),
        at: Date.now(),
      });
    }
  }

  /**
   * task.completed / error / 超时 时注销活跃执行。ref 恒 teamMemberId（tmm_ 前缀，
   * 与登记同值匹配）；scope 恒 `team:<teamId>`。
   */
  unregisterExecution(workerId: string, scope: string, ref: string): void {
    const key = this.executionKey(workerId, scope);
    const entry = this.activeExecutions.get(key);
    if (!entry) {
      return;
    }
    entry.agents.delete(ref);
    if (entry.agents.size === 0) {
      this.activeExecutions.delete(key);
    }
  }

  /**
   * MCP assertWorkerTask 防冒充校验：返回该 worker+scope 当前活跃执行成员集合。
   * 无注册记录（非 dispatch 驱动/进程重启后）→ 返回 null，调用方回退 findFirst 兼容；
   * 有记录 → 调用方必须严格校验 selfInstanceId 在集合内（防止冒充）。
   */
  isAgentExecuting(workerId: string, scope: string): Set<string> | null {
    const key = this.executionKey(workerId, scope);
    const entry = this.activeExecutions.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.at > this.executionTtlMs) {
      this.activeExecutions.delete(key);
      return null;
    }
    return entry.agents;
  }

  /** F3 MINOR-3：回流超时 ms（env DISPATCH_TIMEOUT_MS，缺省 DISPATCH_TIMEOUT_MS=120s）。 */
  public dispatchTimeoutMs: number;
  /** 事件静默窗口 ms（env SILENT_SESSION_WAKE_MS，缺省 600s，滑动重武装）：距最近事件超窗 → 唤醒/判败。 */
  public silentSessionWakeMs: number;
  /** 空闲判死 ms（env AGENT_IDLE_TIMEOUT_MS，缺省 30min）：running 后无输出活动超时 → 判死。 */
  public agentIdleTimeoutMs: number;
  /** F3 MINOR-3：任务工作目录根（env WORK_DIR，缺省 /data/vteam-worker-tasks）。 */
  public taskWorkDirRoot: string;
  /** F3 MAJOR-1：增量 poll 游标（sessionId → 已消费到的最新消息 id），复用会话跨轮续接。 */
  private readonly pollCursors = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
    private readonly workersService: WorkersService,
    private readonly workerClient: WorkerClient,
    private readonly sessionLifecycle: SessionLifecycleService,
    private readonly artifactsService: ArtifactsService,
    config: ConfigService,
    ingress: WorkerEventIngress,
    @Optional()
    private readonly moduleRef?: ModuleRef,
    // 静默 watchdog 的 durable deadline（trigger-unification todo-9）：
    // 缺省可空——单测/旧装配未提供时仅内存 setTimeout 生效，不阻断分派；
    // 生产装配经 ChatModule（已 import TimersModule）提供。
    @Optional()
    @Inject(TriggerService)
    private readonly triggers?: TriggerService,
    // 目标策略解析（vteam-role-behavior-abstraction Todo 11：边界段由 resolved policy 的
    // correction 提供）。缺省可空——单测/旧装配未提供时回退常量派生的边界段，
    // 不阻断分派；生产装配经 ChatModule（已 import ExecutionPoliciesModule）提供。
    @Optional()
    @Inject(ExecutionPolicyService)
    private readonly executionPolicyService?: ExecutionPolicyService,
  ) {
    super();
    const maxBytes = config.get<number>('DOCLIB_MAX_BYTES');
    this.doclibMaxBytes =
      typeof maxBytes === 'number' && maxBytes > 0
        ? maxBytes
        : DEFAULT_DOCLIB_MAX_BYTES;
    const totalBytes = config.get<number>('DOCLIB_TOTAL_BYTES');
    this.doclibTotalBytes =
      typeof totalBytes === 'number' && totalBytes > 0
        ? totalBytes
        : DEFAULT_DOCLIB_TOTAL_BYTES;
    const historyBytes = config.get<number>('CHAT_HISTORY_MAX_BYTES');
    this.chatHistoryMaxBytes =
      typeof historyBytes === 'number' && historyBytes > 0
        ? historyBytes
        : DEFAULT_CHAT_HISTORY_MAX_BYTES;
    // F3 MINOR-3：回流超时可配（DISPATCH_TIMEOUT_MS），缺省 120s（复杂任务多轮 tool 调用）
    const timeoutMs = config.get<number>('DISPATCH_TIMEOUT_MS');
    this.dispatchTimeoutMs =
      typeof timeoutMs === 'number' && timeoutMs > 0
        ? timeoutMs
        : DISPATCH_TIMEOUT_MS;
    // 事件静默窗口（SILENT_SESSION_WAKE_MS，缺省 600s，滑动）——只判「距最近事件是否超窗」
    // plain ConfigModule 无 schema：读到的是 STRING，”600000“ 等需 parseTimeoutMs 解析
    const silentWake = config.get('SILENT_SESSION_WAKE_MS');
    this.silentSessionWakeMs = parseTimeoutMs(
      silentWake,
      DEFAULT_SILENT_SESSION_WAKE_MS,
    );
    // 空闲判死（AGENT_IDLE_TIMEOUT_MS，缺省 30min）——running 后无输出活动超时判死
    const idleTimeout = config.get('AGENT_IDLE_TIMEOUT_MS');
    this.agentIdleTimeoutMs = parseTimeoutMs(
      idleTimeout,
      DEFAULT_AGENT_IDLE_TIMEOUT_MS,
    );
    // F3 MINOR-3：任务工作目录根（WORK_DIR），任务目录 = <根>/tasks/<taskId>
    const workDir = config.get<string>('WORK_DIR');
    this.taskWorkDirRoot =
      typeof workDir === 'string' && workDir.trim()
        ? workDir.trim()
        : DEFAULT_TASK_WORK_DIR;

    // T9 接线：注册回流回调（D5——落库+广播 chat.message.new+emitFinal 归本类回流处理器，
    // 防双写；agent.status 仅本地回调通知，SSE emit 由 ingress 完成）
    ingress.onTaskCompleted((payload) => {
      void this.handleTaskCompleted(payload).catch((err: unknown) =>
        this.logger.error(
          `task.completed 回流处理失败: ${this.describeError(err)}`,
        ),
      );
    });
    ingress.onAgentStatus((payload) => {
      void this.handleAgentStatus(payload);
    });
    // 判死 watchdog：ingress 活动事件通知（session.updated/delta/agent.status/task.completed）
    // → 终态清除静默 watchdog / 非终态滑动重武装窗口 + 刷新空闲判死计时
    ingress.onSessionActivity((payload) => {
      this.handleSessionActivity(payload);
    });
    // todo-7 重启安全：空闲扫描常驻启动（AGENT_IDLE_TIMEOUT_MS>0 时），重启后即便
    // 没有进程内 dispatch 状态，DB 侧检出仍能判死 stuck running 会话。
    this.startIdleScan();
    // todo-9 重启安全：静默 deadline 经 TriggerService 注册同 kind handler，
    // 重启后到期行仍能收割静默会话（内存 pending 全空时走 DB 侧判定）。
    try {
      this.triggers?.registerHandler(
        TRIGGER_KIND.SESSION_IDLE_SCAN,
        (trigger) => this.handleSilenceTrigger(trigger),
      );
    } catch (err) {
      this.logger.warn(
        `静默 deadline handler 注册失败（仅内存 watchdog 生效）: ${this.describeError(err)}`,
      );
    }
  }

  onModuleDestroy(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
    }
    this.pending.clear();
    this.pendingBySession.clear();
    this.silentWakeAttempts.clear();
    this.dispatchSnapshots.clear();
    this.snapshotSessionIndex.clear();
    if (this.idleScanTimer) {
      clearInterval(this.idleScanTimer);
      this.idleScanTimer = null;
    }
  }

  // ------------------------------------------------------------------
  // MessageDispatcher 抽象实现
  // ------------------------------------------------------------------

  /**
   * 下发分派（fire-and-forget，ChatService 不 await 结果）：
   * 单团队入口：全量经 dispatchForTeamTarget（assignWorker → createSession/bind →
   * execute → ingress 回流），任务只作数据经 taskContext 透传给 execute/回流归因。
   * 返回 `{replies: []}`——真实回复经 task.completed 回流（D5），不在此生成。
   * 单目标失败 emitError + 广播 agent.error，不阻塞其他目标（FR-21）。
   */
  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const teamId = request.teamId ?? null;
    if (!teamId) {
      throw new BadRequestException({
        code: 'TEAM_SESSION_MISSING_DIMENSION',
        message: '分派缺少 teamId（单团队入口 teamId 必填）',
      });
    }
    const scope = toExecutionScope(null, teamId);
    for (const target of request.targets) {
      try {
        await this.dispatchForTeamTarget(request, target, teamId);
      } catch (err) {
        const message = this.describeError(err);
        this.logger.error(
          `agent ${target.agentId} dispatch failed: ${message}`,
          (err as Error).stack,
        );
        this.emitError({
          taskId: scope,
          agentId: target.agentId,
          error: message,
        });
        await this.broadcastAgentError({
          taskId: scope,
          agentId: target.agentId,
          sessionId: target.sessionId,
          level: 'message',
          errorType: 'dispatch_failed',
          message,
          teamId,
        });
      }
    }
    return { replies: [] };
  }

  /**
   * FR-13：agent 互 @ 触发——MCP `notify_agent` 工具调用入口。
   * 双维度：任务维度（taskId 传任务）经任务归属 teamId 触发；团队维度
   * （taskId 缺省、teamId 直传，零任务团队）跳过任务查表、用传入 teamId 直接
   * 触发。两路均经 ensureTeamSession（teamId, targetInstanceId）即建即得团队
   * 会话，复用 dispatch() 单团队入口全链路（assignWorker → createSession/bind
   * → execute → ingress 回流落库+广播，不复制单目标分派逻辑）；单目标失败由
   * dispatch() 统一 emitError + 广播 agent.error。团队路径 taskId 置空 +
   * taskContext 缺省（对齐用户-@ 团队成员触发的 team-scope 约定：工作目录走
   * teams/<teamId>，提示词走【团队接待】段）。
   * 统一返回契约（plan-review todo 3）：本方法内部返回保持 void（不组装
   * triggered——triggered 只在 notifyAgent 层组装）；可选 issueId 由 notifyAgent
   * 透传（派活归属 issue，缺省不阻断；todo 4 消费 issue 锁/去重）。
   * 执行门禁（plan-review todo 4；server-gate-removal todo 3）：kind 缺省 execution。
   * 计划状态不再作为派发前提（plan.status 门已移除）。保留：调用方携带 planHash 且冻结
   * 哈希齐备时比对，不一致即抛错（提示期望/实际短哈希）。review/nudge/wake 豁免。
   * 门禁读错/未装配即 fail-open 放行 + warn（永不转 fail-closed）。
   * 计划表读经 PlanLifecycleService（ModuleRef 懒解析，避免 ChatModule 与
   * TasksModule 静态环；本文件永不直读计划表）。
   */
  async dispatchAgentMention(input: {
    taskId?: string | null;
    /** 团队维度直传（taskId 缺省时必填，跳过任务查表）。 */
    teamId?: string | null;
    /** 群聊频道（触发来源：目标 agent 的 group_post 回复落库+广播走此频道）。 */
    channelId: string;
    /** 消息内容（含 @目标，透传给目标 agent 作为触发 prompt）。 */
    text: string;
    /** 被 @ 的目标成员 id（TeamMember.id，tmm_ 前缀）。 */
    targetInstanceId: string;
    /** 可选 issue 绑定（notify_agent 透传；缺省不阻断，todo 4 消费）。 */
    issueId?: string | null;
    /** 执行分类（缺省 execution；内部唤醒/轮次通知传 wake，评审传 review，催办传 nudge）。 */
    kind?: DispatchExecutionKind;
    /**
     * 调用方携带的计划哈希（实际值，planVersion.hash sha1-8 口径；todo 3 执行认哈希）。
     * 与冻结哈希不一致即抛错拦截；缺省 → 哈希门禁未武装（原状态门禁语义不变）。
     * notifyAgent 层不透传本字段（各层以自有输入独立执法）。
     */
    planHash?: string | null;
  }): Promise<string> {
    let teamId: string | null = null;
    let taskIdForDispatch: string | null = null;
    let taskStatusForDispatch: string | null = null;
    if (input.taskId) {
      const taskRow = await (this.prisma as any).task.findUnique({
        where: { id: input.taskId },
        select: { teamId: true, status: true },
      });
      teamId = (taskRow as any)?.teamId ?? null;
      if (!teamId) {
        throw new Error(
          `实例 ${input.targetInstanceId} 无团队会话（团队 未知，任务 ${input.taskId}）`,
        );
      }
      taskIdForDispatch = input.taskId;
      taskStatusForDispatch = (taskRow as any)?.status ?? null;
    } else if (input.teamId) {
      teamId = input.teamId;
    } else {
      throw new Error(
        `实例 ${input.targetInstanceId} 无团队会话（团队 未知，任务 未知）`,
      );
    }
    const kind: DispatchExecutionKind = input.kind ?? 'execution';
    if (kind === 'execution' && taskIdForDispatch) {
      // 终态任务门禁：execution 派发绑定 completed/archived 任务即拒绝（零副作用，
      // 位于计划门禁/worker 调用/回执记账之前）；review/nudge/wake 豁免（收尾流量），
      // 缺行（行缺失语义归别处）与无 taskId 照旧放行。终态口径对齐 TASK_STATUS
      // （terminal = completed + archived），先例见 tryAutoRestart 的 in_progress 前置。
      if (
        taskStatusForDispatch === 'completed' ||
        taskStatusForDispatch === 'archived'
      ) {
        throw new Error(
          `任务 ${taskIdForDispatch} 已终态终止 (terminal, status=${taskStatusForDispatch})：execution 派发已拒绝，请主 Agent 调用 task_create 创建新任务后再派发`,
        );
      }
      // 计划门禁对每个目标一律生效（a_plan 角色豁免已删除）：任一目标携带过期
      // planHash 都必须被拒，否则过期计划可经计划员目标绕过哈希门禁。
      await this.assertPlanExecutionAllowed(
        taskIdForDispatch,
        input.planHash ?? null,
      );
    }
    const ensured = await this.sessionLifecycle.ensureTeamSession(
      teamId,
      input.targetInstanceId,
    );
    await this.dispatch({
      messageId: await this.idGen.nextId(MESSAGE_ID_PREFIX),
      channelId: input.channelId,
      taskId: taskIdForDispatch ?? '',
      teamId,
      ...(taskIdForDispatch
        ? { taskContext: { taskId: taskIdForDispatch } }
        : {}),
      text: input.text,
      targets: [
        {
          agentId: ensured.agentId,
          instanceId: input.targetInstanceId,
          sessionId: ensured.id,
        },
      ],
    });
    // 返回被分派的目标会话主键（trigger-unification wake 失败记录）：
    // HookService 落 hook.target.wakeSessionId 以关联后续 agent.error /
    // session.updated(failed)；其余调用方忽略返回值，向后兼容。
    return ensured.id;
  }

  /**
   * 计划执行门禁（todo4 第二道防线；第一道在 notifyAgent 层组装 plan-gated 返回）。
   * 计划状态不再作为派发条件（todo 3）：状态门禁已移除，仅保留计划行兜底创建与
   * 冻结哈希比对。调用方携带 planHash 且冻结哈希齐备时比对，不一致即抛错
   * （报错同时命名期望/实际短哈希）；任一侧缺失 → 哈希门禁未武装（fail-open）。
   * 读错/建行失败/未装配即 fail-open + warn。门禁对每个目标一律生效（无角色豁免）。
   */
  private async assertPlanExecutionAllowed(
    taskId: string,
    callerHash?: string | null,
  ): Promise<void> {
    let planLifecycle: PlanLifecycleService | null = null;
    try {
      planLifecycle =
        this.moduleRef?.get(PlanLifecycleService, { strict: false }) ?? null;
    } catch (err) {
      this.logger.warn(
        `门禁 PlanLifecycleService 未装配 task=${taskId}，fail-open 放行：${this.describeError(err)}`,
      );
      planLifecycle = null;
    }
    if (!planLifecycle) {
      return;
    }
    try {
      await planLifecycle.autoEnsureRow(taskId);
    } catch (err) {
      this.logger.warn(
        `门禁读失败 task=${taskId}，fail-open 放行：${this.describeError(err)}`,
      );
      return;
    }
    const actual = normalizePlanHash(callerHash);
    if (actual) {
      const expected = await this.resolveFrozenPlanHash(taskId);
      if (isStalePlanHash(expected, actual)) {
        throw new Error(buildStalePlanHashHint(expected as string, actual));
      }
    }
  }

  /**
   * 冻结哈希读端（todo 3；todo 2 落 frozenHash 列前过渡口径）：
   * 任务下各轮次账本取最大 round 者 planVersion.hash。无账本/读错/
   * 未装配 → null（哈希门禁未武装，fail-open）。只读 issues 表，不碰计划表。
   */
  private async resolveFrozenPlanHash(taskId: string): Promise<string | null> {
    try {
      const issueRepo = (this.prisma as any)?.issue;
      if (!issueRepo || typeof issueRepo.findMany !== 'function') {
        return null;
      }
      const rows = await issueRepo.findMany({
        where: { taskId },
        select: { description: true },
      });
      const descriptions: Array<string | null | undefined> = Array.isArray(rows)
        ? rows.map(
            (row: { description?: string | null }) => row?.description ?? null,
          )
        : [];
      return selectFrozenPlanHash(descriptions);
    } catch (err) {
      this.logger.warn(
        `冻结哈希读取失败 task=${taskId}，哈希门禁未武装：${this.describeError(err)}`,
      );
      return null;
    }
  }

  // ------------------------------------------------------------------
  // 单团队分派入口（Todo 1 收敛：任务路径已删，全量走本区；任务只作数据经 taskContext）
  // ------------------------------------------------------------------

  /**
   * team-mode 主成员判定（触发选择）：team.mainAgentMemberId → 该成员，否则首位
   * 成员（seq 升序）；团队缺失/空名册/主成员悬空 → null。语义对齐 chat.service
   * buildMainAgentTrigger 团队分支（mainAgentMemberId 优先，否则首位）。
   */
  async resolveTeamMainMember(
    teamId: string,
  ): Promise<{ memberId: string; agentId: string } | null> {
    const team = await (this.prisma as any).team.findUnique({
      where: { id: teamId },
      select: { mainAgentMemberId: true },
    });
    if (!team) {
      return null;
    }
    if (team.mainAgentMemberId) {
      const main = await (this.prisma as any).teamMember.findFirst({
        where: { id: team.mainAgentMemberId, teamId },
        select: { id: true, agentId: true },
      });
      return main ? { memberId: main.id, agentId: main.agentId } : null;
    }
    const first = await (this.prisma as any).teamMember.findFirst({
      where: { teamId },
      orderBy: [{ seq: 'asc' }, { id: 'asc' }],
      select: { id: true, agentId: true },
    });
    return first ? { memberId: first.id, agentId: first.agentId } : null;
  }

  /**
   * team-mode 主触发（无任务）：主成员判定 + ensureTeamSession，会话即建即返，
   * 供团队直聊无 @ 时默认触发主 Agent。空名册 → null。
   */
  async buildTeamMainTrigger(teamId: string): Promise<{
    agentId: string;
    instanceId: string;
    sessionId: string;
  } | null> {
    const main = await this.resolveTeamMainMember(teamId);
    if (!main) {
      return null;
    }
    const session = await this.sessionLifecycle.ensureTeamSession(
      teamId,
      main.memberId,
    );
    return {
      agentId: main.agentId,
      instanceId: main.memberId,
      sessionId: session.id,
    };
  }

  /**
   * team-mode 成员触发（无任务 @-mention）：按 (teamId, teamMemberId) 定位成员 +
   * ensureTeamSession，会话即建即返，供零任务团队 @agent/@all 目标补会话
   * （createMessage 内 no_session → dispatched 翻转用）。
   * 成员缺失即错，不做跨维度回退；会话创建复用
   * ensureTeamSession，无新会话逻辑（与 buildTeamMainTrigger 同形）。
   */
  async buildTeamMemberTrigger(
    teamId: string,
    teamMemberId: string,
  ): Promise<{ agentId: string; instanceId: string; sessionId: string }> {
    const member = await (this.prisma as any).teamMember.findFirst({
      where: { id: teamMemberId, teamId },
      select: { id: true, agentId: true },
    });
    if (!member) {
      throw new Error(`成员 ${teamMemberId} 不在团队 ${teamId} 内`);
    }
    const session = await this.sessionLifecycle.ensureTeamSession(
      teamId,
      member.id,
    );
    return {
      agentId: member.agentId,
      instanceId: member.id,
      sessionId: session.id,
    };
  }

  /** team-mode 频道定位：(teamId, teamMemberId) 私聊优先 → team_group 回退；无频道 → null。 */
  private async resolveTeamChannel(teamId: string, teamMemberId: string) {
    const dm = await this.prisma.chatChannel.findFirst({
      where: { teamId, teamMemberId },
      select: { id: true, type: true },
    });
    if (dm) {
      return dm;
    }
    return this.prisma.chatChannel.findFirst({
      where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
      select: { id: true, type: true },
    });
  }

  /**
   * 团队记忆索引（prompt hint 富集专用，session-unification Todo 9 起仅
   * team+global 两域，任务级记忆已删除）：计数 + 最近 5 条 description 行拼成
   * 索引块注入 system。仅读记忆表做提示词富集，不改 memorySave/memorySearch
   * 写/可见语义。失败吞错返 null（无记忆 mock/表异常时分派照常）。
   */
  private async buildTeamMemoryIndex(teamId: string): Promise<string | null> {
    try {
      const [teamCnt, globCnt, recent] = await Promise.all([
        this.prisma.memory.count({
          where: { level: 'team', teamId, deletedAt: null },
        } as any),
        this.prisma.memory.count({
          where: { level: 'global', deletedAt: null },
        } as any),
        this.prisma.memory.findMany({
          where: {
            deletedAt: null,
            OR: [{ level: 'team', teamId }, { level: 'global' }],
          } as any,
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            level: true,
            description: true,
            content: true,
            tags: true,
          },
        } as any),
      ]);
      const tagMap = new Map<string, number>();
      for (const r of recent as any[]) {
        const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
        for (const t of tags) tagMap.set(t, (tagMap.get(t) ?? 0) + 1);
      }
      const topTags = [...tagMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([k]) => k);
      const lines = (recent as any[]).map(
        (r) =>
          `- [${r.level}] ${r.description || String(r.content).slice(0, 60)} (tags:${Array.isArray(r.tags) ? (r.tags as string[]).join(',') : '-'})`,
      );
      if (teamCnt + globCnt > 0) {
        let memoryIndex =
          `【可用记忆索引 team:${teamCnt} global:${globCnt}${topTags.length ? ` Top tags:${topTags.join(',')}` : ''}】\n` +
          (lines.length
            ? lines.join('\n') +
              '\n按需用 vteam_memory_search 拉正文，摘要命中再取 content。'
            : '暂无记忆正文。');
        if (memoryIndex.length > 1200) memoryIndex = memoryIndex.slice(0, 1200);
        return memoryIndex;
      }
      return null;
    } catch (err) {
      this.logger.debug(
        `记忆索引构建失败 team=${teamId}，返回 null：${this.describeError(err)}`,
      );
      return null;
    }
  }

  /**
   * 单团队入口单目标分派：会话按 (teamId, teamMemberId) 经
   * ensureTeamSession 即建即得；任务只作数据（request.taskContext?.taskId 透传
   * execute/回流归因，不参与会话/注册/watchdog 键）；主判定走团队门（session
   * 团队成员 == team.mainAgentMemberId）；工作目录按任务隔离
   * （taskContext.taskId → <根>/tasks/<taskId>，无任务 → <根>/teams/<teamId>）；
   * 执行注册/watchdog/loading 事件键走 `team:<teamId>` 作用域。
   */
  private async dispatchForTeamTarget(
    request: DispatchRequest,
    target: {
      agentId: string;
      sessionId: string | null;
      instanceId?: string | null;
    },
    teamId: string,
  ): Promise<void> {
    const scope = toExecutionScope(null, teamId);
    // team-mode 仅取 teamMemberId，缺失即错，不回退
    const teamMemberId = target.instanceId ?? null;
    if (!teamMemberId) {
      throw new Error(
        `团队直聊分派缺少成员 id（团队 ${teamId}，target.instanceId 必填，不回退）`,
      );
    }

    // 1. 会话：target.sessionId 缺失 → ensureTeamSession 即建；存在 → 校验归属
    let sessionId = target.sessionId;
    if (!sessionId) {
      const ensured = await this.sessionLifecycle.ensureTeamSession(
        teamId,
        teamMemberId,
      );
      sessionId = ensured.id;
    }
    const session = await (this.prisma as any).session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        workerId: true,
        instanceRef: true,
        teamId: true,
        teamMemberId: true,
      },
    });
    if (
      !session ||
      session.teamMemberId !== teamMemberId ||
      (session.teamId ?? null) !== teamId
    ) {
      throw new Error(
        `会话 ${sessionId} 与团队成员 ${teamMemberId} 不匹配（团队 ${teamId}），无法分派`,
      );
    }

    // 2. 定位 worker：已绑复用，未绑/残留 pending 则分配 + 首次 bind 占位
    const hasStalePending = session.instanceRef === PENDING_INSTANCE_REF;
    let workerId = session.workerId;
    let opencodeSessionId =
      !hasStalePending &&
      session.instanceRef &&
      session.instanceRef !== PENDING_INSTANCE_REF
        ? session.instanceRef
        : null;

    // 成员级模型覆盖优先（teamMember.overrideModelId，会话页「修改 agent 模型」落库字段），
    // 其次 taskContext 透传，最后回退 agent 模板 defaultModelId。
    // 查询缺失/失败不阻断分派：回退后续解析（覆盖查询本属增强，非主链路）。
    const memberOverride = teamMemberId
      ? await this.resolveMemberOverrideModelId(teamMemberId)
      : null;
    const agentModelId =
      memberOverride ??
      request.taskContext?.overrideModelId ??
      (await this.resolveAgentModelId(target.agentId));
    const assignmentReq: AssignmentRequirement = agentModelId
      ? { modelId: agentModelId }
      : {};

    if (!workerId || hasStalePending) {
      workerId = await this.workersService.assignWorker(assignmentReq);
      if (!workerId) {
        throw new Error(
          '无可用 worker：请先启动 worker 节点（mock 降级需 WORKER_MOCK_FALLBACK）',
        );
      }
      await this.sessionLifecycle.bindSessionToWorker(
        sessionId,
        workerId,
        PENDING_INSTANCE_REF,
      );
    }

    // 复用已绑定 worker 的在线校验 + 离线重分配（同 task-mode 时序）
    let workerRow = await this.prisma.worker.findUnique({
      where: { id: workerId },
      select: {
        id: true,
        status: true,
        capabilities: true,
        defaultModelId: true,
      },
    });
    if (!workerRow || workerRow.status === WORKER_STATUS.OFFLINE) {
      const staleWorkerId = workerId;
      this.logger.warn(
        `agent ${target.agentId} 绑定的 worker ${staleWorkerId} 不可用` +
          `${workerRow ? '（offline）' : '（不存在）'}，解绑并重新分配 worker`,
      );
      await this.sessionLifecycle.unbindSession(sessionId);
      workerId = await this.workersService.assignWorker(assignmentReq);
      if (!workerId) {
        throw new Error(
          '无可用 worker：请先启动 worker 节点（mock 降级需 WORKER_MOCK_FALLBACK）',
        );
      }
      workerRow = await this.prisma.worker.findUnique({
        where: { id: workerId },
        select: {
          id: true,
          status: true,
          capabilities: true,
          defaultModelId: true,
        },
      });
      if (!workerRow) {
        throw new Error(`worker ${workerId} 不存在`);
      }
      opencodeSessionId = null;
      await this.sessionLifecycle.bindSessionToWorker(
        sessionId,
        workerId,
        PENDING_INSTANCE_REF,
      );
    }
    const worker: WorkerEndpointRef = {
      id: workerId,
      capabilities: workerRow.capabilities,
    };

    const model = this.toModelSelection(
      agentModelId ?? workerRow.defaultModelId ?? null,
    );

    // 3. 提示词：单触发器——任务段 + team 段按 taskContext 有无拼接；
    // 群聊触发指令二选一（任务模式 GROUP 版 / 团队直聊 TEAM 版）。
    const taskIdForPrompt = request.taskContext?.taskId ?? '';
    const promptBlocks: string[] = [];
    if (taskIdForPrompt) {
      promptBlocks.push(
        `【任务上下文】你的当前任务 ID：${taskIdForPrompt}。` +
          '需要群聊历史/文档库/任务信息时，调用 vteam 的 vteam_chat_history / vteam_doclib / vteam_task_context 工具（传 taskId）。' +
          '需要向群聊发布消息时调用 vteam 的 vteam_group_post 工具。',
      );
    } else {
      promptBlocks.push(
        `【团队上下文】你当前在团队 ${teamId} 直聊（无任务）。` +
          '需要群聊历史时调用 vteam_chat_history（传 teamId）；需要向群聊发布时调用 vteam_group_post（传 teamId）。',
      );
    }
    const sourceChannel = await this.prisma.chatChannel.findUnique({
      where: { id: request.channelId },
      select: { type: true },
    });
    if (
      sourceChannel?.type === CHANNEL_TYPE.team_group &&
      !request.text.includes('[WeCom:')
    ) {
      // 互斥优先级 wecom 优先：企微消息走 wecom_reply 单通道，不再叠加群聊指令
      //（GROUP/TEAM_GROUP 二选一逻辑保持不变，仅在非企微时注入）。
      promptBlocks.push(
        taskIdForPrompt
          ? GROUP_TRIGGER_INSTRUCTION
          : TEAM_GROUP_TRIGGER_INSTRUCTION,
      );
    }
    if (request.text.includes('[WeCom:')) {
      const wecomMatch = /\[WeCom:([^\]]+)\]/.exec(request.text);
      const wecomUserLabel = wecomMatch ? wecomMatch[1].trim() : '';
      const tailored = wecomUserLabel
        ? `【企微消息】此消息来自企业微信用户 ${wecomUserLabel} via WeCom，请务必使用 vteam_wecom_reply 工具回复，不要使用 vteam_group_post，以确保用户在企微端收到@回复。`
        : WECOM_TRIGGER_INSTRUCTION;
      promptBlocks.push(tailored);
    }
    promptBlocks.push(request.text);
    const prompt = promptBlocks.join('\n\n');

    // 4. loading(thinking)：团队 scope 广播 + team: 作用域事件
    await this.realtime.broadcast(
      EVENT_TYPES.AGENT_LOADING,
      {
        taskId: scope,
        agentId: target.agentId,
        instanceId: teamMemberId,
        sessionId,
        phase: 'thinking',
      },
      { type: 'team', id: teamId } as any,
    );
    this.emitLoading({
      taskId: scope,
      agentId: target.agentId,
      instanceId: teamMemberId,
      sessionId,
      phase: 'thinking',
    });

    // 5. 创建 opencode 会话（未创建/占位时）→ 第二次 bind 写入真实 instanceRef
    if (!opencodeSessionId) {
      try {
        const created = await this.workerClient.createSession(worker, model);
        opencodeSessionId = created.sessionID;
        await this.sessionLifecycle.bindSessionToWorker(
          sessionId,
          workerId,
          opencodeSessionId,
        );
      } catch (err) {
        await this.sessionLifecycle
          .unbindSession(sessionId)
          .catch((rbErr: unknown) =>
            this.logger.error(`回滚绑定失败: ${this.describeError(rbErr)}`),
          );
        throw err;
      }
    }

    // 6. 工作目录（任务隔离保留：taskContext.taskId → tasks/<taskId>；
    // 无任务 → teams/<teamId>）+ 身份/名册/主判定（task 查询全部跳过；空名册 = 空列表）
    const teamWorkDir = await this.resolveAgentWorkDir(
      request.taskContext?.taskId ?? '',
      teamId,
    );
    const agentRow = await this.prisma.agent.findUnique({
      where: { id: target.agentId },
      select: {
        id: true,
        name: true,
        prompt: true,
        persona: true,
        agentKey: true,
      },
    });
    const agentIdentity: AgentIdentityInfo = {
      id: target.agentId,
      name: agentRow?.name ?? null,
      // 标签 key-derived（todo 10）：agentKey 命中内置名空间 → key；自定义/缺席 → ''。
      // 字段保留供装配两处消费（身份行 + 名册行），删除/重命名归 todo 8。
      role: roleLabelOfAgentKey(agentRow?.agentKey ?? null),
      prompt: agentRow?.prompt ?? null,
      persona: agentRow?.persona ?? null,
      agentKey: agentRow?.agentKey ?? null,
    };
    let teamMemberRows: any[] = [];
    try {
      teamMemberRows =
        (await (this.prisma as any).teamMember.findMany({
          where: { teamId },
          include: {
            agent: { select: { id: true, name: true, agentKey: true } },
            // 角色绑定来源（todo 5）：TeamMember.roleId → AgentRole.rolePrompt。
            // 注意 roleId 在 TeamMember 上，不在 agent 行；名册行的标签 key 由
            // agent.agentKey 派生（todo 10，不再读已删除的 agent.role 列）。
            // 2026-09-21 role-owned capability model：同一行还带出 key/capabilities，
            // 作为目标成员的工具屏蔽输入——一次查询两用。
            role: {
              select: {
                id: true,
                key: true,
                capabilities: true,
                rolePrompt: true,
              },
            },
          },
        })) ?? [];
    } catch (lookupErr: unknown) {
      this.logger.warn(
        `团队 ${teamId} 成员查询失败，按空名册继续: ${this.describeError(lookupErr)}`,
      );
      teamMemberRows = [];
    }
    const team: TeamMemberInfo[] = teamMemberRows.map((tm: any) => ({
      id: tm.agent.id,
      name: tm.agent.name,
      role: roleLabelOfAgentKey(tm.agent.agentKey ?? null),
      instanceId: tm.id,
      alias: tm.alias,
      seq: tm.seq,
    }));
    const teamLookup = await (this.prisma as any).team.findUnique({
      where: { id: teamId },
      select: { mainAgentMemberId: true },
    });
    const mainAgentMemberId: string | null =
      teamLookup?.mainAgentMemberId ?? null;
    // 主门与 task_create 团队维度门一致：session 团队成员 == team.mainAgentMemberId
    const isMainAgent =
      mainAgentMemberId !== null && teamMemberId === mainAgentMemberId;
    const selfAlias =
      team.find((m) => m.instanceId === teamMemberId)?.alias ?? null;
    // 目标成员的岗位权威（与上方名册同一行，一次查找三用）：岗位职责段（rolePrompt）+
    // 能力矩阵（capabilities，驱动工具屏蔽）+ 常量回退键（key）。成员行缺失/未绑角色
    // → null ⇒ 回退 `agentKey` 常量派生，绝不阻断分派。
    const selfRoleRow: {
      id?: string | null;
      key?: string | null;
      capabilities?: Record<string, boolean> | null;
      rolePrompt?: string | null;
    } | null =
      teamMemberRows.find((m: any) => m.id === teamMemberId)?.role ?? null;
    const selfRoleAuthority: MemberRoleAuthority | null = selfRoleRow
      ? {
          id: selfRoleRow.id ?? null,
          key: selfRoleRow.key ?? null,
          capabilities: selfRoleRow.capabilities ?? null,
        }
      : null;
    this.registerExecution(workerId, scope, teamMemberId);
    const cleanupChannel = await this.resolveTeamChannel(teamId, teamMemberId);
    if (cleanupChannel) {
      await this.prisma.message.updateMany({
        where: {
          channelId: cleanupChannel.id,
          senderType: SENDER_TYPE.agent,
          senderId: target.agentId,
          status: MESSAGE_STATUS.processing,
        },
        data: { status: MESSAGE_STATUS.failed },
      });
    }
    const imageAttach = await this.resolveImageAttachments(request.messageId);
    const finalPrompt = imageAttach
      ? `${prompt}\n\n${imageAttach.pointer}`
      : prompt;
    const memoryIndex = taskIdForPrompt
      ? await this.buildTeamMemoryIndex(teamId)
      : null;
    // 策略解析一次、两用（agent-role-decommission todo 2；2026-09-21 role-owned）：岗位
    // 绑定策略 → correction 边界段；tools → 记忆/产出物段屏蔽（`resolvedTools`）。两条
    // 推导共享同一次解析，不重复查；未绑岗位/解析失败 → 常量回退，不阻断分派。
    const { correction, tools: resolvedTools } =
      await this.resolveBoundaryAndTools(agentIdentity, selfRoleAuthority);
    const systemOpts: BuildSystemInstructionsOptions = {
      isMainAgent,
      mainAgentMemberId,
      team,
      selfInstanceId: teamMemberId,
      selfAlias,
      persistentWorkDir: teamWorkDir,
      // P0：企微系统段默认不注入，仅触发正文含 [WeCom:] 标记时注入。
      isWecomChannel: request.text.includes('[WeCom:'),
      // P1：issue 完整版仅 product/tester/developer 注入，其余角色只收 GLOBAL 一句版。
      // todo 10：判据改由 agentKey 提供（模板行 agentKey === role ⇒ 结果不变；
      // 自定义 agentKey 为小写 ASCII，永不命中中文子串检查 ⇒ 仍 false，与旧 null 一致）。
      issueDetail: roleNeedsIssueDetail(agentIdentity.agentKey),
      // 记忆/产出物段屏蔽：由已解析策略 tools 驱动（与上方 correction 同一次解析）。
      resolvedTools,
      // 岗位职责段来源（todo 5）：TeamMember.roleId → AgentRole.rolePrompt（selfRoleRow
      // 与岗位策略解析同一次查询）。行缺失/未绑角色/rolePrompt 空 → null（不注入
      // 【岗位职责】，不抛错）。agent.role 是标签 key，不是此段来源。
      rolePrompt: selfRoleRow?.rolePrompt ?? null,
    };
    if (taskIdForPrompt) {
      if (memoryIndex) {
        systemOpts.memoryIndex = memoryIndex;
      }
    } else {
      systemOpts.teamMode = true;
      systemOpts.taskId = '';
    }
    // opencode 原生 agent：成员显式选择时才传（null → 不带 agent 字段，保持原行为）
    const opencodeAgentName = teamMemberId
      ? await this.resolveMemberOpencodeAgentName(teamMemberId)
      : null;
    // 执行 agent 优先级：成员显式绑定的外部 agent（opencodeAgentName，含岗位外部槽位
    // 预填）是用户的选择，无条件胜出；无外部绑定时才用内部策略候选——目标 Agent 行经
    // resolvePolicyAgentCandidate 映射出 `vteam-<agentKey>`（todo 10 起只认 agentKey，
    // 非法/缺席 → 无候选），且仍受 worker 能力位 `enabled && names.includes(候选)` 门控
    // （能力位只门控内部候选，不门控外部绑定）；两者皆无 → 省略 agent 键，由引擎默认
    // （与引入前逐字节一致）。
    // 是否"计划模式"是所绑定 agent 自身的属性：用户要用计划 agent 就直接绑定计划 agent，
    // 平台不代选、也不注入计划指令。
    const policyCandidateAgent: string | null =
      resolvePolicyAgentCandidate(agentIdentity);
    const resolvedAgentName: string | null =
      opencodeAgentName ??
      (policyCandidateAgent &&
      workerSupportsAgentPolicies(worker, policyCandidateAgent)
        ? policyCandidateAgent
        : null);
    // Todo 11（2026-09-21 起岗位权威）：目标成员的职责边界段由**岗位**绑定策略的 correction
    // 提供（不再按 agent 名白名单读取常量，也不再读执行 Agent 的策略）——内置岗位走绑定
    // 策略（出厂 correction == 常量，输出逐字节一致），自定义岗位的自定义 correction 同样注入。
    // 岗位缺席（存量）/解析失败/无服务/无 correction → 回退 `vteam-<role.key ?? agentKey>`
    // 常量派生，保证基线行为与引入前逐字节一致。
    const boundarySection = renderBoundarySection(correction);
    if (boundarySection) {
      systemOpts.boundarySection = boundarySection;
    }
    await this.workerClient.execute(worker, {
      prompt: [{ type: 'text', text: finalPrompt }],
      model,
      directory: teamWorkDir,
      taskId: request.taskContext?.taskId ?? '',
      agentId: target.agentId,
      channelId: request.channelId,
      sessionId: opencodeSessionId,
      ...(resolvedAgentName ? { agent: resolvedAgentName } : {}),
      ...(imageAttach ? { attachments: imageAttach.attachments } : {}),
      system: buildSystemInstructions(agentIdentity, systemOpts),
    });
    // is_7：execute 202 受理后暂存原始分派快照（恢复重放用；wake 重放文本不覆盖）。
    this.saveDispatchSnapshot({
      text: request.text,
      messageId: request.messageId,
      channelId: request.channelId,
      taskId: request.taskContext?.taskId ?? '',
      teamId,
      teamMemberId,
      agentId: target.agentId,
      createdAt: Date.now(),
    });
    this.snapshotSessionIndex.set(
      sessionId,
      dispatchSnapshotKey(teamId, teamMemberId),
    );

    this.completedSessions.delete(sessionId);
    this.failedSessions.delete(sessionId);

    // 7. loading(operating) + 回流超时 watchdog（team: 作用域 key）
    await this.realtime.broadcast(
      EVENT_TYPES.AGENT_LOADING,
      {
        taskId: scope,
        agentId: target.agentId,
        instanceId: teamMemberId,
        sessionId,
        phase: 'operating',
      },
      { type: 'team', id: teamId } as any,
    );
    this.emitLoading({
      taskId: scope,
      agentId: target.agentId,
      instanceId: teamMemberId,
      sessionId,
      phase: 'operating',
    });
    this.startPendingWatchdog(
      scope,
      target.agentId,
      sessionId,
      workerId,
      teamMemberId,
    );
  }

  // ------------------------------------------------------------------
  // 回流处理（D5：落库 + 广播 + emitFinal 归本类，防双写）
  // ------------------------------------------------------------------

  /**
   * task.completed 回流唯一入口（Todo 7 team-only）：归属门 + 幂等门（F2 C1 双通道
   * 防重）→ 团队唯一实现（handleTeamTaskCompleted 落库 + 广播 + emitFinal）→ 产出物
   * 归档 + wecom 桥接。任务只作归因数据（message.taskId 照写；归档/桥接触发键），
   * 不参与会话/频道定位；回流 scope 统一 team（emitFinal taskId 承载 scope 串兼容前端）。
   */
  async handleTaskCompleted(payload: TaskCompletedPayload): Promise<void> {
    const { taskId, sessionId } = payload;
    // 无归属（无 session/taskId/agentId）→ 不碰 DB 直接跳过
    if (!taskId && !sessionId && !payload.agentId) {
      this.logger.error(
        `task.completed 缺少归属，无法处理：${JSON.stringify(payload)}`,
      );
      return;
    }
    // F2 C1（CRITICAL）：双通道幂等——自持轮询与 ingress task.completed 可能同时到达，
    // 同 sessionId 已落库则跳过；failedSessions 命中（watchdog/轮询已超时）→ 迟到回流
    // 跳过落库仅记日志（防用户同时见错误+消息，MINOR）。
    if (sessionId) {
      if (this.completedSessions.has(sessionId)) {
        this.logger.debug(`session ${sessionId} 已落库，跳过重复回流`);
        return;
      }
      if (this.failedSessions.has(sessionId)) {
        this.logger.warn(`session ${sessionId} 已超时失败，迟到回流跳过落库`);
        return;
      }
      // 本轮完成：唤醒重试计数复零（下一轮 dispatch 重新开始计算）。
      this.silentWakeAttempts.delete(sessionId);
    }
    // 团队唯一路径：落库 + 广播 + emitFinal（无 task/team 双实现）
    const settled = await this.handleTeamTaskCompleted(payload);
    if (sessionId) {
      this.clearDispatchSnapshotBySession(sessionId);
    }
    const agentId = settled.agentId;
    const text = settled.text;
    const displayText = settled.displayText;
    const finalParts = settled.finalParts;
    // wecom 镜像归属实例（团队成员；回退 agent）
    const executionRef: string | undefined =
      settled.teamMemberId ?? settled.agentId ?? undefined;

    // （落库 + 广播 + emitFinal 已由上游 handleTeamTaskCompleted 完成；以下仅产出物归档 + wecom 桥接）

    try {
      if (payload.taskId) {
        let derivedText = (payload.text ?? displayText ?? '').trim();
        if (
          !derivedText &&
          Array.isArray(payload.parts) &&
          payload.parts.length > 0
        ) {
          const partsArr = payload.parts as Array<Record<string, unknown>>;
          const textParts = partsArr
            .filter((p) => p.type === 'text' && typeof p.text === 'string')
            .map((p) => String(p.text));
          if (textParts.length > 0) {
            derivedText = textParts.join('\n').trim();
          } else {
            const anyText = partsArr
              .map((p) => {
                if (typeof p.text === 'string') return p.text as string;
                if (typeof p.content === 'string') return p.content as string;
                return '';
              })
              .filter(Boolean)
              .join('\n')
              .trim();
            if (anyText) derivedText = anyText;
          }
          if (derivedText) {
            this.logger.log(
              `wecom bridge: text derived from parts len=${derivedText.length} taskId=${payload.taskId}`,
            );
          }
        }
        const textToSend = derivedText;
        if (!textToSend) {
          this.logger.warn(
            `wecom bridge: skip taskId=${payload.taskId} text empty (payload.text len=${(payload.text ?? '').length} displayText len=${(displayText ?? '').length} parts=${Array.isArray(payload.parts) ? (payload.parts as unknown[]).length : 0})`,
          );
        } else {
          const prismaAny = this.prisma as unknown as Record<string, unknown>;
          if (
            !prismaAny.taskMessageChannel ||
            typeof (prismaAny.taskMessageChannel as { findMany?: unknown })
              .findMany !== 'function'
          ) {
            this.logger.warn(
              `wecom bridge: skip taskId=${payload.taskId} no taskMessageChannel model (test mock)`,
            );
          } else {
            const bindings = await (
              prismaAny.taskMessageChannel as {
                findMany: (
                  q: unknown,
                ) => Promise<Array<{ messageChannelId: string }>>;
              }
            ).findMany({
              where: { taskId: payload.taskId },
              select: { messageChannelId: true },
            });
            let wecomChannelsCount = 0;
            const wecomChannelIds: string[] = [];
            for (const b of bindings) {
              try {
                const c = await (
                  this.prisma as unknown as {
                    messageChannel: {
                      findUnique: (
                        q: unknown,
                      ) => Promise<{ id: string; type: string } | null>;
                    };
                  }
                ).messageChannel.findUnique({
                  where: { id: b.messageChannelId },
                  select: { id: true, type: true },
                });
                if (c && c.type === 'wecom_aibot') {
                  wecomChannelsCount++;
                  wecomChannelIds.push(c.id);
                }
              } catch (e) {
                // Fail closed: an unresolved binding may still be a wecom
                // channel — count it so the summary below does not misreport
                // "no wecom channels", and let the per-binding path below
                // re-resolve it instead of skipping it as absent-and-fine.
                wecomChannelsCount++;
                wecomChannelIds.push(b.messageChannelId);
                this.logger.warn(
                  `wecom bridge: channel lookup failed bindingsId=${b.messageChannelId} taskId=${payload.taskId}: ${this.describeError(e)}`,
                );
              }
            }
            this.logger.log(
              `wecom bridge: taskId=${payload.taskId}, bindings=${bindings.length}, found wecom channels=${wecomChannelsCount}`,
            );
            if (bindings.length === 0) {
              this.logger.warn(
                `wecom bridge: no bindings for taskId=${payload.taskId}`,
              );
            } else if (wecomChannelsCount === 0) {
              this.logger.warn(
                `wecom bridge: no wecom channels among bindings taskId=${payload.taskId} bindings=${JSON.stringify(bindings.map((b) => b.messageChannelId))}`,
              );
            }
            const wecomMirroredIds = new Set<string>();
            for (const b of bindings) {
              try {
                const ch = await (
                  this.prisma as unknown as {
                    messageChannel: {
                      findUnique: (q: unknown) => Promise<{
                        id: string;
                        type: string;
                        config?: unknown;
                      } | null>;
                    };
                  }
                ).messageChannel.findUnique({
                  where: { id: b.messageChannelId },
                });
                if (!ch) {
                  this.logger.warn(
                    `wecom bridge: channel not found bindingsId=${b.messageChannelId} taskId=${payload.taskId}`,
                  );
                  continue;
                }
                if (ch.type !== 'wecom_aibot') {
                  this.logger.log(
                    `wecom bridge: skip non-wecom channel ${ch.id} type=${ch.type}`,
                  );
                  continue;
                }
                const task = await this.prisma.task.findUnique({
                  where: { id: payload.taskId },
                  select: { teamId: true },
                });
                const groupChatChannel = task?.teamId
                  ? await this.prisma.chatChannel.findFirst({
                      where: {
                        teamId: task.teamId,
                        type: CHANNEL_TYPE.team_group,
                        deletedAt: null,
                      },
                      select: { id: true },
                    })
                  : null;
                if (!groupChatChannel) {
                  this.logger.warn(
                    `wecom bridge: no groupChannel for taskId=${payload.taskId}`,
                  );
                  continue;
                }
                const externalMsg = await (
                  this.prisma as unknown as {
                    message: {
                      findFirst: (
                        q: unknown,
                      ) => Promise<{ id: string; content?: unknown } | null>;
                    };
                  }
                ).message.findFirst({
                  where: {
                    channelId: groupChatChannel.id,
                    senderType: SENDER_TYPE.external,
                  },
                  orderBy: { createdAt: 'desc' },
                });
                const extContent = (
                  externalMsg as unknown as { content?: { text?: string } }
                )?.content;
                const extTextLen =
                  typeof extContent?.text === 'string'
                    ? extContent.text.length
                    : ((extContent as unknown as string | undefined)?.length ??
                      0);
                this.logger.log(
                  `wecom bridge: externalMsg id=${(externalMsg as unknown as { id?: string })?.id ?? 'null'} textLen=${extTextLen} groupChannelId=${groupChatChannel.id}`,
                );
                if (!externalMsg) {
                  this.logger.warn(
                    `wecom bridge: externalMsg not found groupChannelId=${groupChatChannel.id} taskId=${payload.taskId}`,
                  );
                  continue;
                }
                let ok = false;
                let adapter:
                  | {
                      finishStream?: (a: string, b: string) => Promise<boolean>;
                      sendFallbackMessage?: (
                        a: string,
                        b: string,
                      ) => Promise<boolean>;
                      getStream?: (a: string) =>
                        | {
                            fromUserId?: string;
                            fromUserName?: string;
                            chattype?: string;
                          }
                        | undefined;
                      getPendingUser?: (a: string) =>
                        | {
                            fromUserId?: string;
                            fromUserName?: string;
                            chattype?: string;
                          }
                        | undefined;
                      type?: string;
                    }
                  | undefined;
                try {
                  adapter = this.moduleRef?.get(WecomAibotAdapter, {
                    strict: false,
                  }) as unknown as typeof adapter;
                } catch (e) {
                  this.logger.debug(
                    `wecom bridge: ModuleRef adapter lookup miss taskId=${payload.taskId}: ${formatErrorMessage(e)}`,
                  );
                }
                if (!adapter) {
                  try {
                    const g = globalThis as unknown as Record<string, unknown>;
                    adapter =
                      (g['__wecomAdapter'] as typeof adapter) ?? undefined;
                  } catch (e) {
                    this.logger.debug(
                      `wecom bridge: global adapter lookup miss taskId=${payload.taskId}: ${formatErrorMessage(e)}`,
                    );
                  }
                }
                if (!adapter) {
                  this.logger.warn(
                    `wecom bridge: no wecom adapter taskId=${payload.taskId} (lazy ModuleRef miss, will skip finishStream)`,
                  );
                } else if (typeof adapter.finishStream !== 'function') {
                  this.logger.warn(
                    `wecom bridge: adapter missing finishStream taskId=${payload.taskId} adapterType=${(adapter as unknown as { type?: string }).type}`,
                  );
                }
                let directedWecomText = textToSend;
                let mirrorText = textToSend;
                let pendingInfo:
                  | {
                      fromUserId?: string;
                      fromUserName?: string;
                      chattype?: string;
                    }
                  | undefined;
                let pendingFromCard = false;
                if (adapter) {
                  // PRIORITY: card operator check first — post-card must NOT fall through to finishStream
                  // even if streams map still contains the placeholder (which it always does before discard)
                  try {
                    const cardOp = (adapter as any).getPendingOperatorForTask?.(
                      payload.taskId,
                    );
                    if (cardOp) {
                      pendingInfo = cardOp;
                      pendingFromCard = true;
                      this.logger.log(
                        `wecom bridge: using card pending operator taskId=${payload.taskId} fromUserId=${(cardOp as any).fromUserId} fromUserName=${(cardOp as any).fromUserName} chattype=${(cardOp as any).chattype ?? ''}`,
                      );
                    }
                  } catch (e) {
                    this.logger.warn(
                      `wecom bridge: getPendingOperatorForTask failed taskId=${payload.taskId}, fall to stream path: ${formatErrorMessage(e)}`,
                    );
                  }
                  if (!pendingFromCard) {
                    try {
                      pendingInfo =
                        (adapter as any).getStream?.(externalMsg.id) ??
                        (adapter as any).getPendingUser?.(externalMsg.id);
                      if (
                        !pendingInfo &&
                        typeof (adapter as any).getPendingUser === 'function'
                      ) {
                        pendingInfo = (adapter as any).getPendingUser(
                          externalMsg.id,
                        );
                      }
                    } catch (e) {
                      this.logger.warn(
                        `wecom bridge: stream/pending-user lookup failed taskId=${payload.taskId} internalMessageId=${externalMsg.id}, fromName degrades to '': ${formatErrorMessage(e)}`,
                      );
                    }
                  }
                  const fromName =
                    pendingInfo?.fromUserName || pendingInfo?.fromUserId || '';
                  const chattype = pendingInfo?.chattype ?? null;
                  if (fromName) {
                    if (chattype === 'group') {
                      directedWecomText = `@${fromName} ${textToSend}`;
                    }
                    mirrorText = `@${fromName} ${textToSend}`;
                  }
                  if (pendingInfo) {
                    this.logger.log(
                      `wecom bridge: pending chattype=${chattype} fromName=${fromName} directedWecomLen=${directedWecomText.length} fromCard=${pendingFromCard}`,
                    );
                  }
                  if (pendingFromCard) {
                    try {
                      (adapter as any).consumePendingOperatorForTask?.(
                        payload.taskId,
                      );
                      this.logger.log(
                        `wecom bridge: consumed pending operator for taskId=${payload.taskId}`,
                      );
                    } catch (e) {
                      // Fail closed: the pending operator may still be present when
                      // consume fails. Do not send it now; a later dispatch can retry
                      // the consume and send it at most once.
                      this.logger.warn(
                        `wecom bridge: consume pending operator failed taskId=${payload.taskId}: ${this.describeError(e)}`,
                      );
                      throw e;
                    }
                  }
                }
                if (pendingFromCard) {
                  this.logger.log(
                    `wecom post-card: discardStream + sendNewMessage taskId=${payload.taskId} internalMessageId=${externalMsg.id}`,
                  );
                  try {
                    if (
                      typeof (adapter as unknown as { discardStream?: unknown })
                        .discardStream === 'function'
                    ) {
                      (
                        adapter as unknown as {
                          discardStream: (a: string) => boolean;
                        }
                      ).discardStream(externalMsg.id);
                      this.logger.log(
                        `wecom bridge: post-card discarded placeholder stream internalMessageId=${externalMsg.id} taskId=${payload.taskId}`,
                      );
                    }
                  } catch (e) {
                    this.logger.warn(
                      `wecom bridge: post-card discardStream failed taskId=${payload.taskId} internalMessageId=${externalMsg.id} (best-effort): ${formatErrorMessage(e)}`,
                    );
                  }
                  try {
                    const pcAdapter: any = adapter;
                    const canNew =
                      pcAdapter &&
                      typeof pcAdapter.sendNewMessage === 'function';
                    const canFallback =
                      pcAdapter &&
                      typeof pcAdapter.sendFallbackMessage === 'function';
                    if (canNew) {
                      this.logger.log(
                        `wecom bridge: post-card sendNewMessage called channelId=${ch.id} textLen=${directedWecomText.length}`,
                      );
                      const sendOk = await pcAdapter.sendNewMessage(
                        ch.id,
                        directedWecomText,
                      );
                      this.logger.log(
                        `wecom bridge: post-card sendNewMessage result=${sendOk} channelId=${ch.id}`,
                      );
                      ok = !!sendOk;
                      if (!ok)
                        this.logger.warn(
                          `wecom post-card sendNewMessage failed channel ${ch.id}`,
                        );
                    } else if (canFallback) {
                      this.logger.log(
                        `wecom bridge: post-card fallback sendMessage called channelId=${ch.id} textLen=${directedWecomText.length}`,
                      );
                      const fbOk = await pcAdapter.sendFallbackMessage(
                        ch.id,
                        directedWecomText,
                      );
                      this.logger.log(
                        `wecom bridge: post-card fallback result=${fbOk} channelId=${ch.id}`,
                      );
                      ok = !!fbOk;
                    } else {
                      this.logger.warn(
                        `wecom bridge: post-card no send method for ${externalMsg.id}`,
                      );
                    }
                  } catch (e) {
                    this.logger.warn(
                      `wecom post-card send failed for ${externalMsg.id}: ${(e as Error).message}`,
                    );
                  }
                  if (ok)
                    this.logger.log(
                      `wecom post-card new message ok internalMessageId=${externalMsg.id} taskId=${payload.taskId}`,
                    );
                } else {
                  this.logger.log(
                    `wecom simple: finishStream taskId=${payload.taskId} internalMessageId=${externalMsg.id}`,
                  );
                  if (adapter && typeof adapter.finishStream === 'function') {
                    try {
                      this.logger.log(
                        `wecom bridge: finishStream called with internalMessageId=${externalMsg.id} textLen=${directedWecomText.length} channelId=${ch.id}`,
                      );
                      ok = await adapter.finishStream(
                        externalMsg.id,
                        directedWecomText,
                      );
                      this.logger.log(
                        `wecom bridge: finishStream called with internalMessageId=${externalMsg.id} result=${ok}`,
                      );
                    } catch (e) {
                      this.logger.warn(
                        `wecom finishStream error for ${externalMsg.id}: ${(e as Error).message}`,
                      );
                    }
                  }
                  if (ok) {
                    this.logger.log(
                      `wecom finishStream ok internalMessageId=${externalMsg.id} taskId=${payload.taskId}`,
                    );
                  } else {
                    this.logger.warn(
                      `wecom finishStream miss for ${externalMsg.id}, try fallback sendMessage channelId=${ch.id} textLen=${directedWecomText.length}`,
                    );
                    try {
                      const fallbackAdapter = adapter;
                      if (
                        fallbackAdapter &&
                        typeof (
                          fallbackAdapter as unknown as {
                            sendFallbackMessage?: unknown;
                          }
                        ).sendFallbackMessage === 'function'
                      ) {
                        this.logger.log(
                          `wecom bridge: fallback sendMessage called channelId=${ch.id} textLen=${directedWecomText.length}`,
                        );
                        const fbOk = await (
                          fallbackAdapter as unknown as {
                            sendFallbackMessage: (
                              a: string,
                              b: string,
                            ) => Promise<boolean>;
                          }
                        ).sendFallbackMessage(ch.id, directedWecomText);
                        this.logger.log(
                          `wecom bridge: fallback sendMessage result=${fbOk} channelId=${ch.id}`,
                        );
                        if (!fbOk) {
                          this.logger.warn(
                            `wecom fallback sendMessage also failed for channel ${ch.id}`,
                          );
                        } else {
                          ok = true;
                        }
                      } else if (fallbackAdapter) {
                        this.logger.warn(
                          `wecom finishStream miss for ${externalMsg.id}, fallback not implemented`,
                        );
                      } else {
                        this.logger.warn(
                          `wecom bridge: fallback skipped no adapter for channel ${ch.id}`,
                        );
                      }
                    } catch (fbErr) {
                      this.logger.warn(
                        `wecom fallback failed: ${(fbErr as Error).message}`,
                      );
                    }
                  }
                }
                try {
                  const mirrorKey = `${payload.taskId}:${externalMsg.id}`;
                  if (!wecomMirroredIds.has(mirrorKey)) {
                    wecomMirroredIds.add(mirrorKey);

                    let skipMirror = false;
                    try {
                      const recent = await (
                        this.prisma as unknown as {
                          message: {
                            findFirst: (q: unknown) => Promise<{
                              id: string;
                              content?: unknown;
                              createdAt: Date;
                            } | null>;
                          };
                        }
                      ).message.findFirst({
                        where: {
                          channelId: groupChatChannel.id,
                          senderType: SENDER_TYPE.agent,
                        },
                        orderBy: { createdAt: 'desc' },
                      });
                      if (recent) {
                        const recentText =
                          (recent.content as unknown as { text?: string })
                            ?.text ?? '';
                        const normMirror = mirrorText.trim();
                        const normRecent = String(recentText).trim();
                        const ageMs =
                          Date.now() - new Date(recent.createdAt).getTime();
                        // Hard dedup: any agent mirror within 120s suppresses second mirror (wecom_reply already updated placeholder)
                        if (ageMs < 120_000) {
                          // Strong match first (logs reason), else unconditional suppress for wecom tasks
                          if (
                            normRecent === normMirror ||
                            normMirror.includes(normRecent) ||
                            normRecent.includes(textToSend.trim().slice(0, 80))
                          ) {
                            skipMirror = true;
                            this.logger.log(
                              `wecom bridge: dedup skip mirror taskId=${payload.taskId} recentId=${recent.id} ageMs=${ageMs} reason=textMatch`,
                            );
                          } else if (normRecent.length > 0) {
                            skipMirror = true;
                            this.logger.log(
                              `wecom bridge: dedup skip mirror taskId=${payload.taskId} recentId=${recent.id} ageMs=${ageMs} reason=cooldown120s`,
                            );
                          } else {
                            skipMirror = true;
                            this.logger.log(
                              `wecom bridge: dedup skip mirror taskId=${payload.taskId} recentId=${recent.id} ageMs=${ageMs} reason=anyRecent120s`,
                            );
                          }
                        }
                        if (
                          !skipMirror &&
                          textToSend.trim() &&
                          normMirror.includes(textToSend.trim().slice(0, 80))
                        ) {
                          if (ageMs < 120_000 && normRecent.length > 0) {
                            skipMirror = true;
                            this.logger.log(
                              `wecom bridge: dedup skip mirror by final text equality taskId=${payload.taskId}`,
                            );
                          }
                        }
                      }
                    } catch (e) {
                      // Fail closed: without a successful dedup read, the 120s
                      // cooldown cannot be proven; suppress this mirror and let a
                      // later dispatch retry the read.
                      this.logger.warn(
                        `wecom bridge: mirror dedup read failed taskId=${payload.taskId}: ${this.describeError(e)}`,
                      );
                      throw e;
                    }
                    if (skipMirror) {
                    } else {
                      const prismaAny2 = this.prisma as unknown as {
                        message: {
                          create: (q: unknown) => Promise<{ id: string }>;
                        };
                      };
                      const mirrorId =
                        await this.idGen.nextId(MESSAGE_ID_PREFIX);
                      const mirrorMsg = await prismaAny2.message.create({
                        data: {
                          id: mirrorId,
                          channelId: groupChatChannel.id,
                          taskId,
                          senderType: SENDER_TYPE.agent,
                          senderId: agentId,
                          senderInstanceId: executionRef ?? null,
                          content: {
                            text: mirrorText,
                            parts: finalParts,
                          } as unknown as Prisma.InputJsonValue,
                          mentions: null,
                          status: MESSAGE_STATUS.sent,
                        } as any,
                      });
                      await this.realtime.broadcast(
                        EVENT_TYPES.CHAT_MESSAGE_NEW,
                        {
                          message: this.toMessageDto(
                            mirrorMsg as unknown as MessageRow,
                          ),
                        },
                        { type: 'channel', id: groupChatChannel.id },
                      );
                      this.logger.log(
                        `wecom bridge: mirrored to team_group channel=${groupChatChannel.id} mirrorId=${mirrorId} textLen=${mirrorText.length}`,
                      );
                    }
                  }
                } catch (mirrorErr) {
                  this.logger.warn(
                    `wecom bridge: mirror to team_group failed: ${(mirrorErr as Error).message}`,
                  );
                }
              } catch (innerErr) {
                this.logger.warn(
                  `wecom per-channel handling failed: ${(innerErr as Error).message}`,
                );
              }
            }
          }
        }
      } else {
        this.logger.warn(
          `wecom bridge: skip no taskId payload=${JSON.stringify(payload)}`,
        );
      }
    } catch (e) {
      this.logger.warn(`wecom bridge failed: ${(e as Error).message}`);
    }

    // 5. 产出物归档（声明非法时 onArtifactSubmitted 返回 invalid 不抛错，12 篇 §3.1）
    // P3：合并 worker 显式上送（payload.artifacts）与 server 从回复文本提取
    // （extractArtifacts）的声明——方案 A 下 worker 完成事件不带 artifacts 字段，
    // 归档依赖 text 提取（F3 MAJOR-2 poll 路径逻辑，切方案 A 后曾丢失）。
    const mergedArtifacts = this.mergeArtifactDeclarations([
      ...(Array.isArray(payload.artifacts) ? payload.artifacts : []),
      ...extractArtifacts(text),
    ]);
    // 归档收集 fileRef → 落盘 URL 映射（群聊转发附件用）：worker fileRef（容器路径）
    // 与 group_post.fileRef 一致时，群聊消息可挂该文件的下载附件
    const archivedFileUrls = new Map<string, { url: string; name: string }>();
    for (const raw of mergedArtifacts) {
      const art = (raw ?? {}) as Record<string, unknown>;
      try {
        const result = await this.artifactsService.onArtifactSubmitted({
          taskId,
          type: String(art.type ?? ''),
          title: String(art.title ?? ''),
          content: String(art.content ?? ''),
          ...(art.fileRef !== undefined
            ? { fileRef: String(art.fileRef) }
            : {}),
        });
        if (result.status === 'invalid') {
          this.logger.warn(
            `agent ${agentId} 产出物声明非法（${result.reason}）：${JSON.stringify(art)}`,
          );
        } else {
          // 归档成功（archived/duplicate 均带 artifact）→ 广播 artifact.submitted
          // （scope=task，前端任务页产出物列表实时刷新，不再依赖手动刷新页面）
          if (result.artifact && typeof result.artifact === 'object') {
            const archived = result.artifact as Record<string, unknown>;
            await this.realtime.broadcast(
              EVENT_TYPES.ARTIFACT_SUBMITTED,
              {
                taskId,
                artifactId: String(archived.id ?? ''),
                version: archived.currentVersion ?? null,
                type: String(art.type ?? ''),
                title: String(art.title ?? ''),
                agentId,
              },
              { type: 'task', id: taskId },
            );
          }
          if (
            result.artifact &&
            typeof result.artifact === 'object' &&
            typeof art.fileRef === 'string' &&
            art.fileRef &&
            (result.artifact as Record<string, unknown>).fileUrl
          ) {
            const fileUrl = String(
              (result.artifact as Record<string, unknown>).fileUrl,
            );
            archivedFileUrls.set(art.fileRef, {
              url: fileUrl,
              name:
                fileUrl.split(/[\\/]/).pop() ??
                String(
                  (result.artifact as Record<string, unknown>).title ?? '附件',
                ),
            });
          }
        }
      } catch (err) {
        this.logger.error(
          `agent ${agentId} 产出物归档失败: ${this.describeError(err)}`,
          (err as Error).stack,
        );
      }
    }
    // 群聊回复只经 MCP group_post 工具直发（工具 handler 已落库群聊并广播）——
    // 不再做任何兜底转发（文本声明/群聊触发兜底转发完整回复均移除）：私聊正文
    // 独白留在 private 会话频道，群聊不展示私聊内容（曾致群聊每人 3 条）。
  }

  /**
   * task.completed 回流团队唯一实现（Todo 7）：团队归属解析 → 频道定位 →
   * 落库（senderType=agent）→ 广播 chat.message.new + emitFinal。
   * - 归属解析 team-only：sessionId → 团队会话直查 (teamId, teamMemberId)；
   *   无 session 时经任务归属反查团队 + agent 反查成员（兜底不断流）；
   *   任务只作归因数据（message.taskId 照写），不参与会话/频道定位。
   * - 执行注销/watchdog/事件键走 `team:<teamId>` 作用域；emitFinal taskId 承载
   *   scope 串兼容前端。产出物归档由调用方按归因 taskId 执行（Artifact 需 taskId）。
   */
  private async handleTeamTaskCompleted(
    payload: TaskCompletedPayload,
  ): Promise<{
    agentId: string | null;
    teamMemberId: string | null;
    text: string;
    displayText: string;
    finalParts: Array<Record<string, unknown>>;
  }> {
    const { taskId, sessionId } = payload;
    let teamId: string | null = null;
    let teamMemberId: string | null = null;
    let agentId: string | null = payload.agentId ?? null;
    if (sessionId) {
      const session = await (this.prisma as any).session.findUnique({
        where: { id: sessionId },
        select: { agentId: true, teamId: true, teamMemberId: true },
      });
      agentId = agentId ?? session?.agentId ?? null;
      teamId = session?.teamId ?? null;
      teamMemberId = session?.teamMemberId ?? null;
    } else if (taskId && agentId) {
      const task = await (this.prisma as any).task.findUnique({
        where: { id: taskId },
        select: { teamId: true },
      });
      teamId = task?.teamId ?? null;
      if (teamId) {
        const member = await (this.prisma as any).teamMember?.findFirst?.({
          where: { teamId, agentId },
          select: { id: true },
        });
        teamMemberId = member?.id ?? null;
      }
    }
    const text = payload.text ?? '';
    const unsettled = {
      agentId,
      teamMemberId,
      text,
      displayText: text,
      finalParts: [] as Array<Record<string, unknown>>,
    };
    if (!teamId || !teamMemberId || !agentId) {
      this.logger.error(
        `team task.completed 无法定位团队会话（session=${sessionId ?? '-'}），跳过回复落库`,
      );
      this.emitError({
        taskId: taskId ?? 'unknown',
        agentId: agentId ?? 'unknown',
        error: '回复回流失败：无法定位目标频道',
      });
      return unsettled;
    }
    const scope = toExecutionScope(null, teamId);
    if (typeof payload.workerId === 'string' && payload.workerId) {
      this.unregisterExecution(payload.workerId, scope, teamMemberId);
    }
    this.clearPendingWatchdog(scope, agentId);
    const channel = await this.resolveTeamChannel(teamId, teamMemberId);
    if (!channel) {
      this.logger.error(
        `team task.completed 无法定位频道（team=${teamId} member=${teamMemberId}），跳过回复落库`,
      );
      this.emitError({
        taskId: scope,
        agentId,
        error: '回复回流失败：无法定位目标频道',
      });
      return unsettled;
    }
    // 群聊回退（team_group）时正文独白不落群聊（结论经 group_post 工具直发），
    // 仅幂等标记 + emitFinal 收尾
    if (channel.type === CHANNEL_TYPE.team_group) {
      if (sessionId) {
        this.completedSessions.add(sessionId);
      }
      this.emitFinal({ taskId: scope, agentId, messageId: '', text });
      return unsettled;
    }
    // 私聊独白落库：group_post 声明剥离（协议标签不入独白）；parts 全量保留
    // （reasoning/tool 前端折叠展示）；流式 processing 消息终态化为 sent 防双消息
    const rawParts = Array.isArray(payload.parts) ? payload.parts : [];
    const finalParts = normalizeParts(rawParts);
    const groupPost = extractGroupPost(text);
    const displayText =
      groupPost !== null ? stripGroupPostDeclarations(text) : text;
    const finalContent = {
      text: displayText,
      parts: finalParts,
    } as Prisma.InputJsonValue;
    try {
      const processingRow = await this.prisma.message.findFirst({
        where: {
          channelId: channel.id,
          senderType: SENDER_TYPE.agent,
          senderId: agentId,
          status: MESSAGE_STATUS.processing,
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      const message = processingRow
        ? await this.prisma.message.update({
            where: { id: processingRow.id },
            data: {
              content: finalContent,
              status: MESSAGE_STATUS.sent,
              taskId: taskId ?? null,
            } as any,
          })
        : await this.prisma.message.create({
            data: {
              id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
              channelId: channel.id,
              taskId: taskId ?? null,
              senderType: SENDER_TYPE.agent,
              senderId: agentId,
              senderInstanceId: teamMemberId,
              content: finalContent,
              mentions: null,
              status: MESSAGE_STATUS.sent,
            } as any,
          });
      if (processingRow) {
        this.logger.log(
          `agent ${agentId} 流式消息终态化 message=${processingRow.id} → sent`,
        );
      }
      if (sessionId) {
        this.completedSessions.add(sessionId);
      }
      await this.realtime.broadcast(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: this.toMessageDto(message) },
        { type: 'channel', id: channel.id },
      );
      this.emitFinal({
        taskId: scope,
        agentId,
        messageId: message.id,
        text: displayText,
      });
    } catch (err) {
      this.logger.error(
        `agent ${agentId} 回复落库失败: ${this.describeError(err)}`,
        (err as Error).stack,
      );
      this.emitError({
        taskId: scope,
        agentId,
        error: `回复落库失败: ${this.describeError(err)}`,
      });
      return { agentId, teamMemberId, text, displayText, finalParts };
    }
    return { agentId, teamMemberId, text, displayText, finalParts };
  }

  /** P3：合并多来源产出物声明（worker 上送 + 回复文本提取），按声明形状去重防重复归档。 */
  private mergeArtifactDeclarations(
    candidates: unknown[],
  ): Array<Record<string, unknown>> {
    const seen = new Set<string>();
    const out: Array<Record<string, unknown>> = [];
    for (const raw of candidates) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        continue;
      }
      const c = raw as Record<string, unknown>;
      const key = JSON.stringify({
        type: c.type,
        title: c.title,
        fileRef: c.fileRef,
        content: c.content,
      });
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(c);
    }
    return out;
  }

  /**
   * agent.status 回流处理（T9 ingress onAgentStatus 回调触发，Todo10 团队归一）：
   * 仅做 emitLoading/emitError 本地回调通知（对齐 MessageDispatcher 订阅契约，供
   * ChatService onLoading/onError 日志）；SSE 的 agent.loading/agent.error emit 已由
   * T9 ingress 完成（worker-event.ingress.ts handleAgentStatus），此处不重复广播防双写。
   * P4：错误分支额外落库 failed 消息（processing → failed + 错误内容广播）——
   * 修复首字超时/模型错误后消息永久卡 processing、用户无失败反馈的问题。
   * team-only：有 session → 经会话反查 (teamId, teamMemberId)；无 session →
   * 经任务归属 teamId + (teamId, agentId) 成员定位（任务仅归因透传，不参与键）；
   * 维度不全 → 跳过（未知 channel 不抛错）。失败回流唯一走
   * failTeamProcessingMessage → resolveTeamChannel。
   */
  async handleAgentStatus(payload: AgentStatusPayload): Promise<void> {
    const { taskId, agentId, sessionId } = payload;
    let teamId: string | null = null;
    let teamMemberId: string | null = null;
    let resolvedAgentId: string | null = agentId ?? null;
    let emitSessionId: string | null = null;
    if (sessionId) {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { teamId: true, teamMemberId: true, agentId: true },
      });
      teamId = session?.teamId ?? null;
      teamMemberId = session?.teamMemberId ?? null;
      resolvedAgentId = resolvedAgentId ?? session?.agentId ?? null;
      emitSessionId = sessionId;
    } else if (taskId && agentId) {
      const taskRow = await (this.prisma as any).task.findUnique({
        where: { id: taskId },
        select: { teamId: true },
      });
      teamId = (taskRow as any)?.teamId ?? null;
      if (teamId) {
        const member = await (this.prisma as any).teamMember.findFirst({
          where: { teamId, agentId },
          select: { id: true },
        });
        teamMemberId = member?.id ?? null;
      }
    }
    if (!teamId || !teamMemberId || !resolvedAgentId) {
      return;
    }
    const scope = toExecutionScope(null, teamId);
    const isError =
      payload.status === 'error' ||
      (typeof payload.error === 'string' && payload.error.length > 0);
    if (isError) {
      if (emitSessionId) {
        this.failedSessions.add(emitSessionId);
      }
      if (typeof payload.workerId === 'string' && payload.workerId) {
        this.unregisterExecution(payload.workerId, scope, teamMemberId);
      }
      await this.failTeamProcessingMessage(
        teamId,
        teamMemberId,
        resolvedAgentId,
        payload.error?.trim() || 'agent 处理失败',
      );
      this.emitError({
        taskId: scope,
        agentId: resolvedAgentId,
        error: payload.error ?? 'agent 处理失败',
      });
    } else {
      this.emitLoading({
        taskId: scope,
        agentId: resolvedAgentId,
        sessionId: emitSessionId,
        phase: payload.phase === 'thinking' ? 'thinking' : 'operating',
      });
    }
  }

  /** team-mode 失败回流 → 团队频道内该 agent 最新 processing 消息标记 failed（无则新建）。 */
  private async failTeamProcessingMessage(
    teamId: string,
    teamMemberId: string,
    agentId: string,
    errorText: string,
  ): Promise<void> {
    try {
      const channel = await this.resolveTeamChannel(teamId, teamMemberId);
      if (!channel) {
        return;
      }
      const processingRow = await this.prisma.message.findFirst({
        where: {
          channelId: channel.id,
          senderType: SENDER_TYPE.agent,
          senderId: agentId,
          status: MESSAGE_STATUS.processing,
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      const content = { text: errorText, parts: [] } as Prisma.InputJsonValue;
      const message = processingRow
        ? await this.prisma.message.update({
            where: { id: processingRow.id },
            data: { content, status: MESSAGE_STATUS.failed } as any,
          })
        : await this.prisma.message.create({
            data: {
              id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
              channelId: channel.id,
              taskId: null,
              senderType: SENDER_TYPE.agent,
              senderId: agentId,
              senderInstanceId: teamMemberId,
              content,
              mentions: null,
              status: MESSAGE_STATUS.failed,
            } as any,
          });
      await this.realtime.broadcast(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: this.toMessageDto(message) },
        { type: 'channel', id: channel.id },
      );
      this.logger.warn(
        `agent ${agentId} 处理失败，消息 ${message.id} 标记 failed：${errorText}`,
      );
    } catch (err) {
      this.logger.error(
        `agent ${agentId} 失败消息落库失败: ${this.describeError(err)}`,
      );
    }
  }

  // ------------------------------------------------------------------
  // 私有工具
  // ------------------------------------------------------------------

  /**
   * F2 C1（CRITICAL）+ F3 MAJOR-1（增量检测）：自持轮询完成判定——promptAsync 后 server
   * 侧每 500ms 拉取 GET /session/{id}/message，**只检测本轮 dispatch 之后新增的消息**中
   * 是否出现 step-finish(reason=stop)（pollCursors 记录已消费到的最新消息 id，复用会话
   * 时不误命中上一次会话的 step-finish）→ handlePolledCompletion 落库+广播+emitFinal。
   * 默认超时（dispatchTimeoutMs）→ failedSessions 标记防迟到回流；emitError 由 watchdog
   * 统一触发（避免双 emitError）。
   * ⚠️ 方案 A：dispatch 主链路已切换为调 worker 执行端点 POST /execute + ingress 事件回流，
   * **dispatch 不再调用本方法**。本方法保留仅作兜底/测试路径（单测直接调用验证轮询语义）。
   */
  private async pollForCompletion(params: {
    worker: WorkerEndpointRef;
    opencodeSessionId: string;
    taskId: string;
    agentId: string;
    sessionId: string;
    /**
     * F4 消息来源频道（DispatchRequest.channelId 透传）：轮询回流时作为
     * preferredChannelId（用户实际触发的路径，群聊优先）。
     */
    channelId?: string;
    startedAt?: number;
    /**
     * F3 MAJOR-1 残留修复：promptAsync 前基线 cursor（dispatch 前置取定，此时 serve
     * 尚未创建本次 assistant 占位消息，不会落在占位上）。null=无历史（首次会话，
     * messagesAfter(null) 返回全部）；undefined=未提供（前置取基线失败）→ 回退既有
     * 游标或兜底首轮自取。
     */
    baselineCursor?: string | null;
  }): Promise<void> {
    const deadline = Date.now() + this.dispatchTimeoutMs;
    // F3 MAJOR-1：增量 poll 游标——上次已消费到的最新消息 id；复用会话第二次 dispatch
    // 时从上次已消费位置继续。F3 残留修复：优先使用 dispatch 在 promptAsync 前取的
    // 基线（绝对正确，无占位污染）；未提供才回退 pollCursors 既有游标（跨轮续接）。
    let cursor: string | null | undefined;
    if (params.baselineCursor !== undefined) {
      cursor = params.baselineCursor;
      if (cursor !== null) {
        this.pollCursors.set(params.sessionId, cursor);
      }
    } else {
      cursor = this.pollCursors.get(params.sessionId);
    }
    let initialized = cursor !== undefined;
    let firstTextAt: number | null = null;
    while (Date.now() < deadline) {
      let messages: unknown[];
      try {
        messages = await this.workerClient.getMessages(
          params.worker,
          params.opencodeSessionId,
        );
      } catch (err) {
        // getMessages 失败（worker 暂时不可达）：超时窗口内继续重试
        this.logger.warn(
          `agent ${params.agentId} 轮询 getMessages 失败: ${this.describeError(err)}`,
        );
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      const lastId = this.lastMessageId(messages);
      if (!initialized) {
        // F3 MAJOR-1 残留修复：兜底首轮基线（前置基线失败/无既有游标场景）——用
        // baselineId 跳过空 assistant 占位（promptAsync 后 serve 创建的本次回复占位，
        // parts=[]），基线落在本次 user prompt 消息（或更早）上，防 messagesAfter
        // 永空（m_37 超时根因）；不检测本轮。
        cursor = this.baselineId(messages);
        this.pollCursors.set(params.sessionId, cursor);
        initialized = true;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      const fresh = this.messagesAfter(messages, cursor ?? null);
      // F3 MINOR-3：记录首字出现时间（新消息中第一个非 synthetic text part），
      // QA 报告首字延迟依据；不优化模型响应速度（受模型/网络影响）
      if (firstTextAt === null && this.hasTextPart(fresh)) {
        firstTextAt = Date.now();
        const delta =
          params.startedAt !== undefined
            ? firstTextAt - params.startedAt
            : null;
        this.logger.log(
          `agent ${params.agentId} 首字出现${delta !== null ? `（dispatch 后 ${delta}ms）` : ''}`,
        );
      }
      // OBS-009：step-finish(reason=error)/error part → 模型调用失败，立即 emitError +
      // agent.error 广播快速返回（不再静默等到 dispatchTimeoutMs 超时才报错）。标记
      // failedSessions 复用现有逻辑——迟到回流（ingress/轮询）跳过落库防双写。
      const pollError = findError(fresh);
      if (pollError !== undefined) {
        this.pollCursors.set(params.sessionId, lastId ?? cursor);
        this.clearPendingWatchdog(params.taskId, params.agentId);
        this.failedSessions.add(params.sessionId);
        const message = `agent 处理失败：${pollError}`;
        this.logger.error(`agent ${params.agentId} ${message}`);
        this.emitError({
          taskId: params.taskId,
          agentId: params.agentId,
          error: message,
        });
        void this.broadcastAgentError({
          taskId: params.taskId,
          agentId: params.agentId,
          level: 'retry',
          errorType: 'model_error',
          message,
        });
        return;
      }
      if (findFinish(fresh)) {
        this.pollCursors.set(params.sessionId, lastId ?? cursor);
        this.clearPendingWatchdog(params.taskId, params.agentId);
        await this.handlePolledCompletion(params, fresh);
        return;
      }
      if (lastId !== null && lastId !== cursor) {
        this.pollCursors.set(params.sessionId, lastId);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    // 超时：标记失败防迟到回流（emitError 由 watchdog 同步触发，不重复 emit）
    this.failedSessions.add(params.sessionId);
    this.logger.error(
      `agent ${params.agentId} 自持轮询超时（${this.dispatchTimeoutMs / 1000}s 未出现 step-finish）`,
    );
  }

  /** F2 C1：轮询完成 → handleTaskCompleted（幂等检查：failedSessions/completedSessions）。
   *  F3 MAJOR-2：从回复文本提取产出物声明（12 篇 §3.1/§8.2）——原 poll 路径不携带
   *  artifacts 字段，归档循环拿到空数组（M4「产出物自动归档」不可用）；无声明 → 空数组。 */
  private async handlePolledCompletion(
    params: {
      taskId: string;
      agentId: string;
      sessionId: string;
      channelId?: string;
    },
    messages: unknown[],
  ): Promise<void> {
    if (this.failedSessions.has(params.sessionId)) {
      this.logger.warn(
        `session ${params.sessionId} 已超时失败，迟到的轮询回流跳过落库`,
      );
      return;
    }
    if (this.completedSessions.has(params.sessionId)) {
      this.logger.debug(
        `session ${params.sessionId} 已由 ingress 回流落库，跳过轮询回流`,
      );
      return;
    }
    const finish = findFinish(messages);
    const text = aggregateText(messages);
    await this.handleTaskCompleted({
      taskId: params.taskId,
      agentId: params.agentId,
      sessionId: params.sessionId,
      // F4 回流频道透传：消息来源频道随 payload 交 handleTaskCompleted 落库团队频道
      channelId: params.channelId,
      text,
      parts: (messages as PollMessageShape[]).flatMap((m) => m.parts ?? []),
      tokens: finish?.tokens,
      cost: finish?.cost,
      // F3 MAJOR-2：回复含产出物声明 → 提取后经 handleTaskCompleted 走 onArtifactSubmitted
      artifacts: extractArtifacts(text),
    });
  }

  /** doclib 上下文组装（12 篇 §8.2 注入格式）：产出物清单 + 各文档最新版本正文。 */
  private async buildDoclibContext(taskId: string): Promise<string> {
    const artifacts = await this.prisma.artifact.findMany({
      where: { taskId },
      select: {
        id: true,
        type: true,
        title: true,
        currentVersion: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (artifacts.length === 0) {
      return '';
    }

    // 各产出物 current_version 正文 + 作者（authorAgentId 在版本行，12 篇 §8.3：历史版本不进上下文）
    const versions = await this.prisma.artifactVersion.findMany({
      where: {
        OR: artifacts.map((a) => ({
          artifactId: a.id,
          version: a.currentVersion,
        })),
      },
      select: { artifactId: true, contentRef: true, authorAgentId: true },
    });
    const versionByArtifact = new Map(versions.map((v) => [v.artifactId, v]));

    const blocks = artifacts.map((a) => {
      const v = versionByArtifact.get(a.id);
      const content = truncateUtf8(v?.contentRef ?? '', this.doclibMaxBytes);
      return (
        `<artifact type="${escapeXml(a.type)}" title="${escapeXml(a.title)}"` +
        ` version="v${a.currentVersion}" author="${escapeXml(v?.authorAgentId ?? 'unknown')}"` +
        ` updated="${a.updatedAt ? a.updatedAt.toISOString().slice(0, 10) : ''}">` +
        `${escapeXml(content)}</artifact>`
      );
    });

    // 总大小防御上限（正常场景不触发；超出时整体截断，可能切裂结尾标签）
    const full = `<doclib>\n${blocks.join('\n')}\n</doclib>`;
    if (Buffer.byteLength(full, 'utf8') <= this.doclibTotalBytes) {
      return full;
    }
    const truncated = truncateUtf8(full, this.doclibTotalBytes);
    // F2 MINOR：截断可能切裂 `</doclib>` 结尾标签 → 去掉残缺片段补完整闭合标签
    if (!truncated.endsWith('</doclib>')) {
      const cut = truncated.lastIndexOf('</doclib');
      const head = cut >= 0 ? truncated.slice(0, cut) : truncated;
      return `${head.trimEnd()}\n</doclib>`;
    }
    return truncated;
  }

  /**
   * 群聊历史上下文组装（新需求：@agent 触发时带上来源频道 sent 历史，含未 @agent 的消息）：
   * ① 查询 channelId 频道 status=sent 历史（排除当前触发消息，避免重复），时间升序；
   * ② 每条取 content.text（用户=正文；agent=已排除 reasoning 的结论性文本），标注发言者；
   * ③ 按条累加 + 总量截断（对齐 doclib 32KB 语义，防超长 prompt）；空历史 → 空串（不注入）。
   */
  private async buildChatHistoryContext(
    channelId: string,
    excludeMessageId: string,
  ): Promise<string> {
    const messages = await this.prisma.message.findMany({
      where: {
        channelId,
        status: MESSAGE_STATUS.sent,
        NOT: { id: excludeMessageId },
      },
      select: { id: true, senderType: true, content: true },
      orderBy: { createdAt: 'asc' },
    });
    if (messages.length === 0) {
      return '';
    }
    const lines: string[] = [];
    let totalBytes = 0;
    for (const m of messages) {
      // 防御：查询 where 已排除触发消息，此处按 id 再滤一次（测试/mock 场景下 NOT 不生效）
      if (m.id === excludeMessageId) {
        continue;
      }
      const text = this.extractHistoryMessageText(m.content);
      if (!text) {
        continue;
      }
      const line = `${this.historySpeakerLabel(m.senderType)}: ${text}`;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (totalBytes + lineBytes > this.chatHistoryMaxBytes) {
        // 超总量：首条即超限 → 单条截断注入保前缀；否则停止追加保留已有前缀
        if (lines.length === 0) {
          lines.push(truncateUtf8(line, this.chatHistoryMaxBytes));
        }
        break;
      }
      lines.push(line);
      totalBytes += lineBytes;
    }
    if (lines.length === 0) {
      return '';
    }
    return `[群聊历史消息]\n${lines.join('\n')}`;
  }

  /** 从消息 content（Prisma Json）提取结论性文本：非对象/缺 text/非字符串 → undefined（跳过不抛错）。 */
  private extractHistoryMessageText(
    content: Prisma.JsonValue,
  ): string | undefined {
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      return undefined;
    }
    const text = (content as Record<string, unknown>).text;
    return typeof text === 'string' && text.trim() ? text : undefined;
  }

  /** 历史消息发言者标注：用户 → 用户，agent → Agent，其他（system 等）→ 系统。 */
  private historySpeakerLabel(senderType: string): string {
    if (senderType === SENDER_TYPE.user) {
      return '用户';
    }
    if (senderType === SENDER_TYPE.agent) {
      return 'Agent';
    }
    return '系统';
  }

  private async forwardToGroup(
    taskId: string,
    agentId: string,
    content: Prisma.InputJsonValue,
    sessionId: string | undefined,
    mainChannelId: string,
    attachment?: { url: string; name: string },
  ): Promise<void> {
    try {
      const task = await (this.prisma as any).task.findUnique({
        where: { id: taskId },
        select: { teamId: true },
      });
      const teamId = task?.teamId ?? null;
      if (!teamId) return;
      const group = await this.prisma.chatChannel.findFirst({
        where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
        select: { id: true },
      });
      if (!group || group.id === mainChannelId) {
        return;
      }
      const ext = attachment
        ? (FileStorageService.extractExtension(attachment.name) ?? '')
        : '';
      const groupMessage = await this.prisma.message.create({
        data: {
          id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
          channelId: group.id,
          taskId,
          senderType: SENDER_TYPE.agent,
          senderId: agentId,
          content,
          mentions: null,
          status: MESSAGE_STATUS.sent,
          ...(attachment
            ? {
                attachmentUrl: attachment.url,
                attachmentName: attachment.name,
                attachmentType: ext,
              }
            : {}),
        } as any,
      });
      await this.realtime.broadcast(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: this.toMessageDto(groupMessage) },
        { type: 'channel', id: group.id },
      );
      this.logger.log(
        `agent ${agentId} 群聊转发（对外结果）message=${groupMessage.id}（session=${sessionId ?? '-'}）`,
      );
    } catch (err) {
      this.logger.error(
        `agent ${agentId} 群聊转发失败: ${this.describeError(err)}`,
      );
    }
  }

  /**
   * C7：模型解析优先级链（阶段 1，Agent→模板）：Agent.defaultModelId 显式非空直接用；
   * 否则沿 baseAgentId 链向上取最近非空 defaultModelId（模板默认；链可多层 clone of clone，
   * 取自 type=template 祖先或任意非空 defaultModelId 祖先，seed 已预置模板模型）。
   * 全链无配置 → null（不指定模型，由 worker 默认/serve 默认兜底）。
   */
  private async resolveMemberOverrideModelId(
    teamMemberId: string,
  ): Promise<string | null> {
    const repo = (this.prisma as any).teamMember;
    if (!repo || typeof repo.findFirst !== 'function') {
      return null;
    }
    try {
      const row = (await repo.findFirst({
        where: { id: teamMemberId },
        select: { overrideModelId: true },
      })) as { overrideModelId: string | null } | null;
      return row?.overrideModelId ?? null;
    } catch (err) {
      // 覆盖查询失败不阻断分派：回退 agent 默认模型（增强特性容错）
      this.logger.warn(
        `成员覆盖模型查询失败 teamMemberId=${teamMemberId}，回退 agent 默认模型：${this.describeError(err)}`,
      );
      return null;
    }
  }

  /**
   * 团队成员选择的 opencode 原生 agent 名（TeamMember.opencodeAgentName）。
   *
   * 非空 → 分派时下发 prompt_async 的 `agent` 字段，由 opencode 内核按该 agent 的
   * prompt/permission 执行（vteam 只做传递，不自造 agent 语义）；null → 不带该字段，
   * 行为与引入本特性前逐字节一致（零回归）。
   *
   * 容错：查询失败不阻断分派，回退 null（同 resolveMemberOverrideModelId 的增强特性容错）。
   */
  private async resolveMemberOpencodeAgentName(
    teamMemberId: string,
  ): Promise<string | null> {
    const repo = (this.prisma as any).teamMember;
    if (!repo || typeof repo.findFirst !== 'function') {
      return null;
    }
    try {
      const row = (await repo.findFirst({
        where: { id: teamMemberId },
        select: { opencodeAgentName: true },
      })) as { opencodeAgentName: string | null } | null;
      return row?.opencodeAgentName ?? null;
    } catch (err) {
      this.logger.warn(
        `成员 opencode agent 名查询失败 teamMemberId=${teamMemberId}，回退 null：${this.describeError(err)}`,
      );
      return null;
    }
  }

  /**
   * 目标成员**岗位**的边界 correction 与工具屏蔽表（2026-09-21 capability model）。
   *
   * **两条通道分离**（有意）：
   *  - `tools`（记忆/产出物段屏蔽）由 `AgentRole.capabilities`（业务能力点矩阵）推导：
   *    缺失键 ⇒ 允许 ⇒ `'allow'`；显式 `false` ⇒ `'deny'`。未绑岗位 → null（不屏蔽）。
   *  - `correction`（prompt 关注点，非授权）保持既有来源：`resolveByRole({roleKey})` 读
   *    内置约定策略行 `ep_<roleKey>`（DB 可编辑值胜出），行缺失/外部自定义岗位 → 回退
   *    `role.key`（未绑岗位回退 `agent.agentKey`）常量派生的 `resolveConstantPolicySource`；
   *    均无 → null。correction 返回前经 `canonicalizeCorrection` 按角色 `handoffTo` 声明序
   *    重排（DB MySQL JSON 键序与常量声明序不同，不重排会改变渲染出的转交顺序）。
   */
  private async resolveBoundaryAndTools(
    agent: AgentIdentityInfo,
    role: MemberRoleAuthority | null,
  ): Promise<{
    correction: BoundaryCorrection | null;
    tools: Record<string, AgentToolState> | null;
  }> {
    // 常量名优先取岗位 key（内置 7 名 key === 模板 agentKey ⇒ 存量同值）；未绑岗位的
    // 存量/单测路径回退 agentKey（与引入前逐字节一致）。
    const constantName = agentKeyToVteamAgentName(role?.key ?? agent.agentKey);
    const capabilityTools = role
      ? capabilityMatrixToToolStates(role.capabilities ?? {})
      : null;
    if (this.executionPolicyService && role) {
      try {
        const resolved = await this.executionPolicyService.resolveByRole({
          roleKey: role.key,
        });
        if (resolved) {
          return {
            correction: canonicalizeCorrection(
              resolved.correction,
              constantName ?? resolved.agentName,
            ),
            tools: capabilityTools,
          };
        }
      } catch (err) {
        // 策略解析异常不阻断分派 → 回退常量派生
        this.logger.warn(
          `岗位策略解析失败 role=${role.key}，回退常量派生：${this.describeError(err)}`,
        );
      }
    }
    if (constantName) {
      const constant = resolveConstantPolicySource(constantName);
      return {
        correction: constant?.config.correction ?? null,
        // 已绑岗位 → 能力矩阵推导（capability model）；未绑岗位（存量路径）→ 常量工具集
        //（与引入 capability model 前逐字节一致，Q5 不再新增此类成员）。
        tools: role ? capabilityTools : (constant?.config.tools ?? null),
      };
    }
    return { correction: null, tools: capabilityTools };
  }

  private async resolveAgentModelId(agentId: string): Promise<string | null> {
    let currentId: string | null = agentId;
    for (
      let depth = 0;
      currentId && depth < MAX_BASE_AGENT_CHAIN_DEPTH;
      depth++
    ) {
      const row = await this.prisma.agent.findUnique({
        where: { id: currentId },
        select: {
          id: true,
          defaultModelId: true,
          baseAgentId: true,
          type: true,
        },
      });
      if (!row) {
        return null;
      }
      if (row.defaultModelId) {
        return row.defaultModelId;
      }
      if (!row.baseAgentId || row.type === 'template') {
        return null;
      }
      currentId = row.baseAgentId;
    }
    return null;
  }

  /** Agent.defaultModelId（`provider/model`）→ opencode serve 模型选择；缺省/非法 → null。 */
  private toModelSelection(
    defaultModelId: string | null | undefined,
  ): { providerID: string; modelID: string } | null {
    if (!defaultModelId) {
      return null;
    }
    const slash = defaultModelId.lastIndexOf('/');
    if (slash <= 0 || slash === defaultModelId.length - 1) {
      return null;
    }
    return {
      providerID: defaultModelId.slice(0, slash),
      modelID: defaultModelId.slice(slash + 1),
    };
  }

  /**
   * 事件静默自愈 watchdog（滑动窗口）：dispatch 调 worker 执行端点后武装；此后每个非终态
   * 回流事件（session.updated(running)/delta/agent.status）经 handleSessionActivity 滑动
   * 重武装——窗口度量「距最近一次事件」而非「距 dispatch」，覆盖首字出现之后的中途静默
   * （worker 侧 exec-server.ts「首字出现后无完成超时」+ AGENT_IDLE_TIMEOUT_MS=0 时无其它兜底）。
   *
   * 三条探活路径（优先级/职责切分，勿互相抢跑）：
   * ① worker 首字探测 300s（worker 侧 env 见 worker/src/config.ts，默认 300000，worker/src/driver/prompt-await.ts:267）：
   *    token/模型诊断唯一归 worker——它持有会话、能 abort、附 serve 诊断；
   * ② server 事件静默 600s 滑动 ×3（本 watchdog，DEFAULT_SILENT_SESSION_WAKE_MS）：
   *    阈值 > worker 300s，永不抢跑 ①；到期先查心跳，worker 已 offline → 立即失败不唤醒，
   *    在线 → tryAutoRestart 唤醒（最多 MAX_SILENT_WAKE_ATTEMPTS 次，每次重武装完整窗口）；
   * ③ 心跳 10s 上报 / 30s 判离线（WORKER_HEARTBEAT_INTERVAL_MS=10_000，
   *    server/src/workers/workers.constants.ts + workers.service.ts HealthChecker）：
   *    进程死亡的探活走这条路，本 watchdog 的 offline 快速失败依赖它。
   *
   * 同时通过 DB 活动列记录空闲判死追踪起点（活动事件刷新，超 AGENT_IDLE_TIMEOUT_MS 判死）。
   * OBS-009：poll 已快速失败（failedSessions 已标记）时跳过注册。
   */
  private startPendingWatchdog(
    scope: string,
    agentId: string,
    sessionId: string,
    workerId: string,
    teamMemberId: string,
  ): void {
    if (this.silentSessionWakeMs <= 0) {
      return;
    }
    if (this.failedSessions.has(sessionId)) {
      return;
    }
    const dispatchedAt = this.armSilenceWatchdog({
      scope,
      agentId,
      sessionId,
      workerId,
      teamMemberId,
    });
    // 空闲判死追踪起点写入 DB（活动事件经 handleSessionActivity 刷新）。
    void this.persistSessionActivity(sessionId, new Date(dispatchedAt));
    this.startIdleScan();
  }

  /**
   * 武装静默 deadline（注册与唤醒重试共用）：同键旧轮清理（timer + durable 行 best-effort
   * 取消）→ 新 setTimeout（捕获本轮 sessionId，防旧 timer 收割新一轮）→ 注册 pending 映射
   * → 落 durable 行（due = 本轮 deadlineAt）。返回本轮注册时刻，调用方据此写 DB 活动列。
   * 世代号 dispatchedAt 一经注册不再改写；事件滑动重武装只推 timer/deadlineAt（不落 DB 行）。
   */
  private armSilenceWatchdog(args: {
    scope: string;
    agentId: string;
    sessionId: string;
    workerId: string;
    teamMemberId: string;
  }): number {
    const { scope, agentId, sessionId, workerId, teamMemberId } = args;
    const key = `${scope}:${agentId}`;
    const existing = this.pending.get(key);
    let activitySeen = false;
    if (existing) {
      clearTimeout(existing.timer);
      this.pendingBySession.delete(existing.sessionId);
      // 旧轮被取代：其唤醒计数一并作废（防静默旧会话计数悬挂）。
      if (existing.sessionId !== sessionId) {
        this.silentWakeAttempts.delete(existing.sessionId);
      } else {
        // 同会话重武装（唤醒重试）：保留「已见事件」标记（空闲判死否决依据）。
        activitySeen = existing.activitySeen;
      }
      // 同键重注册：旧 durable deadline 一并取消（best-effort），防旧行误收割新一轮
      // （唤醒重试时本行即被取代的旧行；正 firing 的行 cancel 幂等兜底）。
      void this.cancelSilenceTrigger(existing.triggerDedupKey);
    }
    const dispatchedAt = Date.now();
    const deadlineAt = dispatchedAt + this.silentSessionWakeMs;
    const timer = setTimeout(() => {
      const current = this.pending.get(key);
      // 同键已被更新一轮（session 不同）→ 本 timer 是旧轮残留，不收割。
      if (!current || current.sessionId !== sessionId) {
        return;
      }
      // 同会话重武装（唤醒重试/事件滑动）：本 timer 已被新 timer 取代 → 旧轮残留，不收割。
      if (current.timer !== timer) {
        return;
      }
      void this.reapSilenceDeadline({
        key,
        scope,
        agentId,
        sessionId,
        workerId,
        teamMemberId,
      });
    }, this.silentSessionWakeMs);
    timer.unref?.();
    const entry: PendingDispatch = {
      scope,
      agentId,
      instanceId: teamMemberId,
      sessionId,
      workerId,
      timer,
      dispatchedAt,
      deadlineAt,
      activitySeen,
    };
    this.pending.set(key, entry);
    this.pendingBySession.set(sessionId, key);
    // todo-9：同 deadline 经 TriggerService 落 durable 行（setTimeout 重启即丢，
    // 此行重启后仍到期触发 handleSilenceTrigger）。
    void this.scheduleSilenceTrigger(entry, key, deadlineAt);
    return dispatchedAt;
  }

  /**
   * 事件滑动重武装（仅内存 timer，不落 durable 行——事件高频，避免每事件一次 DB 写）：
   * 窗口推到 now + silentSessionWakeMs，deadlineAt 同步推进，activitySeen 置位
   * （空闲判死不再否决该会话）。旧 durable 行到期时 handler 见 deadlineAt > dueAt
   * 会自我顺延（见 handleSilenceTrigger），故事件路径无需碰 DB。
   */
  private rearmSilenceWatchdogBySession(sessionId: string): void {
    if (this.silentSessionWakeMs <= 0) {
      return;
    }
    const key = this.pendingBySession.get(sessionId);
    if (key === undefined) {
      return;
    }
    const entry = this.pending.get(key);
    if (!entry || entry.sessionId !== sessionId) {
      return;
    }
    clearTimeout(entry.timer);
    const deadlineAt = Date.now() + this.silentSessionWakeMs;
    const timer = setTimeout(() => {
      const current = this.pending.get(key);
      if (!current || current.sessionId !== sessionId) {
        return;
      }
      if (current.timer !== timer) {
        return;
      }
      void this.reapSilenceDeadline({
        key,
        scope: entry.scope,
        agentId: entry.agentId,
        sessionId,
        workerId: entry.workerId,
        teamMemberId: entry.instanceId,
      });
    }, this.silentSessionWakeMs);
    timer.unref?.();
    entry.timer = timer;
    entry.deadlineAt = deadlineAt;
    entry.activitySeen = true;
  }

  /**
   * 静默 deadline 收割（内存 timer 与 durable trigger 共用同一行为，async）：
   * ① 心跳快速失败——先查 worker：已 offline（或行缺失）→ 立即走失败路径，
   *    **不**调 tryAutoRestart（离线 worker 唤醒无意义，探活归心跳路径）；
   * ② 在线且静默未达唤醒上限 → 计数 +1、重武装全新窗口（内存 timer + durable 行）
   *    并经既有 tryAutoRestart 唤醒（fire-and-forget，失败只记日志）；不刷新
   *    DB 活动列（唤醒≠活动，空闲判死只认真实事件）；
   * ③ 在线但达到上限仍静默 → 失败路径：pending 删除 + failedSessions 标记 +
   *    活跃执行注销 + 追踪退出 + emitError + 广播 agent.error
   *    （silent_session_timeout，文案声明心跳正常 + 唤醒次数耗尽）。
   */
  private async reapSilenceDeadline(args: {
    key?: string;
    scope: string;
    agentId: string;
    sessionId: string;
    workerId: string;
    teamMemberId: string;
  }): Promise<void> {
    const { key, scope, agentId, sessionId, workerId, teamMemberId } = args;
    // 已判败（空闲判死/轮询快速失败/前次收割）→ 清残余 pending，不重复广播。
    if (this.failedSessions.has(sessionId)) {
      if (key !== undefined) {
        this.pending.delete(key);
      }
      this.pendingBySession.delete(sessionId);
      return;
    }
    const fail = (error: string): void => {
      if (key !== undefined) {
        this.pending.delete(key);
      }
      this.pendingBySession.delete(sessionId);
      this.silentWakeAttempts.delete(sessionId);
      // F2 MINOR：超时标记失败会话——迟到的回流（ingress/轮询）跳过落库仅记日志
      this.failedSessions.add(sessionId);
      this.unregisterExecution(workerId, scope, teamMemberId);
      this.logger.error(`agent ${agentId} ${error}`);
      this.emitError({ taskId: scope, agentId, error });
      void this.broadcastAgentError({
        taskId: scope,
        agentId,
        sessionId,
        level: 'retry',
        errorType: 'silent_session_timeout',
        message: error,
      });
    };
    // ① 心跳快速失败：探活走心跳路径（WORKER_HEARTBEAT_INTERVAL_MS=10s / 30s 判离线）。
    let workerRow: { status?: string } | null = null;
    let workerLookupFailed = false;
    try {
      workerRow = await this.prisma.worker.findUnique({
        where: { id: workerId },
        select: { status: true },
      });
    } catch (err) {
      this.logger.warn(
        `worker ${workerId} 心跳状态查询失败（fail-open 按在线继续）: ${this.describeError(err)}`,
      );
      workerLookupFailed = true;
    }
    if (
      !workerLookupFailed &&
      (!workerRow || workerRow.status === WORKER_STATUS.OFFLINE)
    ) {
      fail(
        `agent 无响应（${this.silentSessionWakeMs / 1000}s 无事件回流，worker 心跳已离线），不再唤醒直接失败，请检查 worker 状态`,
      );
      return;
    }
    const attempts = this.silentWakeAttempts.get(sessionId) ?? 0;
    if (attempts < MAX_SILENT_WAKE_ATTEMPTS) {
      this.silentWakeAttempts.set(sessionId, attempts + 1);
      this.armSilenceWatchdog({
        scope,
        agentId,
        sessionId,
        workerId,
        teamMemberId,
      });
      this.logger.warn(
        `agent ${agentId} 事件静默（第 ${attempts + 1}/${MAX_SILENT_WAKE_ATTEMPTS} 次自动唤醒） session=${sessionId}`,
      );
      void this.attemptSilenceWake(sessionId).catch((err: unknown) =>
        this.logger.error(
          `事件静默唤醒失败 session=${sessionId}: ${this.describeError(err)}`,
        ),
      );
      return;
    }
    fail(
      `agent 无响应（${this.silentSessionWakeMs / 1000}s 无事件回流，worker 心跳正常），已尝试 ${MAX_SILENT_WAKE_ATTEMPTS} 次自动唤醒仍未恢复，请稍后重试或检查 worker 状态`,
    );
  }

  /**
   * 事件静默唤醒（fire-and-forget）：按平台会话主键解析归属任务/团队/成员（与空闲判死
   * markSessionIdleDead 同一口径）后经既有 tryAutoRestart 走 dispatchAgentMention
   * kind='wake'（【自动恢复】文案复用，不新增唤醒机制）。teamId/teamMemberId 不可解析 →
   * 跳过唤醒（计数与重武装照常）；异常由调用方 catch 记日志，永不外抛。
   */
  private async attemptSilenceWake(sessionId: string): Promise<void> {
    const row = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { taskId: true, teamId: true, teamMemberId: true },
    });
    const teamId = row?.teamId ?? null;
    const teamMemberId = row?.teamMemberId ?? null;
    if (!teamId || !teamMemberId) {
      this.logger.warn(
        `事件静默唤醒跳过：会话 ${sessionId} 无团队归属（重试计数与重武装照常）`,
      );
      return;
    }
    await this.tryAutoRestart(teamId, teamMemberId, row?.taskId ?? null);
  }

  /**
   * 静默 deadline 落 durable 行（one-shot，due = 入参 dueAt）。
   * kind 复用 SESSION_IDLE_SCAN（白名单内唯一的会话存活类 kind，
   * 不新增 kind 即不 churn 白名单与 REST source 映射），payload.reason 作鉴别。
   * dedupKey per-dispatch 唯一（schedule 对既有 dedupKey 是幂等直返，
   * 同会话多轮分派必须各有新行，旧行由 cancel 显式取消）。
   * 全程 best-effort：失败只记 warn，内存 timer 照常生效。
   */
  private async scheduleSilenceTrigger(
    entry: PendingDispatch,
    key: string,
    dueAt: number,
  ): Promise<void> {
    if (!this.triggers) {
      return;
    }
    const dedupKey = buildTriggerDedupKey(
      TRIGGER_KIND.SESSION_IDLE_SCAN,
      key,
      `${entry.sessionId}:silent-session:${dueAt}:${Math.floor(Math.random() * 1_000_000)}`,
    );
    const payload: SilentSessionTriggerPayload = {
      reason: 'silent-session',
      scope: entry.scope,
      agentId: entry.agentId,
      sessionId: entry.sessionId,
      workerId: entry.workerId,
      teamMemberId: entry.instanceId,
      dispatchedAt: entry.dispatchedAt,
      dueAt,
    };
    try {
      await this.triggers.schedule(
        TRIGGER_KIND.SESSION_IDLE_SCAN,
        new Date(dueAt),
        payload,
        dedupKey,
      );
      // 仅落库成功才挂载到内存条目（clear 路径凭此取消；调度失败则无行可取消）；
      // 且仅挂载到同世代条目——唤醒重试的旧 schedule 迟到 resolve 不得覆盖新窗口的 key。
      const current = this.pending.get(key);
      if (
        current &&
        current.sessionId === entry.sessionId &&
        current.dispatchedAt === entry.dispatchedAt
      ) {
        current.triggerDedupKey = dedupKey;
      }
    } catch (err) {
      this.logger.warn(
        `静默 deadline durable 行落库失败（仅内存 watchdog 生效） session=${entry.sessionId}: ${this.describeError(err)}`,
      );
    }
  }

  /** 终态清除/重注册时取消 durable deadline（无行/已终态时 cancel 抛错→吞掉记 warn）。 */
  private async cancelSilenceTrigger(
    dedupKey: string | undefined,
  ): Promise<void> {
    if (!this.triggers || !dedupKey) {
      return;
    }
    try {
      await this.triggers.cancel(dedupKey);
    } catch (err) {
      this.logger.warn(
        `静默 deadline durable 行取消失败（忽略） ${dedupKey}: ${this.describeError(err)}`,
      );
    }
  }

  /**
   * durable 静默 deadline 到期处理（TriggerService SESSION_IDLE_SCAN handler）。
   * - 非本载荷（reason 缺失/它用）→ no-op，{done:true}（同 kind 共存不互伤）。
   * - 已标记失败 → {done:true}（内存 timer 已收割，不重复广播）。
   * - pendingBySession 仍命中（本进程监控中）：
   *   · 世代号防御：dispatchedAt 不匹配（被重武装取代的旧行迟到 firing）→ 跳过；
   *   · deadlineAt > dueAt（事件已把窗口滑到本行之后）→ 本行过期：顺延 durable 行
   *     到当前 deadlineAt（不收割、不动内存 timer），{done:true}；
   *   · 否则窗口真到期 → 清 timer + reapSilenceDeadline（唤醒重试/失败）。
   * - 命中缺席（重启后内存全空）→ DB 侧判定：行缺失/非 running → 跳过；
   *   base = max(dispatchedAt, DB 活动列)，base + 窗口 > now → 窗口未到（活动把
   *   窗口滑后过本行 due）→ 顺延 durable 行不收割；已到期 → 同走 reap（重启后唤醒
   *   上限从 0 起算），DB 异常时 fail-open 跳过。
   */
  private async handleSilenceTrigger(
    trigger: TriggerFireContext,
  ): Promise<TriggerOutcome> {
    const payload = trigger?.payload;
    if (!isSilenceTriggerPayload(payload)) {
      return { done: true };
    }
    const { scope, agentId, sessionId, workerId, teamMemberId, dispatchedAt } =
      payload;
    if (this.failedSessions.has(sessionId)) {
      return { done: true };
    }
    const key = this.pendingBySession.get(sessionId);
    if (key !== undefined) {
      const current = this.pending.get(key);
      if (!current || current.sessionId !== sessionId) {
        return { done: true };
      }
      // 世代号防御：本行是被重武装取代的旧行（迟到 firing）→ 不收割新一轮。
      if (current.dispatchedAt !== dispatchedAt) {
        return { done: true };
      }
      // 滑动防御：事件已把窗口推到本行之后 → 本行过期，顺延 durable 行，内存 timer 不动。
      if (current.deadlineAt > payload.dueAt) {
        const staleDedupKey = current.triggerDedupKey;
        await this.scheduleSilenceTrigger(current, key, current.deadlineAt);
        void this.cancelSilenceTrigger(staleDedupKey);
        return { done: true };
      }
      clearTimeout(current.timer);
      const dedupKey = current.triggerDedupKey;
      await this.reapSilenceDeadline({
        key,
        scope,
        agentId,
        sessionId,
        workerId,
        teamMemberId,
      });
      // 本行正 firing（claim 后回调中），cancel 只影响他行；仍调用以幂等语义兜底。
      void this.cancelSilenceTrigger(dedupKey);
      return { done: true };
    }
    let row: { status: unknown; lastActivityAt: unknown } | null;
    try {
      row = (await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { status: true, lastActivityAt: true },
      })) as { status: unknown; lastActivityAt: unknown } | null;
    } catch (err) {
      this.logger.warn(
        `静默 deadline 重启判定读会话失败（fail-open 跳过） session=${sessionId}: ${this.describeError(err)}`,
      );
      return { done: true };
    }
    if (!row || row.status !== SESSION_STATUS.running) {
      return { done: true };
    }
    const activityAt =
      row.lastActivityAt instanceof Date
        ? row.lastActivityAt.getTime()
        : dispatchedAt;
    const base = Math.max(dispatchedAt, activityAt);
    const windowEnd = base + this.silentSessionWakeMs;
    if (windowEnd > Date.now()) {
      // 事件把窗口滑到本行之后（重启后内存全空）→ 顺延 durable 行，不收割。
      if (this.triggers) {
        try {
          const dedupKey = buildTriggerDedupKey(
            TRIGGER_KIND.SESSION_IDLE_SCAN,
            `${scope}:${agentId}`,
            `${sessionId}:silent-session:${windowEnd}:${Math.floor(Math.random() * 1_000_000)}`,
          );
          await this.triggers.schedule(
            TRIGGER_KIND.SESSION_IDLE_SCAN,
            new Date(windowEnd),
            {
              reason: 'silent-session',
              scope,
              agentId,
              sessionId,
              workerId,
              teamMemberId,
              dispatchedAt,
              dueAt: windowEnd,
            } satisfies SilentSessionTriggerPayload,
            dedupKey,
          );
        } catch (err) {
          this.logger.warn(
            `静默 deadline 顺延行落库失败（fail-open 跳过） session=${sessionId}: ${this.describeError(err)}`,
          );
        }
      }
      return { done: true };
    }
    await this.reapSilenceDeadline({
      scope,
      agentId,
      sessionId,
      workerId,
      teamMemberId,
    });
    return { done: true };
  }

  /**
   * 双写 DB 侧：尽力而为，失败只记 warn 永不抛错（dispatch 主链路不受 DB 抖动影响）。
   */
  private async persistSessionActivity(
    sessionId: string,
    at?: Date,
  ): Promise<void> {
    try {
      await this.prisma.session.update({
        where: { id: sessionId },
        data: { lastActivityAt: at ?? new Date() },
      });
    } catch (err) {
      this.logger.warn(
        `session ${sessionId} 活动时间回写失败（fail-open，DB 扫描继续）: ${this.describeError(err)}`,
      );
    }
  }

  /**
   * ingress 活动事件通知处理（onSessionActivity 回调）：
   * - 终态（task.completed / session 非 running / agent.status=error）→ 本轮结束：
   *   清除静默 watchdog + 复零唤醒计数（生命周期=完成/判败/换会话）；
   * - 非终态事件（delta / agent.status 非 error / session.updated(running)）→
   *   **滑动重武装**：窗口推到 now + silentSessionWakeMs（只重置内存 timer/deadlineAt，
   *   不落 durable 行），activitySeen 置位（空闲判死不再否决）；唤醒计数不清；
   * - 非终态同时刷新 DB 活动列（空闲判死计时）。
   */
  private handleSessionActivity(payload: SessionActivityPayload): void {
    const { sessionId } = payload;
    if (!sessionId) {
      return;
    }
    const terminal =
      payload.type === 'task.completed' ||
      (payload.type === 'session.updated' &&
        !!payload.status &&
        payload.status !== SESSION_STATUS.running) ||
      (payload.type === 'agent.status' && payload.status === 'error');
    if (terminal) {
      this.clearPendingWatchdogBySession(sessionId);
      this.clearDispatchSnapshotBySession(sessionId);
    } else {
      this.rearmSilenceWatchdogBySession(sessionId);
    }
    if (
      payload.type === 'task.completed' ||
      (payload.type === 'session.updated' &&
        payload.status &&
        payload.status !== SESSION_STATUS.running)
    ) {
      return;
    }
    // is_7：首个非终态活动 = 会话存活/首字成功，快照使命达成（防重放循环）。
    this.clearDispatchSnapshotBySession(sessionId);
    void this.persistSessionActivity(sessionId);
  }

  /** 启动空闲判死扫描（0 表示禁用，按需求已禁杀死长任务；构造时常驻启动 + watchdog 惰性兜底） */
  private startIdleScan(): void {
    if (this.agentIdleTimeoutMs <= 0) {
      return;
    }
    if (this.idleScanTimer) {
      return;
    }
    this.idleScanTimer = setInterval(() => {
      void this.scanIdleSessions().catch((err: unknown) =>
        this.logger.error(`空闲判死扫描失败: ${this.describeError(err)}`),
      );
    }, IDLE_SCAN_INTERVAL_MS);
    this.idleScanTimer.unref?.();
  }

  /**
   * 空闲判死扫描：从 DB 检出超时会话，跳过仍等首事件（pending 且 activitySeen=false）
   * 的会话——滑动窗口已接管其无事件检测；已见事件的会话即便 watchdog 仍挂着（滑动
   * 重武装不清 pending）也照常参与判死；超 AGENT_IDLE_TIMEOUT_MS 无活动 → 查
   * Session.status，仅 running 判死（failed + emitError + 广播 agent.error）；
   * 非 running（idle/完成/冻结）→ 退出追踪不判死（防误杀）。
   * DB 侧谓词同时覆盖非空活动列与 NULL 活动列（NULL 回退 updatedAt）；本进程内
   * 正处首字等待的会话（pending 且 activitySeen=false）一律否决，不判死。
   */
  private async scanIdleSessions(): Promise<void> {
    if (this.agentIdleTimeoutMs <= 0) {
      return;
    }
    const now = Date.now();
    const stale: string[] = [];
    // DB 侧检出：活动列为 NULL 时回退到 Session.updatedAt（@updatedAt，
    // 自动反映最后写入），避免新建/持久化失败的 running 会话因 NULL 比较而永久逃逸。
    try {
      const cutoff = new Date(now - this.agentIdleTimeoutMs);
      const dbStale = await this.prisma.session.findMany({
        where: {
          status: SESSION_STATUS.running,
          OR: [
            { lastActivityAt: { lt: cutoff } },
            { lastActivityAt: null, updatedAt: { lt: cutoff } },
          ],
        },
        select: { id: true },
        take: 100,
      });
      for (const row of dbStale ?? []) {
        if (this.isPendingFirstEventWait(row.id)) {
          continue;
        }
        stale.push(row.id);
      }
    } catch (err) {
      this.logger.warn(
        `空闲判死 DB 检出失败（fail-open，扫描继续）: ${this.describeError(err)}`,
      );
    }
    for (const sessionId of stale) {
      await this.markSessionIdleDead(sessionId);
    }
  }

  /** 空闲判死否决：会话 watchdog 仍在且未见过任何回流事件（首事件等待中，滑动窗口接管）→ 不判死。 */
  private isPendingFirstEventWait(sessionId: string): boolean {
    const key = this.pendingBySession.get(sessionId);
    if (key === undefined) {
      return false;
    }
    const entry = this.pending.get(key);
    return (
      entry !== undefined &&
      entry.sessionId === sessionId &&
      !entry.activitySeen
    );
  }

  /**
   * 读取会话的最近活动时间（epoch ms）。DB 的 last_activity_at 是 wall-clock
   * SESSION-scoped；NULL 时以 Session.updatedAt 回退，冷却判断保持保守。
   */
  public async getSessionLastActivityAt(
    sessionId: string,
  ): Promise<number | undefined> {
    const row = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { lastActivityAt: true, updatedAt: true },
    });
    const activityAt = row?.lastActivityAt ?? row?.updatedAt;
    return activityAt?.getTime();
  }

  public isSessionPending(sessionId: string): boolean {
    return this.pendingBySession.has(sessionId);
  }

  private async markSessionIdleDead(sessionId: string): Promise<void> {
    try {
      const row = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: {
          status: true,
          taskId: true,
          teamId: true,
          teamMemberId: true,
          agentId: true,
          workerId: true,
          instanceRef: true,
        },
      });
      if (!row) {
        return;
      }
      if (row.status !== SESSION_STATUS.running) {
        return;
      }
      // 内存否决（todo-7，Oracle 约束）：本进程仍登记该成员为活跃执行 → 正处轮中，
      // 跳过判死（isAgentExecuting 只读复用，语义不变；TTL 30min 到期后否决自动失效）。
      if (row.workerId && row.teamId && row.teamMemberId) {
        const active = this.isAgentExecuting(
          row.workerId,
          toExecutionScope(null, row.teamId),
        );
        if (active !== null && active.has(row.teamMemberId)) {
          this.logger.warn(
            `session ${sessionId} 仍在活跃执行集合中（内存否决），跳过空闲判死`,
          );
          return;
        }
      }
      let forensicsError: string | undefined;
      let forensicsType = 'agent_idle_timeout';
      // abort-before-restart：尸检 getMessages 与中止 abort 共用一次 capabilities 查询。
      let abortRef: WorkerEndpointRef | null = null;
      let abortInstanceRef: string | null = null;
      if (
        row.workerId &&
        row.instanceRef &&
        row.instanceRef !== PENDING_INSTANCE_REF
      ) {
        try {
          const workerRow = await this.prisma.worker.findUnique({
            where: { id: row.workerId },
            select: { capabilities: true },
          });
          if (workerRow) {
            abortRef = {
              id: row.workerId,
              capabilities: workerRow.capabilities,
            };
            // instanceRef 即 opencode ses_ id（非平台 s_ id），原样透传 workerClient。
            abortInstanceRef = row.instanceRef;
            const messages = await this.workerClient.getMessages(
              abortRef,
              row.instanceRef,
            );
            const errText = findError(messages);
            if (errText) {
              forensicsError = errText;
              forensicsType = inferErrorType(errText);
            }
          }
        } catch (err) {
          this.logger.debug(
            `session ${sessionId} 错误尸检失败 worker=${row.workerId}，沿用默认错误类型：${this.describeError(err)}`,
          );
        }
      }
      await this.prisma.session.update({
        where: { id: sessionId },
        data: { status: SESSION_STATUS.failed },
      });
      this.failedSessions.add(sessionId);
      // 判败即解除静默 watchdog（滑动语义下 pending 在事件后仍挂着，不清会残留 timer/durable 行）。
      this.clearPendingWatchdogBySession(sessionId);
      // stop-first：best-effort 中止 worker 侧 stuck 执行，释放槽位并防止迟到完成
      // 事件写入已失败会话；中止失败只记 warn，永不阻断后续恢复链。
      if (abortRef && abortInstanceRef) {
        await this.abortStuckWorkerSession(
          abortRef,
          abortInstanceRef,
          sessionId,
        );
      }
      // Todo10 团队化：键/广播统一走团队 scope（任务仅归因透传给自动恢复门）。
      const teamId = row.teamId ?? null;
      const teamMemberId = row.teamMemberId ?? null;
      const agentId = row.agentId ?? '';
      if (!teamId || !teamMemberId || !agentId) return;
      const scope = toExecutionScope(null, teamId);
      const taskId = row.taskId ?? null;
      if (forensicsError && isQuotaError(forensicsType)) {
        const quotaMsg = `agent 额度不足已暂停（${forensicsError}），请补充额度或更换模型后重试`;
        this.logger.error(`session ${sessionId} ${quotaMsg}`);
        this.emitError({ taskId: scope, agentId, error: quotaMsg });
        void this.broadcastAgentError({
          taskId: scope,
          agentId,
          sessionId,
          level: 'message',
          errorType: 'quota_exceeded',
          message: quotaMsg,
        });
        return;
      }
      if (forensicsError) {
        const transientMsg = `agent 意外中断（${forensicsError}），已自动重试`;
        this.logger.warn(`session ${sessionId} ${transientMsg}，尝试自动拉起`);
        this.emitError({ taskId: scope, agentId, error: transientMsg });
        void this.broadcastAgentError({
          taskId: scope,
          agentId,
          sessionId,
          level: 'retry',
          errorType: forensicsType,
          message: transientMsg,
        });
        void this.tryAutoRestart(teamId, teamMemberId, taskId).catch((e) =>
          this.logger.error(`自动拉起失败: ${this.describeError(e)}`),
        );
        return;
      }
      const idleMsg = `agent 长时间无活动（超过 ${this.agentIdleTimeoutMs / 60000}min），已判死`;
      this.logger.error(`session ${sessionId} ${idleMsg}`);
      this.emitError({ taskId: scope, agentId, error: idleMsg });
      void this.broadcastAgentError({
        taskId: scope,
        agentId,
        sessionId,
        level: 'retry',
        errorType: 'agent_idle_timeout',
        message: idleMsg,
      });
      void this.tryAutoRestart(teamId, teamMemberId, taskId).catch((e) =>
        this.logger.error(`自动拉起失败: ${this.describeError(e)}`),
      );
    } catch (err) {
      this.logger.error(
        `session ${sessionId} 空闲判死失败: ${this.describeError(err)}`,
      );
    }
  }

  /**
   * stop-first：空闲判死后 best-effort 中止 worker 侧 stuck 会话。
   * 失败只记 warn、永不抛错，调用方恢复链（失败标记/广播/自动拉起）照常继续。
   */
  private async abortStuckWorkerSession(
    workerRef: WorkerEndpointRef,
    instanceRef: string,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.workerClient.abort(workerRef, instanceRef);
    } catch (err) {
      this.logger.warn(
        `session ${sessionId} 中止 worker 会话 ${instanceRef} 失败，按已失败继续恢复: ${this.describeError(err)}`,
      );
    }
  }

  /**
   * 自动拉起（Todo10 团队化）：频道经 resolveTeamChannel 团队定位，目标为成员
   * tmm_ 直调 dispatchAgentMention；任务仅归因（进度门 + prompt 上下文）。
   *
   * 恢复门槛（2026-09-23 放宽，与 dispatchAgentMention 对 wake 的终态门禁同口径）：
   * - **只挡终态**（completed/archived）——非终态一律允许恢复。原 `!== 'in_progress'`
   *   会把 pending_review 这类「任务尚未结束」的卡死会话挡在自动恢复之外；
   * - **taskId 可缺省**（纯团队直聊）——dispatchAgentMention 支持团队维度直传，且唤醒
   *   文本（buildWakeText）/快照键（dispatchSnapshotKey）/频道定位（resolveTeamChannel）
   *   都只依赖 teamId+teamMemberId，不需要任务上下文；
   * - 未知 channel → 跳过不抛错（dispatch 必须有落点）。
   *
   * is_7：唤醒文本优先重放原始分派快照（有快照 → 通用语 +【原始任务重放】段；
   * 无/过期快照 → 通用语回退，字节与引入前一致）。
   */
  private async tryAutoRestart(
    teamId: string,
    teamMemberId: string,
    taskId: string | null,
  ): Promise<void> {
    if (taskId) {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { status: true },
      });
      if (!task) return;
      if (task.status === 'completed' || task.status === 'archived') return;
    }
    const channel = await this.resolveTeamChannel(teamId, teamMemberId);
    if (!channel) return;
    await this.dispatchAgentMention({
      taskId: taskId ?? null,
      teamId,
      channelId: channel.id,
      text: this.buildWakeText(teamId, teamMemberId),
      targetInstanceId: teamMemberId,
      kind: 'wake',
    });
  }

  /**
   * is_7 快照存取（与 pending 同内存语义）：
   * save（dispatch 202 受理后）→ peek（恢复重放，只读不消费）→ clear（首字活动/
   * 完成落库后，防重放循环）。wake 重放文本自身永不覆盖快照（以通用语开头即跳过）。
   */
  private saveDispatchSnapshot(snap: DispatchSnapshot): void {
    if (!snap.teamId || !snap.teamMemberId || !snap.text) {
      return;
    }
    if (snap.text.startsWith(FALLBACK_WAKE_TEXT)) {
      return;
    }
    const key = dispatchSnapshotKey(snap.teamId, snap.teamMemberId);
    this.dispatchSnapshots.set(key, { ...snap, createdAt: Date.now() });
  }

  private peekDispatchSnapshot(
    teamId: string,
    teamMemberId: string,
  ): DispatchSnapshot | undefined {
    const key = dispatchSnapshotKey(teamId, teamMemberId);
    const snap = this.dispatchSnapshots.get(key);
    if (!snap) {
      return undefined;
    }
    if (Date.now() - snap.createdAt > DISPATCH_SNAPSHOT_TTL_MS) {
      this.dispatchSnapshots.delete(key);
      return undefined;
    }
    return snap;
  }

  private clearDispatchSnapshot(teamId: string, teamMemberId: string): void {
    this.dispatchSnapshots.delete(dispatchSnapshotKey(teamId, teamMemberId));
  }

  private clearDispatchSnapshotBySession(sessionId: string): void {
    const key = this.snapshotSessionIndex.get(sessionId);
    if (key !== undefined) {
      this.dispatchSnapshots.delete(key);
      this.snapshotSessionIndex.delete(sessionId);
    }
  }

  private buildWakeText(teamId: string, teamMemberId: string): string {
    const snap = this.peekDispatchSnapshot(teamId, teamMemberId);
    if (!snap) {
      return FALLBACK_WAKE_TEXT;
    }
    return `${FALLBACK_WAKE_TEXT}，继续执行以下原始任务：\n\n【原始任务重放】${snap.text}`;
  }

  // ------------------------------------------------------------------
  // F3 辅助（增量 poll / 工作目录）
  // ------------------------------------------------------------------

  /** F3 MAJOR-1：消息列表中 cursor（消息 id）之后的子集；cursor 为空 → 全量；
   *  cursor 不在列表（游标丢失/会话重建异常）→ 全量（正常流程不出现，防漏检）。 */
  private messagesAfter(messages: unknown[], cursor: string | null): unknown[] {
    if (!cursor) {
      return messages;
    }
    const idx = (messages as PollMessageShape[]).findIndex(
      (m) => m.info?.id === cursor,
    );
    if (idx < 0) {
      return messages;
    }
    return messages.slice(idx + 1);
  }

  /** F3 MAJOR-1：消息列表最后一条带 id 的消息 id（增量 poll 游标记录用）；无 id → null。 */
  private lastMessageId(messages: unknown[]): string | null {
    const list = messages as PollMessageShape[];
    for (let i = list.length - 1; i >= 0; i--) {
      const id = list[i].info?.id;
      if (id) {
        return id;
      }
    }
    return null;
  }

  /**
   * F3 MAJOR-1 残留修复：兜底基线消息 id——最后一条**非空 assistant 占位**消息 id。
   * promptAsync 后 serve 为本次回复创建 assistant 占位消息（parts=[]，未填充）；若基线
   * 取到它 → messagesAfter(cursor) 永空 → 永不命中 step-finish（m_37 超时根因）。兜底
   * 路径（前置基线失败后首轮自取）跳过占位，基线落在本次 user prompt（或更早）上；
   * 无消息/全为占位 → null（messagesAfter(null) 返回全部）。
   */
  private baselineId(messages: unknown[]): string | null {
    const list = messages as PollMessageShape[];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      const id = m.info?.id;
      if (!id) {
        continue;
      }
      if (m.info?.role === 'assistant' && (m.parts ?? []).length === 0) {
        continue;
      }
      return id;
    }
    return null;
  }

  /** F3 MINOR-3：消息列表是否含 assistant 非 synthetic text part（首字出现判定）。 */
  private hasTextPart(messages: unknown[]): boolean {
    return (messages as PollMessageShape[]).some(
      (m) =>
        m.info?.role === 'assistant' &&
        (m.parts ?? []).some((p) => p.type === 'text' && !p.synthetic),
    );
  }

  /** F3 MINOR-3：任务级工作目录（<根>/tasks/<taskId>），mkdir -p 保证存在后返回。 */
  private async ensureTaskWorkDir(taskId: string): Promise<string> {
    const dir = taskDirOf(this.taskWorkDirRoot, taskId);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      this.logger.warn(
        `任务工作目录创建失败 dir=${dir}（best-effort，仍返回路径）: ${(err as Error)?.message ?? err}`,
      );
    }
    return dir;
  }

  /** team-mode 团队工作目录（<根>/teams/<teamId>），mkdir -p 保证存在后返回（同 ensureTaskWorkDir 风格）。 */
  private async ensureTeamWorkDir(teamId: string): Promise<string> {
    const dir = path.join(this.taskWorkDirRoot, 'teams', teamId);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      this.logger.warn(
        `team-mode 工作目录创建失败 dir=${dir}（best-effort，仍返回路径）: ${(err as Error)?.message ?? err}`,
      );
    }
    return dir;
  }

  /**
   * 执行工作目录（任务隔离保留）：taskId 非空 → <根>/tasks/<taskId>（同任务
   * 多成员共享任务目录，随任务 FIFO 流转）；taskId 为空 → <根>/teams/<teamId>
   * （团队直聊回退）。mkdir -p 保证存在后返回。
   */
  private async resolveAgentWorkDir(
    taskId: string,
    teamId?: string | null,
  ): Promise<string> {
    if (!taskId) {
      return this.ensureTeamWorkDir(teamId ?? '');
    }
    return this.ensureTaskWorkDir(taskId);
  }

  /** 可进执行上下文的图片扩展名（对齐 web IMAGE_EXTS + uploads 白名单交集；非图片行为不变）。 */
  private static readonly IMAGE_ATTACHMENT_EXTS: ReadonlySet<string> = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
  ]);

  private static readonly IMAGE_ATTACHMENT_MIME: Readonly<
    Record<string, string>
  > = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
  };

  /**
   * 触发消息的图片附件 → 执行附件引用（问题二：用户发的图进执行上下文）。
   * 仅 /uploads/ 落盘 + 图片扩展名才携带；其余（无附件/非图片/查询失败）返回 null，
   * 调用方保持纯文本分派，行为与此前一致。
   */
  private async resolveImageAttachments(
    messageId: string,
  ): Promise<{ attachments: ExecuteAttachment[]; pointer: string } | null> {
    try {
      const row = await this.prisma.message.findUnique({
        where: { id: messageId },
        select: {
          attachmentUrl: true,
          attachmentName: true,
          attachmentType: true,
        },
      });
      const url = row?.attachmentUrl ?? null;
      if (!url || !url.startsWith('/uploads/')) return null;
      const ext = (row?.attachmentType ?? '').toLowerCase();
      if (!WorkerDispatcher.IMAGE_ATTACHMENT_EXTS.has(ext)) return null;
      const filename =
        row?.attachmentName?.trim() || url.split('/').pop() || 'image';
      return {
        attachments: [
          {
            url,
            mime: WorkerDispatcher.IMAGE_ATTACHMENT_MIME[ext],
            filename,
          },
        ],
        pointer: `【附件图片】用户附了一张图片（${filename}），已放入本次执行的上下文，请查看图片内容后再作答。`,
      };
    } catch (err) {
      this.logger.warn(
        `触发消息 ${messageId} 附件查询失败，按纯文本分派: ${this.describeError(err)}`,
      );
      return null;
    }
  }

  private clearPendingWatchdog(scope: string, agentId: string): void {
    const existing = this.pending.get(`${scope}:${agentId}`);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(`${scope}:${agentId}`);
      this.pendingBySession.delete(existing.sessionId);
      this.silentWakeAttempts.delete(existing.sessionId);
      // 终态（或本轮结束）：durable deadline 同步取消，防到期误收割。
      void this.cancelSilenceTrigger(existing.triggerDedupKey);
    }
  }

  /** 按平台 sessionId 清除静默 watchdog（终态事件/清除路径，taskId/agentId 未知）。 */
  private clearPendingWatchdogBySession(sessionId: string): void {
    this.silentWakeAttempts.delete(sessionId);
    const key = this.pendingBySession.get(sessionId);
    if (!key) {
      return;
    }
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(key);
      void this.cancelSilenceTrigger(existing.triggerDedupKey);
    }
    this.pendingBySession.delete(sessionId);
  }

  /** 广播 agent.error（FR-21，scope=task；team-mode 传 teamId 走 team scope，task-mode 不变）；广播异常吞掉不阻断主流程。 */
  private async broadcastAgentError(event: {
    taskId: string;
    agentId: string;
    sessionId?: string | null;
    level?: 'tool' | 'message' | 'retry';
    errorType?: string;
    retryInfo?: unknown;
    message?: string;
    teamId?: string;
  }): Promise<void> {
    try {
      await this.realtime.broadcast(
        EVENT_TYPES.AGENT_ERROR,
        {
          taskId: event.taskId,
          agentId: event.agentId,
          sessionId: event.sessionId ?? null,
          level: event.level ?? 'message',
          errorType: event.errorType ?? 'dispatch_failed',
          ...(event.retryInfo !== undefined
            ? { retryInfo: event.retryInfo }
            : {}),
          ...(event.message !== undefined ? { message: event.message } : {}),
        },
        event.teamId
          ? ({ type: 'team', id: event.teamId } as any)
          : { type: 'task', id: event.taskId },
      );
    } catch (err) {
      this.logger.error(`agent.error 广播失败: ${this.describeError(err)}`);
    }
  }

  /** 错误归一：WorkerUnavailableException 已带 workerId，直接透传 message。 */
  private describeError(err: unknown): string {
    if (err instanceof WorkerUnavailableException) {
      return err.message;
    }
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }

  /** 消息 DTO（09 篇 §2.4）：content/mentions 透传 Json；createdAt ISO8601（对齐 ChatService）。 */
  private toMessageDto(row: MessageRow) {
    return {
      id: row.id,
      channelId: row.channelId,
      senderType: row.senderType,
      senderId: row.senderId,
      content: row.content,
      mentions: row.mentions ?? [],
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** F2 C1：延迟（unref 防阻塞进程退出；fake timers 下可被 advanceTimersByTimeAsync 推进）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
