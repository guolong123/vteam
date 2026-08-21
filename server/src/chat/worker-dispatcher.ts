import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { validateArtifactDeclaration } from '../artifacts/artifacts.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { FileStorageService } from '../uploads/uploads.service';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
  SESSION_STATUS,
} from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WORKER_STATUS } from '../workers/workers.constants';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { WorkerClient, WorkerEndpointRef, WorkerUnavailableException } from '../workers/worker.client';
import {
  AgentStatusPayload,
  SessionActivityPayload,
  TaskCompletedPayload,
  WorkerEventIngress,
} from '../workers/worker-event.ingress';
import { AssignmentRequirement, WorkersService } from '../workers/workers.service';
import { renderPersonaSection } from '../agents/persona.constants';
import { EXECUTION_MODES } from '../plans/plan.constants';
import { DispatchRequest, DispatchResult, MessageDispatcher } from './message-dispatcher';
import { extractConclusionParts, normalizeParts } from './message-parts';
import { sanitizeWorkDirName } from '../tasks/work-dir.util';

/** 消息主键前缀：与 ChatService 共享 IdGeneratorService 的 'm' 计数（重启续号同源）。 */
const MESSAGE_ID_PREFIX = 'm';

/** 首次 bind 的 instanceRef 占位（opencode 会话尚未创建；第二次 bind 写入真实 sessionId）。 */
export const PENDING_INSTANCE_REF = 'pending';

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
 */
export const GLOBAL_SYSTEM_INSTRUCTIONS = [
  '你是 AI 协作平台的 Agent，请遵守以下平台协议：',
  '【产出物声明】你的工作产出可交付内容时，调用 vteam MCP 的 submit_artifact 工具提交：',
  '参数 {taskId: 你的任务ID, type: "text"|"doc"|"file", title: 标题, content?: 内容(text 必填), fileRef?: 文件路径(doc/file 必填)}。',
  'text 类型直接提交内容；doc/file 类型提交你写入工作目录的文件（自动拉取归档为产出物）。',
  '【群聊通知】你在群聊被 @ 时，完整处理过程（思考/工具调用）在你的私聊会话中完成，不会公开。',
  '你像真人一样自行决定是否在群里公开回应：要发布结论/进展时，调用 vteam MCP 的 group_post 工具发布。',
  '工具参数：{taskId: 你的任务ID, content: 要发布到群聊的内容, fileRef?: 产出物文件引用}。',
  'fileRef 可选：向群聊发送文件时直接传入文件路径（如 /tmp/opencode/x.txt），文件将作为群聊附件并自动归档为产出物。',
  '不调用工具发布则回复仅保留在私聊会话（不公开）。',
  '【@ 定向机制】群聊中 @ 你的消息会定向分发给你。需要定向触发/通知任务内的其他 Agent 时，' +
  '调用 vteam MCP 的 notify_agent 工具（参数 {taskId: 你的任务ID, targetInstanceId: 目标实例 id（ta_ 前缀，见 task_context 的 agentMembers）, content: 消息内容}）' +
  '——目标实例会收到你的消息并开始执行；回复时也可用 @用户名 在群聊中定向回复特定成员。',
  '【Issue 管理】任务内 issue 协作：创建 issue 调 vteam MCP 的 issue_create（参数 {taskId, selfInstanceId, title, description?, tags?, assigneeInstanceId?}）；查询 issue_list/issue_get；更新 issue_update；状态流转 issue_transition（action: start/resolve/close/reopen/reject）。产品/测试 Agent 负责创建需求或缺陷 issue 并指派（assigneeInstanceId 为目标实例 id），研发 Agent 处理指派给自己的 issue 并流转状态。issue 标签（tags）标识类型（如 需求/缺陷/优化）。',
  '【任务状态】主 Agent 可调用 vteam MCP 的 task_transition 工具（参数 {taskId, selfInstanceId, action: start/mark-pending-review/accept/reject/archive, reason?}）流转任务状态：start 开始 / mark-pending-review 提交验收 / accept 验收通过 / reject 驳回（可附 reason）/ archive 归档。仅主实例可调用 task_transition，其余成员调用将返回 403 提示（请知会主实例或由管理员在任务管理界面操作）。',
  '【持久化目录】你运行在 k8s 容器环境中，平台为每个 Agent 分配独立的持久化工作目录（默认 /data/worker/<agent名称>，可在创建任务时指定）。' +
  '仅该目录及挂载卷内的内容在容器重启后保留，其余路径（如 /tmp、仓库外任意路径）写入的文件重启后会丢失；' +
  '工作产物、git clone 的仓库、脚本、产出物文件等请写入该持久化目录，提交产出物（doc/file）时 fileRef 应指向该目录内的文件。',
  '【托管模式】若当前任务开启托管（任务设置 managedMode=on），团队成员的 question/permission 请求不再弹窗给用户，改由主 Agent 确认：收到【托管确认】消息（含 requestId、kind、问题详情）时，调用 vteam MCP 的 question_confirm 工具（参数 {taskId, selfInstanceId, requestId, kind, answers?/response?}）决策——question 传 answers（答案数组，null=拒绝）；permission 传 response（once 允许一次 / always 总是允许 / reject 拒绝）。仅主实例可调用 question_confirm。',
  '【记忆管理】任务执行中的经验与知识可通过 vteam MCP 记忆工具存取。开始任务/需要历史经验时，调用 memory_search（参数 {taskId, query?, level?, tags?, limit?≤5}）按需检索任务级、项目级与全局级记忆（返回含 description 索引，命中后再取 content 正文，可多次翻页）；任务验收完成收到总结引导时，调用 memory_save（参数 {taskId, selfInstanceId, level: "task"|"project"|"global", content, description?:30字摘要, tags?}）沉淀经验——description 由模型携带，缺省回落 content 截断，任务专属经验写 level=task，跨任务复用价值写 level=project，全局级（level=global）仅沉淀平台通用知识，勿写项目/任务专属信息。遇可用记忆索引时先用 tags 精搜，再用 query 精排，单次≤5条，摘要命中再取正文。',
].join('\n');

/**
 * P8：分派时动态构建系统提示——在 GLOBAL_SYSTEM_INSTRUCTIONS 基础上注入当前 Agent 的完整
 * 身份（id + 名称 + 角色 + 用户设置的 prompt 职责），供 MCP 工具调用的 selfInstanceId 参数
 * 填写（服务端按 session.taskAgentId 校验后精确落库 senderId/senderInstanceId，
 * 修复"@测试 触发但回复显示开发者"）。
 * GLOBAL_SYSTEM_INSTRUCTIONS 常量保持不动（其他调用方兼容），本函数仅在 dispatch 下发时
 * 拼接身份段；agent 行查询不到时由调用方降级（name/role/prompt 置 null，回退用 agentId）。
 */
export interface AgentIdentityInfo {
  id: string;
  name: string | null;
  role: string | null;
  prompt: string | null;
  /** Agent 性格 key（PERSONA_LIBRARY 预设 key；null=无性格）。运行时按此拼接【性格】段进系统提示。 */
  persona: string | null;
}

/** 团队成员信息（dispatch 时从 taskAgents→agent 提取，注入全局上下文供 agent 判断与谁协作）。
 *  T3 实例化：团队成员 = 任务实例（TaskAgent）——instanceId 为实例 id（ta_ 前缀）、
 *  alias 为实例别名（默认「<角色中文名>-<seq>」如 开发者-1）、seq 为同 agent 同任务序号；
 *  id/name/role 来自模板 agent（保留兼容）。 */
export interface TeamMemberInfo {
  /** 模板 agent id（继承 name/role/prompt/model）。 */
  id: string;
  name: string | null;
  role: string | null;
  /** 实例 id（TaskAgent.id，ta_ 前缀）——团队成员唯一身份（@/指派/主实例判定依据）。 */
  instanceId: string;
  /** 实例别名（默认「<角色中文名>-<seq>」）；缺省回退 name。 */
  alias: string | null;
  /** 同 agent 同任务内序号（服务端生成，唯一键 taskId+agentId+seq）。 */
  seq: number;
}

export interface BuildSystemInstructionsOptions {
  /** 当前 agent 是否任务主实例（session.taskAgentId === task.mainAgentInstanceId）→ true 时追加主 Agent 职责段。 */
  isMainAgent?: boolean;
  /** 任务团队成员（实例 id/别名/序号 + 模板 agent id/名称/角色）；空/缺省则不注入【团队成员】段。 */
  team?: TeamMemberInfo[];
  /** 任务主实例 id（用于团队成员段中标注主实例成员；无主实例时为 null）。 */
  mainAgentInstanceId?: string | null;
  /** 当前 agent 的实例身份（TaskAgent.id，ta_ 前缀）；缺省（存量会话未绑实例）回退 agent.id 保持兼容。 */
  selfInstanceId?: string;
  /** 当前 agent 的实例别名（默认「<角色中文名>-<seq>」）；缺省回退 agent.name。 */
  selfAlias?: string | null;
  /** 任务级独立工作目录（<WORK_DIR>/tasks/<taskId>，prompt_async directory）；注入
   *  提示词作为运行时持久化目录（k8s 只有该目录重启后保留），引导 agent 把工作文件写入。 */
  persistentWorkDir?: string;
  /** 任务执行模式（tasks.execution_mode，direct/plan；Todo 4 tc-flow 引入）。所有任务注入
   *  轻量【执行计划】能力引导（PLAN_CAPABILITY_INSTRUCTION）；executionMode=plan 时额外
   *  追加完整【计划工作流】段（PLAN_WORKFLOW_INSTRUCTION）。 */
  executionMode?: string;
  /** 可用记忆索引块（task/project/global 计数+Top tags+description 列表，已按预算截断 <400 token）；缺省不注入。 */
  memoryIndex?: string | null;
}

/**
 * 主 Agent 动态职责段（dispatch 时仅注入被选为主 Agent 的成员）：模板 prompt 不再写死
 * "主 Agent"职责（见 seed.ts），改由运行时按 Task.mainAgentId 判定后动态下发——
 * 牵头分工、协调产出衔接、群聊进度提示、必要时 @ 成员协调、可汇总验收材料。
 * 语义对齐 FR-08（推进/进度同步）、FR-11（@ 触发响应）、FR-13（成员互 @ 协调，不超 3 轮）。
 */
export const MAIN_AGENT_INSTRUCTION =
  '【主 Agent 职责】你是本任务的主 Agent（牵头人）。除角色本职外，还需承担任务组织职责：' +
  '牵头拆解工作并分派给团队成员，协调各角色产出衔接，环节切换或产出完成时主动在群聊提示进度（FR-08）；' +
  '推进受阻或需要协作时，通过 notify_agent / 群聊 @ 定向协调成员（FR-13，互 @ 不超 3 轮）；' +
  '收尾时可汇总各角色产出与验收材料，供成员验收判定（FR-11）。' +
  '任务开启托管模式时，成员的 question/permission 请求由你确认——收到【托管确认】消息时调用 question_confirm 工具决策。';

/**
 * 计划流程可用轻量引导段（dispatch 时对所有任务注入）：让模型始终知晓「计划驱动」能力——
 * 任意任务不经切换执行模式即可走计划流程（对齐 omo 哲学：工具无条件可用 + 提示引导，无需切换模式）。
 * 仅注入能力引导文案，不注入任何计划数据（按需注入哲学）。plan 模式任务再叠加
 * PLAN_WORKFLOW_INSTRUCTION 完整工作流段（轻量 + 完整两段）。
 */
export const PLAN_CAPABILITY_INSTRUCTION =
  '【执行计划】如需计划驱动，主 Agent 可调用 vteam MCP 的 plan_submit 工具产出执行计划' +
  '（六要素任务清单），经成员评审通过后按计划逐项推进（plan_task_transition 汇报进度）；' +
  '计划流程对任意任务可用，无需切换模式。若任务执行模式为 plan，按完整计划工作流执行。';

/**
 * 计划工作流完整引导段（dispatch 时注入 executionMode=plan 的任务）：任务采用「计划驱动」执行模式
 * （tc-flow）时，主 Agent 启动前须先产出执行计划并提交评审，评审通过后按计划子任务逐项推进。
 * 本段为独立常量——GLOBAL_SYSTEM_INSTRUCTIONS 静态数组保持不动（其他调用方兼容），由
 * buildSystemInstructions 在 dispatch 时按 executionMode 条件动态追加（对齐 MAIN_AGENT_INSTRUCTION /
 * persistentWorkDir 动态注入先例）。仅注入工作流引导文案，不注入任何计划数据（按需注入哲学）。
 */
export const PLAN_WORKFLOW_INSTRUCTION =
  '【计划工作流】（本任务执行模式=plan）任务启动前主 Agent 须产出执行计划：经 plan_submit 提交' +
  '（tasks 每项含 目标/边界/引用/验收/QA/提交 六要素）；计划评审由成员确认或主 Agent 指派成员' +
  '（评审者可经 plan_get 读计划、plan_review 提交结论；评审默认放行、驳回须附理由）；' +
  '评审通过后按 plan_task 逐项推进（plan_task_transition 汇报进度，状态 done/blocked）；' +
  '全部完成后主 Agent 提交验收（task_transition mark-pending-review）。' +
  '计划前如关键假设不明，先向成员确认再提交。';

/**
 * P8：分派时动态构建系统提示——在 GLOBAL_SYSTEM_INSTRUCTIONS 基础上注入当前 Agent 的完整
 * 身份（id + 名称 + 角色 + 用户设置的 prompt 职责），供 MCP 工具调用的 selfInstanceId 参数
 * 填写（服务端按 session.taskAgentId 校验后精确落库 senderId/senderInstanceId，
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
  const blocks = [
    GLOBAL_SYSTEM_INSTRUCTIONS +
      '\n' +
      `【你的身份】你是本任务的 ${selfName}（实例 id: ${selfInstanceId}，角色: ${agent.role ?? ''}）。` +
      (agent.prompt ? `\n【职责】${agent.prompt}` : '') +
      '\n调用 vteam MCP 工具时，落库类工具（group_post / notify_agent / submit_artifact）的' +
      'selfInstanceId 参数必须填写你的实例 id（ta_ 前缀，服务器按此校验归属并精确记录发送者）。',
    agent.persona ? renderPersonaSection(agent.persona) : '',
    opts?.persistentWorkDir
      ? `\n【运行时工作目录】本任务为你分配的实际持久化工作目录为：${opts.persistentWorkDir}。` +
        '工作产物、脚本、中间文件等请写入该目录（提交 doc/file 产出物时 fileRef 使用该目录下的路径）。'
      : '',
  ];
  if (opts?.isMainAgent) {
    blocks.push(MAIN_AGENT_INSTRUCTION);
  }
  blocks.push(PLAN_CAPABILITY_INSTRUCTION);
  if (opts?.executionMode === EXECUTION_MODES.plan) {
    blocks.push(PLAN_WORKFLOW_INSTRUCTION);
  }
  if (opts?.team && opts.team.length > 0) {
    const teamLines = opts.team.map(
      (m) =>
        `- ${m.alias ?? m.name ?? m.id}（实例 id: ${m.instanceId}，角色: ${m.role ?? ''}）` +
        (m.instanceId === opts.mainAgentInstanceId ? ' —— 主 Agent' : ''),
    );
    blocks.push(
      `【团队成员】本次任务的团队成员（据此判断与谁协作、@ 谁）：\n${teamLines.join('\n')}`,
    );
  }
  if (opts?.memoryIndex) {
    blocks.push(opts.memoryIndex);
  }
  return blocks.filter((b) => b.length > 0).join('\n');
}

/**
 * 群聊触发强化指令（dispatch 动态注入，仅来源为群聊频道时）：用户在群聊 @ 你 →
 * 默认应在群聊中公开回复结论（像真人被群聊点名后当众回应）。私聊触发不注入
 * （保持私密独白）。经 group_post 工具发布控制公开内容——模型通过工具发布的内容才会被群聊显示。
 */
export const GROUP_TRIGGER_INSTRUCTION =
  '【群聊回复要求】本条消息来自任务群聊，你被 @ 定向分发。请在群聊中公开回复你的结论' +
  '——调用 vteam MCP 的 group_post 工具发布到群聊（参数 {taskId, content, fileRef?}）。' +
  '群聊只会显示你通过 group_post 发布的内容，完整处理过程保留在你的私聊会话。' +
  '如需向群聊发送文件：直接调用 group_post 并携带 fileRef（{taskId, content, fileRef: "文件路径"}），文件将作为群聊附件并自动归档为产出物。';

/**
 * 分派后等待回流的默认超时（D8 总超时；F3 MINOR-3：架构师 5 轮 tool 调用实测 72s > 60s，
 * 复杂任务多轮工具调用易超时 → 默认放宽至 120s，env DISPATCH_TIMEOUT_MS 可配）。
 * 配置项默认值（实例字段 dispatchTimeoutMs 从 ConfigService 读取，缺省回落本值）。
 */
export const DISPATCH_TIMEOUT_MS = 120_000;

/**
 * 首字超时（方案 A watchdog 语义）：dispatch 调 worker 执行端点后，若 FIRST_TOKEN_TIMEOUT_MS
 * 内无任何事件回流（无 session.updated(running)/delta/task.completed/agent.status）→ 判
 * 「模型完全没响应」：emitError + agent.error 广播。只判「是否开始产出」，完成无时间上限
 * （长期任务由 worker 自行推进，完成经 task.completed 回流）。env FIRST_TOKEN_TIMEOUT_MS 可配。
 */
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 60_000;

/** 空闲判死：session 进入 running 后无任何输出活动（delta/agent.status/task.completed）超时 →
 *  判死（session 标 failed + agent.error）。env AGENT_IDLE_TIMEOUT_MS 可配。 */
export const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 30 * 60_000;

/** 空闲判死扫描周期（定期遍历 lastActivityAt，检查超时会话）。 */
export const IDLE_SCAN_INTERVAL_MS = 60_000;

/** F3 MINOR-3：任务工作目录根（env WORK_DIR，默认 /tmp/keta-worker-tasks）。
 *  任务级独立工作目录 = <根>/tasks/<taskId>（server 侧 mkdir -p 保证存在），
 *  作为 prompt_async 的 directory 传入——防模型在仓库根真实写文件污染（F4 零污染关键）。 */
export const DEFAULT_TASK_WORK_DIR = '/tmp/keta-worker-tasks';

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
export const MODEL_FAILURE_FALLBACK_MESSAGE = '模型调用失败（serve 返回 error）';

/**
 * F2 C1：step-finish(reason=stop) 完成判定（移植 worker prompt-await.ts findFinish）。
 * 只认 assistant 消息（user 消息带 step-finish 不算）+ reason===stop。
 */
export function findFinish(messages: unknown[]): PollMessageShape['parts'][number] | undefined {
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
      if (parsed && typeof parsed === 'object' && validateArtifactDeclaration(parsed).valid) {
        push(parsed);
      }
    } catch {
      // 同上：丢弃
    }
  }
  return out;
}

/** 待回流会话（watchdog 超时用）：key = `${taskId}:${agentId}`。 */
interface PendingDispatch {
  taskId: string;
  agentId: string;
  /** 执行实例 id（TaskAgent.id，ta_ 前缀）；存量会话（taskAgentId NULL）回退 agentId。 */
  instanceId: string;
  /** 平台 Session 主键（活动事件回调据此反查首字 watchdog）。 */
  sessionId: string;
  /** 执行 worker id（首字超时注销活跃执行用）。 */
  workerId: string;
  timer: ReturnType<typeof setTimeout>;
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
          return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
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
export function extractGroupPost(text: string): { content: string; fileRef?: string } | null {
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
              obj: JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>,
            });
          } catch {
            // 非合法 JSON：跳过
          }
          break;
        }
      }
    }
  }
  return found
    .sort((a, b) => a.pos - b.pos)
    .map((x) => x.obj);
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
export class WorkerDispatcher extends MessageDispatcher implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerDispatcher.name);

  /** doclib 注入上限（12 篇 §8.3 可配；公开字段便于测试覆盖）。 */
  public doclibMaxBytes: number;
  public doclibTotalBytes: number;
  /** 群聊历史注入上限（对齐 doclib 32KB 语义；公开字段便于测试覆盖）。 */
  public chatHistoryMaxBytes: number;

  /** 待回流 watchdog：`${taskId}:${agentId}` → 定时器（首字超时：默认 60s 无首个事件 emitError）。 */
  private readonly pending = new Map<string, PendingDispatch>();

  /** sessionId → watchdog key 反查（ingress 活动事件回调按 sessionId 清除首字 watchdog）。 */
  private readonly pendingBySession = new Map<string, string>();

  /** sessionId → 最近一次输出活动时间戳（空闲判死依据，ingress 活动事件刷新）。 */
  private readonly lastActivityAt = new Map<string, number>();

  /** 空闲判死扫描定时器（惰性启动：首个 dispatch 注册 watchdog 时）。 */
  private idleScanTimer: ReturnType<typeof setInterval> | null = null;

  /** F2 C1 幂等：已落库回流的会话（自持轮询与 ingress task.completed 双通道防重）。
   *  F3 MAJOR-1：新一轮 dispatch 会清除目标会话标记（跨轮回流允许），仍防同轮双写。 */
  private readonly completedSessions = new Set<string>();
  /** F2 MINOR：watchdog/轮询已超时的会话（迟到回流跳过落库，防用户同时见错误+消息）。 */
  private readonly failedSessions = new Set<string>();

  /**
   * 执行中注册表（workerId:taskId → 活跃执行集合）：dispatch 调 worker execute 前登记，
   * task.completed / agent.status error / watchdog 超时注销。platform-mcp 的落库类工具
   * （group_post / notify_agent / submit_artifact）经 assertWorkerTask 用本表校验
   * selfInstanceId 必须为当前活跃执行实例——修复多会话任务（taskId 下多个实例会话并存）
   * 时 findFirst 定位歧义导致的冒充漏洞（曾误把 a_developer 判为执行 Agent）。
   */
  private readonly activeExecutions = new Map<
    string,
    { agents: Set<string>; at: number }
  >();
  /** 执行注册 TTL（ms）：worker 崩溃/回流丢失时防活跃记录泄漏，超时视为不活跃。 */
  private readonly executionTtlMs = 30 * 60 * 1000;

  private executionKey(workerId: string, taskId: string): string {
    return `${workerId}:${taskId}`;
  }

  /**
   * dispatch 下发 execute 前登记活跃执行（防冒充校验依据）。
   * T4 实例语义：登记集合存**实例 id**（TaskAgent.id，ta_ 前缀）。instanceId 由调用方
   * 传入 `session.taskAgentId`；存量会话（taskAgentId NULL）回退 agentId 保持兼容。
   */
  registerExecution(workerId: string, taskId: string, instanceId: string): void {
    const key = this.executionKey(workerId, taskId);
    const entry = this.activeExecutions.get(key);
    if (entry) {
      entry.agents.add(instanceId);
      entry.at = Date.now();
    } else {
      this.activeExecutions.set(key, { agents: new Set([instanceId]), at: Date.now() });
    }
  }

  /**
   * task.completed / error / 超时 时注销活跃执行。ref 为实例 id（ta_ 前缀）；
   * 兼容存量 agentId 回退登记（taskAgentId NULL 会话以 agentId 登记，注销同值匹配）。
   */
  unregisterExecution(workerId: string, taskId: string, ref: string): void {
    const key = this.executionKey(workerId, taskId);
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
   * MCP assertWorkerTask 防冒充校验：返回该 worker+task 当前活跃执行实例集合。
   * 无注册记录（非 dispatch 驱动/进程重启后）→ 返回 null，调用方回退 findFirst 兼容；
   * 有记录 → 调用方必须严格校验 selfInstanceId 在集合内（防止冒充）。
   */
  isAgentExecuting(workerId: string, taskId: string): Set<string> | null {
    const key = this.executionKey(workerId, taskId);
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
  /** 首字超时 ms（env FIRST_TOKEN_TIMEOUT_MS，缺省 60s）：dispatch 后无首个事件回流 → emitError。 */
  public firstTokenTimeoutMs: number;
  /** 空闲判死 ms（env AGENT_IDLE_TIMEOUT_MS，缺省 30min）：running 后无输出活动超时 → 判死。 */
  public agentIdleTimeoutMs: number;
  /** F3 MINOR-3：任务工作目录根（env WORK_DIR，缺省 /tmp/keta-worker-tasks）。 */
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
    // 首字超时（FIRST_TOKEN_TIMEOUT_MS，缺省 60s）——只判「dispatch 后是否开始产出」
    const firstToken = config.get<number>('FIRST_TOKEN_TIMEOUT_MS');
    this.firstTokenTimeoutMs =
      typeof firstToken === 'number' && firstToken > 0
        ? firstToken
        : DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
    // 空闲判死（AGENT_IDLE_TIMEOUT_MS，缺省 30min）——running 后无输出活动超时判死
    const idleTimeout = config.get<number>('AGENT_IDLE_TIMEOUT_MS');
    this.agentIdleTimeoutMs =
      typeof idleTimeout === 'number' && idleTimeout > 0
        ? idleTimeout
        : DEFAULT_AGENT_IDLE_TIMEOUT_MS;
    // F3 MINOR-3：任务工作目录根（WORK_DIR），任务目录 = <根>/tasks/<taskId>
    const workDir = config.get<string>('WORK_DIR');
    this.taskWorkDirRoot =
      typeof workDir === 'string' && workDir.trim() ? workDir.trim() : DEFAULT_TASK_WORK_DIR;

    // T9 接线：注册回流回调（D5——落库+广播 chat.message.new+emitFinal 归本类回流处理器，
    // 防双写；agent.status 仅本地回调通知，SSE emit 由 ingress 完成）
    ingress.onTaskCompleted((payload) => {
      void this.handleTaskCompleted(payload).catch((err: unknown) =>
        this.logger.error(`task.completed 回流处理失败: ${this.describeError(err)}`),
      );
    });
    ingress.onAgentStatus((payload) => {
      void this.handleAgentStatus(payload);
    });
    // 判死 watchdog：ingress 活动事件通知（session.updated/delta/agent.status/task.completed）
    // → 清除首字 watchdog + 刷新空闲判死计时
    ingress.onSessionActivity((payload) => {
      this.handleSessionActivity(payload);
    });
  }

  onModuleDestroy(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
    }
    this.pending.clear();
    this.pendingBySession.clear();
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
   * 对每个 target 串行：定位/分配 worker → doclib 注入 → loading 两阶段 →
   * createSession/bind 真实 instanceRef → promptAsync。
   * 返回 `{replies: []}`——真实回复经 task.completed 回流（D5），不在此生成。
   * 单目标失败 emitError + 广播 agent.error，不阻塞其他目标（FR-21）。
   */
  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    for (const target of request.targets) {
      try {
        await this.dispatchForTarget(request, target);
      } catch (err) {
        const message = this.describeError(err);
        this.logger.error(
          `agent ${target.agentId} dispatch failed: ${message}`,
          (err as Error).stack,
        );
        this.emitError({
          taskId: request.taskId,
          agentId: target.agentId,
          error: message,
        });
        await this.broadcastAgentError({
          taskId: request.taskId,
          agentId: target.agentId,
          sessionId: target.sessionId,
          level: 'message',
          errorType: 'dispatch_failed',
          message,
        });
      }
    }
    return { replies: [] };
  }

  /**
   * FR-13：agent 互 @ 触发——MCP `notify_agent` 工具调用入口。
   * T3 实例语义：查目标**实例**在任务下的会话（uk_sessions_task_agent，按 taskAgentId）
   * → 构造 DispatchRequest 触发目标实例的 dispatch（agentId 从 session 行取，防同 agent
   * 多实例下会话串扰）；复用 dispatch() 全链路（assignWorker → createSession/bind →
   * execute → ingress 回流落库+广播，不复制 dispatchForTarget 逻辑）；单目标失败由
   * dispatch() 统一 emitError + 广播 agent.error。
   */
  async dispatchAgentMention(input: {
    taskId: string;
    /** 群聊频道（触发来源：目标 agent 的 group_post 回复落库+广播走此频道）。 */
    channelId: string;
    /** 消息内容（含 @目标，透传给目标 agent 作为触发 prompt）。 */
    text: string;
    /** 被 @ 的目标实例 id（TaskAgent.id，ta_ 前缀）。 */
    targetInstanceId: string;
  }): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: { taskId: input.taskId, taskAgentId: input.targetInstanceId },
      select: { id: true, agentId: true },
    });
    if (!session) {
      throw new Error(`实例 ${input.targetInstanceId} 无会话（任务 ${input.taskId}）`);
    }
    await this.dispatch({
      messageId: await this.idGen.nextId(MESSAGE_ID_PREFIX),
      channelId: input.channelId,
      taskId: input.taskId,
      text: input.text,
      targets: [{ agentId: session.agentId, instanceId: input.targetInstanceId, sessionId: session.id }],
    });
  }

  /**
   * 单目标分派时序（对齐 Phase 2 mock 分派 replyFor 时序）：
   * 1 查 Session → 已绑 worker 复用；未绑 assignWorker（无可用 → 报错不降级 D3）+
   *   首次 bind（instanceRef 占位 pending）→ 2 查 Worker 行（capabilities）→
   *   3 Agent.defaultModelId → {providerID, modelID} → 4 提示词构造（按需注入：任务
   *   ID/MCP 工具引导 + 群聊触发指令 + 当前消息，doclib/群聊历史经 vteam 工具
   *   自主拉取，不再自动注入）→
   *   5 loading(thinking) → 6 createSession（未创建时）→ bind 更新真实 instanceRef →
   *   7 execute（方案 A：调 worker 执行端点 POST /execute，202 即成功，不启动自持轮询）→
   *   8 loading(operating) + 回流超时 watchdog。
   */
  private async dispatchForTarget(
    request: DispatchRequest,
    target: { agentId: string; sessionId: string | null },
  ): Promise<void> {
    const { taskId } = request;
    if (!target.sessionId) {
      throw new Error('会话缺失：目标无 sessionId，无法分派');
    }

    // 1. 定位 Session：已绑 workerId/instanceRef → 复用同一 opencode 会话（D3 二次 @ 复用）。
    // T3 实例语义：taskAgentId = 当前实例（团队/主实例判定、身份注入依据）。
    const session = await this.prisma.session.findUnique({
      where: { id: target.sessionId },
      select: { id: true, workerId: true, instanceRef: true, taskAgentId: true },
    });
    if (!session) {
      throw new Error(`会话 ${target.sessionId} 不存在`);
    }

    // F2 M5（MAJOR）：残留 pending 绑定视为未绑定（上次分派在 createSession 前中断的
    // 兜底回滚），重新分配 worker——防绑坏 worker 后永不重分配。
    const hasStalePending = session.instanceRef === PENDING_INSTANCE_REF;
    let workerId = session.workerId;
    let opencodeSessionId =
      !hasStalePending &&
      session.instanceRef &&
      session.instanceRef !== PENDING_INSTANCE_REF
        ? session.instanceRef
        : null;

    // C7：模型解析优先级链（阶段 1，Agent→模板）。解析结果非空 → 作为 assignWorker 的
    // modelId 过滤条件；为空（Agent/模板均未配模型）→ 跳过模型过滤（回归现状），
    // 等 worker 选定后再用 worker.defaultModelId 兜底（阶段 2）。
    const agentModelId = await this.resolveAgentModelId(target.agentId);
    const assignmentReq: AssignmentRequirement = agentModelId
      ? { modelId: agentModelId }
      : {};

    if (!workerId || hasStalePending) {
      // 未绑定：调度分配 worker（D3 无可用 → 抛错，调用方报错不降级 mock）
      workerId = await this.workersService.assignWorker(assignmentReq);
      if (!workerId) {
        throw new Error('无可用 worker：请先启动 worker 节点（mock 降级需 WORKER_MOCK_FALLBACK）');
      }
      // 首次绑定（T12）：占位 instanceRef，opencode 会话创建后第二次 bind 写入真实 id
      await this.sessionLifecycle.bindSessionToWorker(
        target.sessionId,
        workerId,
        PENDING_INSTANCE_REF,
      );
    }

    // 2. Worker 行（capabilities 供 WorkerClient 解析 baseUrl/port；defaultModelId 供 C7
    // 模型解析阶段 2 兜底；顺带校验复用 worker 在线性）。
    // 修复验收 e2e 缺陷：复用已绑定 worker 不校验在线 → offline worker 被复用 → fetch failed 首字超时。
    // offline（心跳超时标记）或行缺失 → 解绑 + 重新分配；未绑定分支 assignWorker 已过滤 offline，
    // 此检查只命中"复用已绑定"场景（复用语义保留：在线 worker 直接复用，见单测回归用例）。
    let workerRow = await this.prisma.worker.findUnique({
      where: { id: workerId },
      select: { id: true, status: true, capabilities: true, defaultModelId: true },
    });
    if (!workerRow || workerRow.status === WORKER_STATUS.OFFLINE) {
      const staleWorkerId = workerId;
      this.logger.warn(
        `agent ${target.agentId} 绑定的 worker ${staleWorkerId} 不可用` +
          `${workerRow ? '（offline）' : '（不存在）'}，解绑并重新分配 worker`,
      );
      await this.sessionLifecycle.unbindSession(target.sessionId);
      workerId = await this.workersService.assignWorker(assignmentReq);
      if (!workerId) {
        throw new Error('无可用 worker：请先启动 worker 节点（mock 降级需 WORKER_MOCK_FALLBACK）');
      }
      workerRow = await this.prisma.worker.findUnique({
        where: { id: workerId },
        select: { id: true, status: true, capabilities: true, defaultModelId: true },
      });
      if (!workerRow) {
        throw new Error(`worker ${workerId} 不存在`);
      }
      opencodeSessionId = null;
      await this.sessionLifecycle.bindSessionToWorker(
        target.sessionId,
        workerId,
        PENDING_INSTANCE_REF,
      );
    }
    const worker: WorkerEndpointRef = {
      id: workerId,
      capabilities: workerRow.capabilities,
    };

    // 3. C7 模型解析（阶段 2）：最终模型 = Agent/模板解析结果 ?? 执行 worker 默认模型 ?? null。
    // `provider/model` → {providerID, modelID}；null 不指定模型（serve 默认）。
    const model = this.toModelSelection(agentModelId ?? workerRow.defaultModelId ?? null);

    // 4. 提示词构造（阶段 3 迁移：按需注入——移除 doclib/群聊历史自动注入，模型经
    // vteam MCP 工具自主拉取上下文；buildDoclibContext/buildChatHistoryContext
    // 方法保留不删，仅不再被 dispatch 调用，供回退/后续使用）
    const promptBlocks: string[] = [];
    // 动态任务上下文指令（含 taskId + MCP 工具引导）：需要群聊历史/文档库/任务信息时
    // 调用 vteam 的 chat_history / doclib / task_context 工具，发布群聊走 group_post
    promptBlocks.push(
      `【任务上下文】你的当前任务 ID：${taskId}。` +
        '需要群聊历史/文档库/任务信息时，调用 vteam 的 chat_history / doclib / task_context 工具（传 taskId）。' +
        '需要向群聊发布消息时调用 vteam 的 group_post 工具（参数 {taskId, content, fileRef?}）。',
    );
    // 群聊触发强化：来源频道是群聊 → 注入显式指令（默认公开回复到群聊，见
    // GROUP_TRIGGER_INSTRUCTION）；私聊触发不注入（保持私密独白）
    const sourceChannel = await this.prisma.chatChannel.findUnique({
      where: { id: request.channelId },
      select: { type: true },
    });
    if (sourceChannel?.type === CHANNEL_TYPE.task_group) {
      promptBlocks.push(GROUP_TRIGGER_INSTRUCTION);
    }
    promptBlocks.push(request.text);
    const prompt = promptBlocks.join('\n\n');

    // 5. loading(thinking)（对齐 Phase 2 mock 分派时序）——T6 实例语义：广播带 instanceId，
    //    同 agent 多实例各自 loading（前端按实例消费，不再按 agentId 全体 loading）
    await this.realtime.broadcast(
      EVENT_TYPES.AGENT_LOADING,
      { taskId, agentId: target.agentId, instanceId: session.taskAgentId ?? null, sessionId: target.sessionId, phase: 'thinking' },
      { type: 'task', id: taskId },
    );
    this.emitLoading({
      taskId,
      agentId: target.agentId,
      instanceId: session.taskAgentId ?? null,
      sessionId: target.sessionId,
      phase: 'thinking',
    });

    // 6. 创建 opencode 会话（未创建/占位时）→ 第二次 bind 写入真实 instanceRef
    if (!opencodeSessionId) {
      try {
        const created = await this.workerClient.createSession(worker, model);
        opencodeSessionId = created.sessionID;
        await this.sessionLifecycle.bindSessionToWorker(
          target.sessionId,
          workerId,
          opencodeSessionId,
        );
      } catch (err) {
        // F2 M5（MAJOR）：分派失败回滚绑定——Session 恢复 created + workerId/instanceRef
        // 清空 + TaskGroupInstance 软移除，下次 @ 重新分配 worker（防绑坏 worker 永不重分配）。
        await this.sessionLifecycle
          .unbindSession(target.sessionId)
          .catch((rbErr: unknown) =>
            this.logger.error(`回滚绑定失败: ${this.describeError(rbErr)}`),
          );
        throw err;
      }
    }

    // 7. 下发执行（方案 A：fire-and-forget 调 worker 执行端点 POST /execute，202 accepted
    // 即成功——worker 异步驱动 serve 并上送事件；回复经 ingress task.completed 回流
    // （handleTaskCompleted 落库+广播+emitFinal），server 不再自持轮询。
    // 自持轮询 pollForCompletion 方案 A 后不再调用（代码保留作兜底/测试，见方法注释）。
    // is_0000000010：工作目录解析链（worker 持久化目录 = 每 agent 独立工作区）——
    // 1. 实例 task_agents.work_dir（创建任务可指定，优先）
    // 2. 缺省 /data/worker/<sanitize(agent.name)>-<seq>（与 tasks.service 同根，防分叉）
    // 3. 任务级 <WORK_DIR>/tasks/<taskId> 兜底（兼容存量，见 resolveAgentWorkDir）
    // 目录创建下沉两处兜底：server mkdir -p + worker 执行端点 mkdir（文件系统可能不共享）。
    const taskWorkDir = await this.resolveAgentWorkDir(taskId, session, target);
    const agentRow = await this.prisma.agent.findUnique({
      where: { id: target.agentId },
      select: { id: true, name: true, role: true, prompt: true, persona: true },
    });
    const agentIdentity: AgentIdentityInfo = {
      id: target.agentId,
      name: agentRow?.name ?? null,
      role: agentRow?.role ?? null,
      prompt: agentRow?.prompt ?? null,
      persona: agentRow?.persona ?? null,
    };
    // 主 Agent 动态注入 + 团队成员注入（system 通道，不进入聊天记录）：一次轻量 task
    // 查询取 mainAgentInstanceId + 团队成员实例（id/alias/seq/removedAt→agent id/名称/角色）。
    // 模板 prompt 不写死"主 Agent"职责，由运行时按 mainAgentInstanceId 判定动态下发；
    // 团队信息直接进全局上下文，agent 无需再经 task_context MCP 工具拉取即可了解与谁协作。
    // hot path 只 select 必要字段（TASK_AGENTS_INCLUDE 形状对齐 tasks.service）。
    const taskRow = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        projectId: true,
        mainAgentInstanceId: true,
        executionMode: true,
        taskAgents: {
          include: {
            agent: { select: { id: true, name: true, role: true } },
          },
        },
      },
    });
    // T3 实例语义：当前实例 = session.taskAgentId（可能 NULL——存量会话未绑实例，降级
    // agent 语义：isMainAgent=false、selfInstanceId 回退 agent.id、selfAlias 回退 name）。
    const selfInstanceId = session.taskAgentId ?? undefined;
    const team: TeamMemberInfo[] = (taskRow?.taskAgents ?? [])
      .filter((ta) => !ta.removedAt)
      .map((ta) => ({
        id: ta.agent.id,
        name: ta.agent.name,
        role: ta.agent.role,
        instanceId: ta.id,
        alias: ta.alias,
        seq: ta.seq,
      }));
    const isMainAgent =
      session.taskAgentId != null &&
      session.taskAgentId === taskRow?.mainAgentInstanceId;
    const selfAlias = selfInstanceId
      ? (team.find((m) => m.instanceId === selfInstanceId)?.alias ?? null)
      : null;
    // 登记活跃执行（platform-mcp assertWorkerTask 防冒充校验依据）；completed/error 注销。
    // T4 实例语义：登记**实例 id**（session.taskAgentId）；存量会话（taskAgentId NULL）
    // 回退 agentId 保持兼容（防旧会话防冒充失效）。
    this.registerExecution(workerId, taskId, session.taskAgentId ?? target.agentId);
    // 私聊 SSE 不刷新修复：上一轮失败残留的 processing 消息若被 task.completed 复用，
    // 本轮回复会写入旧消息（createdAt 保留上轮时间）→ 前端按 createdAt 排序后新回复被
    // 排到历史中间，私聊页底部不刷新。新一轮 dispatch 前清理目标频道残留 processing。
    const cleanupChannel = await this.resolveChannel(
      taskId,
      target.agentId,
      session.taskAgentId ?? undefined,
    );
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
    let memoryIndex: string | null = null;
    try {
      const projectId = (taskRow as any)?.projectId as string | undefined;
      const countWhere = (level: string, tid?: string | null, pid?: string | null) => {
        if (level === 'task') return { level, taskId: tid, deletedAt: null };
        if (level === 'project') return { level, projectId: pid, deletedAt: null };
        return { level, deletedAt: null };
      };
      const [taskCnt, projCnt, globCnt, recent] = await Promise.all([
        this.prisma.memory.count({ where: countWhere('task', taskId, projectId) } as any),
        projectId ? this.prisma.memory.count({ where: countWhere('project', null, projectId) } as any) : Promise.resolve(0),
        this.prisma.memory.count({ where: countWhere('global', null, null) } as any),
        this.prisma.memory.findMany({
          where: {
            deletedAt: null,
            OR: [{ level: 'task', taskId }, ...(projectId ? [{ level: 'project', projectId }] : []), { level: 'global' }],
          } as any,
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, level: true, description: true, content: true, tags: true },
        } as any),
      ]);
      const tagMap = new Map<string, number>();
      for (const r of recent as any[]) {
        const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
        for (const t of tags) tagMap.set(t, (tagMap.get(t) ?? 0) + 1);
      }
      const topTags = [...tagMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k);
      const lines = (recent as any[]).map((r) => `- [${r.level}] ${r.description || String(r.content).slice(0, 60)} (tags:${Array.isArray(r.tags) ? (r.tags as string[]).join(',') : '-'})`);
      if (taskCnt + projCnt + globCnt > 0) {
        memoryIndex =
          `【可用记忆索引 本任务可见 task:${taskCnt} project:${projCnt} global:${globCnt}${topTags.length ? ` Top tags:${topTags.join(',')}` : ''}】\n` +
          (lines.length ? lines.join('\n') + '\n按需 memory_search({taskId, level/tags/query, limit≤5}) 拉正文，摘要命中再取 content。' : '暂无记忆正文。');
        if (memoryIndex.length > 1200) memoryIndex = memoryIndex.slice(0, 1200);
      }
    } catch {}
    await this.workerClient.execute(worker, {
      prompt: [{ type: 'text', text: prompt }],
      model,
      directory: taskWorkDir,
      taskId,
      agentId: target.agentId,
      channelId: request.channelId,
      sessionId: opencodeSessionId,
      system: buildSystemInstructions(agentIdentity, {
        isMainAgent,
        mainAgentInstanceId: taskRow?.mainAgentInstanceId ?? null,
        team,
        selfInstanceId,
        selfAlias,
        persistentWorkDir: taskWorkDir,
        executionMode: taskRow?.executionMode,
        memoryIndex,
      }),
    });

    // F3 MAJOR-1：新一轮 dispatch 重置该会话的幂等/失败标记——复用同一 sessionId 时，
    // 上一轮已落库（completedSessions）或超时（failedSessions）的标记会阻塞本轮回复
    // 回流（静默失败，F3 QA 实测）。重置后本轮回复可重新落库；completedSessions 仍
    // 防同一轮 ingress 双通道双写（方案 A 后唯一回流通道，防护不破坏）。
    this.completedSessions.delete(target.sessionId);
    this.failedSessions.delete(target.sessionId);

    // 8. loading(operating)（工具执行阶段，FR-20）→ 回流超时 watchdog
    await this.realtime.broadcast(
      EVENT_TYPES.AGENT_LOADING,
      { taskId, agentId: target.agentId, instanceId: session.taskAgentId ?? null, sessionId: target.sessionId, phase: 'operating' },
      { type: 'task', id: taskId },
    );
    this.emitLoading({
      taskId,
      agentId: target.agentId,
      instanceId: session.taskAgentId ?? null,
      sessionId: target.sessionId,
      phase: 'operating',
    });
    this.startPendingWatchdog(
      taskId,
      target.agentId,
      target.sessionId,
      workerId,
      session.taskAgentId ?? target.agentId,
    );
  }

  // ------------------------------------------------------------------
  // 回流处理（D5：落库 + 广播 + emitFinal 归本类，防双写）
  // ------------------------------------------------------------------

  /**
   * task.completed 回流处理（T9 ingress onTaskCompleted 回调触发；单测直接调用断言）：
   * 1 定位发件 Agent（payload.agentId 缺失 → sessionId 反查）→ 2 定位频道（私聊 →
   * 群聊回退）→ 3 落库 message（senderType=agent）→ 4 广播 chat.message.new + emitFinal
   * → 5 产出物归档（artifacts 声明 → ArtifactsService.append，12 篇 §5）。
   */
  async handleTaskCompleted(payload: TaskCompletedPayload): Promise<void> {
    const { taskId, sessionId, channelId } = payload;
    if (!taskId) {
      this.logger.error(`task.completed 缺少 taskId，无法处理：${JSON.stringify(payload)}`);
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
    }
    let agentId = payload.agentId;
    // T4 实例语义：注销需定位实例 id——反查 session 取 taskAgentId（存量 NULL 回退 agentId）
    let executionRef: string | undefined;
    // F3 P1 修复：终态回复落库按实例精确匹配——session.taskAgentId（NULL 回退 agentId）
    let sessionTaskAgentId: string | undefined;
    if (sessionId) {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { agentId: true, taskAgentId: true },
      });
      agentId = agentId ?? session?.agentId;
      executionRef = session?.taskAgentId ?? session?.agentId;
      sessionTaskAgentId = session?.taskAgentId ?? undefined;
    }
    if (!agentId) {
      this.logger.error(
        `task.completed 缺少 agentId/sessionId，无法定位发件人：${JSON.stringify(payload)}`,
      );
      return;
    }
    // 活跃执行注销（该实例已完成，MCP 落库类工具不再允许以它身份调用）
    if (typeof payload.workerId === 'string' && payload.workerId) {
      this.unregisterExecution(payload.workerId, taskId, executionRef ?? agentId);
    }
    this.clearPendingWatchdog(taskId, agentId);
    const text = payload.text ?? '';
    // 群聊通知声明 + 私聊独白展示文本（函数级作用域：try 块内赋值，产出物归档后统一转发）
    let groupPost: ReturnType<typeof extractGroupPost> = null;
    let displayText = text;
    let finalParts: Array<Record<string, unknown>> = [];

    // 2~4. 落库 + 广播 + emitFinal（频道缺失时跳过落库，产出物仍归档）
    // 架构：agent 最终回复落 private 会话频道（内心独白结尾）；群聊触发的处理额外
    // 转发最终结果到群聊（对外消息，见 forwardToGroup）。resolveChannel 固定 private 优先。
    const channel = await this.resolveChannel(taskId, agentId, sessionTaskAgentId);
    // 群聊回复只经 MCP group_post 工具直发：正文独白仅落 private 会话频道（内心独白）。
    // 任务未创建该 agent private 频道（resolveChannel 回退群聊）时跳过正文落库——群聊
    // 只展示 ACK + 工具直发内容，不再把私聊正文兜底写进群聊（曾致群聊每人 3 条：
    // ACK / 终态化正文 / 工具直发）。
    const groupFallback = channel?.type === CHANNEL_TYPE.task_group;
    if (channel && !groupFallback) {
      try {
        // 终态化（任务 3 定稿）：delta 流式期间创建的 processing 消息 → 更新为 sent +
        // 内容最终化，避免双消息（收到确认 + 流式内容两处落库）；无 processing 消息
        // （无 delta 直接完成）→ 走现有 create 落库路径保持兼容。
        // F3 缺陷①：终态化路径与 delta 路径行为必须一致——task_group 只保留结论性
        // text part（reasoning/tool 剔除，防群聊渲染折叠卡片）；private 全量保留
        // （前端折叠展示 reasoning）。
        const rawParts = Array.isArray(payload.parts) ? payload.parts : [];
        finalParts =
          channel.type === CHANNEL_TYPE.private
            ? normalizeParts(rawParts)
            : extractConclusionParts(rawParts);
        // 群聊通知（agent 自主决策，像真人判断是否在群里公开回应）：回复含 group_post
        // 声明 → 仅声明内容转发群聊（对外消息）；无声明 → 不公开，回复留在私聊独白。
        // 私聊独白落库文本移除协议标签（stripGroupPostDeclarations），不显示 JSON/标签。
        groupPost = extractGroupPost(text);
        displayText = groupPost !== null ? stripGroupPostDeclarations(text) : text;
        const finalContent = {
          text: displayText,
          parts: finalParts,
        } as Prisma.InputJsonValue;
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
              data: { content: finalContent, status: MESSAGE_STATUS.sent },
            })
          : await this.prisma.message.create({
              data: {
                id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
                channelId: channel.id,
                senderType: SENDER_TYPE.agent,
                senderId: agentId,
                senderInstanceId: executionRef ?? null,
                content: finalContent,
                mentions: null,
                status: MESSAGE_STATUS.sent,
              },
            });
        if (processingRow) {
          this.logger.log(
            `agent ${agentId} 流式消息终态化 message=${processingRow.id} → sent`,
          );
        }
        // F2 C1：落库成功即标记已完成（ingress/轮询双通道后续到达直接跳过，防重复落库）
        if (sessionId) {
          this.completedSessions.add(sessionId);
        }
        await this.realtime.broadcast(
          EVENT_TYPES.CHAT_MESSAGE_NEW,
          { message: this.toMessageDto(message) },
          { type: 'channel', id: channel.id },
        );
        this.emitFinal({
          taskId,
          agentId,
          messageId: message.id,
          text: displayText,
        });
        // 群聊转发（对外消息）延后到产出物归档后执行（forwardGroupPost）——
        // 需要归档收集的 fileRef→落盘 URL 映射来挂附件
      } catch (err) {
        this.logger.error(
          `agent ${agentId} 回复落库失败: ${this.describeError(err)}`,
          (err as Error).stack,
        );
        this.emitError({
          taskId,
          agentId,
          error: `回复落库失败: ${this.describeError(err)}`,
        });
      }
    } else if (channel) {
      // 群聊回退（无该 agent private 频道）：正文独白不落群聊——结论内容由 MCP
      // group_post 工具直发落库。此处仅完成幂等标记 + emitFinal（前端 loading 收尾）。
      if (sessionId) {
        this.completedSessions.add(sessionId);
      }
      this.emitFinal({ taskId, agentId, messageId: '', text });
    } else {
      this.logger.error(
        `task.completed 无法定位频道（taskId=${taskId} agentId=${agentId}），跳过回复落库`,
      );
      this.emitError({
        taskId,
        agentId,
        error: '回复回流失败：无法定位目标频道',
      });
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
          ...(art.fileRef !== undefined ? { fileRef: String(art.fileRef) } : {}),
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
            const fileUrl = String((result.artifact as Record<string, unknown>).fileUrl);
            archivedFileUrls.set(art.fileRef, {
              url: fileUrl,
              name:
                fileUrl.split(/[\\/]/).pop() ??
                String((result.artifact as Record<string, unknown>).title ?? '附件'),
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
    void groupPost;
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
   * agent.status 回流处理（T9 ingress onAgentStatus 回调触发）：
   * 仅做 emitLoading/emitError 本地回调通知（对齐 MessageDispatcher 订阅契约，供
   * ChatService onLoading/onError 日志）；SSE 的 agent.loading/agent.error emit 已由
   * T9 ingress 完成（worker-event.ingress.ts handleAgentStatus），此处不重复广播防双写。
   * P4：错误分支额外落库 failed 消息（processing → failed + 错误内容广播）——
   * 修复首字超时/模型错误后消息永久卡 processing、用户无失败反馈的问题。
   */
  async handleAgentStatus(payload: AgentStatusPayload): Promise<void> {
    const { taskId, agentId, sessionId } = payload;
    if (!taskId || !agentId) {
      return;
    }
    const isError =
      payload.status === 'error' ||
      (typeof payload.error === 'string' && payload.error.length > 0);
    if (isError) {
      if (sessionId) {
        this.failedSessions.add(sessionId);
      }
      if (typeof payload.workerId === 'string' && payload.workerId) {
        // T4 实例语义：注销按实例 id（sessionId 反查 taskAgentId；存量 NULL 回退 agentId）
        let executionRef: string = agentId;
        if (sessionId) {
          const session = await this.prisma.session.findUnique({
            where: { id: sessionId },
            select: { taskAgentId: true },
          });
          executionRef = session?.taskAgentId ?? agentId;
        }
        this.unregisterExecution(payload.workerId, taskId, executionRef);
      }
      await this.failProcessingMessage(payload);
      this.emitError({
        taskId,
        agentId,
        error: payload.error ?? 'agent 处理失败',
      });
    } else {
      this.emitLoading({
        taskId,
        agentId,
        sessionId: sessionId ?? null,
        phase: payload.phase === 'thinking' ? 'thinking' : 'operating',
      });
    }
  }

  /** P4：agent 失败回流 → 频道内该 agent 最新 processing 消息标记 failed + 错误内容广播
   *  （无 processing 消息则新建 failed 消息），用户可见失败提示。落库/广播失败仅记日志。 */
  private async failProcessingMessage(payload: AgentStatusPayload): Promise<void> {
    const { taskId, agentId } = payload;
    if (!taskId || !agentId) {
      return;
    }
    try {
      const errorText = payload.error?.trim() || 'agent 处理失败';
      // F3 P1 修复：失败消息落库按实例精确匹配——sessionId 反查 taskAgentId
      // （存量 NULL 回退 agentId 首实例；无需反查时 resolveChannel 内部兼容）。
      let failTaskAgentId: string | undefined;
      if (payload.sessionId) {
        const session = await this.prisma.session.findUnique({
          where: { id: payload.sessionId },
          select: { taskAgentId: true },
        });
        failTaskAgentId = session?.taskAgentId ?? undefined;
      }
      const channel = await this.resolveChannel(taskId, agentId, failTaskAgentId);
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
            data: { content, status: MESSAGE_STATUS.failed },
          })
        : await this.prisma.message.create({
            data: {
              id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
              channelId: channel.id,
              senderType: SENDER_TYPE.agent,
              senderId: agentId,
              content,
              mentions: null,
              status: MESSAGE_STATUS.failed,
            },
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
     * preferredChannelId 交 resolveChannel 群聊优先（用户实际触发的路径）。
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
          params.startedAt !== undefined ? firstTextAt - params.startedAt : null;
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
        this.emitError({ taskId: params.taskId, agentId: params.agentId, error: message });
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
    params: { taskId: string; agentId: string; sessionId: string; channelId?: string },
    messages: unknown[],
  ): Promise<void> {
    if (this.failedSessions.has(params.sessionId)) {
      this.logger.warn(`session ${params.sessionId} 已超时失败，迟到的轮询回流跳过落库`);
      return;
    }
    if (this.completedSessions.has(params.sessionId)) {
      this.logger.debug(`session ${params.sessionId} 已由 ingress 回流落库，跳过轮询回流`);
      return;
    }
    const finish = findFinish(messages);
    const text = aggregateText(messages);
    await this.handleTaskCompleted({
      taskId: params.taskId,
      agentId: params.agentId,
      sessionId: params.sessionId,
      // F4 回流频道透传：消息来源频道随 payload 交 handleTaskCompleted → resolveChannel
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
        OR: artifacts.map((a) => ({ artifactId: a.id, version: a.currentVersion })),
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
  private extractHistoryMessageText(content: Prisma.JsonValue): string | undefined {
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

  /**
   * 定位 agent 最终回复的落库频道：**固定 private 会话频道（内心独白）**——架构上
   * private 是每个 agent 的真实会话，群聊是汇总视图（对外消息经 forwardToGroup 转发）。
   * F3 P1 修复：**按实例精确匹配**——同 agent 多实例各自独立私聊频道，若仍按 agentId
   * findFirst 会命中最早创建的实例频道（消息串扰）。优先级：
   * 1. taskAgentId 存在 → `{taskId, taskAgentId}` 精确命中该实例频道（终态回复/失败消息落库）。
   * 2. taskAgentId 缺失（存量会话/频道 NULL）→ 回退 `{taskId, agentId}` 首实例（存量兼容）。
   * 3. 均未命中 → 回退群聊频道兜底（消息仍可见）。
   */
  private async resolveChannel(taskId: string, agentId: string, taskAgentId?: string) {
    const dm = await this.prisma.chatChannel.findFirst({
      where: taskAgentId
        ? { taskId, taskAgentId }
        : { taskId, agentId },
      select: { id: true, type: true },
    });
    if (dm) {
      return dm;
    }
    return this.prisma.chatChannel.findFirst({
      where: { taskId, type: CHANNEL_TYPE.task_group },
      select: { id: true, type: true },
    });
  }

  /**
   * 群聊转发（对外消息）：模型在回复中声明 group_post 后，把声明内容转发到群聊频道。
   * 模型自主决策（像真人判断是否在群里公开回应）——未声明不调用本方法，回复留在私聊独白。
   * attachment：group_post 声明 fileRef 且该文件已归档落盘 → 群聊消息挂附件
   * （图片内嵌预览/文件下载链接，复用 messages 表 attachmentUrl 三字段）。
   * 主频道即群聊（任务无该 agent 私聊，resolveChannel 回退）→ 已落库，跳过转发防重复。
   */
  private async forwardToGroup(
    taskId: string,
    agentId: string,
    content: Prisma.InputJsonValue,
    sessionId: string | undefined,
    mainChannelId: string,
    attachment?: { url: string; name: string },
  ): Promise<void> {
    try {
      const group = await this.prisma.chatChannel.findFirst({
        where: { taskId, type: CHANNEL_TYPE.task_group },
        select: { id: true },
      });
      if (!group || group.id === mainChannelId) {
        return;
      }
      const ext = attachment ? FileStorageService.extractExtension(attachment.name) ?? '' : '';
      const groupMessage = await this.prisma.message.create({
        data: {
          id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
          channelId: group.id,
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
        },
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
  private async resolveAgentModelId(agentId: string): Promise<string | null> {
    let currentId: string | null = agentId;
    for (let depth = 0; currentId && depth < MAX_BASE_AGENT_CHAIN_DEPTH; depth++) {
      const row = await this.prisma.agent.findUnique({
        where: { id: currentId },
        select: { id: true, defaultModelId: true, baseAgentId: true, type: true },
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
   * 首字超时 watchdog（方案 A 语义）：dispatch 调 worker 执行端点后，FIRST_TOKEN_TIMEOUT_MS
   * 内无任何事件回流（无 session.updated/delta/task.completed/agent.status）→ emitError +
   * 广播 agent.error（模型完全没响应）。收到首个事件（ingress activity 回调）即清除——只判
   * 「是否开始产出」，完成无时间上限（长期任务由 worker 推进，完成经 task.completed 回流）。
   * 同时记录 lastActivityAt 作为空闲判死追踪起点（活动事件刷新，超 AGENT_IDLE_TIMEOUT_MS
   * 判死）。OBS-009：poll 已快速失败（failedSessions 已标记）时跳过注册。
   */
  private startPendingWatchdog(
    taskId: string,
    agentId: string,
    sessionId: string,
    workerId: string,
    instanceId: string,
  ): void {
    if (this.failedSessions.has(sessionId)) {
      return;
    }
    const key = `${taskId}:${agentId}`;
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      this.pendingBySession.delete(existing.sessionId);
    }
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.pendingBySession.delete(sessionId);
      // F2 MINOR：超时标记失败会话——迟到的回流（ingress/轮询）跳过落库仅记日志
      this.failedSessions.add(sessionId);
      this.unregisterExecution(workerId, taskId, instanceId ?? agentId);
      this.lastActivityAt.delete(sessionId);
      const error = `agent 无响应（${this.firstTokenTimeoutMs / 1000}s 无事件回流），请稍后重试或检查 worker 状态`;
      this.logger.error(`agent ${agentId} ${error}`);
      this.emitError({ taskId, agentId, error });
      void this.broadcastAgentError({
        taskId,
        agentId,
        sessionId,
        level: 'retry',
        errorType: 'first_token_timeout',
        message: error,
      });
    }, this.firstTokenTimeoutMs);
    timer.unref?.();
    this.pending.set(key, { taskId, agentId, instanceId, sessionId, workerId, timer });
    this.pendingBySession.set(sessionId, key);
    // 空闲判死追踪起点（活动事件经 handleSessionActivity 刷新）
    this.lastActivityAt.set(sessionId, Date.now());
    this.startIdleScan();
  }

  /**
   * ingress 活动事件通知处理（onSessionActivity 回调）：
   * - 任意首个事件到达 → 清除首字 watchdog（模型已开始产出，不再等 60s 无响应）；
   * - task.completed / session 进入非 running 态 → 本轮结束，退出空闲判死追踪；
   * - 其余活动事件（delta / agent.status / session.updated(running)）→ 刷新 lastActivityAt。
   */
  private handleSessionActivity(payload: SessionActivityPayload): void {
    const { sessionId } = payload;
    if (!sessionId) {
      return;
    }
    this.clearPendingWatchdogBySession(sessionId);
    if (
      payload.type === 'task.completed' ||
      (payload.type === 'session.updated' &&
        payload.status &&
        payload.status !== SESSION_STATUS.running)
    ) {
      this.lastActivityAt.delete(sessionId);
      return;
    }
    this.lastActivityAt.set(sessionId, Date.now());
  }

  /** 惰性启动空闲判死扫描（setInterval 周期遍历 lastActivityAt；unref 防阻塞进程退出）。 */
  private startIdleScan(): void {
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
   * 空闲判死扫描：遍历 lastActivityAt，跳过仍等首事件（pendingBySession 命中）的会话；
   * 超 AGENT_IDLE_TIMEOUT_MS 无活动 → 查 Session.status，仅 running 判死（failed + emitError
   * + 广播 agent.error）；非 running（idle/完成/冻结）→ 退出追踪不判死（防误杀）。
   */
  private async scanIdleSessions(): Promise<void> {
    const now = Date.now();
    const stale: string[] = [];
    for (const [sessionId, lastAt] of this.lastActivityAt) {
      if (this.pendingBySession.has(sessionId)) {
        continue;
      }
      if (now - lastAt <= this.agentIdleTimeoutMs) {
        continue;
      }
      stale.push(sessionId);
    }
    for (const sessionId of stale) {
      await this.markSessionIdleDead(sessionId);
    }
  }

  /** 单会话空闲判死：查 DB 状态（仅 running 判死）→ failed + emitError + 广播 agent.error。 */
  private async markSessionIdleDead(sessionId: string): Promise<void> {
    try {
      const row = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { status: true, taskId: true, agentId: true },
      });
      if (!row) {
        this.lastActivityAt.delete(sessionId);
        return;
      }
      if (row.status !== SESSION_STATUS.running) {
        this.lastActivityAt.delete(sessionId);
        return;
      }
      await this.prisma.session.update({
        where: { id: sessionId },
        data: { status: SESSION_STATUS.failed },
      });
      this.failedSessions.add(sessionId);
      this.lastActivityAt.delete(sessionId);
      const taskId = row.taskId ?? '';
      const agentId = row.agentId ?? '';
      const error = `agent 长时间无活动（超过 ${this.agentIdleTimeoutMs / 60000}min），已判死`;
      this.logger.error(`session ${sessionId} ${error}`);
      if (taskId && agentId) {
        this.emitError({ taskId, agentId, error });
        void this.broadcastAgentError({
          taskId,
          agentId,
          sessionId,
          level: 'retry',
          errorType: 'agent_idle_timeout',
          message: error,
        });
      }
    } catch (err) {
      this.logger.error(
        `session ${sessionId} 空闲判死失败: ${this.describeError(err)}`,
      );
    }
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
    const dir = path.join(this.taskWorkDirRoot, 'tasks', taskId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * is_0000000010：实例工作目录解析链——优先实例 task_agents.work_dir（创建任务时
   * 指定或服务端默认 `/data/worker/<sanitize(name)>[-seq]`）；缺失（存量实例/异常）
   * 回落 `/data/worker/<sanitize(agent.name)>-<seq>`（与 tasks.service 同根，防两处默认
   * 路径分叉——PR 审核建议），最终任务级目录兜底。mkdir -p 保证存在；worker 执行端点
   * 亦有兜底创建（server/worker 文件系统可能不共享，依赖 /data/worker 持久卷）。
   */
  private async resolveAgentWorkDir(
    taskId: string,
    session: { taskAgentId: string | null },
    target: { agentId: string; sessionId: string | null },
  ): Promise<string> {
    if (session.taskAgentId) {
      const ta = await this.prisma.taskAgent.findUnique({
        where: { id: session.taskAgentId },
        select: {
          workDir: true,
          seq: true,
          agent: { select: { id: true, name: true } },
        },
      });
      if (ta) {
        const dir = ta.workDir?.trim();
        if (dir) {
          await fs.mkdir(dir, { recursive: true });
          return dir;
        }
        const agentDir = this.defaultAgentWorkDirPath(ta.agent.name ?? ta.agent.id, ta.seq);
        await fs.mkdir(agentDir, { recursive: true });
        return agentDir;
      }
    }
    // 实例行缺失（存量会话未绑实例）：agent 名称兜底 → 任务级兜底
    const agentRow = await this.prisma.agent.findUnique({
      where: { id: target.agentId },
      select: { id: true, name: true },
    });
    if (agentRow) {
      const dir = this.defaultAgentWorkDirPath(agentRow.name ?? agentRow.id, 1);
      await fs.mkdir(dir, { recursive: true });
      return dir;
    }
    return this.ensureTaskWorkDir(taskId);
  }

  /** is_0000000010：默认 agent 目录 `/data/worker/<sanitize(name)>[-seq]`（对齐
   *  tasks.service defaultAgentWorkDir，统一根路径防存量实例调度/DTO 展示分叉）。 */
  private defaultAgentWorkDirPath(name: string, seq: number): string {
    const base = sanitizeWorkDirName(name ?? 'agent');
    return `/data/worker/${seq > 1 ? `${base}-${seq}` : base}`;
  }

  private clearPendingWatchdog(taskId: string, agentId: string): void {
    const existing = this.pending.get(`${taskId}:${agentId}`);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(`${taskId}:${agentId}`);
      this.pendingBySession.delete(existing.sessionId);
    }
  }

  /** 按平台 sessionId 清除首字 watchdog（ingress 活动事件回调路径，taskId/agentId 未知）。 */
  private clearPendingWatchdogBySession(sessionId: string): void {
    const key = this.pendingBySession.get(sessionId);
    if (!key) {
      return;
    }
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(key);
    }
    this.pendingBySession.delete(sessionId);
  }

  /** 广播 agent.error（FR-21，scope=task）；广播异常吞掉不阻断主流程。 */
  private async broadcastAgentError(event: {
    taskId: string;
    agentId: string;
    sessionId?: string | null;
    level?: 'tool' | 'message' | 'retry';
    errorType?: string;
    retryInfo?: unknown;
    message?: string;
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
          ...(event.retryInfo !== undefined ? { retryInfo: event.retryInfo } : {}),
          ...(event.message !== undefined ? { message: event.message } : {}),
        },
        { type: 'task', id: event.taskId },
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