import { z } from 'zod';
import type { PlatformMcpService } from './platform-mcp.service';

/**
 * 平台 MCP 工具定义（阶段 1，手写 JSON-RPC 分发用，不依赖 SDK）。
 *
 * 每个工具 = zod inputSchema（tools/list 派生成 JSON Schema；tools/call 用
 * safeParse 校验 arguments）+ handler（workerId 由 controller 从 `x-worker-id`
 * header 解析后经 ctx 传入，归属校验在 service.assertWorkerTask 内）。
 *
 * 工具集与设计文档 §5 对齐：chat_history / doclib / task_context / group_post / read_file
 * + FR-13 notify_agent（agent 互 @ 触发）+ submit_artifact（agent 直接提交产出物）。
 */

/** 工具 handler 上下文：workerId 透传（归属校验在 service 内做）。 */
export interface PlatformMcpToolContext {
  workerId: string;
}

/**
 * 工具注册项。inputSchema 统一按 ZodTypeAny 消费（tools/list 运行时按
 * ZodObject 读取 shape），handler 参数为 unknown——具体入参类型由各工具
 * handler 内部收窄（zod.safeParse 已保证运行时合法）。
 */
export interface PlatformMcpTool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (ctx: PlatformMcpToolContext, args: unknown) => Promise<unknown>;
}

const chatHistorySchema = z.object({
  taskId: z.string().describe('任务 ID'),
  sinceId: z.string().optional().describe('游标：仅返回 id 大于该值的消息（分页续拉）'),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('返回条数上限（默认 50）'),
});

type ChatHistoryArgs = z.infer<typeof chatHistorySchema>;

const doclibSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  artifactId: z.string().optional().describe('产出物 ID（缺省返回该任务产出物清单）'),
  version: z.number().int().positive().optional().describe('版本号（缺省取 currentVersion）'),
});

type DoclibArgs = z.infer<typeof doclibSchema>;

const taskContextSchema = z.object({
  taskId: z.string().describe('任务 ID'),
});

type TaskContextArgs = z.infer<typeof taskContextSchema>;

const groupPostSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
  content: z.string().describe('要发布到群聊的内容'),
  fileRef: z.string().optional().describe('产出物文件引用（与产出物声明 fileRef 一致时挂附件）'),
});

type GroupPostArgs = z.infer<typeof groupPostSchema>;

const readFileSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  fileRef: z.string().describe('文件路径/引用（如 /tmp/opencode/x.txt 或产出物 fileRef）'),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024)
    .optional()
    .describe('最大读取字节数（默认 256KB，上限 1MB）'),
});

type ReadFileArgs = z.infer<typeof readFileSchema>;

const notifyAgentSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
  targetInstanceId: z
    .string()
    .describe('目标实例 id（ta_ 前缀，见 task_context agentMembers / 团队提示，@ 定向触发目标）'),
  content: z.string().describe('要发送给目标实例的消息内容'),
});

type NotifyAgentArgs = z.infer<typeof notifyAgentSchema>;

const submitArtifactSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
  type: z
    .enum(['text', 'doc', 'file'])
    .describe('产出物类型：text 直接提交内容；doc/file 提交工作目录文件（fileRef）'),
  title: z.string().describe('产出物标题'),
  content: z.string().optional().describe('产出物内容（type=text 必填）'),
  fileRef: z.string().optional().describe('文件路径/引用（type=doc/file 必填，自动拉取并归档）'),
});

type SubmitArtifactArgs = z.infer<typeof submitArtifactSchema>;

const issueCreateSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
  title: z.string().describe('issue 标题'),
  description: z.string().optional().describe('issue 描述（可选）'),
  tags: z
    .array(z.string())
    .optional()
    .describe('issue 标签（标识类型，如 需求/缺陷/优化）'),
  assigneeInstanceId: z
    .string()
    .optional()
    .describe('指派实例 id（ta_ 前缀，须在任务团队未 removed；不传则不指派）'),
});

type IssueCreateArgs = z.infer<typeof issueCreateSchema>;

const issueListSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
  status: z
    .enum(['open', 'in_progress', 'resolved', 'closed'])
    .optional()
    .describe('状态筛选（缺省返回全部未删除 issue）'),
});

type IssueListArgs = z.infer<typeof issueListSchema>;

const issueGetSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
  issueId: z.string().describe('issue ID'),
});

type IssueGetArgs = z.infer<typeof issueGetSchema>;

const issueUpdateSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
  issueId: z.string().describe('issue ID'),
  title: z.string().optional().describe('issue 标题'),
  description: z.string().optional().describe('issue 描述'),
  tags: z.array(z.string()).optional().describe('issue 标签'),
});

type IssueUpdateArgs = z.infer<typeof issueUpdateSchema>;

const issueTransitionSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
  issueId: z.string().describe('issue ID'),
  action: z
    .enum(['start', 'resolve', 'close', 'reopen', 'reject'])
    .describe('状态流转动作：start 开始处理 / resolve 处理完成 / close 验收关闭 / reopen 重开 / reject 拒绝处理'),
  reason: z
    .string()
    .optional()
    .describe('拒绝处理原因（action=reject 时必填）'),
});

type IssueTransitionArgs = z.infer<typeof issueTransitionSchema>;

const taskTransitionSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
  action: z
    .enum(['start', 'mark-pending-review', 'accept', 'reject', 'archive'])
    .describe('状态流转动作：start 开始 / mark-pending-review 提交验收 / accept 验收通过 / reject 驳回 / archive 归档'),
  reason: z.string().optional().describe('驳回原因（action=reject 时写入任务事件 metadata）'),
});

type TaskTransitionArgs = z.infer<typeof taskTransitionSchema>;

const questionConfirmSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
  requestId: z.string().describe('待确认请求 id（que_/per_ 前缀，来自托管确认消息）'),
  kind: z
    .enum(['question', 'permission'])
    .describe('请求类型：question=模型提问 / permission=工具权限确认'),
  answers: z
    .array(z.array(z.string()))
    .optional()
    .describe('question 答复：label 数组（顺序对应问题）；answers=null 表示拒绝'),
  response: z
    .enum(['once', 'always', 'reject'])
    .optional()
    .describe('permission 确认：once 允许一次 / always 总是允许 / reject 拒绝'),
});

type QuestionConfirmArgs = z.infer<typeof questionConfirmSchema>;

export const memorySaveSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
  level: z
    .enum(['task', 'project', 'global'])
    .describe('记忆级别：task=任务级 / project=项目级（写入当前任务所属项目，跨任务共享）/ global=全局（仅主 Agent 可写）'),
  content: z.string().min(1).max(20000).describe('记忆内容（1~20000 字符）'),
  tags: z
    .array(z.string())
    .max(20)
    .optional()
    .describe('记忆标签（≤20 个，memory_search 按标签过滤命中）'),
});

type MemorySaveArgs = z.infer<typeof memorySaveSchema>;

const memorySearchSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  query: z.string().optional().describe('内容关键词过滤（content 包含即命中）'),
  level: z
    .enum(['task', 'project', 'global'])
    .optional()
    .describe('级别过滤（缺省聚合当前任务可见的 task+project+global 三级）'),
  tags: z.array(z.string()).optional().describe('标签过滤（记忆 tags 须包含全部给定标签）'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('返回条数上限（默认 20，最多 50，按创建时间倒序）'),
});

type MemorySearchArgs = z.infer<typeof memorySearchSchema>;

export const planSubmitSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
  title: z.string().min(1).describe('执行计划标题'),
  summary: z.string().optional().describe('计划摘要'),
  scopeIn: z.string().optional().describe('范围：包含'),
  scopeOut: z.string().optional().describe('范围：不包含'),
  tasks: z
    .array(
      z.object({
        title: z.string().min(1).describe('子任务标题'),
        what: z.string().min(1).describe('子任务内容（六要素必填项）'),
        mustNot: z.string().optional().describe('禁止事项'),
        references: z.string().optional().describe('参考依据'),
        acceptance: z.string().optional().describe('验收标准'),
        qa: z.string().optional().describe('QA 要求'),
        commit: z.string().optional().describe('交付产物'),
        assigneeInstanceId: z
          .string()
          .optional()
          .describe('指派实例 id（须属于任务团队未移除成员）'),
      }),
    )
    .min(1)
    .describe('计划子任务（至少 1 项）'),
});

type PlanSubmitArgs = z.infer<typeof planSubmitSchema>;

export const planReviewSchema = z
  .object({
    taskId: z.string().describe('任务 ID'),
    selfInstanceId: z
      .string()
      .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
    planId: z.string().optional().describe('计划 id（缺省取任务当前计划）'),
    verdict: z.enum(['approved', 'rejected']).describe('评审结论'),
    reason: z.string().optional().describe('评审说明（rejected 时必填）'),
  })
  .refine(
    (data) => data.verdict !== 'rejected' || (data.reason ?? '').trim().length > 0,
    { message: '评审驳回必须填写 reason', path: ['reason'] },
  );

type PlanReviewArgs = z.infer<typeof planReviewSchema>;

const planTaskTransitionSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
  planTaskId: z.string().describe('计划子任务 id（pt_ 前缀）'),
  status: z
    .enum(['in_progress', 'done', 'blocked', 'skipped'])
    .describe('子任务新状态：in_progress 进行中 / done 完成 / blocked 阻塞 / skipped 跳过'),
});

type PlanTaskTransitionArgs = z.infer<typeof planTaskTransitionSchema>;

/** team_view：任务团队实时视图（只读，无 selfInstanceId——仅校验 worker 有该任务会话）。 */
export const teamViewSchema = z.object({
  taskId: z.string().describe('任务 ID'),
});

type TeamViewArgs = z.infer<typeof teamViewSchema>;

/** my_profile：自身 Agent 配置视图（只读，prompt 仅返回摘要，不暴露完整提示词）。 */
export const myProfileSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
});

type MyProfileArgs = z.infer<typeof myProfileSchema>;

/**
 * plan_get：读取任务执行计划（只读，评审者读计划通道——Metis MAJOR-4 闭环）。
 * 无 selfInstanceId：仅校验 worker 有该任务会话（对齐 team_view/memorySearch 只读先例）。
 */
export const planGetSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  planId: z
    .string()
    .optional()
    .describe('计划 id（缺省取任务当前计划）'),
});

type PlanGetArgs = z.infer<typeof planGetSchema>;

/**
 * plan_assign_reviewer：指派执行计划评审者（Oracle R3 独立工具，仅主 Agent 可调）。
 * 评审者可经 plan_get 读取计划全文、经 plan_review 完成评审（reviewer 权限联动）。
 */
export const planAssignReviewerSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
  reviewerInstanceId: z
    .string()
    .describe('被指派评审者实例 id（ta_ 前缀，须属于任务团队未移除成员）'),
});

type PlanAssignReviewerArgs = z.infer<typeof planAssignReviewerSchema>;

/**
 * team_add_member：主 Agent 申请将 Agent 加入团队（L2 自治确认门，vteam-team-collaboration
 * Todo 8）。仅主 Agent 可调；创建平台 question 确认请求（question_confirm 确认门），用户
 * 确认后才会真正加入团队并写 team_add 审计。
 */
export const teamAddMemberSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方实例 id（ta_ 前缀，你的实例身份，由系统提示注入）'),
  agentId: z.string().describe('要加入团队的 Agent id'),
  alias: z.string().optional().describe('别名（缺省由服务端按角色生成）'),
  workDir: z.string().optional().describe('工作目录（缺省由服务端按角色生成）'),
});

type TeamAddMemberArgs = z.infer<typeof teamAddMemberSchema>;

/**
 * 构建工具集（service 闭包注入，controller 构造时调用一次）。
 * handler 签名 `(ctx, args)`：ctx.workerId 为 controller 透传的 header 值；
 * args 已在 tools/call 内经 inputSchema.safeParse 校验，此处收窄为具体类型。
 */
export function buildPlatformMcpTools(
  service: PlatformMcpService,
): PlatformMcpTool[] {
  return [
    {
      name: 'chat_history',
      description:
        '查询任务群聊的历史消息（按需拉取，替代自动注入的群聊历史）。返回消息数组 [{id, senderType, senderId, text, createdAt}]。',
      inputSchema: chatHistorySchema,
      handler: (ctx, args) =>
        service.chatHistory(ctx, args as ChatHistoryArgs),
    },
    {
      name: 'doclib',
      description:
        '查询任务产出物文档库。不传 artifactId 返回产出物清单；传 artifactId（+可选 version）返回指定版本全文/文件地址。',
      inputSchema: doclibSchema,
      handler: (ctx, args) => service.doclib(ctx, args as DoclibArgs),
    },
    {
      name: 'task_context',
      description:
        '查询任务概览（标题/描述/状态/主 Agent/背景文档）与团队实例成员列表（agentMembers 含实例 id/别名/模板 agent/角色/主标注）。返回 {id, title, description, status, mainAgentId, mainAgentInstanceId, backgroundDocs, channelId, agentMembers}。',
      inputSchema: taskContextSchema,
      handler: (ctx, args) => service.taskContext(ctx, args as TaskContextArgs),
    },
    {
      name: 'group_post',
      description:
        '向任务群聊发布消息（senderType=agent，发送者=你的实例 selfInstanceId）。fileRef 可选：命中该任务已归档产出物文件时作为群聊附件。返回 {messageId, channelId, attachment}。',
      inputSchema: groupPostSchema,
      handler: (ctx, args) => service.groupPost(ctx, args as GroupPostArgs),
    },
    {
      name: 'read_file',
      description:
        '读取文件内容。优先读取该任务已归档的产出物文件（agent 经 group_post 发送的文件已自动归档）；未归档时从执行该任务的 worker 工作区拉取。返回 {content, fileName, fileRef, source: "archive"|"worker"}。',
      inputSchema: readFileSchema,
      handler: (ctx, args) => service.readFile(ctx, args as ReadFileArgs),
    },
    {
      name: 'notify_agent',
      description:
        '向任务内的另一个实例定向发送消息并触发其执行（实例互 @，按 targetInstanceId 精确命中目标实例）。触发后目标实例会收到该消息并开始处理，结论通常经 group_post 发布到群聊。返回 {messageId, channelId, targetInstanceId}。',
      inputSchema: notifyAgentSchema,
      handler: (ctx, args) => service.notifyAgent(ctx, args as NotifyAgentArgs),
    },
    {
      name: 'submit_artifact',
      description:
        '提交产出物到任务文档库（发送者=你的实例 selfInstanceId）。type=text 直接提交内容；type=doc/file 提交工作目录文件（fileRef），自动从 worker 拉取并归档。返回 {artifactId, version, status: "created"|"appended"|"duplicate"}。',
      inputSchema: submitArtifactSchema,
      handler: (ctx, args) =>
        service.submitArtifact(ctx, args as SubmitArtifactArgs),
    },
    {
      name: 'issue_create',
      description:
        '在任务内创建 issue（需求/缺陷/优化协作，创建者=调用方实例）。返回创建的 issue DTO {id, taskId, taskTitle, title, description, status:"open", tags, assigneeInstanceId, assigneeAgentId, creatorAgentId, createdAt}。',
      inputSchema: issueCreateSchema,
      handler: (ctx, args) => service.issueCreate(ctx, args as IssueCreateArgs),
    },
    {
      name: 'issue_list',
      description:
        '查询任务内 issue 列表（可按 status 过滤，不含已删除）。返回该任务 issue DTO 数组 [{id, taskId, title, status, tags, assigneeInstanceId, assigneeAgentId, creatorAgentId, createdAt}]。',
      inputSchema: issueListSchema,
      handler: (ctx, args) => service.issueList(ctx, args as IssueListArgs),
    },
    {
      name: 'issue_get',
      description:
        '查询单个 issue 详情（任务成员可用，issue 须属于该任务）。返回 issue DTO（含描述/指派/创建者名/拒绝原因/操作记录 activities，操作记录含操作人 actorName）。',
      inputSchema: issueGetSchema,
      handler: (ctx, args) => service.issueGet(ctx, args as IssueGetArgs),
    },
    {
      name: 'issue_update',
      description:
        '更新 issue 的 title/description/tags（部分更新，只传要改的字段）。返回更新后的 issue DTO。',
      inputSchema: issueUpdateSchema,
      handler: (ctx, args) => service.issueUpdate(ctx, args as IssueUpdateArgs),
    },
    {
      name: 'issue_transition',
      description:
        '流转 issue 状态：start(open→in_progress)/resolve(in_progress→resolved)/close(resolved→closed)/reopen(closed|rejected→open)/reject(in_progress→rejected，必填 reason 拒绝原因)。返回更新后的 issue DTO；非法迁移返回错误。',
      inputSchema: issueTransitionSchema,
      handler: (ctx, args) =>
        service.issueTransition(ctx, args as IssueTransitionArgs),
    },
    {
      name: 'task_transition',
      description:
        '流转任务状态：start(pending→in_progress)/mark-pending-review(in_progress→pending_review)/accept(pending_review→completed)/reject(pending_review→in_progress，可附 reason)/archive(completed→archived)。仅主 Agent（mainAgentInstanceId）可调用，其余成员调用将被拒绝。返回更新后的任务 DTO；非法迁移返回错误。',
      inputSchema: taskTransitionSchema,
      handler: (ctx, args) =>
        service.taskTransition(ctx, args as TaskTransitionArgs),
    },
    {
      name: 'question_confirm',
      description:
        '托管模式下确认成员请求（仅主 Agent 可调用）：kind=question 传 answers（label 数组，answers=null 拒绝）；kind=permission 传 response(once/always/reject)。请求 requestId 来自托管确认消息。返回更新后的确认记录；非主实例调用将被拒绝。',
      inputSchema: questionConfirmSchema,
      handler: (ctx, args) =>
        service.questionConfirm(ctx, args as QuestionConfirmArgs),
    },
    {
      name: 'memory_save',
      description:
        '写入平台记忆（沉淀经验/结论/决策，供后续任务 memory_search 检索复用）。level=task 写当前任务级记忆；level=project 写当前任务所属项目级记忆（跨任务共享，projectId 由任务归属自动解析）；level=global 写全局记忆（仅主 Agent 可写）。返回 {memoryId, level}。',
      inputSchema: memorySaveSchema,
      handler: (ctx, args) => service.memorySave(ctx, args as MemorySaveArgs),
    },
    {
      name: 'memory_search',
      description:
        '检索平台记忆（按需检索，替代自动注入）。默认聚合当前任务可见的 task+project+global 三级记忆（已软删不返回），可按 query/level/tags 过滤，结果按创建时间倒序。返回 [{id, level, content, tags, createdBy, createdAt}]。',
      inputSchema: memorySearchSchema,
      handler: (ctx, args) => service.memorySearch(ctx, args as MemorySearchArgs),
    },
    {
      name: 'plan_submit',
      description:
        '提交执行计划（仅主 Agent 可调用）。plan 模式工作流：主 Agent 拆分实施步骤为计划子任务（六要素，what 必填）→ 评审通过后可实施。重复提交：已处于 rejected/completed 的旧计划将被覆盖重提（原评审者自动失效），否则 409。返回 {planId, status: "reviewing", taskCount}。',
      inputSchema: planSubmitSchema,
      handler: (ctx, args) => service.planSubmit(ctx, args as PlanSubmitArgs),
    },
    {
      name: 'plan_review',
      description:
        '评审执行计划（主 Agent 或已被指派的评审者可调用）。verdict=approved 通过后计划可实施；verdict=rejected 必须附 reason（驳回后可修改重提或切换 direct 模式）。评审完成后该计划的评审者身份即失效。返回 {planId, status: "approved"|"rejected"}。',
      inputSchema: planReviewSchema,
      handler: (ctx, args) => service.planReview(ctx, args as PlanReviewArgs),
    },
    {
      name: 'plan_task_transition',
      description:
        '流转计划子任务状态（子任务指派者或主 Agent 可调用）：in_progress/done/blocked/skipped。所有子任务均达终态（done/blocked/skipped）时自动在群聊提示可提交验收。返回 {planTaskId, status}。',
      inputSchema: planTaskTransitionSchema,
      handler: (ctx, args) =>
        service.planTaskTransition(ctx, args as PlanTaskTransitionArgs),
    },
    {
      name: 'team_view',
      description:
        '查询任务团队的实时视图（只读，无需 selfInstanceId）：成员列表（实例 id/agent id/别名/角色/序号/主标注 + 会话实时状态 sessionStatus/sessionId）+ 执行计划子任务分配概览 planSummary（total 总子任务数 / done 已终态 / pending 未完成）。返回 {taskId, members: [{id, agentId, alias, role, seq, main, sessionStatus, sessionId}], planSummary: {total, done, pending}}。',
      inputSchema: teamViewSchema,
      handler: (ctx, args) => service.teamView(ctx, args as TeamViewArgs),
    },
    {
      name: 'my_profile',
      description:
        '查询自身 Agent 配置（只读）：角色/权限范围 permissionScope/工具效应 toolEffects/默认模型 defaultModelId + 任务实例别名/序号/工作目录，prompt 仅返回前 500 字符摘要（promptSummary + promptTruncated，不暴露完整提示词）。返回自身配置视图。',
      inputSchema: myProfileSchema,
      handler: (ctx, args) => service.myProfile(ctx, args as MyProfileArgs),
    },
    {
      name: 'plan_get',
      description:
        '读取任务执行计划（只读，评审者读计划通道，无需 selfInstanceId）：计划头（含 reviewerInstanceId）+ 子任务清单全文（六要素 content + 指派概览）。返回 {id, taskId, title, summary, scopeIn, scopeOut, status, createdBy, reviewerInstanceId, createdAt, updatedAt, tasks: [{id, seq, title, content, assigneeInstanceId, assigneeAlias, assigneeName, status}]}。',
      inputSchema: planGetSchema,
      handler: (ctx, args) => service.planGet(ctx, args as PlanGetArgs),
    },
    {
      name: 'plan_assign_reviewer',
      description:
        '指派执行计划评审者（仅主 Agent 可调用）：写入计划评审者 + 群聊提示「已指派 <alias> 评审执行计划」。被指派评审者可经 plan_get 读取计划全文、经 plan_review 完成评审。返回 {planId, taskId, reviewerInstanceId, reviewerAlias}。',
      inputSchema: planAssignReviewerSchema,
      handler: (ctx, args) =>
        service.planAssignReviewer(ctx, args as PlanAssignReviewerArgs),
    },
    {
      name: 'team_add_member',
      description:
        '申请将 Agent 加入团队（仅主 Agent 可调用，L2 自治确认门）：创建用户确认请求（question_confirm 确认门，question 弹窗「是否确认」），用户确认后才真正加入团队并写 team_add 审计；重复申请（已加入/有 pending 申请）被拒绝。返回 {requestId, taskId, agentId, alias}。',
      inputSchema: teamAddMemberSchema,
      handler: (ctx, args) =>
        service.teamAddMember(ctx, args as TeamAddMemberArgs),
    },
  ];
}

/**
 * 从 zod shape 派生 JSON Schema（tools/list 的 inputSchema 字段）：
 * `{type:'object', properties:{k:{type:'string'|'number'}}, required:[非 optional]}`
 * 仅覆盖本工具集用到的 string/number/boolean/enum 基础类型（ZodOptional 已解包；
 * ZodEnum 归为 string）。
 */
export function zodObjectToJsonSchema(schema: z.ZodTypeAny): {
  type: 'object';
  properties: Record<string, { type: string }>;
  required: string[];
} {
  // zod v4 classic：z.object().refine() 返回仍是 ZodObject（refine 校验挂
  // _def.checks），shape 直接可访问，无需解包
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
  const properties: Record<string, { type: string }> = {};
  const required: string[] = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    let field: unknown = fieldSchema;
    const isOptional = (fieldSchema as z.ZodTypeAny).isOptional();
    if (fieldSchema instanceof z.ZodOptional) {
      field = fieldSchema._def.innerType;
    }
    let type: string;
    if (field instanceof z.ZodString) {
      type = 'string';
    } else if (field instanceof z.ZodNumber) {
      type = 'number';
    } else if (field instanceof z.ZodBoolean) {
      type = 'boolean';
    } else if (field instanceof z.ZodEnum) {
      type = 'string';
    } else if (field instanceof z.ZodArray) {
      type = 'array';
    } else {
      type = 'object';
    }
    properties[key] = { type };
    if (!isOptional) {
      required.push(key);
    }
  }

  return { type: 'object', properties, required };
}
