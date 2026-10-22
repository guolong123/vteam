import * as fs from 'fs';
import * as path from 'path';
import { ROLE_BOUNDARIES, ROLE_POLICY_DENY_TEMPLATE } from './agent.constants';
import { BUILTIN_ROLE_PROMPTS } from './agent-role-prompts.constants';
import { renderBoundarySection } from '../../chat/worker-dispatcher';

/**
 * 批次 C+D · 项目经理「只协调不执行」纪律的**内容**契约（pm-coordination-hardening）。
 *
 * 批次 D 追加一条口径：纪律正文必须**岗位无关**——不写死「需求→产品经理」这类行业产出物
 * 映射。平台是通用的（法务/研究/运营团队都在用），把研发岗位映射焊进纪律，等于对非研发
 * 团队没写。归属判定交给「团队成员名册 + 各岗位自身职责」（可配置知识），纪律只规定
 * **判定程序**（三步判定 + 冲突裁决）。
 *
 * 为什么要有这一份（而不是只改常量）：
 *   生产证据显示，同一条纠正指令（「PM 只协调不执行 / 串行派活 / 做完即停」）已经被
 *   写进记忆模块至少 6 次、横跨 4 个团队（其中一条还记着用户当天直接对 PM 说过），
 *   而行为没有变 ⇒ **指令层纠正在生产上已被证明不足**。纪律必须落进两个**权威**载体：
 *     1. `agent_roles.role_prompt`（岗位定义，每次派发以【岗位职责】注入）——C1；
 *     2. 平台级【职责边界】段的 `correction.scopeSummary`——C2。
 *   本 spec 把这两个载体上「纪律必须以祈使句存在」钉死，防止后续有人把它改回
 *   「只有身份陈述 / 只有条件式禁令」的形态（那正是本轮要修的漂移方向）。
 *
 * 断言口径：**内容断言**，不是整串快照——只钉「纪律条款存在且是可执行指令」，
 * 这样后续润色措辞不会误报，而把条款删掉一定转红。
 *
 * 附带守住本仓的老坑：`agent-role-prompts.constants.ts` 的文件头要求「三处逐字节一致」
 * （常量 / seed 镜像 / 迁移回填）。本 spec 逐角色比对常量与 seed 镜像，
 * 迁移那一份由 `src/prisma/pm-coordination-discipline.migration.spec.ts` 兜底。
 */

const SEED = path.resolve(__dirname, '..', '..', '..', 'prisma', 'seed.ts');

/** 从源码里抠出一个 `{ ... }` 对象字面量（按括号配平，不用正则猜嵌套）。 */
function objectLiteral(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', at + marker.length - 1);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end).toBeGreaterThan(open);
  return source.slice(open, end + 1);
}

/** seed.ts 的 `BUILTIN_ROLE_PROMPTS` 自包含镜像（seed 不 import src，故只能取源码）。 */
function seedRolePrompts(): Record<string, string> {
  const source = fs.readFileSync(SEED, 'utf8');
  const literal = objectLiteral(
    source,
    'const BUILTIN_ROLE_PROMPTS: Record<string, string> =',
  );
  return new Function(`return (${literal});`)() as Record<string, string>;
}

/** seed.ts 里 `ROLE_BOUNDARIES` 镜像中某个角色的 `scopeSummary` 字面量。 */
function seedScopeSummary(agentName: string): string {
  const source = fs.readFileSync(SEED, 'utf8');
  const block = new RegExp(
    `'${agentName}': defineBoundary\\(\\{([\\s\\S]*?)\\n {2}\\}\\),`,
  ).exec(source);
  expect(block).not.toBeNull();
  const literal = /scopeSummary:\s*(\n\s*)?('(?:[^'\\]|\\.)*')/.exec(block![1]);
  expect(literal).not.toBeNull();
  return new Function(`return ${literal![2]}`)() as string;
}

const PM_PROMPT = BUILTIN_ROLE_PROMPTS.project_manager;
const PM_SCOPE = ROLE_BOUNDARIES['vteam-project_manager'].scopeSummary;

describe('PM 岗位定义（rolePrompt）必须携带「只协调不执行」的判定程序', () => {
  it('① 三步判定：先判归属 → 归别人就派发 → 例外必须说明原因', () => {
    expect(PM_PROMPT).toContain('【判定顺序·任何请求先过这一步】');
    // 判定对象是「产出归哪个岗位」，由名册与各岗位职责回答——纪律本身不枚举行业产出物。
    expect(PM_PROMPT).toContain('归哪个岗位');
    expect(PM_PROMPT).toContain('团队成员名册');
    // 第二步必须给到**可执行动作 + 工具名**，否则仍会自己动手。
    expect(PM_PROMPT).toContain('立刻用 vteam_notify_agent 派给该岗位');
    expect(PM_PROMPT).toContain('不产出内容本身');
    // 两个例外口（岗位不可用 / 用户点名）+ 事后必须说明原因。
    expect(PM_PROMPT).toContain('岗位不可用');
    expect(PM_PROMPT).toContain('用户点名要你亲自做');
    expect(PM_PROMPT).toContain('先在群里说明原因');
  });

  it('② 冲突裁决：用户说「直接给我」不构成越界授权', () => {
    expect(PM_PROMPT).toContain('【冲突裁决】');
    // 生产实测失败点：模型把「用户明确要求」当成越界授权（reasoning 原文
    // 「the user explicitly said just paste the code」）⇒ 必须显式排除这条歧义。
    expect(PM_PROMPT).toContain('「直接给我」');
    expect(PM_PROMPT).toContain('不构成越界授权');
    expect(PM_PROMPT).toContain('这超出我的岗位职责，已转交给对应岗位');
  });

  it('③ 纪律正文**岗位无关**：不写死任何行业产出物与角色映射', () => {
    // 平台是通用的（法务/研究/运营团队都在用）。写死「需求→产品经理」这类映射，
    // 会让非研发团队读到与本团队无关的纪律，等于没写。
    for (const pair of ['需求→', '方案→', '实现→', '用例→', '计划→']) {
      expect(PM_PROMPT).not.toContain(pair);
    }
    expect(PM_PROMPT).not.toContain('需求/方案');
    // 「产出归谁」是每个岗位自己的职责描述（可配置），不是 PM 纪律里的常量表。
    expect(PM_PROMPT).toContain('各岗位职责');
  });

  it('③ 串行派活：一次一个执行者 + 其余成员群帖告知 + 上游 stage=end 再派下游', () => {
    expect(PM_PROMPT).toContain('串行派活');
    expect(PM_PROMPT).toContain('一次只激活一个执行者');
    // 具体工具名（不是「通知一下」这种无法执行的描述）。
    expect(PM_PROMPT).toContain('vteam_notify_agent');
    expect(PM_PROMPT).toContain('vteam_group_post');
    // 群帖只告知、不唤醒 —— 与平台【@ 定向机制】一致（@ 不唤醒，notify 才唤醒）。
    expect(PM_PROMPT).toContain('群帖不唤醒任何人');
    // 顺序依赖的具体回执条件。
    expect(PM_PROMPT).toContain('stage=end');
  });

  it('④ 做完即停：只做被派的那一步、不并行产出、不替人做专业判断', () => {
    expect(PM_PROMPT).toContain('做完即停');
    expect(PM_PROMPT).toContain('只完成派给你的那一步');
    expect(PM_PROMPT).toContain('不并行产出别处的材料');
    expect(PM_PROMPT).toContain('不替其他岗位做专业判断');
  });

  it('越界条目 = 拒绝**并**转交归属岗位（不再只是「按【职责边界】转交」）', () => {
    // 原有措辞保留（seed.spec 逐角色断言这句），在其后补上「先拒绝 + 交归属岗位」。
    expect(PM_PROMPT).toContain(
      '越界按系统提示【职责边界】转交（单一来源 ROLE_BOUNDARIES）：先明确拒绝，再把该工作交给归属岗位',
    );
  });

  it('纪律是**可执行指令**（祈使句条目），不是身份陈述或条件式愿望', () => {
    const bullets = PM_PROMPT.split('\n').filter((l) => l.startsWith('- '));
    const discipline = [
      '【判定顺序·任何请求先过这一步】',
      '【冲突裁决】',
      '串行派活',
      '做完即停',
    ];
    for (const head of discipline) {
      const line = bullets.find((l) => l.startsWith(`- ${head}`));
      expect(line).toBeDefined();
      // 祈使句：不是「应该/可以/尽量」这类愿望式措辞。
      expect(line).not.toMatch(/应该|尽量|最好|建议/);
    }
  });

  it('原有岗位内容一条没丢（身份 / 职责 / 协同方式 / 验收边界）', () => {
    expect(PM_PROMPT.startsWith('# 角色：项目经理')).toBe(true);
    expect(PM_PROMPT).toContain('## 职责');
    expect(PM_PROMPT).toContain('## 协同方式');
    expect(PM_PROMPT).toContain('环节推进：');
    expect(PM_PROMPT).toContain('计划完工：');
    expect(PM_PROMPT).toContain('进度跟踪：');
    expect(PM_PROMPT).toContain('风险管理：');
    expect(PM_PROMPT).toContain('阻塞协调：');
    expect(PM_PROMPT).toContain(
      '不代写任何岗位的内容本身；不代替任何岗位做专业判断；不作出验收判定',
    );
    expect(PM_PROMPT).toContain(
      '验收边界：不越权验收——验收判定权在成员，可协助整理验收材料与进度汇总。',
    );
    // 「## 工作方式」是 agent prompt 的地盘，岗位定义里不得出现（seed.spec 逐角色断言）。
    expect(PM_PROMPT).not.toContain('## 工作方式');
  });
});

describe('PM 岗位定义与 seed.ts 自包含镜像逐字节一致（老坑：三处副本）', () => {
  it('7 个内置岗位正文：常量 === seed 镜像（逐角色）', () => {
    const seedPrompts = seedRolePrompts();
    expect(Object.keys(seedPrompts).sort()).toEqual(
      Object.keys(BUILTIN_ROLE_PROMPTS).sort(),
    );
    for (const key of Object.keys(BUILTIN_ROLE_PROMPTS)) {
      expect(seedPrompts[key]).toBe(BUILTIN_ROLE_PROMPTS[key]);
    }
  });

  it('PM 的 scopeSummary：常量 === seed 镜像（ROLE_BOUNDARIES 镜像）', () => {
    expect(seedScopeSummary('vteam-project_manager')).toBe(PM_SCOPE);
  });
});

describe('平台级【职责边界】段必须承载「主动委派」而不是只有条件式禁令', () => {
  it('scopeSummary 是**一句**主动规则：产出归谁由岗位职责界定，自己只产出派发与核验', () => {
    expect(PM_SCOPE).toContain('产出归谁由各岗位职责界定');
    expect(PM_SCOPE).toContain('你只产出派发与核验');
    // 岗位无关：不得写死行业产出物枚举（非研发团队读到即失效）。
    for (const noun of ['需求', '方案', '代码', '用例']) {
      expect(PM_SCOPE).not.toContain(noun);
    }
    // 「超出职责范围的请求必须拒绝」是渲染段第二行的固定文案，不是 scopeSummary 的内容；
    // scopeSummary 必须自带主动语义，否则 agent 只在被要求越界时才想起边界。
    expect(PM_SCOPE).not.toContain('超出职责范围的请求必须拒绝');
  });

  it('scopeSummary 保持单句且不膨胀（它会被插进每次越界拒绝话术）', () => {
    expect(PM_SCOPE).not.toContain('\n');
    expect(PM_SCOPE.split('。').filter((s) => s.length > 0)).toHaveLength(1);
    expect(PM_SCOPE.endsWith('。')).toBe(true);
    // 上限 = 越界拒绝护栏：ROLE_POLICY_DENY_TEMPLATE 每次拒绝都会插一遍。
    expect(PM_SCOPE.length).toBeLessThanOrEqual(120);
    expect(ROLE_POLICY_DENY_TEMPLATE).toContain('<scopeSummary>');
    const denial = ROLE_POLICY_DENY_TEMPLATE.replace(
      '<scopeSummary>',
      PM_SCOPE,
    ).replace('{role}', '项目经理');
    expect(denial.length).toBeLessThanOrEqual(240);
  });

  it('renderBoundarySection 渲染出的【职责边界】段含主动委派条款', () => {
    const section = renderBoundarySection({
      scopeSummary: PM_SCOPE,
      handoff: ROLE_BOUNDARIES['vteam-project_manager'].handoffTo,
    });
    expect(section).toContain('【职责边界】');
    expect(section).toContain(PM_SCOPE);
    expect(section).toContain('产出归谁由各岗位职责界定');
    expect(section).toContain('你只产出派发与核验');
    // 转交映射仍由 handoffTo 渲染（语义未变）。
    expect(section).toContain('code→vteam-developer');
    expect(section).toContain('test→vteam-tester');
    // 越界处理段仍是既有固定文案（本批不改渲染器）。
    expect(section).toContain('越界处理：超出上述职责范围的请求必须拒绝');
  });
});
