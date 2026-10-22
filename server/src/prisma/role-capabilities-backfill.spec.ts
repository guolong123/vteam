/**
 * 能力点目录 → **落库事实**（seed 镜像 / 回填 migration / 真实行）全量键守卫
 * =========================================================================
 * 批次 D-2（2026-10-22）：把「default-allow 下新增能力点 = 全局静默放行」这条坑钉死。
 *
 * ── 缺陷本体 ────────────────────────────────────────────────────────────────
 * 服务端门 `PlatformToolPermissionService.assertToolAllowed` 只在矩阵值**显式 `false`**
 * 时 403：`matrix?.[key] !== false` ⇒ **缺失键 = 允许**（default-allow，见
 * `platform-capability.constants.ts` 文件头）。于是：
 *   **往目录里加一个能力点键 ⇒ 所有存量 `agent_roles` 行（凡缺该键者）立刻获得该能力，
 *   而且全程没有任何报错**（服务端门放行、seed 不覆盖存量行、迁移没写 ⇒ 静默）。
 * 这正是「平台声明的意图」与「运行时行为」分叉的同一类问题（批次 D 的另一半：
 * worker 中性化路径 fail-open 放大了权限）。
 *
 * ── 本守卫断言什么（分三层，第 3 层在本仓不可执行）──────────────────────────
 * ① **出厂矩阵层**（静态，必然执行）：内置 7 岗 / 外部 3 岗 / 出厂兜底矩阵的键集必须
 *    **等于**目录键集——少一个键 = 该岗位静默获得该能力（default-allow）。
 * ② **回填层**（静态，必然执行）：目录里的每个键都必须在存量行里**被显式写过一次**。
 *    既有事实由 `BASELINE_COVERED_KEYS`（守卫引入时已落库的键）登记；此后**新增**的键
 *    必须带一条**全表回填 migration**（写给**每个**岗位行），否则本 spec 转红。
 * ③ **真实行层**（DB，仅在 `DATABASE_URL` 是 mysql 且可达时执行）：逐行断言
 *    `AgentRole.capabilities` 含全部目录键。
 *
 * ── 为什么第 3 层在本仓**跑不了**（诚实声明，不假装覆盖）──────────────────────
 * 本仓本机/CI **无 MySQL**（`nc -z localhost 3306` 不通）、`prisma/schema.prisma` 的
 * provider 固定为 `mysql`（sqlite 需改 provider，非本 spec 能做）、且 jest 单测**把
 * Prisma 整个 mock 掉** ⇒ 纯单测**看不见真实行**。
 * ⇒ 本 spec 的**静态部分（第 1、2 层）才是真正执行的那一半**，它覆盖的正是「部署库里
 * 行内容由什么决定」：seed 写什么（fresh install）+ 迁移写什么（upgrade）。
 * 第 3 层保留为「有 mysql 环境时的加测」，用 URL scheme 判定（sqlite/无 URL ⇒ 跳过）。
 *
 * ── 与既有守卫的关系（不重复）──────────────────────────────────────────────
 * - `role-capabilities-web-parity.spec.ts`：锁 **服务端 ↔ web 副本**（本 spec **不重复**它）。
 * - `agent-role-capabilities-split-grouped.migration.spec.ts`：锁**当前**矩阵形状
 *   （31 键全量、PM 全 true、外部岗 9 true/22 false）。本 spec 锁的是**另一个方向**：
 *   「**新增**键必须带**回填**」——即目录与存量行之间的**增量**契约。
 * - `seed.spec.ts`：锁 seed 落库值与 src 常量逐岗相等。本 spec 额外直接断言
 *   **seed 镜像目录**与服务端目录**键集相等**（缺一个键 ⇒ fresh install 的行就缺键）。
 */

import * as fs from 'fs';
import * as path from 'path';

import { PrismaClient } from '@prisma/client';

import {
  BUILTIN_AGENT_ROLES,
  BUILTIN_ROLE_CAPABILITY_MAPS,
  EXTERNAL_AGENT_ROLE_CAPABILITIES,
  EXTERNAL_AGENT_ROLE_KEYS,
  EXTERNAL_AGENT_UNMANAGED_CAPABILITY_KEYS,
  FALLBACK_AGENT_ROLE,
} from '../common/constants/agent-role.constants';
import {
  buildFactoryCapabilityMatrix,
  PLATFORM_CAPABILITY_KEYS,
} from '../common/constants/platform-capability.constants';

// ── 路径 ──────────────────────────────────────────────────────────────────────

const PRISMA_DIR = path.resolve(__dirname, '..', '..', 'prisma');
const MIGRATIONS_DIR = path.join(PRISMA_DIR, 'migrations');
const SEED_FILE = path.join(PRISMA_DIR, 'seed.ts');

// ── 冻结基线：守卫引入时**存量行里已经**有的键 ───────────────────────────────
//
// 由来（写清楚，免得后来者以为这是「随便列的例外名单」）：
// - 28 个键（目录里除 `secret.command` / `memory.archive` / `memory.merge` 外）由
//   **2026-09-25 基线 squash 之前**的迁移写入（那批迁移已随 squash 归档到
//   `.omo/evidence/tech-debt-remediation/legacy-migrations/`，仓库内不再存在，
//   故只能在此登记事实）。目录新增 `git.repos` 的那次提交（7301390，2026-09-21）
//   也在 squash 之前 ⇒ 它**在**存量行里。
// - `secret.command`：2026-09-26 迁移 `20260926000000_secret_command_capability`
//   全表回填。
// - `memory.archive` / `memory.merge`：2026-10-09 迁移
//   `20261009020000_capability_memory_org_tools` 逐岗回填（覆盖 7 内置 + 3 外部 + 其余行）。
//
// 语义：**此清单之外的任何目录键，都必须由一条「写给每个 agent_roles 行」的 migration
// 回填**，否则存量部署会静默获得该能力（default-allow）。
const BASELINE_COVERED_KEYS: readonly string[] = [
  'task.create',
  'task.transition',
  'task.complete',
  'plan.steps',
  'task.context',
  'team.view',
  'team.add_member',
  'chat.post',
  'chat.read',
  'chat.notify',
  'chat.channel_send',
  'wecom.reply',
  'doc.read',
  'doc.submit',
  'file.read',
  'issue.create',
  'issue.get',
  'issue.list',
  'issue.update',
  'issue.transition',
  'memory.save',
  'memory.search',
  'memory.update',
  'skill.create',
  'question.confirm',
  'my_profile',
  'hook.manage',
  'git.repos',
];

const BUILTIN_ROLE_KEYS: readonly string[] = BUILTIN_AGENT_ROLES.map(
  (r) => r.key,
);

// ── SQL 扫描（回填 migration）────────────────────────────────────────────────

/** 一条回填语句的**岗位覆盖范围**。 */
type RoleScope =
  | { kind: 'all' }
  | { kind: 'only'; keys: string[] }
  | { kind: 'except'; keys: string[] };

interface BackfillStatement {
  /** 迁移目录名（报错时指认来源）。 */
  migration: string;
  /** 被写入的能力点键。 */
  key: string;
  /** 该语句覆盖哪些岗位行。 */
  scope: RoleScope;
}

/** 去掉 `--` 行注释（字符串内的 `--` 不算注释）。 */
function stripSqlComments(sql: string): string {
  const kept: string[] = [];
  for (const line of sql.split('\n')) {
    let inQuote = false;
    let cut = line.length;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === "'") {
        inQuote = !inQuote;
        continue;
      }
      if (!inQuote && ch === '-' && line[i + 1] === '-') {
        cut = i;
        break;
      }
    }
    kept.push(line.slice(0, cut));
  }
  return kept.join('\n');
}

/** 按 `;` 切语句（引号内的 `;` 不切）。 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuote = false;
  for (const ch of sql) {
    if (ch === "'") {
      inQuote = !inQuote;
    }
    if (ch === ';' && !inQuote) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** `'a', 'b'` 形态的名单 → 字符串数组。 */
function parseKeyList(raw: string): string[] {
  return [...raw.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * 语句的岗位覆盖范围：
 * - `WHERE `key` NOT IN (...)` → except（其余行）；
 * - `WHERE `key` IN (...)` → only；
 * - `WHERE `key` = 'x'` → only；
 * - 无岗位谓词 → all（全表）。
 */
function parseRoleScope(statement: string): RoleScope {
  const notIn = /`?key`?\s+NOT\s+IN\s*\(([^)]*)\)/i.exec(statement);
  if (notIn) {
    return { kind: 'except', keys: parseKeyList(notIn[1]) };
  }
  const inList = /`?key`?\s+IN\s*\(([^)]*)\)/i.exec(statement);
  if (inList) {
    return { kind: 'only', keys: parseKeyList(inList[1]) };
  }
  const eq = /`?key`?\s*=\s*'([^']+)'/i.exec(statement);
  if (eq) {
    return { kind: 'only', keys: [eq[1]] };
  }
  return { kind: 'all' };
}

function scopeCovers(scope: RoleScope, roleKey: string): boolean {
  if (scope.kind === 'all') {
    return true;
  }
  if (scope.kind === 'only') {
    return scope.keys.includes(roleKey);
  }
  return !scope.keys.includes(roleKey);
}

/** 扫描全部迁移目录，抽出「写 `agent_roles.capabilities` 某个键」的语句。 */
function collectBackfills(): BackfillStatement[] {
  const out: BackfillStatement[] = [];
  const dirs = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const dir of dirs) {
    const file = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
    if (!fs.existsSync(file)) {
      continue;
    }
    const sql = stripSqlComments(fs.readFileSync(file, 'utf8'));
    for (const statement of splitStatements(sql)) {
      if (!/JSON_SET\(\s*`?capabilities`?/i.test(statement)) {
        continue;
      }
      const calls = statement.match(
        /JSON_SET\(\s*`?capabilities`?([\s\S]*?)\)/gi,
      );
      if (!calls) {
        continue;
      }
      const scope = parseRoleScope(statement);
      for (const call of calls) {
        for (const m of call.matchAll(/'\$\."([^"]+)"'/g)) {
          out.push({ migration: dir, key: m[1], scope });
        }
      }
    }
  }
  return out;
}

// ── seed 镜像目录（fresh install 的落库事实）─────────────────────────────────

/** 解析 `prisma/seed.ts` 里的 `PLATFORM_CAPABILITIES` 镜像键集。 */
function readSeedMirrorKeys(): string[] {
  const text = fs.readFileSync(SEED_FILE, 'utf8');
  const start = text.indexOf('const PLATFORM_CAPABILITIES');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n];', start);
  expect(end).toBeGreaterThan(start);
  const body = text.slice(start, end);
  return [...body.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]);
}

// ── 断言 ──────────────────────────────────────────────────────────────────────

describe('能力点目录 → 落库事实：任何岗位行都不得缺目录键（default-allow 守卫）', () => {
  describe('① 出厂矩阵层：键集必须与目录**完全相等**', () => {
    const catalog = [...PLATFORM_CAPABILITY_KEYS];

    it('目录键无重复（键集合的基数 = 长度）', () => {
      expect(new Set(catalog).size).toBe(catalog.length);
    });

    it('7 个内置岗位矩阵：每个都含全部目录键（缺一个 = 该岗位静默获得该能力）', () => {
      const missing: Record<string, string[]> = {};
      for (const role of BUILTIN_AGENT_ROLES) {
        const matrix = BUILTIN_ROLE_CAPABILITY_MAPS[role.key];
        expect(matrix).toBeDefined();
        const absent = catalog.filter((key) => !(key in matrix));
        if (absent.length > 0) {
          missing[role.key] = absent;
        }
      }
      expect(missing).toEqual({});
    });

    it('内置岗位矩阵不得携带目录外键（孤儿键 = 改不动的假开关）', () => {
      const extra: Record<string, string[]> = {};
      for (const role of BUILTIN_AGENT_ROLES) {
        const extraKeys = Object.keys(
          BUILTIN_ROLE_CAPABILITY_MAPS[role.key],
        ).filter((key) => !catalog.includes(key));
        if (extraKeys.length > 0) {
          extra[role.key] = extraKeys;
        }
      }
      expect(extra).toEqual({});
    });

    it('3 个外部岗位矩阵：含全部目录键（豁免名单为空 ⇒ 全量受管）', () => {
      const expected = catalog.filter(
        (key) =>
          !(
            EXTERNAL_AGENT_UNMANAGED_CAPABILITY_KEYS as readonly string[]
          ).includes(key),
      );
      const absent = expected.filter(
        (key) => !(key in EXTERNAL_AGENT_ROLE_CAPABILITIES),
      );
      expect(absent).toEqual([]);
      expect(Object.keys(EXTERNAL_AGENT_ROLE_CAPABILITIES).sort()).toEqual(
        [...expected].sort(),
      );
    });

    it('出厂兜底矩阵（ar_general / NULL 行补齐用）含全部目录键', () => {
      const factory = buildFactoryCapabilityMatrix();
      expect(Object.keys(factory).sort()).toEqual([...catalog].sort());
    });
  });

  describe('② 回填层：新增能力点必须同 PR 全表回填（存量行不得缺键）', () => {
    const backfills = collectBackfills();
    const migratedKeys = new Set(backfills.map((b) => b.key));

    it('冻结基线清单本身合法（键都在目录里、无重复）', () => {
      expect(new Set(BASELINE_COVERED_KEYS).size).toBe(
        BASELINE_COVERED_KEYS.length,
      );
      const unknown = BASELINE_COVERED_KEYS.filter(
        (key) => !PLATFORM_CAPABILITY_KEYS.includes(key),
      );
      expect(unknown).toEqual([]);
    });

    it('目录里的每个键都已被存量行显式写过（冻结基线 ∪ 回填 migration）', () => {
      const uncovered = PLATFORM_CAPABILITY_KEYS.filter(
        (key) => !BASELINE_COVERED_KEYS.includes(key) && !migratedKeys.has(key),
      );
      if (uncovered.length > 0) {
        throw new Error(
          `能力点目录新增了键但**没有同 PR 全表回填**：${uncovered.join(', ')}\n` +
            'default-allow（缺失键 ⇒ 允许）下，存量 agent_roles 行缺该键 ⇒ ' +
            '**所有缺该键的行静默获得该能力**（服务端门只拦显式 false ⇒ 全程无报错）。\n' +
            '补救（必须同 PR）：\n' +
            '  1) 增加一条 migration，给**每个** agent_roles 行写该键（逐键独立 UPDATE +\n' +
            '     JSON_CONTAINS_PATH 只增不改，运营者已显式的值原样保留；\n' +
            '     7 内置 + 3 外部 + 其余行都要覆盖，别只写内置岗）；\n' +
            '  2) 同步 prisma/seed.ts 的 PLATFORM_CAPABILITIES 镜像（fresh install 的行）\n' +
            '     与 src/common/constants/agent-role.constants.ts 的 BUILTIN_ROLE_CAPABILITY_MAPS。',
        );
      }
      expect(uncovered).toEqual([]);
    });

    it('非冻结基线的键：回填 migration 必须覆盖**所有**岗位行（7 内置 + 3 外部 + 其余行）', () => {
      const fresh = PLATFORM_CAPABILITY_KEYS.filter(
        (key) => !BASELINE_COVERED_KEYS.includes(key),
      );
      for (const key of fresh) {
        const scopes = backfills
          .filter((b) => b.key === key)
          .map((b) => b.scope);
        expect({ key, statements: scopes.length > 0 }).toEqual({
          key,
          statements: true,
        });
        const uncoveredBuiltins = BUILTIN_ROLE_KEYS.filter(
          (roleKey) => !scopes.some((s) => scopeCovers(s, roleKey)),
        );
        const uncoveredExternals = EXTERNAL_AGENT_ROLE_KEYS.filter(
          (roleKey) => !scopes.some((s) => scopeCovers(s, roleKey)),
        );
        // 「其余行」（ar_general + 任意历史自定义行）：要么整表写，要么有一条 NOT IN 排除名单
        // 不含 general 的语句（否则这些行缺键 ⇒ 同样静默放行）。
        const coversOthers = scopes.some(
          (s) =>
            s.kind === 'all' ||
            (s.kind === 'except' && !s.keys.includes(FALLBACK_AGENT_ROLE.key)),
        );
        expect({
          key,
          uncoveredBuiltins,
          uncoveredExternals,
          coversOthers,
        }).toEqual({
          key,
          uncoveredBuiltins: [],
          uncoveredExternals: [],
          coversOthers: true,
        });
      }
    });

    it('回填语句本身是「只增不改」（幂等 + 不覆盖运营者已显式的值）', () => {
      // 每条回填语句都必须带 `JSON_CONTAINS_PATH(...)=0` 守卫，否则重跑会覆盖运营者的编辑。
      const withoutGuard: string[] = [];
      for (const dir of fs.readdirSync(MIGRATIONS_DIR, {
        withFileTypes: true,
      })) {
        if (!dir.isDirectory()) {
          continue;
        }
        const file = path.join(MIGRATIONS_DIR, dir.name, 'migration.sql');
        if (!fs.existsSync(file)) {
          continue;
        }
        const sql = stripSqlComments(fs.readFileSync(file, 'utf8'));
        for (const statement of splitStatements(sql)) {
          if (!/JSON_SET\(\s*`?capabilities`?/i.test(statement)) {
            continue;
          }
          if (!/JSON_CONTAINS_PATH/i.test(statement)) {
            withoutGuard.push(`${dir.name}: ${statement.slice(0, 80)}`);
          }
        }
      }
      expect(withoutGuard).toEqual([]);
    });
  });

  describe('③ seed 镜像层：fresh install 的行键集 = 服务端目录键集', () => {
    it('prisma/seed.ts 的 PLATFORM_CAPABILITIES 镜像与服务端目录键集相等', () => {
      const seedKeys = readSeedMirrorKeys();
      expect(seedKeys.length).toBeGreaterThan(0);
      const missingInSeed = PLATFORM_CAPABILITY_KEYS.filter(
        (key) => !seedKeys.includes(key),
      );
      const extraInSeed = seedKeys.filter(
        (key) => !PLATFORM_CAPABILITY_KEYS.includes(key),
      );
      expect({ missingInSeed, extraInSeed }).toEqual({
        missingInSeed: [],
        extraInSeed: [],
      });
    });
  });
});

// ── ③ 真实行层：仅在有可达 MySQL 时执行（本仓本地无 MySQL ⇒ 跳过）────────────
//
// 判定口径：`DATABASE_URL` 是 `mysql://` 才尝试（jest setup 默认注入 sqlite 的
// `file:./test.db`；schema 的 provider 固定 mysql，sqlite 需改 provider ⇒ 不走这条路）。
// 连接失败 ⇒ 明确失败（配置了 mysql 却连不上 = 环境坏了，不该静默跳过）。
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const MYSQL_URL = /^mysql:\/\//.test(DATABASE_URL) ? DATABASE_URL : null;
const describeIfMysql = MYSQL_URL ? describe : describe.skip;

describeIfMysql('能力点目录 → 真实 agent_roles 行：逐行不得缺目录键', () => {
  let prisma: PrismaClient | null = null;
  let rows: { key: string; capabilities: unknown }[] = [];

  beforeAll(async () => {
    // ⚠️ 必须在 beforeAll 里构造：describe.skip 也会**执行** describe 体（只跳过用例），
    // 在体里 new PrismaClient() 会在 sqlite URL 下直接抛（provider 固定 mysql）。
    prisma = new PrismaClient();
    rows = await prisma.agentRole.findMany({
      select: { key: true, capabilities: true },
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('每一行的 capabilities 都含全部目录键（缺键 = 该岗位静默获得该能力）', () => {
    const problems: { key: string; missing: string[] }[] = [];
    for (const row of rows) {
      const raw = row.capabilities;
      const matrix: Record<string, unknown> =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const missing = PLATFORM_CAPABILITY_KEYS.filter(
        (key) => !(key in matrix),
      );
      if (missing.length > 0) {
        problems.push({ key: row.key, missing });
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `以下岗位行缺少目录键：${JSON.stringify(problems)}\n` +
          'default-allow（缺失键 ⇒ 允许）⇒ 这些行**已经**获得了对应能力。\n' +
          '补救：跑一条全表回填 migration 给这些行写上缺失的键（不要改目录本身）。',
      );
    }
    expect(problems).toEqual([]);
  });
});
