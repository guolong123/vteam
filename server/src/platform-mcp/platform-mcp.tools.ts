import { z } from 'zod';
import { ARTIFACT_CATEGORIES } from '../artifacts/artifacts.constants';
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
 * team-free-chat（todo-4）：任务/团队双上下文字段语义（5 个 team-free 工具共用）。
 * taskId 与 teamId 至少传一个（refine 在 zod 层保证，双空 → tools/call -32602）；
 * taskId 优先，无 taskId 时用 teamId 定位团队会话；两个维度之间无回退（mismatch → 403）。
 * delivery-family 工具（doclib、task_context、submit_artifact、issue 系列、
 * task_transition、question_confirm、team_view、my_profile 等）保持 taskId 必填，不用此语义.
 */
const OPTIONAL_TASK_ID_DESC =
  '任务 ID（与 teamId 至少传一个；taskId 优先，无 taskId 时用 teamId 定位团队会话）';
const TEAM_ID_DESC =
  '团队 ID（无 taskId 时用 teamId 定位团队会话；与 taskId 同传时 taskId 优先）';

/** 双上下文至少传一个（taskId 优先）。refine message 须含 'taskId'（controller.spec 断言）。 */
const REQUIRE_TASK_OR_TEAM_MSG =
  'taskId 与 teamId 至少传一个（taskId 优先，无 taskId 时用 teamId 定位团队会话）';

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

const chatHistorySchema = z
  .object({
    taskId: z.string().optional().describe(OPTIONAL_TASK_ID_DESC),
    teamId: z.string().optional().describe(TEAM_ID_DESC),
    teamMemberId: z
      .string()
      .optional()
      .describe(
        'DM 对端成员 id（tmm_ 前缀）：传即进 DM 模式，仅同团队且调用方为该私聊端点时可读（带审计），否则 403',
      ),
    selfInstanceId: z
      .string()
      .optional()
      .describe(
        '调用方成员 id（tmm_ 前缀）：DM 模式必填（实例级归属绑定，缺失/冒充 403）；群聊模式可选（传即按实例精确绑定）',
      ),
    sinceId: z
      .string()
      .optional()
      .describe(
        '游标：仅返回 id 大于该值的消息（正序续拉；不传游标默认取最近分页）',
      ),
    beforeId: z
      .string()
      .optional()
      .describe(
        '游标：仅返回 id 小于该值的消息（倒序翻页；与 sinceId 同传时 beforeId 决定倒序）',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('返回条数上限（默认 20，最大 100）'),
  })
  .refine((d) => !!d.taskId || !!d.teamId, {
    message: REQUIRE_TASK_OR_TEAM_MSG,
    path: ['taskId'],
  });

type ChatHistoryArgs = z.infer<typeof chatHistorySchema>;

const doclibSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  artifactId: z
    .string()
    .optional()
    .describe('产出物 ID（缺省返回该任务产出物清单）'),
  version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('版本号（缺省取 currentVersion）'),
});

type DoclibArgs = z.infer<typeof doclibSchema>;

const taskContextSchema = z.object({
  taskId: z.string().describe('任务 ID'),
});

type TaskContextArgs = z.infer<typeof taskContextSchema>;

const groupPostSchema = z
  .object({
    taskId: z.string().optional().describe(OPTIONAL_TASK_ID_DESC),
    teamId: z.string().optional().describe(TEAM_ID_DESC),
    selfInstanceId: z
      .string()
      .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
    content: z.string().describe('要发布到群聊的内容'),
    fileRef: z
      .string()
      .optional()
      .describe('产出物文件引用（与产出物声明 fileRef 一致时挂附件）'),
  })
  .refine((d) => !!d.taskId || !!d.teamId, {
    message: REQUIRE_TASK_OR_TEAM_MSG,
    path: ['taskId'],
  });

type GroupPostArgs = z.infer<typeof groupPostSchema>;

const readFileSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  fileRef: z
    .string()
    .describe('文件路径/引用（如 /tmp/opencode/x.txt 或产出物 fileRef）'),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024)
    .optional()
    .describe('最大读取字节数（默认 256KB，上限 1MB）'),
});

type ReadFileArgs = z.infer<typeof readFileSchema>;

const notifyAgentSchema = z
  .object({
    taskId: z.string().optional().describe(OPTIONAL_TASK_ID_DESC),
    teamId: z.string().optional().describe(TEAM_ID_DESC),
    selfInstanceId: z
      .string()
      .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
    targetInstanceId: z
      .string()
      .describe(
        '目标成员 id（tmm_ 前缀，见 task_context agentMembers / 团队提示，@ 定向触发目标）',
      ),
    content: z.string().describe('要发送给目标实例的消息内容'),
    issueId: z
      .string()
      .optional()
      .describe(
        '派活归属 issue id（is_ 前缀，可选；缺省不硬拦，返回 issueBound:false 提醒；传则 issueBound:true 并透传执行链路）',
      ),
    kind: z
      .enum(['execution', 'review', 'nudge', 'wake'])
      .optional()
      .describe(
        '执行分类（缺省 execution：任务维度下要求计划已确认进入 executing，否则 reason=plan-gated 被拦；review/nudge/wake 豁免门禁；review 派发词须带三元组 round + planVersion(+hash) + expected 名单，否则 reason=review-triplet 被拦；内部唤醒传 wake 且永不记账）',
      ),
    force: z
      .preprocess((v) => v === true || v === 'true', z.boolean())
      .optional()
      .describe(
        '强行绕过计划门禁/issue 锁（须同时给非空 forceReason 留审计行，否则仍被拦）',
      ),
    forceReason: z
      .string()
      .optional()
      .describe('force 绕过的审计原因（落回执行 forceReason 列）'),
    planHash: z
      .string()
      .optional()
      .describe(
        '调用方携带的计划哈希（planVersion.hash sha1-8 口径；执行认哈希：与冻结正式版哈希不一致即 reason=plan-gated 被拦并提示两边短哈希；缺省不查哈希）',
      ),
    receiptTimeoutMin: z
      .number()
      .optional()
      .describe(
        '回执超时分钟数（缺省 10，对齐被 @ 后 10 分钟回执规则；范围 1-1440，非法输入服务端回落缺省；仅 execution 派发记账并排平台自动催办 timer，review/nudge/wake 永不记账）',
      ),
  })
  .refine((d) => !!d.taskId || !!d.teamId, {
    message: REQUIRE_TASK_OR_TEAM_MSG,
    path: ['taskId'],
  });

type NotifyAgentArgs = z.infer<typeof notifyAgentSchema>;

const submitArtifactSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
  type: z
    .enum(['text', 'doc', 'file'])
    .describe(
      '产出物类型：text 直接提交内容；doc/file 提交工作目录文件（fileRef）',
    ),
  title: z.string().describe('产出物标题'),
  content: z.string().optional().describe('产出物内容（type=text 必填）'),
  fileRef: z
    .string()
    .optional()
    .describe('文件路径/引用（type=doc/file 必填，自动拉取并归档）'),
  category: z
    .enum(ARTIFACT_CATEGORIES)
    .optional()
    .describe(
      '分类标签（可选）：需求/设计/实现/测试用例/测试报告/运维/其他其一；不传为未分类',
    ),
});

type SubmitArtifactArgs = z.infer<typeof submitArtifactSchema>;

const issueCreateSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
  title: z.string().describe('issue 标题'),
  description: z.string().optional().describe('issue 描述（可选）'),
  tags: z
    .array(z.string())
    .optional()
    .describe('issue 标签（标识类型，如 需求/缺陷/优化）'),
  assigneeInstanceId: z
    .string()
    .optional()
    .describe('指派成员 id（tmm_ 前缀，须为任务归属团队成员；不传则不指派）'),
});

type IssueCreateArgs = z.infer<typeof issueCreateSchema>;

const issueListSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
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
    .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
  issueId: z.string().describe('issue ID'),
});

type IssueGetArgs = z.infer<typeof issueGetSchema>;

const issueUpdateSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
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
    .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
  issueId: z.string().describe('issue ID'),
  action: z
    .enum(['start', 'resolve', 'close', 'reopen', 'reject'])
    .describe(
      '状态流转动作：start 开始处理 / resolve 处理完成 / close 验收关闭 / reopen 重开 / reject 拒绝处理',
    ),
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
    .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
  action: z
    .enum(['start', 'mark-pending-review', 'reject'])
    .describe(
      '状态流转动作：start 开始 / mark-pending-review 提交验收 / reject 驳回。accept 验收通过与 archive 归档仅人类用户可在管理界面操作，Agent 不可调用（调用将被拒绝）；任务就绪后请向用户报告等待人工验收',
    ),
  reason: z
    .string()
    .optional()
    .describe('驳回原因（action=reject 时写入任务事件 metadata）'),
});

type TaskTransitionArgs = z.infer<typeof taskTransitionSchema>;

const questionConfirmSchema = z.object({
  // team-free-chat todo-4：question_confirm 保持 taskId 必填（agent_questions.task_id 非空，
  // 无团队维度可确认），不加入可选 5 工具。
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
  requestId: z
    .string()
    .describe('待确认请求 id（que_/per_ 前缀，来自托管确认消息）'),
  kind: z
    .enum(['question', 'permission'])
    .describe('请求类型：question=模型提问 / permission=工具权限确认'),
  answers: z
    .array(z.array(z.string()))
    .optional()
    .describe(
      'question 答复：label 数组（顺序对应问题）；answers=null 表示拒绝',
    ),
  response: z
    .enum(['once', 'always', 'reject'])
    .optional()
    .describe('permission 确认：once 允许一次 / always 总是允许 / reject 拒绝'),
});

type QuestionConfirmArgs = z.infer<typeof questionConfirmSchema>;

export const memorySaveSchema = z
  .object({
    taskId: z.string().optional().describe(OPTIONAL_TASK_ID_DESC),
    teamId: z.string().optional().describe(TEAM_ID_DESC),
    selfInstanceId: z
      .string()
      .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
    level: z
      .enum(['team', 'global'])
      .describe(
        '记忆级别：team=团队级（写入当前任务所属团队，跨任务共享）/ global=全局（仅主 Agent 可写）',
      ),
    content: z.string().min(1).max(20000).describe('记忆内容（1~20000 字符）'),
    description: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        '记忆摘要（1~255 字符，模型携带，用于列表首屏/索引，按需拉正文）',
      ),
    tags: z
      .array(z.string())
      .max(20)
      .optional()
      .describe('记忆标签（≤20 个，memory_search 按标签过滤命中）'),
  })
  .refine((d) => !!d.taskId || !!d.teamId, {
    message: REQUIRE_TASK_OR_TEAM_MSG,
    path: ['taskId'],
  });

type MemorySaveArgs = z.infer<typeof memorySaveSchema>;

export const memoryUpdateSchema = z
  .object({
    taskId: z.string().optional().describe(OPTIONAL_TASK_ID_DESC),
    teamId: z.string().optional().describe(TEAM_ID_DESC),
    selfInstanceId: z
      .string()
      .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
    memoryId: z.string().describe('记忆条目 id（me_ 前缀）'),
    content: z
      .string()
      .min(1)
      .max(20000)
      .optional()
      .describe('记忆内容（1~20000 字符，更新后同步重算去重键）'),
    description: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('记忆摘要（1~255 字符，不传则保留原摘要）'),
    tags: z
      .array(z.string())
      .max(20)
      .optional()
      .describe('记忆标签（≤20 个，全量替换）'),
  })
  .refine((d) => !!d.taskId || !!d.teamId, {
    message: REQUIRE_TASK_OR_TEAM_MSG,
    path: ['taskId'],
  })
  .refine(
    (d) =>
      d.content !== undefined ||
      d.description !== undefined ||
      d.tags !== undefined,
    {
      message: '至少提供 content/description/tags 之一',
      path: ['content'],
    },
  );

type MemoryUpdateArgs = z.infer<typeof memoryUpdateSchema>;

const memorySearchSchema = z
  .object({
    taskId: z.string().optional().describe(OPTIONAL_TASK_ID_DESC),
    teamId: z.string().optional().describe(TEAM_ID_DESC),
    query: z
      .string()
      .optional()
      .describe(
        '关键词过滤（content/description 包含即命中，多词空格分隔 AND）',
      ),
    level: z
      .enum(['team', 'global'])
      .optional()
      .describe('级别过滤（缺省聚合当前任务可见的 team+global 两级）'),
    tags: z
      .array(z.string())
      .optional()
      .describe('标签过滤（记忆 tags 须包含全部给定标签）'),
    sourceInstanceId: z
      .string()
      .optional()
      .describe('来源成员过滤（tmm_ 前缀，只看某团队成员沉淀的记忆）'),
    sourceAgentId: z
      .string()
      .optional()
      .describe('来源 Agent 过滤（a_ 前缀，只看某 Agent 模板沉淀的全部记忆）'),
    sessionId: z
      .string()
      .optional()
      .describe('会话过滤（s_ 前缀，只看某次会话沉淀的记忆）'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('返回条数上限（默认 20，最多 50，按创建时间倒序）'),
  })
  .refine((d) => !!d.taskId || !!d.teamId, {
    message: REQUIRE_TASK_OR_TEAM_MSG,
    path: ['taskId'],
  });

type MemorySearchArgs = z.infer<typeof memorySearchSchema>;

export const teamViewSchema = z.object({
  taskId: z.string().describe('任务 ID'),
});

type TeamViewArgs = z.infer<typeof teamViewSchema>;

/** my_profile：自身 Agent 配置视图（只读，prompt 仅返回摘要，不暴露完整提示词）。
 * team-free-chat todo-4：保持 task-bound（自身配置按任务实例快照查询），不加入可选 5 工具。 */
export const myProfileSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
});

type MyProfileArgs = z.infer<typeof myProfileSchema>;

/**
 * team_add_member：主 Agent 申请将 Agent 加入团队（L2 自治确认门，vteam-team-collaboration
 * Todo 8）。仅主 Agent 可调；创建平台 question 确认请求（question_confirm 确认门），用户
 * 确认后才会真正加入团队并写 team_add 审计。
 */
export const teamAddMemberSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
  agentId: z.string().describe('要加入团队的 Agent id'),
  alias: z.string().optional().describe('别名（缺省由服务端按角色生成）'),
  workDir: z.string().optional().describe('工作目录（缺省由服务端按角色生成）'),
});

type TeamAddMemberArgs = z.infer<typeof teamAddMemberSchema>;

/**
 * plan_mode：切换任务计划模式开关（仅主 Agent 可调）。
 * enabled=true → 主 Agent 先出计划文件（工作目录 `.opencode/plans/*.md`，计划 Tab 直接同步展示），
 * 其他成员只评审不起草；
 * enabled=false → 直接执行。agentName 可选：同步指定主 Agent 的执行 agent
 * （如切到 'build'；空串=回跟随默认；不传=保持当前选择）。
 */
export const planModeSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
  enabled: z
    .boolean()
    .describe('计划模式开关（true=开启，false=关闭/切回直接执行）'),
  agentName: z
    .string()
    .optional()
    .describe(
      '同步指定的主 Agent 执行 agent 名（如 build；空串=回跟随默认；不传=保持当前）',
    ),
});

type PlanModeArgs = z.infer<typeof planModeSchema>;

export const planCompleteSchema = z.object({
  taskId: z.string().describe('任务 ID'),
  selfInstanceId: z
    .string()
    .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
});

type PlanCompleteArgs = z.infer<typeof planCompleteSchema>;

const channelSendSchema = z.object({
  // team-free-chat todo-4：channel_send 无 taskId 入参（任务上下文由服务端按 worker 会话
  // 自动解析），不在可选 5 工具之列，保持原样。
  target: z
    .string()
    .min(1)
    .describe('Channel id or name (e.g., nc_xxxx or my-webhook)'),
  text: z.string().min(1).max(4000).describe('Markdown/text to send'),
});

type ChannelSendArgs = z.infer<typeof channelSendSchema>;

const wecomReplySchema = z
  .object({
    taskId: z.string().optional().describe('任务 ID（缺省自动解析当前任务）'),
    selfInstanceId: z
      .string()
      .optional()
      .describe('调用方成员 id（tmm_ 前缀，你的成员身份；缺省自动解析）'),
    msgtype: z
      .enum(['text', 'markdown', 'template_card', 'image', 'mpnews'])
      .optional()
      .describe(
        '消息类型：text/markdown 文本、template_card 卡片、image 图片、mpnews 图文（默认 text）。card/mpnews 图片均为可选 HTTPS URL，无本地文件要求。',
      ),
    text: z
      .string()
      .max(4000)
      .optional()
      .describe(
        '回复正文，支持 markdown，≤4000字。msgtype=text/markdown 时必填，template_card/image/mpnews 时可选（作为附带文本镜像群聊）',
      ),
    atUser: z
      .boolean()
      .optional()
      .describe(
        '是否@发送者（默认 true，群聊时 @，私聊直回；仅 text/markdown 生效）',
      ),
    card: z
      .any()
      .optional()
      .describe(
        '模板卡片 JSON（msgtype=template_card 时必填）：{card_type, main_title, button_list, task_id 等}，card_type+main_title 必填，icon_url/pic_url/image_url 等图片字段均可选不传也能发，参考 @wecom/aibot-node-sdk TemplateCard',
      ),
    media: z
      .string()
      .optional()
      .describe(
        '图片文件引用（msgtype=image 时必填其一：与 mediaId 二选一）：worker 工作区路径（如 /tmp/opencode/xxx.png）或已归档 fileRef/artifactId，服务端自动拉取并上传为 mediaId；仅 image 需要本地文件，card/mpnews 的 picurl 为可选 HTTPS URL',
      ),
    mediaId: z
      .string()
      .optional()
      .describe(
        '已上传媒体 ID（msgtype=image 时与 media 二选一，传 mediaId 则直接发送不再上传）',
      ),
    filename: z
      .string()
      .optional()
      .describe(
        '文件名（msgtype=image 时可选，上传时透传，如 image.png；缺省从 media 推断）',
      ),
    articles: z
      .array(
        z.object({
          title: z.string().min(1).describe('图文标题（必填）'),
          description: z.string().optional().describe('图文描述/摘要（可选）'),
          url: z.string().optional().describe('跳转链接（可选，HTTPS URL）'),
          picurl: z
            .string()
            .optional()
            .describe(
              '封面图片 URL（可选，HTTPS URL，无则不展示封面，不做上传）',
            ),
        }),
      )
      .optional()
      .describe(
        '图文 articles（msgtype=mpnews 时必填其一：与 mpnews 二选一；picurl 可选，缺省也能发）',
      ),
    mpnews: z
      .object({
        articles: z
          .array(
            z.object({
              title: z.string().min(1),
              thumb_media_id: z.string().optional(),
              author: z.string().optional(),
              content_source_url: z.string().optional(),
              content: z.string().optional(),
              digest: z.string().optional(),
              description: z.string().optional(),
              url: z.string().optional(),
              picurl: z.string().optional(),
            }),
          )
          .optional(),
      })
      .or(
        z.array(
          z.object({
            title: z.string().min(1),
            description: z.string().optional(),
            url: z.string().optional(),
            picurl: z.string().optional(),
          }),
        ),
      )
      .optional()
      .describe(
        'mpnews 原始体（兼容旧调用：{articles:[{title,digest,url,picurl}]} 或直接 articles 数组）；picurl 均为可选',
      ),
  })
  .refine(
    (data) => {
      const t = (data.msgtype ?? 'text') as string;
      if (t === 'text' || t === 'markdown') {
        return typeof data.text === 'string' && data.text.trim().length > 0;
      }
      return true;
    },
    {
      message: 'text 不能为空（msgtype=text/markdown 时必填）',
      path: ['text'],
    },
  );

type WecomReplyArgs = z.infer<typeof wecomReplySchema>;

/**
 * team-free-chat todo-4：task_create（主 Agent 在团队会话无任务时建任务）。
 * 团队由服务端按会话上下文解析（不接收入参，归属即团队，无项目维度）。
 */
const taskCreateSchema = z
  .object({
    taskId: z.string().optional().describe(OPTIONAL_TASK_ID_DESC),
    teamId: z.string().optional().describe(TEAM_ID_DESC),
    selfInstanceId: z
      .string()
      .describe(
        '调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入；仅主 Agent 可调）',
      ),
    title: z.string().min(1).max(128).describe('任务标题（必填）'),
    description: z.string().optional().describe('任务描述（可选）'),
    priority: z
      .string()
      .optional()
      .describe('优先级（high/medium/low，缺省 medium）'),
  })
  .refine((d) => !!d.taskId || !!d.teamId, {
    message: REQUIRE_TASK_OR_TEAM_MSG,
    path: ['taskId'],
  });

type TaskCreateArgs = z.infer<typeof taskCreateSchema>;

/**
 * skill_create（learning-mode P2）：主 Agent 沉淀新 SKILL.md（默认停用，
 * 人审后启用）。团队由双上下文解析（taskId 优先，无 taskId 时 teamId），
 * 主身份门在 service 内按 task.mainAgentInstanceId / team.mainAgentMemberId
 * 判定（对齐 task_create 的双维度主门语义）。
 * content 为 SKILL.md 全文（含 frontmatter，service 先 parse 400 再调
 * SkillsService.create，file 适配由 service 合成）。
 */
const skillCreateSchema = z
  .object({
    taskId: z.string().optional().describe(OPTIONAL_TASK_ID_DESC),
    teamId: z.string().optional().describe(TEAM_ID_DESC),
    selfInstanceId: z
      .string()
      .describe(
        '调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入；仅主 Agent 可调）',
      ),
    name: z.string().min(1).describe('技能名（小写字母数字，中划线分段）'),
    description: z.string().optional().describe('技能描述（可选）'),
    content: z.string().min(1).describe('SKILL.md 全文（含 YAML frontmatter）'),
  })
  .refine((d) => !!d.taskId || !!d.teamId, {
    message: REQUIRE_TASK_OR_TEAM_MSG,
    path: ['taskId'],
  });

type SkillCreateArgs = z.infer<typeof skillCreateSchema>;

/**
 * git_repos_list（T6 P6 读取补齐）：调用方被授权仓库只读清单。
 * task_create 式双上下文 + selfInstanceId（resolveExecContext 归属 + 冒充 403）；
 * 仅返回调用方模板 Agent 持有未吊销授权的行，脱敏（无凭证 key，repoUrl 敏感）。
 */
const gitReposListSchema = z
  .object({
    taskId: z.string().optional().describe(OPTIONAL_TASK_ID_DESC),
    teamId: z.string().optional().describe(TEAM_ID_DESC),
    selfInstanceId: z
      .string()
      .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
  })
  .refine((d) => !!d.taskId || !!d.teamId, {
    message: REQUIRE_TASK_OR_TEAM_MSG,
    path: ['taskId'],
  });

type GitReposListArgs = z.infer<typeof gitReposListSchema>;

/**
 * hook_register（trigger-unification todo-12：agent 自助"稍后唤醒我"）。
 * ownerInstanceId 故意不在 schema 内——服务端取自 resolveExecContext 的
 * callerId（防冒充）；channelId 同理由服务端解析（任务/团队群聊频道）。
 * targetInstanceId 可选（缺省唤醒调用方自身）；time 需 dueAt/delayMs 二选一，
 * all_idle 禁止带（refine 在 zod 层保证，失败 → tools/call -32602）。
 */
const hookRegisterSchema = z
  .object({
    taskId: z.string().optional().describe(OPTIONAL_TASK_ID_DESC),
    teamId: z.string().optional().describe(TEAM_ID_DESC),
    selfInstanceId: z
      .string()
      .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入；服务端以此作为 hook 所有者）'),
    kind: z
      .enum(['time', 'all_idle'])
      .describe(
        '唤醒类型：time=定时唤醒（需 dueAt/delayMs）/ all_idle=团队静默时唤醒（由全局 poll 评估）',
      ),
    wakeText: z
      .string()
      .min(1)
      .describe('唤醒词（下一轮被唤醒时带回的上下文，服务端截断 2000 字符）'),
    targetInstanceId: z
      .string()
      .optional()
      .describe(
        '被唤醒成员 id（tmm_ 前缀，须在当前团队；缺省为调用方自身）',
      ),
    dueAt: z
      .string()
      .optional()
      .describe('到期时刻（ISO 时间字符串，与 delayMs 二选一，仅 time 有效）'),
    delayMs: z
      .number()
      .positive()
      .optional()
      .describe('相对延迟毫秒（与 dueAt 二选一，仅 time 有效）'),
    expiresInMs: z
      .number()
      .positive()
      .optional()
      .describe('hook 生命周期毫秒（缺省 24h；到期未触发则 expired）'),
    graceMs: z
      .number()
      .positive()
      .optional()
      .describe('静默宽限毫秒（仅 all_idle 有效，缺省服务端 4min）'),
    dedupKey: z
      .string()
      .optional()
      .describe('幂等注册键（缺省服务端组装；重复注册幂等直返既有行）'),
  })
  .refine((d) => !!d.taskId || !!d.teamId, {
    message: REQUIRE_TASK_OR_TEAM_MSG,
    path: ['taskId'],
  })
  .refine(
    (d) =>
      d.kind === 'all_idle' ||
      (d.dueAt !== undefined || d.delayMs !== undefined),
    {
      message: 'time hook 必须带 dueAt 或 delayMs（到期唤醒时刻）',
      path: ['dueAt'],
    },
  )
  .refine(
    (d) =>
      d.kind === 'time' ||
      (d.dueAt === undefined && d.delayMs === undefined),
    {
      message: 'all_idle hook 不接受 dueAt/delayMs（静默由全局 poll 评估）',
      path: ['dueAt'],
    },
  )
  .refine((d) => d.dueAt === undefined || d.delayMs === undefined, {
    message: 'dueAt 与 delayMs 二选一，不可同传',
    path: ['delayMs'],
  });

type HookRegisterArgs = z.infer<typeof hookRegisterSchema>;

/**
 * hook_cancel（trigger-unification todo-12：取消自己的 hook）。
 * hookId 与 dedupKey 至少传一个；服务端复核调用方为 hook 所有者或是执行
 * 团队主 Agent（否则 403），hook 归属团队必须等于执行团队（跨团队 403）。
 */
const hookCancelSchema = z
  .object({
    taskId: z.string().optional().describe(OPTIONAL_TASK_ID_DESC),
    teamId: z.string().optional().describe(TEAM_ID_DESC),
    selfInstanceId: z
      .string()
      .describe('调用方成员 id（tmm_ 前缀，你的成员身份，由系统提示注入）'),
    hookId: z.string().optional().describe('hook id（hks_ 前缀）'),
    dedupKey: z.string().optional().describe('注册幂等键（与 hookId 二选一）'),
  })
  .refine((d) => !!d.taskId || !!d.teamId, {
    message: REQUIRE_TASK_OR_TEAM_MSG,
    path: ['taskId'],
  })
  .refine((d) => !!d.hookId || !!d.dedupKey, {
    message: 'hookId 与 dedupKey 至少传一个',
    path: ['hookId'],
  });

type HookCancelArgs = z.infer<typeof hookCancelSchema>;

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
        '查询任务群聊的历史消息（按需拉取，替代自动注入的群聊历史）。分页返回 {items, truncated, total}：默认取最近 20 条，beforeId 倒序翻页；响应超 64KB 自动截断并标记 truncated。',
      inputSchema: chatHistorySchema,
      handler: (ctx, args) => service.chatHistory(ctx, args as ChatHistoryArgs),
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
        '向任务群聊发布消息（triggerless：仅落库+广播，返回 {messageId, channelId, attachment}，无 triggered 字段；@ 提及的内部触发不向调用方返回状态，需要触发状态请用 notify_agent）。senderType=agent，发送者=你的实例 selfInstanceId。用于内部群聊沟通，不用于回复企微用户（企微消息请用 wecom_reply）。fileRef 可选：命中该任务已归档产出物文件时作为群聊附件。',
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
        '向任务内的另一个实例定向发送消息并触发其执行（实例互 @，按 targetInstanceId 精确命中目标实例）。团队维度（teamId、无任务）同样触发目标成员执行。触发后目标实例会收到该消息并开始处理，结论通常经 group_post 发布到群聊。统一返回契约 {messageId, channelId, targetInstanceId, triggered, reason, issueBound, origMessageId?}：reason 词汇 ok|duplicate|throttled|plan-gated|review-triplet（成功 reason=ok；被 @ storm 节流 triggered=false+reason=throttled，消息仍已发布；kind=review 缺三元组 triggered=false+reason=review-triplet+精确 hint，修订不开始）。issueId 可选：派活归属 issue，缺省返回 issueBound:false（提醒，不硬拦），传则 issueBound:true 并透传执行链路。',
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
        '流转任务状态：start(pending→in_progress)/mark-pending-review(in_progress→pending_review)/reject(pending_review→in_progress，可附 reason)。仅主 Agent（mainAgentInstanceId）可调用，其余成员调用将被拒绝。accept 验收通过与 archive 归档仅人类用户可在管理界面操作，Agent 调用将被拒绝（任务就绪后请报告等待人工验收）。返回更新后的任务 DTO；非法迁移返回错误。',
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
        '写入平台记忆（只存可复用经验，禁存会话总结/流水账/一次性结论）。可存三类：howto=怎么做（有效路径/命令/配置）、pitfall=坑与规避（错误原因+规避动作）、constraint=平台硬约束。content 写「场景 + 做法/坑 + 规避动作」。level=team 跨任务复用（teamId 从任务或团队上下文自动解析）；level=global 平台通用（仅主 Agent 可写）。description 30字摘要（缺省回落 content 截断）。内容完全重复（同级同归属同去重键）直接返回既有条目 status:"duplicate"，不新增。返回 {memoryId, level, status:"created"|"duplicate"}。',
      inputSchema: memorySaveSchema,
      handler: (ctx, args) => service.memorySave(ctx, args as MemorySaveArgs),
    },
    {
      name: 'memory_update',
      description:
        '按 id 更新平台记忆（content/description/tags 部分更新，至少传一个；content 更新同步重算去重键）。team 级记忆仅归属团队可改（跨团队 403）；global 级仅主 Agent 可改；已删除条目 404。返回 {memoryId, level, status:"updated"}。',
      inputSchema: memoryUpdateSchema,
      handler: (ctx, args) =>
        service.memoryUpdate(ctx, args as MemoryUpdateArgs),
    },
    {
      name: 'memory_search',
      description:
        '检索平台记忆（按需检索，替代自动注入）。默认聚合当前任务可见的 team+global 两级记忆（已软删不返回），可按 query(level/content/description)/tags 过滤，结果按创建时间倒序。返回 [{id, level, content, description, tags, createdBy, createdAt}]。首屏用 description 索引，按需拉 content。',
      inputSchema: memorySearchSchema,
      handler: (ctx, args) =>
        service.memorySearch(ctx, args as MemorySearchArgs),
    },
    {
      name: 'team_view',
      description:
        '查询任务团队的实时视图（只读，无需 selfInstanceId）：成员列表（实例 id/agent id/别名/角色/序号/主标注 + 会话实时状态 sessionStatus/sessionId）。返回 {taskId, members: [{id, agentId, alias, role, seq, main, sessionStatus, sessionId}]}。',
      inputSchema: teamViewSchema,
      handler: (ctx, args) => service.teamView(ctx, args as TeamViewArgs),
    },
    {
      name: 'my_profile',
      description:
        '查询自身 Agent 配置（只读）：生效权限 effectivePermission（唯一事实来源，经 ExecutionPolicy 按绑定策略解析：policyId/policyName/agentName[vteam-<role>]/permission[opencode 原生]/correction[guard]，与 live enforcement 同源，自审计以此为准；未绑定策略时为 null）+ 任务实例别名/序号/工作目录/默认模型 defaultModelId，prompt 仅返回前 500 字符摘要（promptSummary + promptTruncated，不暴露完整提示词）。返回自身配置视图。',
      inputSchema: myProfileSchema,
      handler: (ctx, args) => service.myProfile(ctx, args as MyProfileArgs),
    },
    {
      name: 'team_add_member',
      description:
        '申请将 Agent 加入团队（仅主 Agent 可调用，L2 自治确认门）：创建用户确认请求（question_confirm 确认门，question 弹窗「是否确认」），用户确认后才真正加入团队并写 team_add 审计；重复申请（已加入/有 pending 申请）被拒绝。返回 {requestId, taskId, agentId, alias}。',
      inputSchema: teamAddMemberSchema,
      handler: (ctx, args) =>
        service.teamAddMember(ctx, args as TeamAddMemberArgs),
    },
    {
      name: 'plan_mode',
      description:
        '切换任务计划模式开关（仅主 Agent 可调用）：enabled=true 开启（主 Agent 先出计划文档，其他成员只评审不起草）；enabled=false 关闭切回直接执行。agentName 可选同步指定主 Agent 的执行 agent（如 build；空串=回跟随默认；不传=保持当前）。返回 {taskId, planMode, agentName}。',
      inputSchema: planModeSchema,
      handler: (ctx, args) => service.planMode(ctx, args as PlanModeArgs),
    },
    {
      name: 'plan_complete',
      description:
        '标记计划执行完成（executing→completed，仅主 Agent 可调用）。执行交付齐后调用，推动计划状态机闭环；已 completed 幂等返回；非 executing 态报错。返回 {taskId, status, idempotent}。',
      inputSchema: planCompleteSchema,
      handler: (ctx, args) =>
        service.planComplete(ctx, args as PlanCompleteArgs),
    },
    {
      name: 'channel_send',
      description:
        'Agent-decided outbound notification: send text/markdown to a notification channel bound to the current task (webhook/wecom_group_robot). This is the SOLE way to trigger outbound webhook notifications — auto-push on task status/agent reply is disabled. Decide when to notify based on task context.',
      inputSchema: channelSendSchema,
      handler: (ctx, args) => service.channelSend(ctx, args as ChannelSendArgs),
    },
    {
      name: 'wecom_reply',
      description:
        '回复企业微信私聊或群@消息（唯一 conversational 回流入企微入口，通过 wecom_aibot 长连接）。支持类型：msgtype=text|markdown|template_card|image|mpnews（默认 text）。text/markdown 走 replyStream/finishStream 替换占位并镜像群聊；template_card 需 card JSON（card_type+main_title 必填，icon_url/pic_url/image_url 等图片字段均为可选不传也能发：如 {card_type:"text_notice", main_title:{title:"标题"}} 即可），优先 replyTemplateCard/被动回复否则 sendMessage 主动推送；image 需 media(文件路径/fileRef, 仅此类型需本地文件) 或 mediaId 二选一 + 可选 filename；mpnews 图文需 articles 或 mpnews 二选一（每篇仅 title 必填，picurl/description/url 均可选，无 picurl 也能发，自动映射为 news_notice 卡片无需上传）。\n\n【msgtype 选型指南｜何时用哪种】\n| msgtype | 适用场景 | 典型例子 | 媒体/图片说明 |\n| text | 私聊/群@ 简单文本回复，无格式需求 | 问候、确认、简短答复、状态回告 | 无图片 |\n| markdown | 需要格式化、链接、列表、代码块的回复 | 带链接的说明、分步骤列表、富文本答复 | 无图片 |\n| template_card | 需交互（按钮/跳转/投票）或结构化展示 | 审批/确认按钮、投票、通知卡片；4类 card_type：text_notice(通知)、news_notice(单图文)、button_interaction(交互按钮)、vote_interaction(投票) | card 内 pic_url/image_url/icon_url 均为可选 HTTPS URL，不传也能发 |\n| image | 需发送图片（图表、截图、可视化结果） | 生成的图表、截图、二维码 | 仅此类型需本地文件：media(工作区路径/fileRef) 或 mediaId 二选一，服务端自动上传 |\n| mpnews | 需发送多图文消息 | 文档列表、新闻推送、多文章合集 | articles 每篇仅 title 必填，picurl/description/url 均为可选 HTTPS URL，无 picurl 也能发，无需上传 |\n\n常见会话场景：私聊直回（atUser 忽略直回发送者）、群聊 @回复（atUser=true 自动 @发送者）、卡片交互回调后更新/再发卡片、图文推送。不要用 channel_send/group_post 回复企微用户。\n\n示例：{msgtype:"template_card", card:{card_type:"text_notice", main_title:{title:"标题"}}}；{msgtype:"mpnews", articles:[{title:"标题", description:"摘要", url:"https://example.com"}]}。',
      inputSchema: wecomReplySchema,
      handler: (ctx, args) => service.wecomReply(ctx, args as WecomReplyArgs),
    },
    {
      name: 'task_create',
      description:
        '在团队会话无任务时创建任务（仅主 Agent 可调）。团队由当前会话解析，任务建在该团队下。返回创建的任务 DTO。',
      inputSchema: taskCreateSchema,
      handler: (ctx, args) => service.taskCreate(ctx, args as TaskCreateArgs),
    },
    {
      name: 'skill_create',
      description:
        '沉淀新技能 SKILL.md（仅主 Agent 可调，默认停用，需人审启用）。content 为 SKILL.md 全文（含 frontmatter）；name/description 声明技能元信息。返回创建的技能行（含 id/name/enabled=false）。',
      inputSchema: skillCreateSchema,
      handler: (ctx, args) => service.skillCreate(ctx, args as SkillCreateArgs),
    },
    {
      name: 'git_repos_list',
      description:
        '查询调用方被授权的 git 仓库只读清单（仅返回调用方持有未吊销授权的行；脱敏，无凭证 key 明文，repoUrl 敏感仅授权可见）。返回 {repos: [{id, repoUrl, credentialName, authType, fingerprint, permission, effect}]}。',
      inputSchema: gitReposListSchema,
      handler: (ctx, args) =>
        service.gitReposList(ctx, args as GitReposListArgs),
    },
    {
      name: 'hook_register',
      description:
        '注册稍后唤醒（agent 自助 delay/wake）：time=到期在同会话唤醒（需 dueAt/delayMs 二选一），all_idle=团队静默时唤醒（全局 poll 评估）。所有者=调用方自身（服务端取身份，防冒充）。返回 {hookId, status, kind, dueAt, expiresAt}。',
      inputSchema: hookRegisterSchema,
      handler: (ctx, args) =>
        service.hookRegister(ctx, args as HookRegisterArgs),
    },
    {
      name: 'hook_cancel',
      description:
        '取消 hook（按 hookId 或 dedupKey；仅所有者或主 Agent 可取消，已终态行幂等直返）。返回 {hookId, status}。',
      inputSchema: hookCancelSchema,
      handler: (ctx, args) => service.hookCancel(ctx, args as HookCancelArgs),
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
