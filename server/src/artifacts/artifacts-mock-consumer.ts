import { Injectable, Logger } from '@nestjs/common';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEvent, RealtimeService } from '../realtime/realtime.service';

/** 回流延迟下界（毫秒）：模拟 worker 处理耗时，默认 200ms。 */
export const ARTIFACT_DELAY_MS = 200;
/** 回流延迟随机区间（毫秒）：200 + [0,300) = 200~500ms。 */
export const ARTIFACT_DELAY_RANGE_MS = 300;

/** 触发式提交入参（payload 契约 = Artifact 表字段 + 版本内容占位，T6 归档消费）。 */
export interface ArtifactSubmissionInput {
  type: string;
  title: string;
  /** 内容占位（T6 归档落库时转 contentRef/文件存储）。 */
  content: string;
  /** 内容引用占位（缺省生成 `mock://<taskId>/<seq>`）；T6 真实文件存储替换。 */
  fileRef?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Phase 3 mock 回流消费者（18 篇 §8.3 真实 worker task.completed 回流的 mock 版）：
 * `simulateSubmission(taskId, {...})` 触发式广播 `artifact.submitted`
 * （scope=task，payload 含 taskId/type/title/content/fileRef）——模拟 Phase 4 worker
 * 归档回流，供 T6 归档链路消费、T14 测试触发。
 *
 * 对齐 MockDispatcher 构造注入模式（prisma/idGen/realtime）：
 * - 本任务**不落库**（归档落库由 T6 消费事件后做），prisma/idGen 保留构造参数仅为
 *   Phase 4 替换 WorkerDispatcher 时签名一致；
 * - 延迟用**公开可配置字段**（MockDispatcher 同款教训——TS number 参数放构造器会被
 *   Nest 当注入 token 启动失败，故放类字段，测试实例化后覆盖为 0）。
 */
@Injectable()
export class ArtifactsMockConsumer {
  private readonly logger = new Logger(ArtifactsMockConsumer.name);

  /** 回流延迟注入点（公开字段，默认 200~500ms）；测试实例化后覆盖为 0（与 fake timers 二选一）。 */
  public delayMs: number = ARTIFACT_DELAY_MS;
  public delayRangeMs: number = ARTIFACT_DELAY_RANGE_MS;

  /** fileRef 序号（`mock://<taskId>/<seq>` 占位递增）。 */
  private seq = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * 模拟一次 worker 归档回流：sleep（默认 200~500ms 随机）→ 广播
   * `artifact.submitted`（scope=task，projectId 由 RealtimeService 自动解析）。
   * 返回广播落库后的事件帧（id 游标），便于触发方/测试断言。
   */
  async simulateSubmission(
    taskId: string,
    input: ArtifactSubmissionInput,
  ): Promise<RealtimeEvent> {
    // 1. 模拟 worker 处理延迟（默认 200~500ms；可配置）
    await sleep(this.delayMs + Math.random() * this.delayRangeMs);

    // 2. 生成 payload（fileRef 字符串占位，缺省 `mock://<taskId>/<seq>`；不落库）
    const payload = {
      taskId,
      type: input.type,
      title: input.title,
      content: input.content,
      fileRef: input.fileRef ?? `mock://${taskId}/${++this.seq}`,
    };

    // 3. 广播（scope=task:id）
    const event = await this.realtime.broadcast(
      EVENT_TYPES.ARTIFACT_SUBMITTED,
      payload,
      { type: 'task', id: taskId },
    );
    this.logger.debug(`artifact.submitted broadcast: ${event.id} (${taskId})`);
    return event;
  }
}
