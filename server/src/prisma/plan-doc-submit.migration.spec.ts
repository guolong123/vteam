import * as fs from 'fs';
import * as path from 'path';
import { BUILTIN_ROLE_CAPABILITY_MAPS } from '../common/constants/agent-role.constants';
import { PLATFORM_CAPABILITY_KEYS } from '../common/constants/platform-capability.constants';

/**
 * 迁移契约：`20260923000001_plan_doc_submit`（计划员放开 doc.submit，用户决策 2026-09-23）。
 *
 * 本迁移是「**已应用库**的唯一补丁路径」：000009 早已在存量库执行过，改能力点必须靠
 * 新迁移；fresh 安装则由该迁移 + seed 的 ROLE_BOUNDARIES 双路径一致落库。
 *
 * 断言（与 000006/000009 契约同形状）：
 *   1. 范围守卫：恰 2 条语句，目标行分别锚定 `key='plan'`（岗位矩阵）与 `id='ep_plan'`（岗位策略）；
 *   2. plan 字面量逐键 ≡ `BUILTIN_ROLE_CAPABILITY_MAPS.plan`（27 键，doc.submit=true）；
 *   3. 岗位策略用 `JSON_SET` 追加单一键（不整列覆盖，避免抹掉 ep_plan 其余 12 键）；
 *   4. 幂等：右值恒为常量字面量、不引用列自身，重跑零变化。
 */
const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260923000001_plan_doc_submit',
  'migration.sql',
);

const sql = fs.readFileSync(MIGRATION, 'utf8');

/** 取指定 WHERE 锚点所在语句里 `CAST('{...}' AS JSON)` 的字面量。 */
function jsonLiteralAfter(anchor: string): Record<string, unknown> {
  const statements = sql.split(';');
  const stmt = statements.find((s) => s.includes(anchor));
  if (!stmt) throw new Error(`[plan-doc-submit] 未找到锚点语句：${anchor}`);
  const match = /CAST\('(\{.*?\})' AS JSON\)/s.exec(stmt);
  if (!match) throw new Error(`[plan-doc-submit] 锚点语句缺 CAST 字面量：${anchor}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe('20260923000001 计划员放开 doc.submit（迁移契约）', () => {
  it('范围守卫：恰 2 条 UPDATE，分别锚定 plan 岗位行与 ep_plan 策略行', () => {
    const updates = sql.match(/^UPDATE /gm) ?? [];
    expect(updates).toHaveLength(2);
    expect(sql).toContain("AND `key` = 'plan'");
    expect(sql).toContain("WHERE `id` = 'ep_plan'");
  });

  it('plan 字面量逐键 ≡ BUILTIN_ROLE_CAPABILITY_MAPS.plan（27 键，键序 = 目录序）', () => {
    const literal = jsonLiteralAfter("AND `key` = 'plan'");
    const expected = BUILTIN_ROLE_CAPABILITY_MAPS.plan;
    expect(Object.keys(literal)).toEqual([...PLATFORM_CAPABILITY_KEYS]);
    expect(Object.keys(literal)).toEqual(Object.keys(expected));
    expect(literal).toEqual(expected);
    expect(literal['doc.submit']).toBe(true);
  });

  it('岗位策略用 JSON_SET 追加单一键（不整列覆盖）', () => {
    expect(sql).toContain(
      "JSON_SET(`config`, '$.tools.vteam_submit_artifact', 'allow')",
    );
    // 反向：不得出现整列 CAST 覆盖 ep_plan 的 config（会丢其余 12 键）。
    expect(sql).not.toMatch(/SET `config` = CAST/);
  });

  it('幂等：右值为常量字面量、不引用列自身', () => {
    for (const stmt of sql.split(';')) {
      if (!stmt.includes('UPDATE')) continue;
      const setClause = stmt.split('SET')[1] ?? '';
      expect(setClause).not.toMatch(/`capabilities`\s*[,)]/);
      expect(setClause).not.toMatch(/`config`\s*[,)]/);
    }
  });
});
