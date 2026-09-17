import {
  ROLE_BASH_DENY_PATTERNS,
  ROLE_BOUNDARIES,
  ROLE_SERVER_GATED_TOOLS,
  VTEAM_MCP_TOOL_NAMES,
} from '../common/constants/agent.constants';
import {
  BUILTIN_ORDER,
  constantDerived,
  factorySeedConfig,
  reorderLikeMysql,
  reverseKeys,
  storageRoundTrip,
} from './__fixtures__/policy-fixtures';
import { resolveBuiltinPolicy } from './execution-policy.service';

/**
 * vteam-role-behavior-abstraction Todo 2 契约测试（canonical 发射 + 每字段 DB 解析）。
 *
 * 核心不变量：解析自 SQL `JSON` 列的 config 经 canonical 发射后，输出键序与常量构造
 * 的插入顺序逐字节一致——与 DB 返回的键序（MySQL 按「键长度 + 字节序」重排）无关。
 * 期望值一律由 `ROLE_BOUNDARIES` 常量独立派生，不内联字面量（防漂移）。
 */
describe('policy canonical emission + per-field db resolution (Todo 2)', () => {
  function comparable(resolved: ReturnType<typeof resolveBuiltinPolicy>) {
    const { serverGated: _serverGated, ...rest } = resolved;
    return rest;
  }

  describe('canonical emission 与 DB 键序无关（7 角色）', () => {
    it.each(BUILTIN_ORDER)(
      '%s：乱序 config 发射结果与常量派生输出 JSON.stringify 逐字节相等',
      (name) => {
        const expected = constantDerived(name);
        const factory = factorySeedConfig(name);

        const mysqlOrdered = storageRoundTrip(reorderLikeMysql(factory));
        const reversed = storageRoundTrip(reverseKeys(factory));
        const plain = storageRoundTrip(factory);

        for (const config of [plain, mysqlOrdered, reversed]) {
          const resolved = resolveBuiltinPolicy(name, config);
          expect(JSON.stringify(comparable(resolved))).toBe(
            JSON.stringify(expected),
          );
          expect(comparable(resolved)).toEqual(expected);
        }
      },
    );

    it.each(BUILTIN_ORDER)(
      '%s：permission 顶层键序 == edit,read,bash,task,...VTEAM_MCP_TOOL_NAMES',
      (name) => {
        const resolved = resolveBuiltinPolicy(name, factorySeedConfig(name));
        const present = VTEAM_MCP_TOOL_NAMES.filter(
          (tool) => tool in resolved.permission,
        );
        const expectedOrder = ['edit', 'read', 'bash', 'task', ...present];
        expect(Object.keys(resolved.permission)).toEqual(expectedOrder);
      },
    );

    it.each(BUILTIN_ORDER)(
      '%s：edit 映射 `*` 先、随后 writeGlobs 声明序',
      (name) => {
        const boundary = ROLE_BOUNDARIES[name];
        const resolved = resolveBuiltinPolicy(name, factorySeedConfig(name));
        const edit = resolved.permission.edit as Record<string, unknown>;
        expect(Object.keys(edit)).toEqual(['*', ...boundary.writeGlobs]);
      },
    );

    it.each(BUILTIN_ORDER)('%s：tools 键序 == toolAllows 声明序', (name) => {
      const boundary = ROLE_BOUNDARIES[name];
      const resolved = resolveBuiltinPolicy(name, factorySeedConfig(name));
      expect(Object.keys(resolved.tools)).toEqual(
        Object.keys(boundary.toolAllows),
      );
    });

    it.each(BUILTIN_ORDER)(
      '%s：correction 键序 == scopeSummary,handoff,denyTemplate',
      (name) => {
        const resolved = resolveBuiltinPolicy(name, factorySeedConfig(name));
        expect(Object.keys(resolved.correction)).toEqual([
          'scopeSummary',
          'handoff',
          'denyTemplate',
        ]);
        expect(Object.keys(resolved.correction.handoff as object)).toEqual(
          Object.keys(ROLE_BOUNDARIES[name].handoffTo),
        );
      },
    );

    it('tools 中用户新增的合法键按字典序追加在常量键序之后', () => {
      const resolved = resolveBuiltinPolicy('vteam-product', {
        ...factorySeedConfig('vteam-product'),
        tools: {
          ...factorySeedConfig('vteam-product').tools,
          zzz_custom: 'ask',
          aaa_custom: 'deny',
        },
      });
      const keys = Object.keys(resolved.tools);
      expect(keys.slice(-2)).toEqual(['aaa_custom', 'zzz_custom']);
      expect(keys.slice(0, -2)).toEqual(
        Object.keys(ROLE_BOUNDARIES['vteam-product'].toolAllows),
      );
    });
  });

  describe('规范化（发射前）', () => {
    it('permission 含 write 键时不发射 write（agent + guard 共用）', () => {
      const resolved = resolveBuiltinPolicy('vteam-developer', {
        permission: {
          write: { '*': 'allow' },
          ...factorySeedConfig('vteam-developer').permission,
        },
        correction: factorySeedConfig('vteam-developer').correction,
      });
      expect(resolved.permission).not.toHaveProperty('write');
      expect(JSON.stringify(resolved.permission)).not.toContain('"write"');
    });

    it('tools 非法值（bogus）被丢弃，合法值保留', () => {
      const resolved = resolveBuiltinPolicy('vteam-product', {
        permission: factorySeedConfig('vteam-product').permission,
        correction: factorySeedConfig('vteam-product').correction,
        tools: {
          vteam_group_post: 'allow',
          bogus_tool: 'whatever',
          another_bad: 42,
          vteam_memory_search: 'ask',
        },
      });
      expect(resolved.tools).toEqual({
        vteam_group_post: 'allow',
        vteam_memory_search: 'ask',
      });
      expect(resolved.tools).not.toHaveProperty('bogus_tool');
      expect(resolved.tools).not.toHaveProperty('another_bad');
    });

    it('bashDeny 强制转 string[]：非字符串项被过滤', () => {
      const resolved = resolveBuiltinPolicy('vteam-tester', {
        permission: factorySeedConfig('vteam-tester').permission,
        correction: factorySeedConfig('vteam-tester').correction,
        bashDeny: ['rm -rf /', 42, null, 'dd if='],
      });
      expect(resolved.bashDeny).toEqual(['rm -rf /', 'dd if=']);
    });
  });

  describe('每字段回退（DB 值缺失/非法 → 常量，永不抛错、永不残缺）', () => {
    it.each(BUILTIN_ORDER)(
      '%s：config=null 时输出等于常量派生（含非空 tools）',
      (name) => {
        const resolved = resolveBuiltinPolicy(name, null);
        expect(JSON.stringify(comparable(resolved))).toBe(
          JSON.stringify(constantDerived(name)),
        );
        expect(Object.keys(resolved.tools).length).toBeGreaterThan(0);
      },
    );

    it.each(BUILTIN_ORDER)(
      '%s：tools 缺失 → 常量 allowlist（绝不 {}）',
      (name) => {
        const factory = factorySeedConfig(name);
        const resolved = resolveBuiltinPolicy(name, {
          permission: factory.permission,
          correction: factory.correction,
        });
        expect(resolved.tools).toEqual(ROLE_BOUNDARIES[name].toolAllows);
        expect(Object.keys(resolved.tools).length).toBeGreaterThan(0);
      },
    );

    it.each(BUILTIN_ORDER)('%s：tools 全非法 → 回退常量 allowlist', (name) => {
      const factory = factorySeedConfig(name);
      const resolved = resolveBuiltinPolicy(name, {
        permission: factory.permission,
        correction: factory.correction,
        tools: { bogus: 'nope', also_bad: 1 },
      });
      expect(resolved.tools).toEqual(ROLE_BOUNDARIES[name].toolAllows);
    });

    it('tools 为 [] 或字符串等非对象 → 回退常量 allowlist', () => {
      const factory = factorySeedConfig('vteam-architect');
      for (const tools of [[], 'nope', 7, true]) {
        const resolved = resolveBuiltinPolicy('vteam-architect', {
          permission: factory.permission,
          correction: factory.correction,
          tools,
        });
        expect(resolved.tools).toEqual(
          ROLE_BOUNDARIES['vteam-architect'].toolAllows,
        );
      }
    });

    it('bashDeny 非数组 → 回退常量清单', () => {
      const factory = factorySeedConfig('vteam-plan');
      const resolved = resolveBuiltinPolicy('vteam-plan', {
        permission: factory.permission,
        correction: factory.correction,
        bashDeny: 'rm -rf',
      });
      expect(resolved.bashDeny).toEqual([...ROLE_BASH_DENY_PATTERNS]);
    });

    it('permission 缺失 → 回退常量派生 permission', () => {
      const resolved = resolveBuiltinPolicy('vteam-plan', {
        correction: factorySeedConfig('vteam-plan').correction,
      });
      expect(resolved.permission).toEqual(
        constantDerived('vteam-plan').permission,
      );
    });

    it('correction 缺失 → 回退常量 correction', () => {
      const resolved = resolveBuiltinPolicy('vteam-librarian', {
        permission: factorySeedConfig('vteam-librarian').permission,
      });
      expect(resolved.correction).toEqual(
        constantDerived('vteam-librarian').correction,
      );
    });

    it('description 为 config 值时胜出，缺失/空串回退 boundary.scopeSummary', () => {
      const factory = factorySeedConfig('vteam-developer');
      expect(
        resolveBuiltinPolicy('vteam-developer', {
          ...factory,
          description: '自定义描述',
        }).description,
      ).toBe('自定义描述');
      expect(resolveBuiltinPolicy('vteam-developer', factory).description).toBe(
        ROLE_BOUNDARIES['vteam-developer'].scopeSummary,
      );
      expect(
        resolveBuiltinPolicy('vteam-developer', {
          ...factory,
          description: '',
        }).description,
      ).toBe(ROLE_BOUNDARIES['vteam-developer'].scopeSummary);
    });

    it('mode 不在 config 内：仅 vteam-plan 为 all，其余 primary', () => {
      for (const name of BUILTIN_ORDER) {
        const factory = factorySeedConfig(name);
        const resolved = resolveBuiltinPolicy(name, {
          ...factory,
          mode: 'all',
        });
        expect(resolved.mode).toBe(name === 'vteam-plan' ? 'all' : 'primary');
      }
    });
  });

  describe('permission.task 门', () => {
    it.each(BUILTIN_ORDER)(
      '%s：出厂 config 下 task 值与常量派生一致（仅 plan allow）',
      (name) => {
        const resolved = resolveBuiltinPolicy(name, factorySeedConfig(name));
        expect(resolved.permission.task).toBe(
          name === 'vteam-plan' ? 'allow' : 'deny',
        );
      },
    );
  });

  describe('serverGated（API/UI 展示用，不进 worker wire 格式）', () => {
    it.each(BUILTIN_ORDER)(
      '%s：serverGated == ROLE_SERVER_GATED_TOOLS 拷贝',
      (name) => {
        const resolved = resolveBuiltinPolicy(name, null);
        expect(resolved.serverGated).toEqual([...ROLE_SERVER_GATED_TOOLS]);
        resolved.serverGated.push('mutated');
        expect(ROLE_SERVER_GATED_TOOLS).not.toContain('mutated');
      },
    );
  });
});
