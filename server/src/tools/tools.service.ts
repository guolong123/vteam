import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TOOL_ERRORS } from '../common/constants/tool.constants';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import {
  WORKER_COMMAND_TYPES,
  WorkersService,
} from '../workers/workers.service';
import { CreateToolDto } from './dto/create-tool.dto';
import { QueryToolsDto } from './dto/query-tools.dto';
import { UpdateToolDto } from './dto/update-tool.dto';

/** Tool 域主键前缀（对齐 15 篇 §2.2：`tl_<零填充序号>`，如 tl_0000000001）。 */
const TOOL_ID_PREFIX = 'tl';

/** GET /tools 调用方上下文（全局 JwtAuthGuard 填充 request.user）。 */
export interface ToolViewer {
  id: string;
}

/**
 * Tool 服务：列表/详情 + 注册/启停（T2 重构对齐 09 §3.8）。
 * - findAll：source/execution/enabled/mcpServer 过滤 + name 模糊搜索 + 分页 {items, total}；
 *   **成员只读强制 enabled=true**（agent 配置页工具区数据源，FR-35 启用开关），admin 全量
 * - create：action 唯一（撞 @unique → 409 TOOL_ACTION_EXISTS），id=tl_<seq>，
 *   **无独立 source 入参**：execution=mcp → source=mcp，其余 → custom（builtin 走 seed）；
 *   schema/initCommand 透传 Json，mcpServer 可空，enabled 默认 true
 * - update：仅 {schema?, initCommand?, enabled?}（09 §3.8 PATCH 契约，
 *   name/action/execution 注册后不可改——工具名即权限点 FR-48）
 * - 无 remove（09 §3.8 工具不提供 DELETE，停用 enabled=false 替代）
 *
 * 注册→权限命名空间（04 篇 FR-48 / 11 篇 §2）：`action` 列 @unique 即权限点，
 * POST /tools 注册成功即该 action 进入权限命名空间（agent_tool_effects 按 toolAction
 * 字符串弱关联引用，支持通配如 jenkins-*），权限点集合随注册动态扩展、非固定枚举。
 */
@Injectable()
export class ToolsService implements OnModuleInit {
  private readonly logger = new Logger(ToolsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly workersService: WorkersService,
  ) {}

  /**
   * 进程启动对齐 tool 域前缀序号（重启续号）。
   * 只统计 tl_<数字> 行的最大序号，忽略 tl_builtin_* 命名 id
   * （原 findFirst orderBy id desc 会被字典序更大的 tl_builtin_* 干扰 → parseInt NaN → seed 失败）。
   */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.tool, TOOL_ID_PREFIX, this.idGen);
  }

  /**
   * GET /tools：source/execution/enabled/mcpServer 过滤 + name 模糊搜索 + 分页。
   * viewer 为空（无鉴权上下文）不强制过滤；admin 遵循 query.enabled（缺省全量）；
   * 成员只读：强制 enabled=true（09 §3.8 成员只读 + FR-35 启用开关，仅启用工具可供 Agent 勾选）。
   * 返回 {items, total, page, pageSize}（对齐 agents.findMany 模式）。
   */
  async findAll(query: QueryToolsDto = {}, viewer?: ToolViewer) {
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const where: Prisma.ToolWhereInput = {
      source: query.source ? { equals: query.source } : undefined,
      execution: query.execution ? { equals: query.execution } : undefined,
      enabled: query.enabled === undefined ? undefined : query.enabled,
      name: query.name ? { contains: query.name } : undefined,
      mcpServer: query.mcpServer ? { equals: query.mcpServer } : undefined,
    };

    if (viewer && !(await this.isPlatformAdmin(viewer))) {
      where.enabled = true;
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.tool.count({ where }),
      this.prisma.tool.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { items: rows, total, page, pageSize };
  }

  /**
   * POST /tools：注册工具（09 §3.8 契约，去独立 source 入参）。
   * action 全局唯一 → 冲突 409 `TOOL_ACTION_EXISTS`（schema.prisma @unique）。
   * source 推导：execution=mcp → 'mcp'，其余（code/cli/http）→ 'custom'；
   * builtin 工具不在此注册（走 seed 数据，source=builtin）。
   * schema/initCommand 透传 Json，mcpServer 可空，enabled 缺省 true。
   */
  async create(dto: CreateToolDto) {
    await this.assertActionAvailable(dto.action);
    if (dto.execution === 'mcp' && dto.mcpServer) {
      await this.assertMcpServerExists(dto.mcpServer);
    }

    const tool = await this.prisma.tool.create({
      data: {
        id: await this.idGen.nextId(TOOL_ID_PREFIX),
        name: dto.name.trim(),
        action: dto.action.trim(),
        source: dto.execution === 'mcp' ? 'mcp' : 'custom',
        execution: dto.execution,
        mcpServer: dto.mcpServer ?? null,
        schema: dto.schema as Prisma.InputJsonValue | undefined,
        initCommand: dto.initCommand as Prisma.InputJsonValue | undefined,
        enabled: dto.enabled ?? true,
      },
    });
    await this.broadcastReloadConfig();
    return tool;
  }

  /**
   * PATCH /tools/:id：更新工具定义（09 §3.8 收敛为 {schema?, initCommand?, enabled?}）。
   * 不存在 → 404 `TOOL_NOT_FOUND`；name/action/execution/source 不可更新
   * （注册后不改——工具名即权限 action FR-48），停用 enabled=false 替代删除。
   */
  async update(id: string, dto: UpdateToolDto) {
    const existing = await this.prisma.tool.findUnique({ where: { id } });
    if (!existing) {
      this.throwNotFound(id);
    }

    const tool = await this.prisma.tool.update({
      where: { id },
      data: {
        ...(dto.schema !== undefined
          ? { schema: dto.schema as Prisma.InputJsonValue }
          : {}),
        ...(dto.initCommand !== undefined
          ? { initCommand: dto.initCommand as Prisma.InputJsonValue }
          : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
    });
    await this.broadcastReloadConfig();
    return tool;
  }

  /** 工具变更落库成功后向全部在线 worker 广播 reload-config（F1 MAJOR 闭环）。 */
  private async broadcastReloadConfig(): Promise<void> {
    try {
      const n = await this.workersService.broadcastCommand({
        type: WORKER_COMMAND_TYPES.RELOAD_CONFIG,
        resourceVersion: new Date().toISOString(),
      });
      if (n > 0) {
        this.logger.log(`工具变更：已广播 reload-config 到 ${n} 个 worker`);
      }
    } catch (e) {
      this.logger.warn(`工具变更后广播 reload-config 失败: ${e}`);
    }
  }

  /** action 唯一校验（仅 POST 注册时）：已存在 → 409 TOOL_ACTION_EXISTS。 */
  private async assertActionAvailable(action: string): Promise<void> {
    const hit = await this.prisma.tool.findUnique({
      where: { action: action.trim() },
      select: { id: true },
    });
    if (hit) {
      throw new ConflictException({
        code: TOOL_ERRORS.TOOL_ACTION_EXISTS,
        message: `工具 action 已存在：${action.trim()}`,
      });
    }
  }

  /**
   * MCP 工具弱关联防断链：execution=mcp 时 mcpServer 必须命中已注册的
   * mcp_servers（name 或 id 均可，前端 skills 页按 id/name 双键反查）。
   * 不存在 → 400 TOOL_MCP_SERVER_NOT_FOUND（避免注册后前端反查失败显示未连接）。
   */
  private async assertMcpServerExists(mcpServer: string): Promise<void> {
    const ref = mcpServer.trim();
    const hit = await this.prisma.mcpServer.findFirst({
      where: { OR: [{ id: ref }, { name: ref }] },
      select: { id: true },
    });
    if (!hit) {
      throw new BadRequestException({
        code: TOOL_ERRORS.TOOL_MCP_SERVER_NOT_FOUND,
        message: `MCP 服务器不存在：${ref}（请先在 MCP 服务器管理中注册，或填入其名称/ID）`,
      });
    }
  }

  /**
   * 调用方是否为平台管理员（复用 admin.guard.ts 判定语义）：
   * permissions.all === true（seed 简写）或 permissions.users.manage === true（权限矩阵）。
   * 用于 GET 成员只读过滤——与 AdminGuard 的授权校验保持一致，不重复走守卫
   * （守卫管"能不能调管理端点"，service 管"GET 过滤什么"）。
   */
  private async isPlatformAdmin(viewer: ToolViewer): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: viewer.id },
      include: { role: true },
    });
    if (!user || !user.enabled) {
      return false;
    }
    const permissions = (user.role.permissions ?? {}) as Record<
      string,
      unknown
    >;
    if (permissions.all === true) {
      return true;
    }
    const usersPerm = permissions.users as { manage?: boolean } | undefined;
    return usersPerm?.manage === true;
  }

  /** 404：TOOL_NOT_FOUND（对齐 AGENT_ERRORS 的 code 语义）。 */
  private throwNotFound(id: string): never {
    throw new NotFoundException({
      code: TOOL_ERRORS.TOOL_NOT_FOUND,
      message: `工具 ${id} 不存在`,
    });
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
