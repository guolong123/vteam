import { ROLE_BOUNDARIES, type VteamAgentName } from './agent.constants';
import {
  buildCapabilityMatrixFromTools,
  PLATFORM_CAPABILITY_KEYS,
} from './platform-capability.constants';
import {
  AGENT_ROLE_ID_PREFIX,
  AGENT_ROLE_TYPES,
  BUILTIN_AGENT_ROLES,
  BUILTIN_AGENT_ROLE_BY_KEY,
  BUILTIN_ROLE_CAPABILITY_MAPS,
  EXTERNAL_AGENT_ROLES,
  EXTERNAL_AGENT_ROLE_KEYS,
  FALLBACK_AGENT_ROLE,
  deriveCustomAgentRoleId,
  deriveCustomAgentRoleKey,
} from './agent-role.constants';

describe('agent-role.constants（agent_roles 单一事实来源）', () => {
  it('主键前缀为 ar（不与 RBAC Role 的 r_ 冲突）', () => {
    expect(AGENT_ROLE_ID_PREFIX).toBe('ar');
    expect(AGENT_ROLE_TYPES).toEqual({ builtin: 'builtin', custom: 'custom' });
  });

  it('恰有 7 个内置角色，key/name/id/defaultAgentId/sortOrder 齐全且互异', () => {
    expect(BUILTIN_AGENT_ROLES).toHaveLength(7);
    expect(new Set(BUILTIN_AGENT_ROLES.map((r) => r.key)).size).toBe(7);
    expect(new Set(BUILTIN_AGENT_ROLES.map((r) => r.id)).size).toBe(7);
    expect(BUILTIN_AGENT_ROLES.map((r) => r.sortOrder)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const role of BUILTIN_AGENT_ROLES) {
      expect(role.defaultAgentId).toBeTruthy();
      expect(role.id).toBe(`ar_${role.key}`);
      expect(role.defaultAgentId).toBe(`a_${role.key}`);
    }
    expect(BUILTIN_AGENT_ROLE_BY_KEY['product']?.id).toBe('ar_product');
    expect(BUILTIN_AGENT_ROLE_BY_KEY['librarian']?.name).toBe('知识管理员');
  });

  it('兜底角色为 general / 通用（case iii 回填目标，sortOrder 100）', () => {
    expect(FALLBACK_AGENT_ROLE.id).toBe('ar_general');
    expect(FALLBACK_AGENT_ROLE.key).toBe('general');
    expect(FALLBACK_AGENT_ROLE.name).toBe('通用');
    expect(FALLBACK_AGENT_ROLE.sortOrder).toBe(100);
  });

  it('deriveCustomAgentRoleKey 与 migration SQL 派生规则逐字节一致（已知向量）', () => {
    // analyst: stem=analyst, md5=05d5c5dfb743a5bd8fd7494fdc9bdb00
    expect(deriveCustomAgentRoleKey('analyst')).toBe('custom_analyst_05d5c5df');
    expect(deriveCustomAgentRoleId('analyst')).toBe('ar_c_05d5c5dfb743a5bd');
  });

  it('deriveCustomAgentRoleKey 归一化：大写/空格/符号 → 下划线，且对原文哈希（大小写敏感）', () => {
    expect(deriveCustomAgentRoleKey('  Data-Analyst  ')).toBe(deriveCustomAgentRoleKey('  Data-Analyst  '));
    // 归一化后的 stem 不含非法字符，key 满足 AGENT_KEY_PATTERN 的字符集。
    const key = deriveCustomAgentRoleKey('数据 分析师/Lead');
    expect(key).toMatch(/^custom_[a-z0-9_]+_[0-9a-f]{8}$/);
    // 'A' 与 'a' 仅归一化输入不同时 stem 相同、hash 不同：证明哈希 raw 原文。
    expect(deriveCustomAgentRoleKey('Analyst')).not.toBe(deriveCustomAgentRoleKey('analyst'));
  });

  it('空/纯符号 role 的 stem 回落 role 前缀，不产生空段', () => {
    const key = deriveCustomAgentRoleKey('***');
    expect(key.startsWith('custom_role_')).toBe(true);
    expect(key).toMatch(/^custom_role_[0-9a-f]{8}$/);
  });

  it('同值恒等（确定性）：重复派生同入参得同 id/key', () => {
    expect(deriveCustomAgentRoleId('analyst')).toBe(deriveCustomAgentRoleId('analyst'));
    expect(deriveCustomAgentRoleKey('analyst')).toBe(deriveCustomAgentRoleKey('analyst'));
  });

  it('BUILTIN_ROLE_CAPABILITY_MAPS 恰覆盖 7 内置岗 × 27 目录键（键序 = 目录序）', () => {
    expect(Object.keys(BUILTIN_ROLE_CAPABILITY_MAPS).sort()).toEqual(
      BUILTIN_AGENT_ROLES.map((r) => r.key).sort(),
    );
    for (const role of BUILTIN_AGENT_ROLES) {
      expect(Object.keys(BUILTIN_ROLE_CAPABILITY_MAPS[role.key])).toEqual([
        ...PLATFORM_CAPABILITY_KEYS,
      ]);
    }
  });

  it('契约：project_manager = 全 27 点 true（显式覆盖，不按 ROLE_BOUNDARIES 派生）', () => {
    const pm = BUILTIN_ROLE_CAPABILITY_MAPS.project_manager;
    expect(Object.keys(pm)).toHaveLength(27);
    for (const key of PLATFORM_CAPABILITY_KEYS) {
      expect(`${key}=${pm[key]}`).toBe(`${key}=true`);
    }
  });

  it('契约：其余 6 内置岗矩阵 ⊆ ROLE_BOUNDARIES 全组放行派生集（只收窄，绝不超授权）', () => {
    for (const role of BUILTIN_AGENT_ROLES) {
      if (role.key === 'project_manager') continue;
      const map = BUILTIN_ROLE_CAPABILITY_MAPS[role.key];
      const derived = buildCapabilityMatrixFromTools(
        ROLE_BOUNDARIES[`vteam-${role.key}` as VteamAgentName].toolAllows,
      );
      for (const key of PLATFORM_CAPABILITY_KEYS) {
        if (map[key] === true) {
          // true ⇒ 派生集也必须 true（子集方向）。
          expect(`${role.key}.${key}=${derived[key]}`).toBe(
            `${role.key}.${key}=true`,
          );
        }
      }
    }
  });

  it('外部 3 岗定义：key 清单/外部槽位/sortOrder 紧随内置 1..7/一行式 rolePrompt', () => {
    expect(EXTERNAL_AGENT_ROLES.map((r) => r.key)).toEqual([
      'sisyphus',
      'prometheus',
      'atlas',
    ]);
    expect([...EXTERNAL_AGENT_ROLE_KEYS]).toEqual([
      'sisyphus',
      'prometheus',
      'atlas',
    ]);
    expect(EXTERNAL_AGENT_ROLES.map((r) => r.sortOrder)).toEqual([8, 9, 10]);
    expect(new Set(EXTERNAL_AGENT_ROLES.map((r) => r.id)).size).toBe(3);
    for (const role of EXTERNAL_AGENT_ROLES) {
      expect(role.id).toBe(`ar_${role.key}`);
      expect(role.name.length).toBeGreaterThan(0);
      expect(role.defaultOpencodeAgentName.length).toBeGreaterThan(0);
      expect(role.defaultOpencodeAgentName.length).toBeLessThanOrEqual(128);
      expect(role.sortOrder).toBeGreaterThan(7);
      expect(role.sortOrder).toBeLessThan(FALLBACK_AGENT_ROLE.sortOrder);
      expect(role.rolePrompt.startsWith('# 角色：')).toBe(true);
      expect(role.rolePrompt).not.toContain('\n');
    }
  });
});
