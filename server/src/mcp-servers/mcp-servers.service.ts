import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MCP_SERVER_ERRORS } from '../common/constants/mcp-server.constants';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import {
  WORKER_COMMAND_TYPES,
  WorkersService,
} from '../workers/workers.service';
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { MCP_STATUS, McpStatusEntryDto } from './dto/mcp-status.dto';
import { QueryMcpServersDto } from './dto/query-mcp-servers.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';
import {
  DiscoveredMcpTool,
  discoverMcpTools,
  McpServerRecordLike,
} from './mcp-discovery';

/** MCP 服务器域主键前缀（对齐 15 篇 §2.2：`ms_<零填充序号>`，如 ms_0000000001）。 */
const MCP_SERVER_ID_PREFIX = 'ms';

/** 同步物化 Tool 行的主键前缀（对齐 tools.service.ts：`tl_<零填充序号>`）。 */
const TOOL_ID_PREFIX = 'tl';

/** Tool action 合法形态（对齐 create-mcp-server.dto name 规则：小写开头）。 */
const TOOL_ACTION_RE = /^[a-z0-9][a-z0-9-_.]*$/;

/**
 * 远端工具名 → Tool action：小写 + 非法字符替换为 '-'；
 * 置空/替换后仍不满足 TOOL_ACTION_RE → null（调用方记 skipped）。
 */
function toToolAction(remoteName: string): string | null {
  const sanitized = remoteName.toLowerCase().replace(/[^a-z0-9-_.]/g, '-');
  if (!sanitized || !TOOL_ACTION_RE.test(sanitized)) {
    return null;
  }
  return sanitized;
}

/** T8c：单条服务器状态的内存形态（serverName → status + 上报时间）。 */
interface StoredMcpStatus {
  status: (typeof MCP_STATUS)[keyof typeof MCP_STATUS];
  updatedAt: Date;
}

/**
 * MCP 服务器服务：CRUD + local/remote 分支配置校验（T8a，11 篇 §5.1/§5.8）。
 * - findAll：type/enabled 过滤 + name 模糊搜索 + 分页 {items, total, page, pageSize}
 * - create：name 唯一（撞 @unique → 409 MCP_SERVER_NAME_EXISTS）+ 配置校验
 *   （local 必填 command[] 非空；remote 必填合法 http(s) url）
 * - update：部分更新（PATCH），改 type/command/url 后按合并配置重新校验；不存在 → 404
 * - remove：物理删除（mcp_servers 表无外键引用；tools.mcpServer 存字符串 id，弱关联不级联）
 */
@Injectable()
export class McpServersService implements OnModuleInit {
  /** T8c：worker 心跳上报的服务器可用性（内存 Map，serverName → 三态）。
   *  单实例内存方案（免 DB 迁移）；server 重启后状态清空，待 worker 下一次
   *  心跳重新填充——与 Worker 表 lastHeartbeatAt 的在线判定语义一致。 */
  private readonly statusByServer = new Map<string, StoredMcpStatus>();

  private readonly logger = new Logger(McpServersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    @Inject(forwardRef(() => WorkersService))
    private readonly workersService: WorkersService,
  ) {}

  /**
   * 进程启动对齐 mcp-servers 域前缀序号（重启续号）。
   * 复用 common/id-resync.ts 的 resyncIdPrefix：只统计 ms_ 纯数字序号 max，
   * 跳过 ms_vteam 等命名 id——原 findFirst orderBy id desc 会取到字典序更大的
   * 命名 id → parseInt NaN → seed 失败 → 计数器从 0 起 → 下次 create 撞 PRIMARY 主键 500。
   */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(
      this.prisma.mcpServer,
      MCP_SERVER_ID_PREFIX,
      this.idGen,
    );
  }

  /**
   * T8c：应用 worker 心跳上报的 MCP 三态快照。
   * 按 serverName 写入内存 Map（同名覆盖，last-update-wins）；
   * 不校验服务器是否存在于库（worker 可能上报用户全局配置的服务器，前端按名展示）。
   */
  applyHeartbeatStatus(entries: McpStatusEntryDto[]): void {
    if (!entries || entries.length === 0) {
      return;
    }
    const now = new Date();
    for (const entry of entries) {
      if (
        entry &&
        typeof entry.serverName === 'string' &&
        entry.serverName.length > 0
      ) {
        this.statusByServer.set(entry.serverName, {
          status: entry.status,
          updatedAt: now,
        });
      }
    }
  }

  /** 服务器行 → 对外视图（合并 T8c 三态；未上报 → status: null）。 */
  private withStatus<T extends { name: string }>(
    row: T,
  ): T & { status: string | null } {
    const stored = this.statusByServer.get(row.name);
    return { ...row, status: stored ? stored.status : null };
  }

  /**
   * toolCount 聚合：Tool.mcpServer 是弱字符串引用，同步写 server.name、
   * 历史种子用名（如 'vteam'），故同时匹配 server.id 与 server.name。
   * 单轮 DB（一次 findMany 只取 mcpServer 列 + 内存 tally），无 N+1；
   * 未绑定（null/他值）的 Tool 行天然被 `in` 过滤忽略。
   * 返回 server.id → tool 总数（含 0）。
   */
  private async countToolsForServers(
    rows: Array<{ id: string; name: string }>,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (rows.length === 0) {
      return counts;
    }
    const ownerOf = new Map<string, string>();
    for (const row of rows) {
      counts.set(row.id, 0);
      if (!ownerOf.has(row.id)) {
        ownerOf.set(row.id, row.id);
      }
      if (!ownerOf.has(row.name)) {
        ownerOf.set(row.name, row.id);
      }
    }
    const tools = await this.prisma.tool.findMany({
      where: { mcpServer: { in: [...ownerOf.keys()] } },
      select: { mcpServer: true },
    });
    for (const tool of tools ?? []) {
      const ownerId =
        tool?.mcpServer != null ? ownerOf.get(tool.mcpServer) : undefined;
      if (ownerId !== undefined) {
        counts.set(ownerId, (counts.get(ownerId) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** GET /mcp-servers：type/enabled 过滤 + name 模糊搜索 + 分页（成员只读可见）。
   * 返回 {items, total, page, pageSize}（对齐 tools.findAll 模式）。
   * workerId（worker 拉取时带 x-worker-id）：若该 worker 注册时上报了 mcpUrl
   * （capabilities.mcpUrl，集群外 worker 覆盖内置 vteam 的地址），
   * 返回列表中对内置 vteam 条目覆盖 url；未上报/用户侧访问不覆盖。
   */
  async findAll(query: QueryMcpServersDto = {}, workerId?: string) {
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const where: Prisma.McpServerWhereInput = {
      type: query.type ? { equals: query.type } : undefined,
      enabled: query.enabled === undefined ? undefined : query.enabled,
      name: query.name ? { contains: query.name } : undefined,
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.mcpServer.count({ where }),
      this.prisma.mcpServer.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const counts = await this.countToolsForServers(rows);

    let items = rows.map((row) => ({
      ...this.withStatus(row),
      toolCount: counts.get(row.id) ?? 0,
    }));

    // 按 worker 覆盖内置 vteam 的地址（集群外 worker 场景：seed 的
    // PLATFORM_MCP_URL 是 K8s 内网服务名，集群外解析失败）
    if (workerId) {
      const worker = await this.prisma.worker.findUnique({
        where: { id: workerId },
        select: { capabilities: true },
      });
      const caps =
        worker?.capabilities &&
        typeof worker.capabilities === 'object' &&
        !Array.isArray(worker.capabilities)
          ? (worker.capabilities as Record<string, unknown>)
          : {};
      const mcpUrl = typeof caps.mcpUrl === 'string' ? caps.mcpUrl : undefined;
      if (mcpUrl) {
        items = items.map((s) =>
          s.name === 'vteam' && s.type === 'remote' ? { ...s, url: mcpUrl } : s,
        );
      }
    }

    return {
      items,
      total,
      page,
      pageSize,
    };
  }

  /** GET /mcp-servers/:id：详情；不存在 → 404 MCP_SERVER_NOT_FOUND。 */
  async findOne(id: string) {
    const row = await this.prisma.mcpServer.findUnique({ where: { id } });
    if (!row) {
      this.throwNotFound(id);
    }
    const counts = await this.countToolsForServers([row]);
    return { ...this.withStatus(row), toolCount: counts.get(row.id) ?? 0 };
  }

  /**
   * POST /mcp-servers：创建。
   * name 全局唯一 → 冲突 409 MCP_SERVER_NAME_EXISTS；
   * local/remote 分支配置非法 → 400 MCP_SERVER_INVALID_CONFIG。
   */
  async create(dto: CreateMcpServerDto) {
    await this.assertNameAvailable(dto.name.trim());
    this.validateConfig(dto.type, dto.command, dto.url);

    const server = await this.prisma.mcpServer.create({
      data: {
        id: await this.idGen.nextId(MCP_SERVER_ID_PREFIX),
        name: dto.name.trim(),
        type: dto.type,
        command: dto.command as Prisma.InputJsonValue | undefined,
        url: dto.url ?? null,
        headers: dto.headers as Prisma.InputJsonValue | undefined,
        oauth: dto.oauth as Prisma.InputJsonValue | undefined,
        enabled: dto.enabled ?? true,
      },
    });
    await this.broadcastReloadConfig();
    return server;
  }

  /**
   * PATCH /mcp-servers/:id：部分更新（编辑/启停）。
   * 不存在 → 404；改 name 撞唯一 → 409；
   * 改 type/command/url 时按合并后的最终配置重新做分支校验 → 400。
   */
  async update(id: string, dto: UpdateMcpServerDto) {
    const existing = await this.prisma.mcpServer.findUnique({
      where: { id },
    });
    if (!existing) {
      this.throwNotFound(id);
    }
    if (dto.name !== undefined && dto.name.trim() !== existing.name) {
      await this.assertNameAvailable(dto.name.trim(), id);
    }

    // 分支配置校验基于「合并后的最终配置」（update 可能只改 type 或只改 command/url）
    const effectiveType = dto.type ?? existing.type;
    const effectiveCommand =
      dto.command !== undefined ? dto.command : existing.command;
    const effectiveUrl = dto.url !== undefined ? dto.url : existing.url;
    this.validateConfig(effectiveType, effectiveCommand, effectiveUrl);

    const server = await this.prisma.mcpServer.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.command !== undefined
          ? { command: dto.command as Prisma.InputJsonValue }
          : {}),
        ...(dto.url !== undefined ? { url: dto.url } : {}),
        ...(dto.headers !== undefined
          ? { headers: dto.headers as Prisma.InputJsonValue }
          : {}),
        ...(dto.oauth !== undefined
          ? { oauth: dto.oauth as Prisma.InputJsonValue }
          : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
    });
    await this.broadcastReloadConfig();
    return server;
  }

  /**
   * DELETE /mcp-servers/:id：物理删除 + 级联删除其物化的 MCP 工具行。
   * tools.mcpServer 是弱关联字符串（存 id/name）；server 删除后遗留的行即孤儿，
   * 占着全局唯一 action 会导致其他 server 同步永久跳过（删了重建也救不回来），故必须级联。
   */
  async remove(id: string) {
    const existing = await this.prisma.mcpServer.findUnique({
      where: { id },
    });
    if (!existing) {
      this.throwNotFound(id);
    }
    await this.prisma.mcpServer.delete({ where: { id } });
    await this.prisma.tool.deleteMany({
      where: { mcpServer: { in: [existing.id, existing.name] } },
    });
    await this.broadcastReloadConfig();
  }

  /**
   * POST /mcp-servers/:id/sync：经 MCP SDK 发现远端工具并物化为 Tool 行
   * （execution=mcp，使同步工具进入权限命名空间可见/可授权）。
   * 不存在 → 404；连接/发现失败 → 400 MCP_SERVER_SYNC_FAILED。
   * 物化规则（单行失败记 skipped，不中断整批）：
   * - action = 远端名小写 + 非法字符转 '-'（非法 → skipped）；
   *   name = `${server.name}_${远端名}`
   * - action 已存在且归属本服务器（mcpServer 为本 server id 或 name）→ 更新
   *   {schema, enabled: true}（updated++）；归属他服务器 → skipped（action 冲突）
   * - 不存在 → 创建 {source/execution: mcp/mcp, mcpServer: server.name}（created++）
   * - 本服务器名下 action 不在发现集合的存量行 → enabled=false（disabled++）
   * 仅 created+updated+disabled > 0 时广播 reload-config。
   */
  async syncTools(id: string) {
    const server = await this.prisma.mcpServer.findUnique({ where: { id } });
    if (!server) {
      this.throwNotFound(id);
    }

    let discovered: DiscoveredMcpTool[];
    try {
      discovered = await this.discoverTools(server);
    } catch (e) {
      throw new BadRequestException({
        code: MCP_SERVER_ERRORS.MCP_SERVER_SYNC_FAILED,
        message: `MCP 服务器 ${server.name} 同步失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }

    let created = 0;
    let updated = 0;
    let disabled = 0;
    const skipped: { action: string; reason: string }[] = [];
    const tools: { id: string; name: string; action: string }[] = [];
    const seenActions = new Set<string>();

    for (const item of discovered ?? []) {
      const remoteName = item && typeof item.name === 'string' ? item.name : '';
      const action = remoteName ? toToolAction(remoteName) : null;
      if (!action) {
        skipped.push({
          action: remoteName || '(unnamed)',
          reason: `工具名无法映射为合法 action（需满足 ${TOOL_ACTION_RE}），已跳过`,
        });
        continue;
      }
      if (seenActions.has(action)) {
        skipped.push({
          action,
          reason: `发现列表内 action 重复（${remoteName}），已跳过`,
        });
        continue;
      }
      seenActions.add(action);
      const name = `${server.name}_${remoteName}`;
      const schema = (item.inputSchema ?? null) as Prisma.InputJsonValue | null;
      try {
        const existing = await this.prisma.tool.findUnique({
          where: { action },
        });
        if (
          existing &&
          (existing.mcpServer === server.id ||
            existing.mcpServer === server.name)
        ) {
          const row = await this.prisma.tool.update({
            where: { id: existing.id },
            data: { schema, enabled: true },
          });
          updated += 1;
          tools.push({ id: row.id, name: row.name, action: row.action });
        } else if (existing) {
          skipped.push({
            action,
            reason: `action 已被其他服务器的工具占用（tool=${existing.id}，mcpServer=${existing.mcpServer ?? 'null'}），已跳过`,
          });
        } else {
          const row = await this.prisma.tool.create({
            data: {
              id: await this.idGen.nextId(TOOL_ID_PREFIX),
              name,
              action,
              source: 'mcp',
              execution: 'mcp',
              mcpServer: server.name,
              schema,
              enabled: true,
            },
          });
          created += 1;
          tools.push({ id: row.id, name: row.name, action: row.action });
        }
      } catch (e) {
        skipped.push({
          action,
          reason: `落库失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    const owned = await this.prisma.tool.findMany({
      where: { OR: [{ mcpServer: server.id }, { mcpServer: server.name }] },
    });
    for (const row of owned ?? []) {
      if (seenActions.has(row.action) || row.enabled === false) {
        continue;
      }
      try {
        await this.prisma.tool.update({
          where: { id: row.id },
          data: { enabled: false },
        });
        disabled += 1;
      } catch (e) {
        skipped.push({
          action: row.action,
          reason: `停用失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    if (created + updated + disabled > 0) {
      await this.broadcastReloadConfig();
    }

    return {
      server: { id: server.id, name: server.name, type: server.type },
      discovered: (discovered ?? []).length,
      created,
      updated,
      disabled,
      skipped,
      tools,
    };
  }

  /**
   * 协议调用接缝：默认走 mcp-discovery.discoverMcpTools；
   * 单测可 jest.spyOn 覆盖，隔离真实 MCP 连接。
   */
  protected discoverTools(
    record: McpServerRecordLike,
  ): Promise<DiscoveredMcpTool[]> {
    return discoverMcpTools(record);
  }

  /** MCP 服务器变更落库成功后向全部在线 worker 广播 reload-config（F1 MAJOR 闭环）。 */
  private async broadcastReloadConfig(): Promise<void> {
    try {
      const n = await this.workersService.broadcastCommand({
        type: WORKER_COMMAND_TYPES.RELOAD_CONFIG,
        resourceVersion: new Date().toISOString(),
      });
      if (n > 0) {
        this.logger.log(
          `MCP 服务器变更：已广播 reload-config 到 ${n} 个 worker`,
        );
      }
    } catch (e) {
      this.logger.warn(`MCP 服务器变更后广播 reload-config 失败: ${e}`);
    }
  }

  /**
   * local/remote 分支配置校验（11 篇 §5.1）：
   * - local：command 必填且 command.command 为非空字符串数组（可含 cwd/environment/timeout）
   * - remote：url 必填且为合法 http(s) 地址
   * 不合法 → 400 MCP_SERVER_INVALID_CONFIG。
   */
  private validateConfig(
    type: string,
    command: unknown,
    url: string | null | undefined,
  ): void {
    if (type === 'local') {
      const cmd = command as { command?: unknown } | null | undefined;
      if (
        !cmd ||
        !Array.isArray(cmd.command) ||
        cmd.command.length === 0 ||
        !cmd.command.every((c) => typeof c === 'string' && c.trim().length > 0)
      ) {
        throw new BadRequestException({
          code: MCP_SERVER_ERRORS.MCP_SERVER_INVALID_CONFIG,
          message:
            'local 类型服务器必须提供非空 command[]（可含 cwd/environment/timeout）',
        });
      }
      return;
    }
    // remote
    if (!url || !/^https?:\/\/.+/.test(url.trim())) {
      throw new BadRequestException({
        code: MCP_SERVER_ERRORS.MCP_SERVER_INVALID_CONFIG,
        message: 'remote 类型服务器必须提供合法 http(s) url',
      });
    }
  }

  /** name 唯一校验：已存在（且非自身）→ 409 MCP_SERVER_NAME_EXISTS。 */
  private async assertNameAvailable(
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const hit = await this.prisma.mcpServer.findUnique({
      where: { name },
      select: { id: true },
    });
    if (hit && hit.id !== excludeId) {
      throw new ConflictException({
        code: MCP_SERVER_ERRORS.MCP_SERVER_NAME_EXISTS,
        message: `MCP 服务器名称已存在：${name}`,
      });
    }
  }

  /** 404：MCP_SERVER_NOT_FOUND。 */
  private throwNotFound(id: string): never {
    throw new NotFoundException({
      code: MCP_SERVER_ERRORS.MCP_SERVER_NOT_FOUND,
      message: `MCP 服务器 ${id} 不存在`,
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
