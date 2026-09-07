import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  BadRequestException,
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
  WorkersService,
} from '../workers/workers.service';
import { renderPersonaSection } from '../agents/persona.constants';
import { EXECUTION_MODES } from '../plans/plan.constants';
import {
  DispatchRequest,
  DispatchResult,
  MessageDispatcher,
} from './message-dispatcher';
import { inferErrorType, isQuotaError } from '../workers/infer-error-type';
import { normalizeParts } from './message-parts';

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
    '调用 vteam MCP 的 notify_agent 工具（参数 {taskId: 你的任务ID, targetInstanceId: 目标成员 id（tmm_ 前缀，见 task_context 的 agentMembers）, content: 消息内容}）' +
    '——目标实例会收到你的消息并开始执行；回复时也可用 @用户名 在群聊中定向回复特定成员。' +
    '【@用户】需要用户确认/决策或完成后通知时，在 group_post 的 content 中写 @user 或 @all（系统动态注入当前任务相关用户，无需写死 @admin），也可写 @用户名 精确@某人；命中后消息对该用户高亮（蓝底+左蓝条+★@你）。',
  '【Issue 管理】任务内 issue 协作：创建 issue 调 vteam MCP 的 issue_create（参数 {taskId, selfInstanceId, title, description?, tags?, assigneeInstanceId?}）；查询 issue_list/issue_get；更新 issue_update；状态流转 issue_transition（action: start/resolve/close/reopen/reject）。产品/测试 Agent 负责创建需求或缺陷 issue 并指派（assigneeInstanceId 为目标实例 id），研发 Agent 处理指派给自己的 issue 并流转状态。issue 标签（tags）标识类型（如 需求/缺陷/优化）。',
  '【任务状态】主 Agent 可调用 vteam MCP 的 task_transition 工具（参数 {taskId, selfInstanceId, action: start/mark-pending-review/accept/reject/archive, reason?}）流转任务状态：start 开始 / mark-pending-review 提交验收 / accept 验收通过 / reject 驳回（可附 reason）/ archive 归档。仅主实例可调用 task_transition，其余成员调用将返回 403 提示（请知会主实例或由管理员在任务管理界面操作）。',
  '【持久化目录】你运行在 k8s 容器环境中，平台为每个 Agent 分配独立的持久化工作目录（默认 /data/vteam-worker/<agent名称>，可在创建任务时指定）。' +
    '仅该目录及挂载卷内的内容在容器重启后保留，其余路径（如 /tmp、仓库外任意路径）写入的文件重启后会丢失；' +
    '工作产物、git clone 的仓库、脚本、产出物文件等请写入该持久化目录，提交产出物（doc/file）时 fileRef 应指向该目录内的文件。',
  '【托管模式】若当前任务开启托管（任务设置 managedMode=on），团队成员的 question/permission 请求不再弹窗给用户，改由主 Agent 确认：收到【托管确认】消息（含 requestId、kind、问题详情）时，调用 vteam MCP 的 question_confirm 工具（参数 {taskId, selfInstanceId, requestId, kind, answers?/response?}）决策——question 传 answers（答案数组，null=拒绝）；permission 传 response（once 允许一次 / always 总是允许 / reject 拒绝）。仅主实例可调用 question_confirm。',
  '【企业微信】当消息来自企业微信（正文含 [WeCom:用户名] 标记）时，请使用 wecom_reply 工具回复（参数 {taskId, selfInstanceId, text, atUser?}），不要用 group_post；wecom_reply 会同时发送到企微会话（群聊自动@该用户，私聊直回）并同步到任务群聊，确保用户在企微端收到回复。',
  '【记忆管理】记忆只存**可复用经验**，不存会话总结。可存：怎么做（有效路径/命令/配置，下次照做）、坑与规避（错误原因+规避动作，下次不再踩）、平台硬约束（工具限制/权限边界/容量上限，下次主动绕开）。禁存：任务流水账、时间线复盘、谁做了什么、当前状态、一次性结论。开始任务/需要历史经验时，调用 memory_search（参数 {taskId, query?, level?, tags?, limit?≤5}）检索（返回含 description 索引，命中后再取 content 正文，可多次翻页）；沉淀时调用 memory_save（参数 {taskId, selfInstanceId, level, content, description?:30字摘要, tags?}）——content 写「场景 + 做法/坑 + 规避动作」，description 概括，跨任务复用写 level=team，平台通用写 level=global，任务专属写 level=task，tags 用 howto/pitfall/constraint 等类型词。遇可用记忆索引时先用 tags 精搜，再用 query 精排，单次≤5条，摘要命中再取正文。',
].join('\n');

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
  role: string | null;
  prompt: string | null;
  /** Agent 性格 key（PERSONA_LIBRARY 预设 key；null=无性格）。运行时按此拼接【性格】段进系统提示。 */
  persona: string | null;
}

/** 团队成员信息（dispatch 时从 TeamMember→Agent 组装，注入全局上下文供 agent 判断与谁协作）。
 *  TeamMember 维度：instanceId 为团队成员 id（tmm_ 前缀，TeamMember.id），alias/seq 来自团队模板；
 *  id/name/role 来自模板 agent。 */
export interface TeamMemberInfo {
  /** 模板 agent id（继承 name/role/prompt/model）。 */
  id: string;
  name: string | null;
  role: string | null;
  /** 团队成员 id（TeamMember.id，tmm_ 前缀）——团队成员唯一身份（@/指派/主实例判定依据）。 */
  instanceId: string;
  /** 实例别名（默认「<角色中文名>-<seq>」）；缺省回退 name。 */
  alias: string | null;
  /** 同 agent 同团队内序号（服务端生成，唯一键 teamId+agentId+seq）。 */
  seq: number;
}

export interface BuildSystemInstructionsOptions {
  /** 当前 agent 是否团队主成员（session.teamMemberId === team.mainAgentMemberId）→ true 时追加主 Agent 职责段。 */
  isMainAgent?: boolean;
  /** 任务团队成员（实例 id/别名/序号 + 模板 agent id/名称/角色）；空/缺省则不注入【团队成员】段。 */
  team?: TeamMemberInfo[];
  /** 任务主实例 id（用于团队成员段中标注主实例成员；无主实例时为 null）。 */
  mainAgentInstanceId?: string | null;
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
  /** 任务执行模式（tasks.execution_mode，direct/plan；Todo 4 tc-flow 引入）。所有任务注入
   *  轻量【执行计划】能力引导（PLAN_CAPABILITY_INSTRUCTION）；executionMode=plan 时额外
   *  追加完整【计划工作流】段（PLAN_WORKFLOW_INSTRUCTION）。 */
  executionMode?: string;
  /** 可用记忆索引块（team/global 计数+Top tags+description 列表，已按预算截断 <400 token）；缺省不注入。 */
  memoryIndex?: string | null;
  /** team-mode 接待员模式（无任务团队直聊）：分派侧在 taskId 为空时置 true，追加【团队接待】话术段；缺省 = task-mode，系统文本字节不变。 */
  teamMode?: boolean;
  /** 当前任务 id（team-mode 传空串；仅 teamMode=true 且 taskId 为空时触发接待段，task-mode 调用方不传本字段）。 */
  taskId?: string | null;
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
  '（tasks 每项含 目标/边界/引用/验收/QA/提交 六要素，其中验收/qa 必填且 qa 须含工具＋步骤＋预期结果）；' +
  '计划结构对齐 TL;DR/范围/验证策略/执行策略/Todos/终验/提交策略/成功标准八段模板；' +
  '计划评审由成员确认或主 Agent 指派成员（评审者可经 plan_get 读计划、plan_review 提交结论；评审默认放行、驳回须附理由）；' +
  '评审通过后等待用户在任务管理界面手动点击“开始任务”再按 plan_task 逐项推进（plan_task_transition 汇报进度，状态 done/blocked），Agent 不可自动调用 task_transition start；' +
  '全部完成后主 Agent 提交验收（task_transition mark-pending-review）。' +
  '计划前如关键假设不明，先向成员确认再提交。驳回重提有 3 次上限，超限需人工裁决。';

export const PLAN_REVIEW_CHECKLIST_INSTRUCTION =
  '【计划评审清单】评审执行计划（plan_get 读取全文）时只查四件事：' +
  '1 引用核查—references 提到的文件/模块是否真实存在且内容相符（用只读工具核实）；' +
  '2 可起步—每个子任务是否有足够上下文动手（知道改哪、参照什么）；' +
  '3 一致性—子任务之间无矛盾、无遗漏依赖；' +
  '4 QA 可执行—每条 qa 是否含具体工具＋步骤＋预期结果、能否机器执行。' +
  '判定：四项全过→approved；有阻塞问题→rejected 附 reason，最多列 3 个最致命问题，每个含子任务定位与改法；风格/“可以更好”类建议不构成驳回理由。';

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
  // 双维度身份：团队会话按团队成员（tmm_）调度时，另行明确其任务实例 id，
  // 避免 agent 拿成员 id 去任务成员表自查时误判"不是任务团队成员"
  const taskInstanceId =
    opts?.taskInstanceId && opts.taskInstanceId !== selfInstanceId
      ? opts.taskInstanceId
      : null;
  const identityLine = taskInstanceId
    ? `【你的身份】你是本任务的 ${selfName}（团队成员 id: ${selfInstanceId}，任务实例 id: ${taskInstanceId}，角色: ${agent.role ?? ''}）。` +
      `你在本任务团队中的实例就是 ${taskInstanceId}（【团队成员】段中标"主 Agent"的那一位若是你，请直接认领）；` +
      `调用 vteam MCP 工具时 selfInstanceId 参数必须填写你的任务实例 id（${taskInstanceId}）。`
    : `【你的身份】你是本任务的 ${selfName}（实例 id: ${selfInstanceId}，角色: ${agent.role ?? ''}）。`;
  const blocks = [
    GLOBAL_SYSTEM_INSTRUCTIONS +
      '\n' +
      identityLine +
      (agent.prompt ? `\n【职责】${agent.prompt}` : '') +
      '\n调用 vteam MCP 工具时，落库类工具（group_post / notify_agent / submit_artifact）的' +
      'selfInstanceId 参数必须填写你的任务实例 id' +
      (taskInstanceId
        ? `（${taskInstanceId}）`
        : '（tmm_ 前缀，服务器按此校验归属并精确记录发送者）') +
      '。',
    agent.persona ? renderPersonaSection(agent.persona) : '',
    opts?.persistentWorkDir
      ? `\n【运行时工作目录】本任务为你分配的实际持久化工作目录为：${opts.persistentWorkDir}。` +
        '工作产物、脚本、中间文件等请写入该目录（提交 doc/file 产出物时 fileRef 使用该目录下的路径）。'
      : '',
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
  blocks.push(PLAN_CAPABILITY_INSTRUCTION);
  if (opts?.executionMode === EXECUTION_MODES.plan) {
    blocks.push(PLAN_WORKFLOW_INSTRUCTION);
    blocks.push(PLAN_REVIEW_CHECKLIST_INSTRUCTION);
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
 * 团队直聊群聊触发指令（仅 dispatchForTeamTarget 的 team_group 频道注入）：
 * 团队维度传参（group_post、notify_agent、chat_history 均传 teamId；selfInstanceId
 * 为 system 身份段中的团队成员 id，tmm_ 前缀）；团队直聊无 taskId，禁传 taskId；
 * 需任务上下文的工具在团队直聊下不可用（先 task_create 建任务）。
 */
export const TEAM_GROUP_TRIGGER_INSTRUCTION =
  '【群聊回复要求】本条消息来自团队直聊（无任务），你被 @ 定向分发。请在群聊中公开回复你的结论' +
  '——调用 vteam MCP 的 group_post 工具发布到群聊（参数 {teamId, selfInstanceId, content, fileRef?}，selfInstanceId 为 system 身份段中的团队成员 id，tmm_ 前缀）。' +
  '群聊只会显示你通过 group_post 发布的内容，完整处理过程保留在你的私聊会话。' +
  '如需通知其他成员：调用 notify_agent（参数 {teamId, selfInstanceId, targetInstanceId, content}）；' +
  '需要群聊历史时调用 chat_history（传 teamId）。' +
  '团队直聊没有 taskId，禁止传递 taskId 参数（传了必 403）。' +
  'my_profile、team_view、doclib、issue、plan、task_transition 类工具需要任务上下文，团队直聊下不要调用（如需任务，先调用 task_create 创建真实任务）。' +
  '如需向群聊发送文件：直接调用 group_post 并携带 fileRef（{teamId, selfInstanceId, content, fileRef: "文件路径"}），文件将作为群聊附件。';

export const WECOM_TRIGGER_INSTRUCTION =
  '【企微消息】此消息来自企业微信用户 via WeCom，请务必使用 wecom_reply 工具回复，不要使用 group_post，以确保用户在企微端收到@回复。' +
  '参数 {taskId, selfInstanceId, text, atUser?}，text 为回复正文（支持 markdown，≤4000字），atUser 默认 true（群聊@，私聊直回）。回复会同时同步到任务群聊。';

/**
 * team-mode 团队接待话术段（无任务团队直聊，仅 teamMode 分派时注入 system）：
 * 主 Agent 接待员身份 + 意图明确→直接 task_create 建真任务（团队由会话解析）+
 * 意图不明→追问两件事且禁建任务、禁 QuestionModal。task-mode 文本不受影响。
 */
export const TEAM_SYSTEM_RECEPTION_INSTRUCTION =
  '【团队接待】你是本团队的主 Agent 接待员（团队直聊，当前无任务上下文）。' +
  '用户意图明确（含做什么、可执行）→ 直接调用 vteam MCP 的 `task_create` 创建真实任务' +
  '（参数 {selfInstanceId, title, description?, priority?}，团队由当前会话解析、无需传归属，建好后告知用户）；' +
  '所在团队不明确 → 先问用户用哪个团队，绝不猜测归属、绝不创建任务；' +
  '用户意图不明 → 普通回复追问两件事（做什么/验收标准），禁止创建任务、' +
  '禁止走 QuestionModal（问题确认弹窗仅任务内可用）。' +
  '参数规则：chat_history、group_post、notify_agent、memory_save、memory_search 这 5 个工具在团队直聊下传 teamId，绝不传 taskId' +
  '（团队直聊没有 taskId，传了必 403）；selfInstanceId 填写 system 身份段中的团队成员 id（tmm_ 前缀）；' +
  'my_profile、team_view 与 delivery 相关工具需要任务上下文，团队直聊下不可用（如需任务，先 task_create 建任务）。';

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

/** F3 MINOR-3：任务工作目录根（env WORK_DIR，默认 /data/vteam-worker）。
 *  任务级独立工作目录 = <根>/tasks/<taskId>（server 侧 mkdir -p 保证存在），
 *  作为 prompt_async 的 directory 传入——防模型在仓库根真实写文件污染（F4 零污染关键）。 */
export const DEFAULT_TASK_WORK_DIR = '/data/vteam-worker';

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
    } catch {
      // 同上：丢弃
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
          return JSON.parse(text.slice(start, i + 1)) as Record<
            string,
            unknown
          >;
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
          } catch {
            // 非合法 JSON：跳过
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

  /** 待回流 watchdog：`<scope>:<agentId>` → 定时器（首字超时：默认 60s 无首个事件 emitError）。 */
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
  /** 首字超时 ms（env FIRST_TOKEN_TIMEOUT_MS，缺省 60s）：dispatch 后无首个事件回流 → emitError。 */
  public firstTokenTimeoutMs: number;
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
    const executionMode = request.taskContext?.executionMode;
    if (
      executionMode !== undefined &&
      executionMode !== EXECUTION_MODES.direct &&
      executionMode !== EXECUTION_MODES.plan
    ) {
      throw new BadRequestException({
        code: 'TASK_EXECUTION_MODE_INVALID',
        message: `任务执行模式非法：${executionMode}（仅 direct/plan）`,
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
   * team-only：经任务归属 teamId + targetInstanceId（tmm_）直查团队会话，
   * 无 task 快照回退（adopt/双实现已删）；复用 dispatch() 单团队入口全链路
   * （assignWorker → createSession/bind → execute → ingress 回流落库+广播，
   * 不复制单目标分派逻辑）；单目标失败由 dispatch() 统一 emitError + 广播 agent.error。
   */
  async dispatchAgentMention(input: {
    taskId: string;
    /** 群聊频道（触发来源：目标 agent 的 group_post 回复落库+广播走此频道）。 */
    channelId: string;
    /** 消息内容（含 @目标，透传给目标 agent 作为触发 prompt）。 */
    text: string;
    /** 被 @ 的目标成员 id（TeamMember.id，tmm_ 前缀）。 */
    targetInstanceId: string;
  }): Promise<void> {
    const taskRow = await (this.prisma as any).task.findUnique({
      where: { id: input.taskId },
      select: { teamId: true },
    });
    const teamId = (taskRow as any)?.teamId ?? null;
    const session = teamId
      ? await (this.prisma.session as any).findFirst({
          where: { teamId, teamMemberId: input.targetInstanceId },
          select: { id: true, agentId: true },
        })
      : null;
    if (!session) {
      throw new Error(
        `实例 ${input.targetInstanceId} 无团队会话（团队 ${teamId ?? '未知'}，任务 ${input.taskId}）`,
      );
    }
    await this.dispatch({
      messageId: await this.idGen.nextId(MESSAGE_ID_PREFIX),
      channelId: input.channelId,
      taskId: input.taskId,
      teamId: taskRow?.teamId ?? null,
      taskContext: { taskId: input.taskId },
      text: input.text,
      targets: [
        {
          agentId: session.agentId,
          instanceId: input.targetInstanceId,
          sessionId: session.id,
        },
      ],
    });
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
      orderBy: { seq: 'asc' },
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
              '\n按需 memory_search({teamId, level/tags/query, limit≤5}) 拉正文，摘要命中再取 content。'
            : '暂无记忆正文。');
        if (memoryIndex.length > 1200) memoryIndex = memoryIndex.slice(0, 1200);
        return memoryIndex;
      }
      return null;
    } catch {
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

    const agentModelId =
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
          '需要群聊历史/文档库/任务信息时，调用 vteam 的 chat_history / doclib / task_context 工具（传 taskId）。' +
          '需要向群聊发布消息时调用 vteam 的 group_post 工具（参数 {taskId, content, fileRef?}）。',
      );
    } else {
      promptBlocks.push(
        `【团队上下文】你当前在团队 ${teamId} 直聊（无任务）。` +
          '需要群聊历史时调用 chat_history（传 teamId）；需要向群聊发布时调用 group_post（传 teamId）。',
      );
    }
    const sourceChannel = await this.prisma.chatChannel.findUnique({
      where: { id: request.channelId },
      select: { type: true },
    });
    if (
      sourceChannel?.type === CHANNEL_TYPE.team_group ||
      sourceChannel?.type === CHANNEL_TYPE.task_group
    ) {
      promptBlocks.push(
        taskIdForPrompt ? GROUP_TRIGGER_INSTRUCTION : TEAM_GROUP_TRIGGER_INSTRUCTION,
      );
    }
    if (request.text.includes('[WeCom:')) {
      const wecomMatch = /\[WeCom:([^\]]+)\]/.exec(request.text);
      const wecomUserLabel = wecomMatch ? wecomMatch[1].trim() : '';
      const tailored = wecomUserLabel
        ? `【企微消息】此消息来自企业微信用户 ${wecomUserLabel} via WeCom，请务必使用 wecom_reply 工具回复，不要使用 group_post，以确保用户在企微端收到@回复。`
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
      select: { id: true, name: true, role: true, prompt: true, persona: true },
    });
    const agentIdentity: AgentIdentityInfo = {
      id: target.agentId,
      name: agentRow?.name ?? null,
      role: agentRow?.role ?? null,
      prompt: agentRow?.prompt ?? null,
      persona: agentRow?.persona ?? null,
    };
    let teamMemberRows: any[] = [];
    try {
      teamMemberRows =
        (await (this.prisma as any).teamMember.findMany({
          where: { teamId },
          include: { agent: { select: { id: true, name: true, role: true } } },
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
      role: tm.agent.role,
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
    const systemOpts: BuildSystemInstructionsOptions = {
      isMainAgent,
      mainAgentInstanceId: mainAgentMemberId,
      team,
      selfInstanceId: teamMemberId,
      selfAlias,
      persistentWorkDir: teamWorkDir,
    };
    if (taskIdForPrompt) {
      systemOpts.executionMode = request.taskContext?.executionMode;
      if (memoryIndex) {
        systemOpts.memoryIndex = memoryIndex;
      }
    } else {
      systemOpts.teamMode = true;
      systemOpts.taskId = '';
    }
    await this.workerClient.execute(worker, {
      prompt: [{ type: 'text', text: finalPrompt }],
      model,
      directory: teamWorkDir,
      taskId: request.taskContext?.taskId ?? '',
      agentId: target.agentId,
      channelId: request.channelId,
      sessionId: opencodeSessionId,
      ...(imageAttach ? { attachments: imageAttach.attachments } : {}),
      system: buildSystemInstructions(agentIdentity, systemOpts),
    });

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
    }
    // 团队唯一路径：落库 + 广播 + emitFinal（无 task/team 双实现）
    const settled = await this.handleTeamTaskCompleted(payload);
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
              } catch {}
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
                const groupChatChannel = await (
                  this.prisma as unknown as {
                    chatChannel: {
                      findFirst: (q: unknown) => Promise<{ id: string } | null>;
                    };
                  }
                ).chatChannel.findFirst({
                  where: {
                    taskId: payload.taskId,
                    type: CHANNEL_TYPE.task_group,
                  },
                  select: { id: true },
                });
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
                } catch {}
                if (!adapter) {
                  try {
                    const g = globalThis as unknown as Record<string, unknown>;
                    adapter =
                      (g['__wecomAdapter'] as typeof adapter) ?? undefined;
                  } catch {}
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
                  } catch {}
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
                    } catch {}
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
                    } catch {}
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
                  } catch {}
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
                    } catch {}
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
                        `wecom bridge: mirrored to task_group channel=${groupChatChannel.id} mirrorId=${mirrorId} textLen=${mirrorText.length}`,
                      );
                    }
                  }
                } catch (mirrorErr) {
                  this.logger.warn(
                    `wecom bridge: mirror to task_group failed: ${(mirrorErr as Error).message}`,
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
    // 群聊回退（team_group；存量 task_group 防御）时正文独白不落群聊（结论经
    // group_post 工具直发），仅幂等标记 + emitFinal 收尾
    if (
      channel.type === CHANNEL_TYPE.team_group ||
      channel.type === CHANNEL_TYPE.task_group
    ) {
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
      const group = teamId
        ? await this.prisma.chatChannel.findFirst({
            where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
            select: { id: true },
          })
        : await this.prisma.chatChannel.findFirst({
            where: { taskId, type: CHANNEL_TYPE.task_group },
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
   * 首字超时 watchdog（方案 A 语义）：dispatch 调 worker 执行端点后，FIRST_TOKEN_TIMEOUT_MS
   * 内无任何事件回流（无 session.updated/delta/task.completed/agent.status）→ emitError +
   * 广播 agent.error（模型完全没响应）。收到首个事件（ingress activity 回调）即清除——只判
   * 「是否开始产出」，完成无时间上限（长期任务由 worker 推进，完成经 task.completed 回流）。
   * 同时记录 lastActivityAt 作为空闲判死追踪起点（活动事件刷新，超 AGENT_IDLE_TIMEOUT_MS
   * 判死）。OBS-009：poll 已快速失败（failedSessions 已标记）时跳过注册。
   */
  private startPendingWatchdog(
    scope: string,
    agentId: string,
    sessionId: string,
    workerId: string,
    teamMemberId: string,
  ): void {
    if (this.firstTokenTimeoutMs <= 0) {
      return;
    }
    if (this.failedSessions.has(sessionId)) {
      return;
    }
    const key = `${scope}:${agentId}`;
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
      this.unregisterExecution(workerId, scope, teamMemberId);
      this.lastActivityAt.delete(sessionId);
      const error = `agent 无响应（${this.firstTokenTimeoutMs / 1000}s 无事件回流），请稍后重试或检查 worker 状态`;
      this.logger.error(`agent ${agentId} ${error}`);
      this.emitError({ taskId: scope, agentId, error });
      void this.broadcastAgentError({
        taskId: scope,
        agentId,
        sessionId,
        level: 'retry',
        errorType: 'first_token_timeout',
        message: error,
      });
    }, this.firstTokenTimeoutMs);
    timer.unref?.();
    this.pending.set(key, {
      scope,
      agentId,
      instanceId: teamMemberId,
      sessionId,
      workerId,
      timer,
    });
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

  /** 惰性启动空闲判死扫描（0 表示禁用，按需求已禁杀死长任务） */
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
   * 空闲判死扫描：遍历 lastActivityAt，跳过仍等首事件（pendingBySession 命中）的会话；
   * 超 AGENT_IDLE_TIMEOUT_MS 无活动 → 查 Session.status，仅 running 判死（failed + emitError
   * + 广播 agent.error）；非 running（idle/完成/冻结）→ 退出追踪不判死（防误杀）。
   */
  private async scanIdleSessions(): Promise<void> {
    if (this.agentIdleTimeoutMs <= 0) {
      return;
    }
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

  public getLastActivityAt(sessionId: string): number | undefined {
    return this.lastActivityAt.get(sessionId);
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
        this.lastActivityAt.delete(sessionId);
        return;
      }
      if (row.status !== SESSION_STATUS.running) {
        this.lastActivityAt.delete(sessionId);
        return;
      }
      let forensicsError: string | undefined;
      let forensicsType = 'agent_idle_timeout';
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
            const messages = await this.workerClient.getMessages(
              { id: row.workerId, capabilities: workerRow.capabilities },
              row.instanceRef,
            );
            const errText = findError(messages);
            if (errText) {
              forensicsError = errText;
              forensicsType = inferErrorType(errText);
            }
          }
        } catch {}
      }
      await this.prisma.session.update({
        where: { id: sessionId },
        data: { status: SESSION_STATUS.failed },
      });
      this.failedSessions.add(sessionId);
      this.lastActivityAt.delete(sessionId);
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
   * 自动拉起（Todo10 团队化）：频道经 resolveTeamChannel 团队定位，目标为成员
   * tmm_ 直调 dispatchAgentMention；任务仅归因（进度门 + prompt 上下文）。
   * taskId 缺失（纯团队直聊）→ 失败已落库+广播，自动恢复需任务上下文，跳过；
   * 任务非 in_progress → 跳过；未知 channel → 跳过不抛错。
   */
  private async tryAutoRestart(
    teamId: string,
    teamMemberId: string,
    taskId: string | null,
  ): Promise<void> {
    if (!taskId) return;
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { status: true },
    });
    if (!task || task.status !== 'in_progress') return;
    const channel = await this.resolveTeamChannel(teamId, teamMemberId);
    if (!channel) return;
    await this.dispatchAgentMention({
      taskId,
      channelId: channel.id,
      text: '【自动恢复】检测到会话意外中断，已自动重试，请继续执行未完成的任务',
      targetInstanceId: teamMemberId,
    });
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
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {}
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
