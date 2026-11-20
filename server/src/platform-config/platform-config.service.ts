import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import {
  findPlatformConfigSpec,
  SESSION_COMPACT_CONFIG_SPECS,
  type PlatformConfigSpec,
} from './platform-config.constants';

/** 平台配置行（Prisma 返回形态）。 */
interface PlatformConfigRow {
  id: string;
  key: string;
  value: string;
  valueType: string;
  description: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 对外输出的配置项（含默认值兜底与解析后的值）。 */
export interface PlatformConfigView {
  key: string;
  value: string;
  valueType: PlatformConfigSpec['valueType'];
  description: string;
  /** 实际生效值（按 valueType 解析；解析失败回落到原始字符串）。 */
  effectiveValue: number | boolean | string;
  updatedBy: string | null;
  updatedAt: string;
}

/** 会话压缩的四个生效参数（dispatcher 消费口径）。 */
export interface SessionCompactConfig {
  /** 不活跃天数（条件①）；0 = 特性关闭。 */
  idleDays: number;
  /** 上下文下限（条件②，token）。 */
  minContextTokens: number;
  /** 等压缩落完上限（ms），超时放弃、照常投递。 */
  awaitMs: number;
  /** 压缩本身超时预算（ms）。 */
  timeoutMs: number;
  /** 特性是否启用（idleDays > 0）。 */
  enabled: boolean;
}

const CONFIG_ID_PREFIX = 'pc';

/**
 * 平台配置服务（键值配置的读写与校验）。
 *
 * ## 设计要点
 *
 * 1. **键白名单**：只有 `platform-config.constants.ts` 里登记的键可落库，
 *    未知键一律 400。避免配置表退化为杂货铺、界面失去单源。
 * 2. **值按类型校验**：`number` 必须是非负有限整数；`bool` 只收 `true|false`。
 *    校验在写路径（保存），读路径 fail-open 回落默认值（DB 里的脏值不阻断业务）。
 * 3. **默认值落库**（`ensureDefaults`）：启动时把每个已登记键的默认值补齐，
 *    界面/读取永远拿到完整集合；已存在的行不覆盖（保留管理员修改）。
 * 4. **事务批量更新**：`updateMany` 在单事务内完成，任一键非法 → 整体回滚。
 *
 * ## 消费方（worker-dispatcher）
 *
 * dispatcher 经 `getSessionCompactConfig()` 取生效值——读 DB（带短 TTL 缓存，
 * 避免每条消息一次表查询）。env 变量（`SESSION_COMPACT_*`）仅作为**首次
 * 启动的种子**，之后以平台配置为准。
 */
@Injectable()
export class PlatformConfigService implements OnModuleInit {
  private readonly logger = new Logger(PlatformConfigService.name);

  /** DB 值缓存：key → { 行, 写入时刻 }（读路径走缓存，TTL 60s；写路径主动失效）。 */
  private readonly cache = new Map<string, { row: PlatformConfigRow; at: number }>();
  private readonly cacheTtlMs = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
  ) {}

  async onModuleInit(): Promise<void> {
    // 主键前缀续号：`pc_` 序列与库内对齐，重启不撞主键。
    await resyncIdPrefix(this.prisma.platformConfig, CONFIG_ID_PREFIX, this.idGen);
    try {
      const created = await this.ensureDefaults();
      if (created > 0) {
        this.logger.log(`[platform-config] 默认配置已补齐 ${created} 项`);
      }
    } catch (err) {
      // 启动期落默认值失败不阻断 boot（配置缺失时读路径回落常量默认值，
      // 业务不受影响）；但必须留痕便于运维发现。
      this.logger.warn(
        `[platform-config] 默认配置落库失败（读路径将回落常量默认值）: ${(err as Error).message}`,
      );
    }
  }

  /** 启动兜底：把每个已登记键的默认值落库（已存在不覆盖）。返回新建条数。 */
  private async ensureDefaults(): Promise<number> {
    const existing = await this.prisma.platformConfig.findMany({
      select: { key: true },
    });
    const existingKeys = new Set(existing.map((r) => r.key));
    const missing = SESSION_COMPACT_CONFIG_SPECS.filter(
      (s) => !existingKeys.has(s.key),
    );
    if (missing.length === 0) {
      return 0;
    }
    await this.prisma.$transaction(async (tx) => {
      for (const spec of missing) {
        await tx.platformConfig.create({
          data: {
            id: await this.idGen.nextId(CONFIG_ID_PREFIX),
            key: spec.key,
            value: spec.defaultValue,
            valueType: spec.valueType,
            description: spec.description,
          },
        });
      }
    });
    this.invalidateCache();
    return missing.length;
  }

  /** 读取全部配置（含未落库键的常量默认值兜底，按常量顺序输出）。 */
  async findAll(): Promise<PlatformConfigView[]> {
    const rows = await this.prisma.platformConfig.findMany({
      orderBy: { key: 'asc' },
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const out: PlatformConfigView[] = [];
    for (const spec of SESSION_COMPACT_CONFIG_SPECS) {
      const row = byKey.get(spec.key);
      out.push(this.toView(spec, row));
    }
    // 防御：库里有白名单外的行（历史脏数据）也原样返回，便于运维发现。
    for (const row of rows) {
      if (!findPlatformConfigSpec(row.key)) {
        out.push({
          key: row.key,
          value: row.value,
          valueType: row.valueType as PlatformConfigSpec['valueType'],
          description: row.description ?? '（未登记的配置键）',
          effectiveValue: row.value,
          updatedBy: row.updatedBy,
          updatedAt: row.updatedAt.toISOString(),
        });
      }
    }
    return out;
  }

  /** 读取单个配置（白名单外 → 400）。 */
  async findOne(key: string): Promise<PlatformConfigView> {
    const spec = this.requireSpec(key);
    const row = await this.findRow(key);
    return this.toView(spec, row);
  }

  /**
   * 更新单个配置（校验通过后 upsert）。
   * 未知键 → 400；值类型/范围非法 → 400（不落库）。
   */
  async updateOne(
    key: string,
    value: string,
    updatedBy?: string | null,
  ): Promise<PlatformConfigView> {
    const spec = this.requireSpec(key);
    this.validateValue(spec, value);
    const row = await this.upsertRow(spec, value, updatedBy ?? null);
    return this.toView(spec, row);
  }

  /**
   * 批量更新（单事务）：任一键非法 → 整体回滚。
   * 空对象 → 400（避免无意义提交）。
   */
  async updateMany(
    configs: Record<string, string>,
    updatedBy?: string | null,
  ): Promise<PlatformConfigView[]> {
    const entries = Object.entries(configs ?? {});
    if (entries.length === 0) {
      throw new BadRequestException({
        code: 'PLATFORM_CONFIG_EMPTY',
        message: 'configs 不能为空对象',
      });
    }
    // 预校验（不落库）：先全部校验通过再进事务，避免事务内抛错导致的无谓回滚。
    const specs = entries.map(([key, value]) => {
      const spec = this.requireSpec(key);
      this.validateValue(spec, value);
      return { spec, value };
    });
    const updated = await this.prisma.$transaction(async (tx) => {
      const rows = await Promise.all(
        specs.map(async ({ spec, value }) =>
          tx.platformConfig.upsert({
            where: { key: spec.key },
            create: {
              id: await this.idGen.nextId(CONFIG_ID_PREFIX),
              key: spec.key,
              value,
              valueType: spec.valueType,
              description: spec.description,
            },
            update: {
              value,
              updatedBy: updatedBy ?? null,
            },
          }),
        ),
      );
      return rows;
    });
    this.invalidateCache();
    return updated.map((row) => {
      const spec = findPlatformConfigSpec(row.key)!;
      return this.toView(spec, row);
    });
  }

  /**
   * 会话压缩的生效参数（worker-dispatcher 消费）。
   *
   * 读路径 fail-open：DB 行缺失/值解析失败 → 回落常量默认值，
   * **绝不阻断消息派发**。`enabled = idleDays > 0`。
   */
  async getSessionCompactConfig(): Promise<SessionCompactConfig> {
    // 注意：这里必须走 cachedRow（缓存未命中会回源 DB），不能用 cachedValue
    // （后者在未命中时返回 undefined，会把 DB 值直接当成缺失回落默认值）。
    const num = async (key: string, fallback: number): Promise<number> => {
      const row = await this.cachedRow(key);
      const n = Number(row?.value);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const idleDays = await num('SESSION_COMPACT_IDLE_DAYS', 3);
    return {
      idleDays,
      minContextTokens: await num('SESSION_COMPACT_MIN_CONTEXT_TOKENS', 40_000),
      awaitMs: await num('SESSION_COMPACT_AWAIT_MS', 120_000),
      timeoutMs: await num('SESSION_COMPACT_TIMEOUT_MS', 180_000),
      enabled: idleDays > 0,
    };
  }

  // ── 内部工具 ────────────────────────────────────────────────

  /** 白名单校验：未知键 → 400（携带可用键提示，便于运维排错）。 */
  private requireSpec(key: string): PlatformConfigSpec {
    const spec = findPlatformConfigSpec(key);
    if (!spec) {
      throw new BadRequestException({
        code: 'PLATFORM_CONFIG_UNKNOWN_KEY',
        message: `未知配置键：${key}`,
      });
    }
    return spec;
  }

  /** 值校验（写路径）：number 必须是非负有限整数；bool 只收 true|false。 */
  private validateValue(spec: PlatformConfigSpec, value: string): void {
    if (spec.valueType === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        throw new BadRequestException({
          code: 'PLATFORM_CONFIG_INVALID_VALUE',
          message: `配置 ${spec.key} 需要非负整数，收到：${value}`,
        });
      }
      return;
    }
    if (spec.valueType === 'bool') {
      if (value !== 'true' && value !== 'false') {
        throw new BadRequestException({
          code: 'PLATFORM_CONFIG_INVALID_VALUE',
          message: `配置 ${spec.key} 需要 true|false，收到：${value}`,
        });
      }
      return;
    }
    // string：空串也允许（语义由具体键定义）。
  }

  /** upsert 一行（写路径，同时失效缓存）。 */
  private async upsertRow(
    spec: PlatformConfigSpec,
    value: string,
    updatedBy: string | null,
  ): Promise<PlatformConfigRow> {
    const row = await this.prisma.platformConfig.upsert({
      where: { key: spec.key },
      create: {
        id: await this.idGen.nextId(CONFIG_ID_PREFIX),
        key: spec.key,
        value,
        valueType: spec.valueType,
        description: spec.description,
      },
      update: { value, updatedBy },
    });
    this.invalidateCache();
    return row;
  }

  /** 带 TTL 的行读取（读路径）。 */
  private async findRow(key: string): Promise<PlatformConfigRow | undefined> {
    return this.cachedRow(key);
  }

  private async cachedRow(key: string): Promise<PlatformConfigRow | undefined> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) {
      return hit.row;
    }
    const row = await this.prisma.platformConfig.findUnique({
      where: { key },
    });
    if (row) {
      this.cache.set(key, { row, at: Date.now() });
    }
    return row ?? undefined;
  }

  /** 写路径失效缓存（下条读会重新落库）。 */
  private invalidateCache(): void {
    this.cache.clear();
  }

  /** 行 → 视图（含默认值兜底）。 */
  private toView(
    spec: PlatformConfigSpec,
    row: PlatformConfigRow | undefined,
  ): PlatformConfigView {
    const stored = row?.value ?? spec.defaultValue;
    return {
      key: spec.key,
      value: stored,
      valueType: spec.valueType,
      description: spec.description,
      effectiveValue: this.parseEffective(spec.valueType, stored),
      updatedBy: row?.updatedBy ?? null,
      updatedAt: (row?.updatedAt ?? new Date()).toISOString(),
    };
  }

  /** 值解析（读路径，失败回落原值）。 */
  private parseEffective(
    valueType: PlatformConfigSpec['valueType'],
    raw: string,
  ): number | boolean | string {
    if (valueType === 'number') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    if (valueType === 'bool') {
      return raw === 'true';
    }
    return raw;
  }
}
