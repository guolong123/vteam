import * as fs from 'fs';
import * as path from 'path';
import {
  BUILTIN_AGENT_ROLES,
  BUILTIN_ROLE_CAPABILITY_MAPS,
  EXTERNAL_AGENT_ROLE_CAPABILITIES,
  EXTERNAL_AGENT_UNMANAGED_CAPABILITY_KEYS,
} from '../common/constants/agent-role.constants';
import { isPlatformCapabilityKey } from '../common/constants/platform-capability.constants';

/**
 * Contract for migration `20260930000000_capability_git_web_retire`.
 *
 * `20260929000000_capability_git_web_tier` 把 `git.repo.read` / `git.repo.write` /
 * `web.browse` 写进了存量 `agent_roles.capabilities`。但那三个键覆盖的 `git_*` /
 * `browser` 是 **worker 注入的本地工具**，不经 platform-mcp ⇒ `PlatformToolPermissionService`
 * 结构上拦不到（`isCapabilityGranted` 零运行时调用方），三个键从写入到退役从未拦截过
 * 任何调用。本迁移物理摘除它们，避免留下「改了不生效」的假开关。
 *
 * 权威源已迁至 agent 权限链路（`NATIVE_PERMISSION_KEYS` 投影 → opencode 原生校验），
 * 见 `execution-policy.service.ts`。
 */

const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260930000000_capability_git_web_retire',
  'migration.sql',
);

const RETIRED_KEYS = ['git.repo.read', 'git.repo.write', 'web.browse'] as const;

const sql = fs.readFileSync(MIGRATION, 'utf8');
const executable = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('T11 三键退役迁移 20260930000000', () => {
  it('只摘除这三个键，且用 JSON_REMOVE（键不存在时为 no-op，天然幂等）', () => {
    expect(executable).toContain('JSON_REMOVE');
    for (const key of RETIRED_KEYS) {
      expect(executable).toContain(`'$."${key}"'`);
    }
    // 不许改写其他能力点：不得出现 JSON_SET / JSON_REPLACE。
    expect(executable).not.toContain('JSON_SET');
    expect(executable).not.toContain('JSON_REPLACE');
  });

  it('只对含这三键的行动手（JSON_CONTAINS_PATH 守卫 + 非 NULL 矩阵）', () => {
    expect(executable).toContain('JSON_CONTAINS_PATH');
    expect(executable).toMatch(
      /`capabilities` IS NOT NULL[\s\S]*?JSON_CONTAINS_PATH\([\s\S]*?=\s*1/,
    );
    // NULL 矩阵行由 seed 出厂矩阵补齐（出厂矩阵不含这三键），不在本迁移范围。
    expect(executable).toContain('`capabilities` IS NOT NULL');
  });

  it('src 侧：三个键已不在能力目录中（目录退役的同步断言）', () => {
    for (const key of RETIRED_KEYS) {
      expect(isPlatformCapabilityKey(key)).toBe(false);
    }
  });

  it('src 侧：7 内置岗位矩阵均不再含这三个键', () => {
    for (const role of BUILTIN_AGENT_ROLES) {
      const matrix = BUILTIN_ROLE_CAPABILITY_MAPS[role.key];
      for (const key of RETIRED_KEYS) {
        expect(matrix).not.toHaveProperty(key);
      }
    }
  });

  it('src 侧：3 外部岗矩阵不含这三键，豁免名单已随之清空', () => {
    // 豁免名单原为这三键（default-allow 下必须删键不能写 false）。能力点退役后
    // 它们不在目录里，外部矩阵与内置一样不会发射 ⇒ 豁免机制整组清空。
    expect(EXTERNAL_AGENT_UNMANAGED_CAPABILITY_KEYS).toHaveLength(0);
    for (const key of RETIRED_KEYS) {
      expect(EXTERNAL_AGENT_ROLE_CAPABILITIES).not.toHaveProperty(key);
    }
    // 外部岗矩阵：9 true 不变（9 工具 allowlist 未含本 plan 新增键），false 侧随目录
    // 增键（memory-enhancement Todo 8a 的 memory.archive / memory.merge）而 +2。
    expect(
      Object.values(EXTERNAL_AGENT_ROLE_CAPABILITIES).filter((v) => v),
    ).toHaveLength(9);
    expect(
      Object.values(EXTERNAL_AGENT_ROLE_CAPABILITIES).filter(
        (v) => v === false,
      ),
    ).toHaveLength(22);
  });

  it('三个键全部出现在 SQL 中（漏摘一个即转红）', () => {
    const missing = RETIRED_KEYS.filter(
      (k) => !executable.includes(`'$."${k}"'`),
    );
    expect(missing).toEqual([]);
  });
});
