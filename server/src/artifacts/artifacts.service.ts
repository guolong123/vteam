import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IdGeneratorService } from '../common/id-generator';
import { RealtimeService } from '../realtime/realtime.service';
import { ACTOR_TYPE, EVENT_TYPES } from '../common/constants/event.constants';
import { TASK_STATUS } from '../common/constants/task.constants';
import { ARTIFACT_ERRORS, ARTIFACT_TYPES } from './artifacts.constants';
import { QueryArtifactsDto } from './dto/artifact.dto';

/** 产出物域主键前缀（15 篇 §2.2：<prefix>_<零填充序号>）。 */
const ID_PREFIX = {
  artifact: 'art',
  version: 'artv',
} as const;

/** artifact.submitted 事件 payload（T2 MockConsumer 广播契约 → T6 消费落库）。 */
export interface ArtifactSubmittedPayload {
  taskId: string;
  type: string;
  title: string;
  content: string;
  fileRef?: string;
}

/** append 元信息（12 篇 §4.1：作者 Agent / 变更说明）。 */
export interface AppendMeta {
  authorAgentId?: string;
  changeNote?: string;
}

/** 只暴露 findFirst({orderBy:{id:'desc'},select:{id:true}}) 的结构化子集（重启续号用）。 */
type SeqModel = {
  findFirst(args: {
    orderBy: { id: 'desc' };
    select: { id: true };
  }): Promise<{ id: string } | null>;
};

/**
 * 轻量协议校验（12 篇 §3.1，不引入 json_schema 依赖）：
 * - type 必填且枚举 text/doc/file；title 必填非空；
 * - text → content 必填；doc/file → fileRef 必填；
 * - 未知字段忽略（向前兼容，12 篇 §3.1「未知字段忽略」）。
 * 返回 { valid, reason? }；不抛错，由调用方决定回退语义。
 */
export function validateArtifactDeclaration(input: {
  type?: unknown;
  title?: unknown;
  content?: unknown;
  fileRef?: unknown;
}): { valid: boolean; reason?: string } {
  if (!input || typeof input !== 'object') {
    return { valid: false, reason: '非法声明：声明必须为对象' };
  }
  if (
    typeof input.type !== 'string' ||
    !(ARTIFACT_TYPES as readonly string[]).includes(input.type)
  ) {
    return { valid: false, reason: '非法声明：type 必填且枚举 text/doc/file' };
  }
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    return { valid: false, reason: '非法声明：title 必填且非空字符串' };
  }
  if (input.type === 'text') {
    if (typeof input.content !== 'string' || input.content.trim().length === 0) {
      return { valid: false, reason: '非法声明：type=text 时 content 必填' };
    }
  } else {
    if (
      typeof input.fileRef !== 'string' ||
      input.fileRef.trim().length === 0
    ) {
      return { valid: false, reason: '非法声明：type=doc/file 时 fileRef 必填' };
    }
  }
  return { valid: true };
}

/**
 * 产出物归档服务（Phase 3 T6，12 篇 §3/§4/§5/§6）。
 *
 * 职责：
 * - 协议校验（§3.1）：非法声明抛 BadRequest，回退普通消息不产生归档；
 * - 归档链路（§5）：`onArtifactSubmitted` 消费 artifact.submitted 事件落库，
 *   `append` 供 POST 旁路端点直接调用；text 直接归档、doc/file 存 fileRef 占位
 *   （Phase 3 不真实拉取，重试逻辑注释预留）；
 * - 版本演进（§4.1）：同 taskId+type+title 合并 append 递增版本；sha256 幂等去重
 *   （§4.3：同 taskId+type+sha256 已归档 → 跳过，版本不增）；
 * - 文档库端点（§6）：任务产出物列表（分页 + type/accepted 筛选）、详情、版本查看。
 */
@Injectable()
export class ArtifactsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
  ) {}

  /** 进程启动：按库内各前缀最大序号对齐 id 生成器（重启续号，防主键冲突）。 */
  async onModuleInit(): Promise<void> {
    await this.seedPrefix(ID_PREFIX.artifact, this.prisma.artifact);
    await this.seedPrefix(ID_PREFIX.version, this.prisma.artifactVersion);
  }

  /**
   * 消费 `artifact.submitted` 事件（T2 MockConsumer 广播契约 → 落库）。
   * 非法声明**不抛错**返回 `{status:'invalid'}`（12 篇 §3.1 回退普通消息语义，
   * 事件消费链路不能被非法输入打崩）；合法声明转 append 归档。
   */
  async onArtifactSubmitted(
    payload: ArtifactSubmittedPayload,
  ): Promise<{ status: string; reason?: string; artifact?: unknown }> {
    const validation = validateArtifactDeclaration(payload);
    if (!validation.valid) {
      return { status: 'invalid', reason: validation.reason };
    }
    return this.append(payload.taskId, payload);
  }

  /**
   * 归档核心：协议校验 → sha256 → 幂等去重 → append 新版本（或新建 v1）。
   * 供 POST /tasks/:id/artifacts 旁路端点与 onArtifactSubmitted 共用。
   * 非法声明抛 400 `ARTIFACT_INVALID_DECLARATION`。
   */
  async append(
    taskId: string,
    submission: ArtifactSubmittedPayload,
    meta: AppendMeta = {},
  ): Promise<{ status: string; artifact?: unknown }> {
    const validation = validateArtifactDeclaration(submission);
    if (!validation.valid) {
      throw new BadRequestException({
        code: ARTIFACT_ERRORS.INVALID_DECLARATION,
        message: validation.reason,
      });
    }

    const type = submission.type;
    const title = submission.title.trim();
    const content = submission.content ?? '';
    const sha256 = createHash('sha256').update(content).digest('hex');

    // 幂等去重（12 篇 §4.3 / 09 §5.4）：同 taskId+type+sha256 已归档 → 跳过，版本不增
    const dup = await this.prisma.artifactVersion.findFirst({
      where: { sha256, artifact: { taskId, type } },
      include: { artifact: true },
    });
    if (dup) {
      return {
        status: 'duplicate',
        artifact: this.toArtifactListItem(dup.artifact, dup),
      };
    }

    // 归档：同 taskId+type+title → append 新版本（FR-43）；否则新建 v1
    const contentRef =
      type === 'text' ? content : (submission.fileRef ?? content);
    const filePath = type === 'doc' || type === 'file' ? (submission.fileRef ?? null) : null;

    const { artifact, current } = await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.artifact.findFirst({
          where: { taskId, type, title },
        });
        if (!existing) {
          const id = await this.idGen.nextId(ID_PREFIX.artifact);
          const created = await tx.artifact.create({
            data: { id, taskId, type, title, currentVersion: 1 },
          });
          const v = await tx.artifactVersion.create({
            data: {
              id: await this.idGen.nextId(ID_PREFIX.version),
              artifactId: id,
              version: 1,
              contentRef,
              filePath,
              sha256,
              acceptedFlag: false,
              authorAgentId: meta.authorAgentId ?? null,
              changeNote: meta.changeNote ?? null,
            },
          });
          return { artifact: created, current: v };
        }
        // 12 篇 §7 验收联动：当前版本已验收锁定（accepted_flag=true）→ 非重复内容不可覆盖
        const current = await tx.artifactVersion.findUnique({
          where: {
            artifactId_version: {
              artifactId: existing.id,
              version: existing.currentVersion,
            },
          },
          select: { acceptedFlag: true },
        });
        if (current?.acceptedFlag) {
          throw new ConflictException({
            code: ARTIFACT_ERRORS.ARTIFACT_ACCEPTED_IMMUTABLE,
            message: `产出物「${existing.title}」当前版本已验收锁定（v${existing.currentVersion}），不可追加`,
          });
        }
        const updated = await tx.artifact.update({
          where: { id: existing.id },
          data: { currentVersion: existing.currentVersion + 1 },
        });
        const v = await tx.artifactVersion.create({
          data: {
            id: await this.idGen.nextId(ID_PREFIX.version),
            artifactId: existing.id,
            version: updated.currentVersion,
            contentRef,
            filePath,
            sha256,
            acceptedFlag: false,
            authorAgentId: meta.authorAgentId ?? null,
            changeNote: meta.changeNote ?? null,
          },
        });
        return { artifact: updated, current: v };
      },
    );

    // 12 篇 §7：completed 任务追加产出 → 自动退回 in_progress（CAS 命中才广播）
    const reverted = await this.prisma.task.updateMany({
      where: { id: taskId, status: TASK_STATUS.completed },
      data: { status: TASK_STATUS.in_progress, version: { increment: 1 } },
    });
    if (reverted.count > 0) {
      await this.realtime.broadcast(
        EVENT_TYPES.TASK_STATUS_CHANGED,
        {
          taskId,
          from: TASK_STATUS.completed,
          to: TASK_STATUS.in_progress,
          actorType: ACTOR_TYPE.system,
          actorId: null,
        },
        { type: 'global' },
      );
    }

    return {
      status: 'archived',
      artifact: this.toArtifactListItem(artifact, current),
    };
  }

  /**
   * GET /tasks/:id/artifacts：任务文档库列表（12 篇 §6.1 FR-44）。
   * 分页 {items, total, page, pageSize} + type 筛选；accepted 筛选按
   * currentVersion 的 acceptedFlag 内存过滤（Prisma 无法跨行引用父行 currentVersion，
   * 故先取 task 内候选再聚合）。
   */
  async findByTask(taskId: string, query: QueryArtifactsDto = {}) {
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const accepted =
      query.accepted === undefined ? undefined : query.accepted === 'true';

    const artifacts = await this.prisma.artifact.findMany({
      where: { taskId, ...(query.type ? { type: query.type } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    if (artifacts.length === 0) {
      return { items: [], total: 0, page, pageSize };
    }

    const versions = await this.prisma.artifactVersion.findMany({
      where: { artifactId: { in: artifacts.map((a) => a.id) } },
    });
    const currentByArtifact = new Map<string, (typeof versions)[number]>();
    for (const v of versions) {
      const art = artifacts.find((a) => a.id === v.artifactId);
      if (art && v.version === art.currentVersion) {
        currentByArtifact.set(v.artifactId, v);
      }
    }

    const rows = artifacts.map((artifact) => ({
      artifact,
      current: currentByArtifact.get(artifact.id) ?? null,
    }));
    const filtered =
      accepted === undefined
        ? rows
        : rows.filter((r) =>
            accepted
              ? r.current?.acceptedFlag === true
              : r.current?.acceptedFlag === false,
          );

    const total = filtered.length;
    const items = filtered
      .slice((page - 1) * pageSize, page * pageSize)
      .map((r) => this.toArtifactListItem(r.artifact, r.current));

    return { items, total, page, pageSize };
  }

  /**
   * GET /artifacts/:id：产出物详情 + 全版本列表（12 篇 §6.2 FR-45 版本切换入口）。
   */
  async findOne(id: string) {
    const artifact = await this.prisma.artifact.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: 'asc' } } },
    });
    if (!artifact) {
      throw new NotFoundException({
        code: ARTIFACT_ERRORS.ARTIFACT_NOT_FOUND,
        message: `产出物 ${id} 不存在`,
      });
    }
    return {
      id: artifact.id,
      taskId: artifact.taskId,
      type: artifact.type,
      title: artifact.title,
      currentVersion: artifact.currentVersion,
      createdAt: artifact.createdAt.toISOString(),
      updatedAt: artifact.updatedAt.toISOString(),
      versions: artifact.versions.map((v) => this.toVersionDto(v)),
    };
  }

  /** GET /artifacts/:id/versions/:version：指定版本内容（12 篇 §6.2 FR-45）。 */
  async findVersion(artifactId: string, version: number) {
    const v = await this.prisma.artifactVersion.findFirst({
      where: { artifactId, version },
    });
    if (!v) {
      throw new NotFoundException({
        code: ARTIFACT_ERRORS.ARTIFACT_VERSION_NOT_FOUND,
        message: `产出物 ${artifactId} 版本 ${version} 不存在`,
      });
    }
    return this.toVersionDto(v);
  }

  /** 文档库列表项 DTO（12 篇 §6.1 展示列 + 验收状态）。 */
  private toArtifactListItem(
    artifact: {
      id: string;
      taskId: string;
      type: string;
      title: string;
      currentVersion: number;
      createdAt: Date;
      updatedAt: Date;
    },
    current?: {
      acceptedFlag: boolean;
      authorAgentId: string | null;
    } | null,
  ) {
    return {
      id: artifact.id,
      taskId: artifact.taskId,
      type: artifact.type,
      title: artifact.title,
      currentVersion: artifact.currentVersion,
      acceptedFlag: current?.acceptedFlag ?? false,
      authorAgentId: current?.authorAgentId ?? null,
      createdAt: artifact.createdAt.toISOString(),
      updatedAt: artifact.updatedAt.toISOString(),
    };
  }

  /** ArtifactVersionDto（id/version/contentRef/filePath/sha256/acceptedFlag/authorAgentId/changeNote/createdAt）。 */
  private toVersionDto(v: {
    id: string;
    artifactId: string;
    version: number;
    contentRef: string;
    filePath: string | null;
    sha256: string | null;
    acceptedFlag: boolean;
    authorAgentId: string | null;
    changeNote: string | null;
    createdAt: Date;
  }) {
    return {
      id: v.id,
      artifactId: v.artifactId,
      version: v.version,
      contentRef: v.contentRef,
      filePath: v.filePath,
      sha256: v.sha256,
      acceptedFlag: v.acceptedFlag,
      authorAgentId: v.authorAgentId,
      changeNote: v.changeNote,
      createdAt: v.createdAt.toISOString(),
    };
  }

  private normalizePage(page?: number): number {
    const p = Number(page ?? 1);
    return Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1;
  }

  private normalizePageSize(pageSize?: number): number {
    const ps = Number(pageSize ?? 20);
    if (!Number.isFinite(ps)) return 20;
    return Math.min(Math.max(Math.floor(ps), 1), 100);
  }

  private async seedPrefix(prefix: string, model: SeqModel): Promise<void> {
    const last = await model.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    if (last) {
      const seq = parseInt(last.id.slice(prefix.length + 1), 10);
      if (Number.isFinite(seq)) {
        this.idGen.seed(prefix, seq);
      }
    }
  }
}
