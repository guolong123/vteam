import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { CHANNEL_TYPE, EVENT_TYPES } from '../common/constants/event.constants';
import { TASK_STATUS } from '../common/constants/task.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEvent, RealtimeService } from '../realtime/realtime.service';

/** 巡检间隔 ms（env PROGRESSION_INTERVAL_MS，缺省 5min）。 */
export const DEFAULT_PROGRESSION_INTERVAL_MS = 5 * 60_000;
/** 巡检轮次上限（env PROGRESSION_MAX_ROUNDS，缺省 12；达到后注销 + 告警防空转）。 */
export const DEFAULT_PROGRESSION_MAX_ROUNDS = 12;
/** 巡检扫描周期 ms（仿 IDLE_SCAN_INTERVAL_MS 模式，缺省 30s；公开便于测试覆盖）。 */
export const PROGRESSION_SCAN_INTERVAL_MS = 30_000;

/** 循环表条目：nextRunAt 下次触发时间戳、rounds 已巡检轮次、maxRounds 轮次上限。 */
interface ProgressionEntry {
  taskId: string;
  nextRunAt: number;
  rounds: number;
  maxRounds: number;
}

/** 巡检消息 prompt（引导而非写死动作——主 Agent 经 MCP 工具自主决策）。 */
export function buildProgressionPrompt(title: string, status: string): string {
  return (
    `【任务巡检】任务 <${title}> 当前状态 <${status}>。请检查：` +
    '① 各 issue 完成度 ② 产出物是否齐全 ③ 团队进展；' +
    '若存在卡点（成员未响应/依赖缺失/issue 未解决），通过 notify_agent 或群聊 @ 定向通知对应成员推进；' +
    '若全部工作完成，调用 task_transition mark-pending-review 提交验收；如尚未完成请说明当前进展与下一步。'
  );
}

/**
 * 任务巡检调度器 + 托管确认路由（one_off 巡检，pending_review 即停）。
 *
 * 功能 1（主 Agent 定期巡检）：内存循环表 `Map<taskId, ProgressionEntry>` + setInterval
 * 扫描（仿 worker-dispatcher IDLE_SCAN_INTERVAL_MS 惰性启动模式）：
 * - register(taskId)：任务进入 in_progress（start/reject）时注册；onModuleInit 扫描库内
 *   in_progress 任务重建（防重启丢循环）。
 * - unregister(taskId)：任务离开 in_progress（pending_review/completed/archived/rejected）时注销。
 * - 扫描：nextRunAt <= now && 任务 status=in_progress && 主 Agent 存在 → dispatch 巡检消息给
 *   主 Agent 会话（复用 WorkerDispatcher.dispatchAgentMention 现有链路）→ nextRunAt += interval、
 *   rounds++。任务状态非 in_progress / 无主实例 → 注销；rounds >= maxRounds → 注销 + 告警。
 *
 * 功能 2（托管确认路由）：订阅 realtime bus 的 agent.question 事件，payload.managed=true 且
 * 未收敛（resolved≠true）→ dispatch 确认请求消息给主 Agent（question_confirm 决策指令）。
 */
@Injectable()
export class TaskProgressionScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TaskProgressionScheduler.name);

  /** 内存循环表：taskId → 巡检条目。 */
  private readonly loop = new Map<string, ProgressionEntry>();

  /** 巡检间隔 ms（env PROGRESSION_INTERVAL_MS，缺省 5min；公开便于测试覆盖）。 */
  public progressionIntervalMs: number;
  /** 巡检轮次上限（env PROGRESSION_MAX_ROUNDS，缺省 12）。 */
  public maxRounds: number;

  /** 扫描定时器（惰性启动：首个 register 时）。 */
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  /** realtime bus 订阅取消函数（托管确认请求路由）。 */
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly workerDispatcher: WorkerDispatcher,
    config: ConfigService,
  ) {
    // env 经 ConfigService 返回字符串，Number() 归一（非法/缺省 → 默认值）
    const interval = Number(config.get('PROGRESSION_INTERVAL_MS'));
    this.progressionIntervalMs =
      Number.isFinite(interval) && interval > 0
        ? interval
        : DEFAULT_PROGRESSION_INTERVAL_MS;
    const rounds = Number(config.get('PROGRESSION_MAX_ROUNDS'));
    this.maxRounds =
      Number.isFinite(rounds) && rounds > 0
        ? rounds
        : DEFAULT_PROGRESSION_MAX_ROUNDS;
  }

  async onModuleInit(): Promise<void> {
    // 防重启丢循环：扫描库内 in_progress 任务重建循环表
    await this.restoreInProgressTasks();
    // 托管模式确认请求路由：订阅 realtime bus 的 agent.question 事件（payload.managed=true）
    this.unsubscribe = this.realtime.subscribe((event) => {
      if (event.type !== EVENT_TYPES.AGENT_QUESTION) {
        return;
      }
      void this.routeManagedQuestion(event).catch((err: unknown) =>
        this.logger.error(`托管确认路由失败: ${this.describeError(err)}`),
      );
    });
    this.ensureScan();
  }

  onModuleDestroy(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * 任务进入 in_progress 时注册（start/reject）。幂等：重复注册重置计时（重新进入巡检周期）。
   * 非 in_progress 或主 Agent 缺失 → 注销（防脏条目）。
   */
  async register(taskId: string): Promise<void> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, status: true, mainAgentInstanceId: true },
    });
    if (
      !task ||
      task.status !== TASK_STATUS.in_progress ||
      !task.mainAgentInstanceId
    ) {
      this.loop.delete(taskId);
      return;
    }
    this.loop.set(taskId, {
      taskId,
      nextRunAt: Date.now() + this.progressionIntervalMs,
      rounds: 0,
      maxRounds: this.maxRounds,
    });
    this.logger.log(
      `[progression] 注册巡检 taskId=${taskId}（interval=${this.progressionIntervalMs}ms, maxRounds=${this.maxRounds}）`,
    );
    this.ensureScan();
  }

  /** 任务离开 in_progress（pending_review/completed/archived/rejected）时注销。 */
  unregister(taskId: string): void {
    if (this.loop.delete(taskId)) {
      this.logger.log(`[progression] 注销巡检 taskId=${taskId}`);
    }
  }

  /** 是否在巡检循环中（spec 断言用）。 */
  isRegistered(taskId: string): boolean {
    return this.loop.has(taskId);
  }

  /** 主动触发一次巡检（真实链路验证用）：跳过 nextRunAt 判定直接 dispatch + 轮次累计。 */
  async patrolNow(taskId: string): Promise<void> {
    const entry = this.loop.get(taskId);
    if (!entry) {
      return;
    }
    await this.runPatrol(taskId);
    entry.rounds += 1;
    entry.nextRunAt = Date.now() + this.progressionIntervalMs;
    if (entry.rounds >= entry.maxRounds) {
      this.loop.delete(taskId);
      this.logger.warn(
        `[progression] taskId=${taskId} 巡检已达轮次上限（${entry.maxRounds}），注销防空转`,
      );
    }
  }

  /** 惰性启动扫描定时器（仿 IDLE_SCAN_INTERVAL_MS 模式；unref 防阻塞进程退出）。 */
  private ensureScan(): void {
    if (this.scanTimer) {
      return;
    }
    this.scanTimer = setInterval(() => {
      void this.scan().catch((err: unknown) =>
        this.logger.error(`[progression] 巡检扫描失败: ${this.describeError(err)}`),
      );
    }, PROGRESSION_SCAN_INTERVAL_MS);
    this.scanTimer.unref?.();
  }

  /** 扫描：遍历循环表，nextRunAt <= now 的条目触发巡检（状态检测 → dispatch → 轮次累计）。 */
  private async scan(): Promise<void> {
    const now = Date.now();
    for (const [taskId, entry] of [...this.loop]) {
      if (entry.nextRunAt > now) {
        continue;
      }
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { title: true, status: true, mainAgentInstanceId: true },
      });
      // 状态检测：任务不存在 / 非 in_progress → 注销（不 dispatch）
      if (!task || task.status !== TASK_STATUS.in_progress) {
        this.unregister(taskId);
        continue;
      }
      // 主 Agent 缺失（团队调整移除主实例）→ 注销防空转
      if (!task.mainAgentInstanceId) {
        this.unregister(taskId);
        continue;
      }
      await this.runPatrol(taskId, task.title);
      entry.rounds += 1;
      entry.nextRunAt = now + this.progressionIntervalMs;
      if (entry.rounds >= entry.maxRounds) {
        this.loop.delete(taskId);
        this.logger.warn(
          `[progression] taskId=${taskId} 巡检已达轮次上限（${entry.maxRounds}），注销防空转`,
        );
      }
    }
  }

  /** 单次巡检：构造巡检 prompt 并 dispatch 给主 Agent。 */
  private async runPatrol(taskId: string, title?: string): Promise<void> {
    const text = buildProgressionPrompt(title ?? taskId, TASK_STATUS.in_progress);
    await this.dispatchToMainAgent(taskId, text);
    this.logger.log(`[progression] 巡检消息已下发主 Agent taskId=${taskId}`);
  }

  /**
   * 定向 dispatch 给主 Agent（巡检/托管确认共用）：
   * 主 Agent 定位 = task.mainAgentInstanceId → 会话；频道 private（按实例）优先，回退群聊。
   * 复用 WorkerDispatcher.dispatchAgentMention（assignWorker → createSession/bind → execute → 回复回流）。
   * 目标无会话 → dispatchAgentMention 抛错（调用方捕获记日志，不阻断扫描）。
   */
  private async dispatchToMainAgent(
    taskId: string,
    text: string,
  ): Promise<void> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { mainAgentInstanceId: true },
    });
    if (!task?.mainAgentInstanceId) {
      throw new Error(`任务 ${taskId} 无主实例，无法定向 dispatch`);
    }
    // 主实例 private 频道优先（巡检/托管确认为私密独白，不注入群聊公开回复指令），回退群聊
    const channel =
      (await this.prisma.chatChannel.findFirst({
        where: {
          taskId,
          type: CHANNEL_TYPE.private,
          taskAgentId: task.mainAgentInstanceId,
        },
        select: { id: true },
      })) ??
      (await this.prisma.chatChannel.findFirst({
        where: { taskId, type: CHANNEL_TYPE.task_group },
        select: { id: true },
      }));
    if (!channel) {
      throw new Error(`任务 ${taskId} 无可用频道，无法定向 dispatch`);
    }
    await this.workerDispatcher.dispatchAgentMention({
      taskId,
      channelId: channel.id,
      text,
      targetInstanceId: task.mainAgentInstanceId,
    });
  }

  /** 托管模式确认请求路由（realtime bus 订阅回调）：agent.question 事件 payload.managed=true 且未收敛 → dispatch 给主 Agent。 */
  private async routeManagedQuestion(event: RealtimeEvent): Promise<void> {
    const payload = (event.payload ?? {}) as {
      managed?: boolean;
      resolved?: boolean;
      question?: {
        taskId?: string | null;
        requestId?: string;
        kind?: string;
        content?: unknown;
      };
      taskId?: string | null;
    };
    if (payload.managed !== true || payload.resolved === true) {
      return;
    }
    const taskId = payload.question?.taskId ?? payload.taskId;
    if (!taskId) {
      return;
    }
    const row = await this.prisma.agentQuestion
      .findUnique({
        where: { requestId: payload.question?.requestId ?? '' },
        select: {
          id: true,
          requestId: true,
          kind: true,
          content: true,
          status: true,
        },
      })
      .catch(() => null);
    if (!row || row.status !== 'pending') {
      return;
    }
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { title: true },
    });
    const contentText = this.describeQuestionContent(row.kind, row.content);
    const text =
      `【托管确认】任务 <${task?.title ?? taskId}> 托管模式下收到成员确认请求：` +
      `requestId=${row.requestId}，kind=${row.kind}，内容：${contentText}。` +
      '请调用 vteam MCP 的 question_confirm 工具决策：' +
      'question 传 {taskId, selfInstanceId, requestId, kind:"question", answers: 答案数组} 提交答案（answers=null 表示拒绝）；' +
      'permission 传 {taskId, selfInstanceId, requestId, kind:"permission", response:"once"|"always"|"reject"}。';
    await this.dispatchToMainAgent(taskId, text);
    this.logger.log(
      `[progression] 托管确认请求已下发主 Agent taskId=${taskId} requestId=${row.requestId}`,
    );
  }

  /** content Json → 可读摘要（确认请求消息内嵌问题详情）。 */
  private describeQuestionContent(kind: string, content: unknown): string {
    if (kind === 'permission') {
      const c = (content ?? {}) as { title?: string; pattern?: unknown };
      return c.title ?? '权限请求';
    }
    const c = (content ?? {}) as {
      questions?: Array<{ question?: string; header?: string }>;
    };
    const text = (c.questions ?? [])
      .map((q) => q.question ?? q.header ?? '')
      .filter(Boolean)
      .join('；');
    return text || '（无详细内容）';
  }

  /** 进程启动重建：扫描库内 in_progress 任务（防重启丢循环）。 */
  private async restoreInProgressTasks(): Promise<void> {
    const rows = await this.prisma.task.findMany({
      where: { status: TASK_STATUS.in_progress },
      select: { id: true },
    });
    for (const row of rows) {
      await this.register(row.id);
    }
    if (rows.length > 0) {
      this.logger.log(
        `[progression] 重启重建巡检循环：${rows.length} 个 in_progress 任务`,
      );
    }
  }

  private describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
