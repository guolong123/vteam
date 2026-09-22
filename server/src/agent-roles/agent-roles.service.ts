import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AGENT_KEY_PATTERN } from '../common/constants/agent.constants';
import {
  AGENT_ROLE_ERRORS,
  AGENT_ROLE_ID_PREFIX,
  AGENT_ROLE_TYPES,
} from '../common/constants/agent-role.constants';
import {
  buildFactoryCapabilityMatrix,
  isPlatformCapabilityKey,
} from '../common/constants/platform-capability.constants';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAgentRoleDto } from './dto/create-agent-role.dto';
import { QueryAgentRolesDto } from './dto/query-agent-roles.dto';
import { UpdateAgentRoleDto } from './dto/update-agent-role.dto';
import { OpencodeAgentNameValidator } from './opencode-agent-name.validator';

/** AgentRole 行（含关联，toAgentRoleDto 输入）。能力字段仅 `capabilities`（业务能力点矩阵）。 */
type AgentRoleRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  type: string;
  defaultAgentId: string | null;
  defaultOpencodeAgentName: string | null;
  capabilities: Prisma.JsonValue | null;
  rolePrompt: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Agent 角色服务（agent-role-entity todo 6）：全局可复用角色的列表/详情 + CRUD。
 *
 * - 列表（type 过滤 + 分页，type/sortOrder 排序：builtin 在前）、详情
 *   （404 `AGENT_ROLE_NOT_FOUND`）
 * - create：仅 `type='custom'`；`key` 机器可读且唯一（冲突 → 409 `AGENT_ROLE_KEY_CONFLICT`）；
 *   `defaultAgentId` 必须指向已存在的 Agent（否则 400 `AGENT_ROLE_DEFAULT_AGENT_NOT_FOUND`）；
 *   `capabilities` 缺省为出厂矩阵（敏感能力点预置拒绝），显式给出时键须 ∈ 能力目录
 *   （未知键 / 非 boolean → 400 `AGENT_ROLE_CAPABILITY_KEY_INVALID`）。
 * - update：内置角色允许编辑 name/description/rolePrompt/defaultAgentId/**capabilities**，
 *   但改 `key` → 403 `AGENT_ROLE_BUILTIN_READONLY`（镜像 agents 模块 `PERMISSION_AGENT_READONLY`）。
 * - 默认 Agent 是**单一槽位**：`defaultAgentId`（内部）与 `defaultOpencodeAgentName`（外部引擎名）
 *   至多一个非空（同时给 → 400 `AGENT_ROLE_DEFAULT_SLOT_CONFLICT`）；update 设置其一自动清空另一个。
 * - remove：`type='builtin'` → 403 `AGENT_ROLE_BUILTIN_READONLY`（行保留）；被团队成员引用
 *   （FK ON DELETE RESTRICT）→ 409 `AGENT_ROLE_IN_USE`，绝不静默删除。
 * - 响应仅含身份 + `rolePrompt` 文本 + `capabilities` **业务能力点矩阵**（引擎原生权限
 *   permission/tools/model/worker 仍不出本服务）。
 */
@Injectable()
export class AgentRolesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly opencodeAgentNameValidator: OpencodeAgentNameValidator,
  ) {}

  /**
   * 进程启动对齐 `ar` 前缀序号（重启续号）。只统计 `ar_<数字>` 行：
   * 内置命名 id（`ar_product`）与迁移派生 id（`ar_c_<hash>`）不参与续号。
   */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.agentRole, AGENT_ROLE_ID_PREFIX, this.idGen);
  }

  /**
   * GET /agent-roles：type 过滤 + 分页，orderBy type/sortOrder
   * （'builtin' < 'custom'，故内置角色恒排前；同 type 内按 sortOrder 升序）。
   */
  async findAll(query: QueryAgentRolesDto = {}) {
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const where = { type: query.type ? { equals: query.type } : undefined };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.agentRole.count({ where }),
      this.prisma.agentRole.findMany({
        where,
        orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: rows.map((row) => this.toAgentRoleDto(row)),
      total,
      page,
      pageSize,
    };
  }

  /** GET /agent-roles/:id：详情。不存在 → 404 `AGENT_ROLE_NOT_FOUND`。 */
  async findOne(id: string) {
    const role = await this.prisma.agentRole.findUnique({ where: { id } });
    if (!role) {
      this.throwNotFound(id);
    }
    return this.toAgentRoleDto(role);
  }

  /**
   * POST /agent-roles：创建自定义角色。
   * key 唯一（P2002 → 409）；defaultAgentId 须指向已存在 Agent（否则 400）。
   * `key`、槽位互斥与 `defaultAgentId` 的存在性校验在同一路径，失败不留半装配行。
   */
  async create(dto: CreateAgentRoleDto) {
    this.assertValidKey(dto.key);
    const internalAgentId = this.normalizeInternalSlot(dto.defaultAgentId);
    const externalAgentName = this.normalizeExternalSlot(
      dto.defaultOpencodeAgentName,
    );
    if (internalAgentId !== null && externalAgentName !== null) {
      this.throwSlotConflict();
    }
    if (internalAgentId !== null) {
      await this.assertAgentExists(internalAgentId);
    }
    // 缺省出厂矩阵（Q1：默认放行 + 敏感点预置拒绝）；显式给出须键 ∈ 目录且值为 boolean。
    const capabilities =
      dto.capabilities === undefined
        ? buildFactoryCapabilityMatrix()
        : this.normalizeCapabilities(dto.capabilities);

    try {
      const created = await this.prisma.agentRole.create({
        data: {
          id: await this.idGen.nextId(AGENT_ROLE_ID_PREFIX),
          key: dto.key,
          name: dto.name.trim(),
          description: dto.description ?? null,
          type: AGENT_ROLE_TYPES.custom,
          defaultAgentId: internalAgentId,
          defaultOpencodeAgentName: externalAgentName,
          capabilities: capabilities as Prisma.InputJsonValue,
          rolePrompt: dto.rolePrompt ?? null,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
      if (externalAgentName !== null) {
        await this.opencodeAgentNameValidator.warnIfUnknown(
          externalAgentName,
          created.id,
        );
      }
      return this.toAgentRoleDto(created);
    } catch (e) {
      this.throwOnKeyConflict(e);
      throw e;
    }
  }

  /**
   * PATCH /agent-roles/:id：更新角色。
   * 内置角色（type=builtin）允许编辑 name/description/rolePrompt/defaultAgentId，
   * 但改 `key` → 403 `AGENT_ROLE_BUILTIN_READONLY`（type 不在 DTO，天然不可改）。
   *
   * 单一槽位语义（写入侧就是"至多一个"的强制点）：
   *   - `defaultAgentId` 显式传 null → 清除；传 id → 必须存在（否则 400）。
   *   - `defaultOpencodeAgentName` 显式传 null/空串 → 清除；传名 → 弱校验后落库。
   *   - **设置其一自动清空另一个**（本次请求里同时给两个非空值 → 400
   *     `AGENT_ROLE_DEFAULT_SLOT_CONFLICT`）。这是「恰好一个」的自然写法：
   *     调用方无需记得先清空另一槽位，槽位切换（内部 ⇄ 外部）是原子动作。
   *   - 两个字段都不传 → 现有槽位保持原样，不被触碰。
   */
  async update(id: string, dto: UpdateAgentRoleDto) {
    const role = await this.prisma.agentRole.findUnique({ where: { id } });
    if (!role) {
      this.throwNotFound(id);
    }

    if (dto.key !== undefined) {
      this.assertValidKey(dto.key);
      if (role.type === AGENT_ROLE_TYPES.builtin) {
        throw new ForbiddenException({
          code: AGENT_ROLE_ERRORS.AGENT_ROLE_BUILTIN_READONLY,
          message: '内置角色的 key 不可修改',
        });
      }
    }

    const internalProvided = dto.defaultAgentId !== undefined;
    const externalProvided = dto.defaultOpencodeAgentName !== undefined;
    const internalAgentId = this.normalizeInternalSlot(dto.defaultAgentId);
    const externalAgentName = this.normalizeExternalSlot(
      dto.defaultOpencodeAgentName,
    );
    if (internalAgentId !== null && externalAgentName !== null) {
      this.throwSlotConflict();
    }
    if (internalAgentId !== null) {
      await this.assertAgentExists(internalAgentId);
    }
    const slotData: {
      defaultAgentId?: string | null;
      defaultOpencodeAgentName?: string | null;
    } = {};
    if (internalProvided) {
      slotData.defaultAgentId = internalAgentId;
      if (internalAgentId !== null) {
        slotData.defaultOpencodeAgentName = null;
      }
    }
    if (externalProvided) {
      slotData.defaultOpencodeAgentName = externalAgentName;
      if (externalAgentName !== null) {
        slotData.defaultAgentId = null;
      }
    }

    try {
      const updated = await this.prisma.agentRole.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.key !== undefined ? { key: dto.key } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...slotData,
          ...(dto.capabilities !== undefined
            ? {
                capabilities: this.normalizeCapabilities(
                  dto.capabilities,
                ) as Prisma.InputJsonValue,
              }
            : {}),
          ...(dto.rolePrompt !== undefined
            ? { rolePrompt: dto.rolePrompt }
            : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        },
      });
      if (externalAgentName !== null) {
        await this.opencodeAgentNameValidator.warnIfUnknown(
          externalAgentName,
          id,
        );
      }
      return this.toAgentRoleDto(updated);
    } catch (e) {
      this.throwOnKeyConflict(e);
      throw e;
    }
  }

  /**
   * DELETE /agent-roles/:id：`type='builtin'` → 403 `AGENT_ROLE_BUILTIN_READONLY`（行保留）；
   * 被团队成员引用（FK ON DELETE RESTRICT，P2003）→ 409 `AGENT_ROLE_IN_USE`；
   * 其余 custom 角色正常删除。
   */
  async remove(id: string) {
    const role = await this.prisma.agentRole.findUnique({ where: { id } });
    if (!role) {
      this.throwNotFound(id);
    }
    if (role.type === AGENT_ROLE_TYPES.builtin) {
      throw new ForbiddenException({
        code: AGENT_ROLE_ERRORS.AGENT_ROLE_BUILTIN_READONLY,
        message: '内置角色不可删除',
      });
    }

    try {
      await this.prisma.agentRole.delete({ where: { id } });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2003'
      ) {
        throw new ConflictException({
          code: AGENT_ROLE_ERRORS.AGENT_ROLE_IN_USE,
          message: '角色已被团队成员引用，请先解绑成员再删除',
        });
      }
      throw e;
    }
  }

  /** 响应映射：仅身份 + rolePrompt 文本与单一默认 Agent 槽位，无任何能力字段。 */
  private toAgentRoleDto(role: AgentRoleRow) {
    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      type: role.type,
      defaultAgentId: role.defaultAgentId,
      defaultOpencodeAgentName: role.defaultOpencodeAgentName,
      capabilities: role.capabilities,
      rolePrompt: role.rolePrompt,
      sortOrder: role.sortOrder,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    };
  }

  /** 404：AGENT_ROLE_NOT_FOUND。 */
  private throwNotFound(id: string): never {
    throw new NotFoundException({
      code: AGENT_ROLE_ERRORS.AGENT_ROLE_NOT_FOUND,
      message: `AgentRole ${id} 不存在`,
    });
  }

  /** 默认槽位冲突（两个字段同时非空）→ 400 AGENT_ROLE_DEFAULT_SLOT_CONFLICT。 */
  private throwSlotConflict(): never {
    throw new BadRequestException({
      code: AGENT_ROLE_ERRORS.AGENT_ROLE_DEFAULT_SLOT_CONFLICT,
      message:
        '默认 Agent 槽位至多一个：defaultAgentId 与 defaultOpencodeAgentName 不能同时设置',
    });
  }

  /** 内部槽位归一化：undefined / null / 空串 → null（未设置），否则原值。 */
  private normalizeInternalSlot(value: string | null | undefined): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /**
   * 外部槽位归一化：undefined / null / 空串 → null（未设置），否则 **trim 后原样保留**
   * （名字含空格与大写，如 `Prometheus - Plan Builder`；不规范化大小写/内部空白）。
   */
  private normalizeExternalSlot(
    value: string | null | undefined,
  ): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /** defaultAgentId 存在性校验：指向不存在的 Agent → 400。 */
  private async assertAgentExists(agentId: string): Promise<void> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true },
    });
    if (!agent) {
      throw new BadRequestException({
        code: AGENT_ROLE_ERRORS.AGENT_ROLE_DEFAULT_AGENT_NOT_FOUND,
        message: `defaultAgentId ${agentId} 指向的 Agent 不存在`,
      });
    }
  }

  /**
   * 能力点矩阵校验：键须 ∈ `PLATFORM_CAPABILITIES` 目录、值须为 boolean。
   * 未知键 / 非法值 → 400 `AGENT_ROLE_CAPABILITY_KEY_INVALID`（不静默忽略，避免拼错键被放过）。
   */
  private normalizeCapabilities(
    value: Record<string, unknown>,
  ): Record<string, boolean> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw this.invalidCapabilities('capabilities 须为对象（能力点键 → boolean）');
    }
    const result: Record<string, boolean> = {};
    for (const [key, effect] of Object.entries(value)) {
      if (!isPlatformCapabilityKey(key)) {
        throw this.invalidCapabilities(`能力点键 ${key} 不在能力目录中`);
      }
      if (typeof effect !== 'boolean') {
        throw this.invalidCapabilities(`能力点 ${key} 取值须为 boolean`);
      }
      result[key] = effect;
    }
    return result;
  }

  /** 400：AGENT_ROLE_CAPABILITY_KEY_INVALID。 */
  private invalidCapabilities(message: string): BadRequestException {
    return new BadRequestException({
      code: AGENT_ROLE_ERRORS.AGENT_ROLE_CAPABILITY_KEY_INVALID,
      message,
    });
  }

  /** key 机器可读格式校验（缺缺失 / 不符 AGENT_KEY_PATTERN → 400）。 */
  private assertValidKey(key: unknown): asserts key is string {
    if (typeof key !== 'string' || key.length === 0) {
      throw new BadRequestException({
        code: AGENT_ROLE_ERRORS.AGENT_ROLE_KEY_INVALID,
        message: 'key 必填：角色须提供 machine-safe 标识',
      });
    }
    if (!new RegExp(AGENT_KEY_PATTERN).test(key)) {
      throw new BadRequestException({
        code: AGENT_ROLE_ERRORS.AGENT_ROLE_KEY_INVALID,
        message: `key 格式非法：需匹配 ${AGENT_KEY_PATTERN}（小写字母开头，仅含小写字母/数字/_/-，最长 63 字符）`,
      });
    }
  }

  /** P2002（uk_agent_roles_key 唯一冲突）→ 409 AGENT_ROLE_KEY_CONFLICT。 */
  private throwOnKeyConflict(e: unknown): void {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      throw new ConflictException({
        code: AGENT_ROLE_ERRORS.AGENT_ROLE_KEY_CONFLICT,
        message: 'key 已被占用，请换一个 machine-safe 标识',
      });
    }
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
}
