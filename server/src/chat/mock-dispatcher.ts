import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  AgentReply,
  DispatchRequest,
  DispatchResult,
  MessageDispatcher,
} from './message-dispatcher';

/** 消息主键前缀：与 ChatService 共享 IdGeneratorService 的 'm' 计数（重启续号同源）。 */
const MESSAGE_ID_PREFIX = 'm';

/** 回复延迟下界（毫秒），默认 1s。 */
export const MOCK_DELAY_MS = 1000;
/** 回复延迟随机区间（毫秒），默认 2s → 实际延迟 1~3s；为 0 时延迟固定 MOCK_DELAY_MS。 */
export const MOCK_DELAY_RANGE_MS = 2000;

/**
 * 确定性哈希（同输入同输出，供模板选择；无第三方依赖）。
 * 中文按 UTF-16 code unit 累乘取模，任何输入都返回稳定整数。
 */
export function hashText(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * 四类角色确定性回复模板（16 篇 §3~§6 角色定位 + 14 篇 §4.1）：
 * 固定文案不随机，每条 2 句；模板数组按输入哈希确定选一条 → 同输入同输出（可断言）。
 * role 从 agentId 解析（seed 契约 a_<role>：a_product/a_architect/a_developer/a_tester），
 * 未知角色走 DEFAULT_REPLY_TEMPLATES 兜底。
 */
const ROLE_REPLY_TEMPLATES: Record<string, string[]> = {
  product: [
    '需求已明确，输出需求文档要点与验收标准：已按功能边界拆解需求，整理为可执行的条目清单。',
    '收到需求说明，正在梳理功能优先级与验收标准，稍后输出完整需求文档。',
  ],
  architect: [
    '技术方案评估完成，输出设计文档与方案评审结论：已权衡可选方案，确定推荐实现路径。',
    '收到，已推演技术方案并对比取舍，输出设计文档与评审结论供成员确认。',
  ],
  developer: [
    '实现方案确认，输出实现代码与说明：按已定方案完成编码，附实现说明与排查结论。',
    '收到，已按技术方案完成实现并自检，输出实现代码与说明。',
  ],
  tester: [
    '测试用例设计完成，输出测试用例与验证结论：已穷举正常流、边界值与异常输入场景。',
    '收到，已设计测试用例并覆盖边界场景，输出验证结论供成员判定。',
  ],
};

const DEFAULT_REPLY_TEMPLATES = [
  '已收到你的消息，正在整理处理结论，稍后输出。',
  '收到，已记录需求要点并整理结论，见下方回复。',
];

/** agentId → 角色：a_<role> 前缀契约；无前缀时按原样解析。 */
function roleOf(agentId: string): string {
  return agentId.startsWith('a_') ? agentId.slice(2) : agentId;
}

/** 确定性选模板：按输入哈希取模（同输入同输出，不随机）。 */
function templateFor(agentId: string, text: string): string {
  const templates =
    ROLE_REPLY_TEMPLATES[roleOf(agentId)] ?? DEFAULT_REPLY_TEMPLATES;
  return templates[hashText(text) % templates.length];
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Phase 2 mock 分派器（18 篇 §6.2「worker 侧分派用 mock 模式」）：
 * 对每个 dispatched 目标模拟完整 SSE 时序（09 篇 §4.2 / FR-20/21）——
 * 1~3s 延迟（delayMs + [0, delayRangeMs)，公开字段可在测试/配置中覆盖为短延迟）
 * → agent.loading（phase=thinking → operating，scope=task）
 * → 确定性角色模板回复落库（senderType=agent）
 * → 广播 chat.message.new（scope=channel，final 替代 Loading 指示器）。
 *
 * 实现 MessageDispatcher 抽象（含 onLoading/onFinal/onError 回调契约）：chat.module.ts
 * 以 useClass 接入；Phase 4 替换为 WorkerDispatcher（18 篇 §8.3 真实 WorkerClient 下发
 * /prompt → task.completed 回流）时消息链路零改动——dispatch 返回空数组、回复经 SSE 回流，
 * 回调契约不变（WorkerDispatcher 在对应时序点同样 emitLoading/emitFinal/emitError）。
 *
 * ⚠️ 构造器只注入 DI 可解析的服务：延迟参数不能放构造器（TS number 类型运行时是
 * Number 元数据，Nest 会当成注入 token 而启动失败），故做成公开可配置字段。
 */
@Injectable()
export class MockDispatcher extends MessageDispatcher {
  private readonly logger = new Logger(MockDispatcher.name);

  /** 延迟注入点（公开字段，默认 1~3s）：测试实例化后直接赋值短延迟或 0（与 fake timers 二选一）。 */
  public delayMs: number = MOCK_DELAY_MS;
  public delayRangeMs: number = MOCK_DELAY_RANGE_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
  ) {
    super();
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    // 1. 模拟 LLM 处理延迟（默认 1~3s；可配置）
    await sleep(this.delayMs + Math.random() * this.delayRangeMs);

    // 2~5. 逐目标：loading 两阶段 → 确定性回复落库 + 广播（串行保序，单 Agent 失败不阻塞其他）
    const replies: AgentReply[] = [];
    for (const target of request.targets) {
      try {
        replies.push(await this.replyFor(request, target));
      } catch (err) {
        this.logger.error(
          `agent ${target.agentId} mock reply failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        this.emitError({
          taskId: request.taskId,
          agentId: target.agentId,
          error: (err as Error).message,
        });
      }
    }
    return { replies };
  }

  /** 单目标时序：loading(thinking) → loading(operating) → 落库 → 广播 chat.message.new。 */
  private async replyFor(request: DispatchRequest, target: {
    agentId: string;
    sessionId: string | null;
  }): Promise<AgentReply> {
    const { taskId, channelId } = request;

    // 2. Loading 两阶段（FR-20 两阶段指示器，scope=task；不流式 parts）
    await this.realtime.broadcast(
      EVENT_TYPES.AGENT_LOADING,
      { taskId, agentId: target.agentId, sessionId: target.sessionId, phase: 'thinking' },
      { type: 'task', id: taskId },
    );
    this.emitLoading({
      taskId,
      agentId: target.agentId,
      sessionId: target.sessionId,
      phase: 'thinking',
    });
    await this.realtime.broadcast(
      EVENT_TYPES.AGENT_LOADING,
      { taskId, agentId: target.agentId, sessionId: target.sessionId, phase: 'operating' },
      { type: 'task', id: taskId },
    );
    this.emitLoading({
      taskId,
      agentId: target.agentId,
      sessionId: target.sessionId,
      phase: 'operating',
    });

    // 3. 确定性模板回复（按角色，同输入同输出）
    const text = templateFor(target.agentId, request.text);

    // 4. 落库（senderType=agent，status=sent；对齐 ChatService 第 8 步收敛契约）
    const message = await this.prisma.message.create({
      data: {
        id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
        channelId,
        senderType: SENDER_TYPE.agent,
        senderId: target.agentId,
        content: { text, parts: [] } as Prisma.InputJsonValue,
        mentions: null,
        status: MESSAGE_STATUS.sent,
      },
    });

    // 5. 广播 final 回复（scope=channel；先落库后转发，08 篇 §7.3）
    await this.realtime.broadcast(
      EVENT_TYPES.CHAT_MESSAGE_NEW,
      { message: this.toMessageDto(message) },
      { type: 'channel', id: channelId },
    );
    this.emitFinal({
      taskId,
      agentId: target.agentId,
      messageId: message.id,
      text,
    });

    return { agentId: target.agentId, text };
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
