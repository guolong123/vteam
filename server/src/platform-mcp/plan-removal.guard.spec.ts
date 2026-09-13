/**
 * 防回流守卫：vteam 自造 plan 域已整体下线（2026-09）。
 *
 * 背景：vteam 早期在服务端自建了「执行计划」域（`plans` 表 + PlanTask 六要素 +
 * plan_submit/plan_review/plan_task_transition/plan_get/plan_assign_reviewer 五个 MCP 工具
 * + executionMode=plan 的服务端硬门禁 + 大段系统提示词），靠提示词约束模型行为，
 * 无内核级强制。现已改为**只传递**：由团队成员选择 opencode 原生 agent
 * （TeamMember.opencodeAgentName → prompt_async 的 agent 字段），计划动作交由
 * opencode 内核（内置 `plan` agent 或自定义 agent 的 permission）执行。
 *
 * 本 spec 以「源码级断言」防止该域被无意重新引入。若确需恢复某项能力，请先确认它
 * 不应由 opencode 承担，再删除对应断言——删除断言这个动作本身就是设计评审的触发点。
 *
 * 断言范围：仅扫描**生产源码**（排除 *.spec.ts 与本文件自身），避免测试夹具误报。
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.join(__dirname, '..');

/** 递归收集 .ts 源文件（排除测试文件与编译产物）。 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.spec.ts')) continue;
    out.push(full);
  }
  return out;
}

/** 返回命中断言的 `相对路径:行号: 行内容`（无命中则空数组）。 */
function grepSource(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (pattern.test(line)) {
        hits.push(
          `${path.relative(SRC_ROOT, file)}:${idx + 1}: ${line.trim()}`,
        );
      }
    });
  }
  return hits;
}

describe('防回流：vteam 自造 plan 域已下线（改由 opencode 原生 agent 承担）', () => {
  it('plans 模块目录不存在（plans.service / plans.controller / plan.constants 等）', () => {
    expect(fs.existsSync(path.join(SRC_ROOT, 'plans'))).toBe(false);
    expect(fs.existsSync(path.join(SRC_ROOT, 'platform-mcp', 'plan-quality.guard.ts'))).toBe(
      false,
    );
  });

  it('不存在对已删除 plan 模块/常量的 import', () => {
    const hits = grepSource(
      /from\s+['"][^'"]*plans\/(plan\.constants|plans\.service|plans\.module|plans\.controller)['"]/,
    );
    expect(hits).toEqual([]);
  });

  it('不存在 plan_* MCP 工具注册（工具名应已全部移除）', () => {
    const hits = grepSource(
      /name:\s*'(plan_submit|plan_review|plan_task_transition|plan_get|plan_assign_reviewer)'/,
    );
    expect(hits).toEqual([]);
  });

  it('不存在 PLAN_STATUS / PLAN_TASK_STATUS / PLAN_ERRORS 引用', () => {
    const hits = grepSource(/\b(PLAN_STATUS|PLAN_TASK_STATUS|PLAN_ERRORS)\b/);
    expect(hits).toEqual([]);
  });

  it('不存在已删除的 PLAN_* 提示词常量引用（能力/工作流/评审清单）', () => {
    const hits = grepSource(
      /\b(PLAN_CAPABILITY_INSTRUCTION|PLAN_WORKFLOW_INSTRUCTION|PLAN_REVIEW_CHECKLIST_INSTRUCTION)\b/,
    );
    expect(hits).toEqual([]);
  });

  it('不存在 plan 表读写（prisma.plan / prisma.planTask）', () => {
    const hits = grepSource(/\bprisma\.(plan|planTask)\b/);
    expect(hits).toEqual([]);
  });

  it('不存在 executionMode 的服务端门禁/切换逻辑（updateExecutionMode）', () => {
    const hits = grepSource(/\bupdateExecutionMode\b/);
    expect(hits).toEqual([]);
  });

  it('产出物提交引导段存在（计划文档/交付物统一走 submit_artifact 的提示词锚点）', () => {
    const hits = grepSource(/export const ARTIFACT_SUBMISSION_INSTRUCTION/);
    expect(hits).toHaveLength(1);
  });

  it('产出物类型收敛为三态（text/doc/file）：submit_artifact 不再接受 plan', () => {
    // 自造计划域下线的另一半：产出物类型里也必须没有 plan——否则又能经产出物通道
    // 造出"计划"，与"计划只存在于 .opencode/plans/ 文件"的单源约定冲突。
    const decl = fs.readFileSync(
      path.join(SRC_ROOT, 'artifacts', 'artifacts.constants.ts'),
      'utf8',
    );
    expect(decl).toMatch(/ARTIFACT_TYPES\s*=\s*\[\s*'text'\s*,\s*'doc'\s*,\s*'file'\s*\]/);
  });

  it('计划提示词只指向 .opencode/plans/ 文件（不再教模型提交 type:"plan"）', () => {
    const hits = grepSource(/type:\s*["']plan["']/);
    expect(hits).toEqual([]);
    const produceHits = grepSource(/export const PLAN_PRODUCE_INSTRUCTION/);
    expect(produceHits).toHaveLength(1);
  });
});
