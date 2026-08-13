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
    .describe('状态流转动作：start 开始处理 / resolve 处理完成 / close 验收关闭 / reopen 重开 / reject 驳回'),
});

type IssueTransitionArgs = z.infer<typeof issueTransitionSchema>;

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
        '查询单个 issue 详情（任务成员可用，issue 须属于该任务）。返回 issue DTO（含描述/指派/创建者名）。',
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
        '流转 issue 状态：start(open→in_progress)/resolve(in_progress→resolved)/close(resolved→closed)/reopen(closed→open)/reject(in_progress→open)。返回更新后的 issue DTO；非法迁移返回错误。',
      inputSchema: issueTransitionSchema,
      handler: (ctx, args) =>
        service.issueTransition(ctx, args as IssueTransitionArgs),
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
