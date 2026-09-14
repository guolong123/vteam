jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
}));
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
}));

const mockPrisma = {
  role: { upsert: jest.fn().mockResolvedValue({ id: 'r_admin' }) },
  user: { upsert: jest.fn().mockResolvedValue({ id: 'u_admin' }) },
  agent: { upsert: jest.fn().mockResolvedValue({}) },
  // 角色 ExecutionPolicy seed（vteam-role-behavior-enforcement Todo 3）：
  // mock 缺少该 key 时 seed 首次 policy upsert 即抛 TypeError。
  executionPolicy: { upsert: jest.fn().mockResolvedValue({}) },
  model: {
    findMany: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue({}),
  },
  workerModelAvailability: { deleteMany: jest.fn().mockResolvedValue({}) },
  tool: { upsert: jest.fn().mockResolvedValue({}) },
  mcpServer: { upsert: jest.fn().mockResolvedValue({}) },
  skill: { upsert: jest.fn().mockResolvedValue({}) },
  team: { upsert: jest.fn().mockResolvedValue({ id: 'tm_0000000001' }) },
  teamMember: { upsert: jest.fn().mockResolvedValue({}) },
  teamUserMember: { upsert: jest.fn().mockResolvedValue({}) },
  $disconnect: jest.fn().mockResolvedValue(undefined),
};

import { main } from '../../prisma/seed';
import {
  AGENT_KEY_PATTERN,
  buildEditPermission,
  buildReadPermission,
  ROLE_BOUNDARIES,
  ROLE_SERVER_GATED_TOOLS,
  VTEAM_MCP_TOOL_NAMES,
} from '../common/constants/agent.constants';

/** 模板 Agent id → 角色 ExecutionPolicy id（seed ROLE_POLICY_BINDINGS 的绑定产物）。 */
const POLICY_BY_AGENT: Record<string, string> = {
  a_product: 'ep_product',
  a_project_manager: 'ep_project_manager',
  a_architect: 'ep_architect',
  a_developer: 'ep_developer',
  a_tester: 'ep_tester',
  a_plan: 'ep_plan',
};

/** 模板 Agent id → role（seed templateAgents 的 role，模板 agentKey 固定等于 role）。 */
const ROLE_BY_AGENT: Record<string, string> = {
  a_product: 'product',
  a_project_manager: 'project_manager',
  a_architect: 'architect',
  a_developer: 'developer',
  a_tester: 'tester',
  a_plan: 'plan',
};

/** 角色 ExecutionPolicy id → opencode agent 名（ROLE_BOUNDARIES 的 key）。 */
const AGENT_NAME_BY_POLICY: Record<string, keyof typeof ROLE_BOUNDARIES> = {
  ep_product: 'vteam-product',
  ep_project_manager: 'vteam-project_manager',
  ep_architect: 'vteam-architect',
  ep_developer: 'vteam-developer',
  ep_tester: 'vteam-tester',
  ep_plan: 'vteam-plan',
};

/** 层① task 门期望：运行时先读边界 taskEffect 形状（Todo 1 若落地），否则仅 vteam-plan allow。 */
const expectedTaskEffect = (agentName: keyof typeof ROLE_BOUNDARIES): string => {
  const runtime = (ROLE_BOUNDARIES[agentName] as unknown as { taskEffect?: unknown }).taskEffect;
  if (runtime === 'allow' || runtime === 'deny') return runtime;
  return agentName === 'vteam-plan' ? 'allow' : 'deny';
};

/**
 * 裸 MCP 工具名（剥离 vteam_ 前缀）：prompt 中只允许真实暴露名 `vteam_<action>`，
 * 禁止裸名（`agent.constants.ts` VTEAM_MCP_TOOL_NAMES 为命名空间单一来源）。
 */
const BARE_MCP_NAMES = VTEAM_MCP_TOOL_NAMES.map((name) => name.replace(/^vteam_/, ''));

const templateAgentCalls = () =>
  mockPrisma.agent.upsert.mock.calls.filter((call) => String(call[0].where.id).startsWith('a_'));

describe('seed（模板 Agent 预置 + 角色策略）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('6 类模板 Agent upsert create 分支均预置为 template 类型（含计划员 a_plan）', async () => {
    await main();

    const agentUpserts = mockPrisma.agent.upsert.mock.calls;
    const templateIds = agentUpserts
      .map((call) => call[0].where.id)
      .filter((id) => id.startsWith('a_'));
    expect(templateIds).toHaveLength(6);
    expect(templateIds).toContain('a_plan');
    for (const id of templateIds) {
      const call = agentUpserts.find((c) => c[0].where.id === id);
      expect(call[0].create.type).toBe('template');
      expect(call[0].create.ackMessage).toBeUndefined();
    }
  });

  it('已移除默认 ACK 文案（收到，正在处理… 机制已下线）', async () => {
    await main();
    const ackValues = mockPrisma.agent.upsert.mock.calls
      .map((call) => call[0].create.ackMessage)
      .filter((v: unknown) => v !== undefined);
    expect(ackValues).toEqual([]);
  });

  it('6 条角色 ExecutionPolicy upsert：type=template、permission 全量派生自 ROLE_BOUNDARIES', async () => {
    await main();

    const policyCalls = mockPrisma.executionPolicy.upsert.mock.calls;
    expect(policyCalls).toHaveLength(6);
    expect(policyCalls.map((call) => call[0].where.id).sort()).toEqual(
      Object.values(POLICY_BY_AGENT).sort(),
    );

    for (const call of policyCalls) {
      const { create, update } = call[0];
      expect(create.type).toBe('template');
      expect(update.type).toBe('template');
      expect(update.config).toEqual(create.config);

      const agentName = AGENT_NAME_BY_POLICY[String(call[0].where.id)];
      const boundary = ROLE_BOUNDARIES[agentName];
      const permission = create.config.permission;
      // 层① 全量派生自边界运行时值（不硬编码 glob：Todo 1 的 plans glob 形状同进退）：
      // edit 经 buildEditPermission(writeGlobs)、read 全 allow、bash 取 bashEffect、
      // task 取边界 taskEffect 形状（仅 vteam-plan allow）。
      expect(permission).not.toHaveProperty('write');
      expect(permission.edit).toEqual(buildEditPermission(boundary.writeGlobs));
      expect(permission.read).toEqual(buildReadPermission());
      expect(permission.bash).toBe(boundary.bashEffect);
      expect(permission.task).toBe(expectedTaskEffect(agentName));
      expect(permission.edit['*']).toBe('deny');

      // 其余键一律为真实暴露名 `vteam_<action>` 的 deny（禁裸 MCP 名、禁未知键），
      // 且与该角色 `ROLE_BOUNDARIES.mcpDenies` 逐项一致（product 全 allow 非门控工具时可为空）。
      const otherKeys = Object.keys(permission).filter(
        (key) => !['edit', 'read', 'bash', 'task'].includes(key),
      );
      expect([...otherKeys].sort()).toEqual(
        [...ROLE_BOUNDARIES[agentName].mcpDenies].sort(),
      );
      for (const key of otherKeys) {
        expect(key.startsWith('vteam_')).toBe(true);
        expect(permission[key]).toBe('deny');
      }
      // 主实例专属工具（server-gated）由 platform-mcp 服务端判定：
      // 层① permission 不写 deny 键（guard 层② 亦不列入 allowlist）。
      for (const gated of ROLE_SERVER_GATED_TOOLS) {
        expect(permission).not.toHaveProperty(gated);
      }

      // 层② 纠正配置：越界话术指向真实工具名 + 角色摘要非空
      expect(create.config.correction.scopeSummary.length).toBeGreaterThan(0);
      expect(create.config.correction.denyTemplate).toContain('vteam_notify_agent');
    }
  });

  it('模板策略 config.tools 为 ROLE_BOUNDARIES allowlist 的拷贝（克隆深拷贝来源）', async () => {
    await main();

    const policyCalls = mockPrisma.executionPolicy.upsert.mock.calls;
    expect(policyCalls).toHaveLength(6);
    for (const call of policyCalls) {
      const policyId = String(call[0].where.id);
      const agentName = AGENT_NAME_BY_POLICY[policyId];
      expect(agentName).toBeDefined();
      expect(call[0].create.config.tools).toEqual(
        ROLE_BOUNDARIES[agentName].toolAllows,
      );
      expect(Object.keys(call[0].create.config.tools).length).toBeGreaterThan(
        0,
      );
      expect(call[0].update.config).toEqual(call[0].create.config);
    }
  });

  it('模板 Agent create 与 update 均写入 agentKey = role（opencode 注入名 vteam-<agentKey> 与现状一致）', async () => {
    await main();

    // agentKey='plan' 满足 AGENT_KEY_PATTERN（小写开头，不假设、直接验证）
    expect('plan').toMatch(new RegExp(AGENT_KEY_PATTERN));

    const templateCalls = templateAgentCalls();
    expect(templateCalls).toHaveLength(6);
    for (const call of templateCalls) {
      const id = String(call[0].where.id);
      expect(call[0].create.agentKey).toBe(ROLE_BY_AGENT[id]);
      expect(call[0].update.agentKey).toBe(ROLE_BY_AGENT[id]);
    }
  });

  it('模板 Agent create 与 update 均绑定角色策略 policyId', async () => {
    await main();

    const templateCalls = templateAgentCalls();
    expect(templateCalls).toHaveLength(6);
    for (const call of templateCalls) {
      const id = String(call[0].where.id);
      expect(call[0].create.policyId).toBe(POLICY_BY_AGENT[id]);
      expect(call[0].update.policyId).toBe(POLICY_BY_AGENT[id]);
    }
  });

  it('ExecutionPolicy upsert 先于模板 Agent upsert（绑定指向已存在策略行）', async () => {
    await main();

    const policyOrder = mockPrisma.executionPolicy.upsert.mock.invocationCallOrder.slice(-6);
    const agentOrder = mockPrisma.agent.upsert.mock.invocationCallOrder.slice(-6);
    expect(policyOrder).toHaveLength(6);
    expect(agentOrder).toHaveLength(6);
    expect(Math.max(...policyOrder)).toBeLessThan(Math.min(...agentOrder));
  });

  it('已存在模板 Agent 时 update 分支仅同步出厂默认 prompt 与 policyId，不覆盖用户修改字段', async () => {
    await main();

    const templateCalls = templateAgentCalls();
    expect(templateCalls).toHaveLength(6);
    for (const call of templateCalls) {
      // prompt 为平台出厂默认值，seed 随平台升级同步（16 篇 §8.4）；policyId 为角色策略绑定；
      // agentKey 为模板固定绑定（= role）；其余字段不 touch
      expect(Object.keys(call[0].update).sort()).toEqual(['agentKey', 'policyId', 'prompt']);
      expect(typeof call[0].update.prompt).toBe('string');
      expect(call[0].update.prompt.length).toBeGreaterThan(50);
      expect(call[0].update).not.toHaveProperty('permissionScope');
      expect(call[0].update).not.toHaveProperty('name');
      expect(call[0].update).not.toHaveProperty('persona');
      expect(call[0].update).not.toHaveProperty('defaultModelId');
    }
  });

  it('首次创建模板 Agent 时 create 分支 defaultModelId 为 null（动态模型目录，不再静态预置）', async () => {
    await main();

    const templateCalls = templateAgentCalls();
    for (const call of templateCalls) {
      // TEMPLATE_DEFAULT_MODELS 已清空（动态获取）：seed 落 null，模型按 worker 上报动态目录选择
      expect(call[0].create.defaultModelId).toBeNull();
    }
  });

  it('模板 prompt 四方向齐全、含越界转交，且不含禁用词/裸 MCP 名', async () => {
    await main();

    const templateCalls = templateAgentCalls();
    expect(templateCalls).toHaveLength(6);
    for (const call of templateCalls) {
      const id = String(call[0].where.id);
      const prompt = call[0].update.prompt as string;
      for (const section of ['## 职责', '## 权限', '## 工作方式', '## 协同方式']) {
        expect(prompt).toContain(section);
      }
      // 越界拒绝与转交（vteam_notify_agent 为真实暴露名）
      expect(prompt).toContain('转交');
      expect(prompt).toContain('vteam_notify_agent');
      // 主 Agent 禁令仅约束旧五角色：计划员 prompt 必须写明只接受主 Agent 派活
      if (id === 'a_plan') {
        expect(prompt).toContain('主 Agent');
      } else {
        expect(prompt).not.toContain('主 Agent');
      }
      expect(prompt).not.toContain('牵头协调者');
      expect(prompt).not.toContain('UI 设计');
      // 裸 MCP 工具名（不带 vteam_ 前缀）一律禁止
      for (const bare of BARE_MCP_NAMES) {
        const barePattern = new RegExp(`(?<!vteam_)\\b${bare}\\b`);
        expect(prompt).not.toMatch(barePattern);
      }
    }
  });

  it('计划员 prompt 四方向内容齐全（身份/职责/边界/协同）', async () => {
    await main();

    const planCall = templateAgentCalls().find((call) => String(call[0].where.id) === 'a_plan');
    expect(planCall).toBeDefined();
    const prompt = planCall![0].update.prompt as string;
    // 身份：团队计划专员，群内可见可@，agent 管理可见
    expect(prompt).toContain('计划专员');
    expect(prompt).toContain('@');
    // 职责：响应主 Agent @ 派活起草计划（explore-first，可 fan-out task 子会话）
    expect(prompt).toContain('派活');
    expect(prompt).toContain('subagent_type恒为vteam-plan');
    // 职责：落盘 .opencode/plans/；群聊回复摘要；按 feedback 修订
    expect(prompt).toContain('.opencode/plans/');
    expect(prompt).toContain('摘要');
    expect(prompt).toContain('feedback');
    // 边界：只读分析 + 计划目录窄写 + 群聊回复；禁实现/禁执行/禁直接问用户；禁改他文件
    expect(prompt).toContain('只读');
    expect(prompt).toContain('禁改');
    expect(prompt).toContain('不执行变更');
    // 协同：只接受主 Agent 派活；评审视角任务走各 plan-review-<role> skill
    expect(prompt).toContain('只接受主 Agent 派活');
    expect(prompt).toContain('plan-review-');
  });

  it('模板 prompt「可用工具」行集合等于 ROLE_BOUNDARIES[agentName].toolAllows 键集（漂移即失败）', async () => {
    await main();

    const templateCalls = templateAgentCalls();
    expect(templateCalls).toHaveLength(6);
    for (const call of templateCalls) {
      const id = String(call[0].where.id);
      const agentName = AGENT_NAME_BY_POLICY[POLICY_BY_AGENT[id]];
      expect(agentName).toBeDefined();
      const prompt = call[0].update.prompt as string;
      // 「可用工具：a / b + c（只读）。」行：按 / 与 + 切分，去掉（只读）后缀后即工具名集合
      const line = prompt.match(/可用工具：([^。]+)。/);
      expect(line).not.toBeNull();
      const listed = line![1]
        .split(/[/+]/)
        .map((token) => token.trim().replace(/（.*）$/, ''))
        .filter((token) => token.length > 0);
      expect([...listed].sort()).toEqual(
        [...Object.keys(ROLE_BOUNDARIES[agentName].toolAllows)].sort(),
      );
      for (const gated of ROLE_SERVER_GATED_TOOLS) {
        expect(listed).not.toContain(gated);
      }
    }
  });

  it('示例团队同时 upsert seed-admin 与 admin(u_admin) 为 owner（fresh deploy 下 admin 开箱可进群）', async () => {
    await main();

    const tumCalls = mockPrisma.teamUserMember.upsert.mock.calls;
    expect(tumCalls).toHaveLength(2);
    const createIds = tumCalls.map((call) => call[0].create.id).sort();
    expect(createIds).toEqual(['tum_0000000001', 'tum_admin_seed']);
    for (const call of tumCalls) {
      expect(call[0].create.teamId).toBe('tm_0000000001');
      expect(call[0].create.role).toBe('owner');
      expect(call[0].update).toEqual({});
    }
  });
});

describe('seed（计划 skills + 评审子句）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** 计划 skill 名 → 期望的 frontmatter allowed-tools（seed 冻结契约）。 */
  const PLAN_SKILL_TOOLS: Record<string, string[]> = {
    'plan-creation': [
      'task_context',
      'read_file',
      'doclib',
      'chat_history',
      'task',
    ],
    'plan-review-product': ['read_file', 'task_context', 'chat_history', 'skill'],
    'plan-review-architect': ['read_file', 'task_context', 'chat_history', 'skill'],
    'plan-review-developer': ['read_file', 'task_context', 'chat_history', 'skill'],
    'plan-review-tester': ['read_file', 'task_context', 'chat_history', 'skill'],
    'plan-review-project_manager': ['read_file', 'task_context', 'chat_history', 'skill'],
  };

  /** 模板 Agent id → 其角色专属评审 skill 名（下划线原样保留）。 */
  const REVIEW_SKILL_BY_AGENT: Record<string, string> = {
    a_product: 'plan-review-product',
    a_project_manager: 'plan-review-project_manager',
    a_architect: 'plan-review-architect',
    a_developer: 'plan-review-developer',
    a_tester: 'plan-review-tester',
  };

  const planSkillCalls = () =>
    mockPrisma.skill.upsert.mock.calls.filter((call) =>
      Object.prototype.hasOwnProperty.call(PLAN_SKILL_TOOLS, String(call[0].where.name)),
    );

  /** 从 skill content 中解析 frontmatter allowed-tools 列表。 */
  const parseAllowedTools = (content: string): string[] => {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    expect(match).not.toBeNull();
    const frontmatter = match![1];
    const toolsSection = frontmatter.split('allowed-tools:')[1];
    expect(toolsSection).toBeDefined();
    return toolsSection
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim());
  };

  it('6 个计划 skills upsert 且 enabled（1 编制 + 5 评审）', async () => {
    await main();

    const calls = planSkillCalls();
    expect(calls.map((call) => String(call[0].where.name)).sort()).toEqual(
      Object.keys(PLAN_SKILL_TOOLS).sort(),
    );
    for (const call of calls) {
      expect(call[0].create.enabled).toBe(true);
      expect(call[0].update.enabled).toBe(true);
      expect(call[0].create.name).toBe(call[0].where.name);
      expect(typeof call[0].create.content).toBe('string');
      expect(call[0].create.content.length).toBeGreaterThan(100);
    }
  });

  it('计划 skills frontmatter 含 name/description/version/allowed-tools 且工具集精确匹配', async () => {
    await main();

    const calls = planSkillCalls();
    expect(calls).toHaveLength(6);
    for (const call of calls) {
      const name = String(call[0].where.name);
      const content = call[0].create.content as string;
      expect(content).toContain(`name: ${name}`);
      expect(content).toContain('description:');
      expect(content).toContain('version:');
      expect(parseAllowedTools(content).sort()).toEqual([...PLAN_SKILL_TOOLS[name]].sort());
    }
  });

  it('plan-creation 使用者为计划成员：无 question 交互与送审调用，有扇出纪律节', async () => {
    await main();

    const byName = new Map(
      planSkillCalls().map((call) => [String(call[0].where.name), call[0].create.content as string]),
    );
    const creation = byName.get('plan-creation')!;
    // 计划成员侧：响应主 Agent @ 派活，落盘后群聊摘要、按 feedback 修订
    for (const keyword of [
      '.opencode/plans/',
      'agentMembers',
      '计划成员',
      'feedback',
      'REJECT',
    ]) {
      expect(creation).toContain(keyword);
    }
    // 扇出纪律节：subagent_type 恒为 vteam-plan、前台阻塞等结果、2~4 路、禁套娃、VERDICT 回收
    for (const keyword of [
      '扇出纪律',
      'subagent_type恒为vteam-plan',
      '前台阻塞',
      '2~4 路',
      '禁套娃',
      'VERDICT',
    ]) {
      expect(creation).toContain(keyword);
    }
    // 用户交互与正式送审归主 Agent：本 skill 内无 question 工具使用、无送审调用
    expect(parseAllowedTools(creation)).toContain('task');
    expect(parseAllowedTools(creation)).not.toContain('question');
    expect(parseAllowedTools(creation)).not.toContain('vteam_plan_review');
    expect(creation).not.toContain('question');
    expect(creation).not.toContain('vteam_plan_review');
    for (const name of Object.keys(REVIEW_SKILL_BY_AGENT).map((id) => REVIEW_SKILL_BY_AGENT[id])) {
      const content = byName.get(name)!;
      expect(content).toContain('VERDICT: APPROVE');
      expect(content).toContain('VERDICT: REJECT');
      expect(content).toContain('禁止修改计划文件');
      expect(content).toContain('禁止执行计划');
      expect(content).toContain('read_file');
    }
  });

  it('5 个评审 skills 各加一句 subagent 注记（检查清单不动）', async () => {
    await main();

    const byName = new Map(
      planSkillCalls().map((call) => [String(call[0].where.name), call[0].create.content as string]),
    );
    for (const name of Object.values(REVIEW_SKILL_BY_AGENT)) {
      expect(byName.get(name)).toContain('subagent');
    }
  });

  it('plan-creation 含 OmO 编制五要素（波次/证据/假设清单/反模式/送审预判）', async () => {
    await main();

    const byName = new Map(
      planSkillCalls().map((call) => [String(call[0].where.name), call[0].create.content as string]),
    );
    const creation = byName.get('plan-creation')!;
    // D1.1 波次结构：Wave 1/2/N + task_context 事实来源
    expect(creation).toContain('Wave 1');
    expect(creation).toContain('Wave 2');
    // D1.2 证据要求：每项附证据，无证据标假设
    expect(creation).toContain('证据要求');
    expect(creation).toContain('[假设]');
    // D1.3 假设清单段
    expect(creation).toContain('## 假设清单');
    // D1.4 反模式：不虚构并行度（旧句保留）+ ✅/❌ 例
    expect(creation).toContain('不虚构并行度');
    expect(creation).toContain('## 反模式');
    expect(creation).toContain('❌');
    expect(creation).toContain('✅');
    // D1.5 送审预判：APPROVAL BIAS / 存疑放行，能开工而非完美
    expect(creation).toContain('APPROVAL BIAS');
    expect(creation).toContain('存疑放行');
    // 7 步骨架与 sibling 互引仍在
    for (const step of ['步骤 1', '步骤 7', '任务分配']) {
      expect(creation).toContain(step);
    }
    expect(creation).toContain('plan-review-product');
    expect(creation).toContain('plan-review-project_manager');
  });

  it('5 个评审 skills 含统一 Momus/Oracle 骨架（目的句/放行偏置/上限/篇幅/范围纪律）', async () => {
    await main();

    const byName = new Map(
      planSkillCalls().map((call) => [String(call[0].where.name), call[0].create.content as string]),
    );
    const reviewContents = Object.values(REVIEW_SKILL_BY_AGENT).map((name) => byName.get(name)!);
    for (const content of reviewContents) {
      // D2.1 目的句 + APPROVAL BIAS（存疑放行）
      expect(content).toContain('能否不卡住地执行');
      expect(content.includes('APPROVAL BIAS') || content.includes('存疑放行')).toBe(true);
      // D2.2 每条视角补 PASS/FAIL 线
      expect(content).toContain('PASS');
      expect(content).toContain('FAIL');
      // D2.3 反模式 + REJECT 最多 3 条
      expect(content).toContain('## 反模式');
      expect(content.includes('最多 3 条') || content.includes('不超过 3 条')).toBe(true);
      expect(content).toContain('✅');
      expect(content).toContain('❌');
      // D2.4 严格输出格式：VERDICT 首行 + 篇幅上限
      expect(content).toContain('第一行必须是');
      expect(content).toContain('VERDICT: APPROVE');
      expect(content).toContain('VERDICT: REJECT');
      expect(content.includes('篇幅上限') || content.includes('每条≤2句')).toBe(true);
      // D2.5 范围纪律：不 redesign、不扩面
      expect(content.includes('范围纪律') || content.includes('不 redesign')).toBe(true);
      // D2.6 旧禁令保留：只读不改文件、不执行
      expect(content).toContain('禁止修改计划文件');
      expect(content).toContain('禁止执行计划');
    }
  });

  it('5 个评审 skills 视角关键词各异（每角色主关键词仅出现一次）', async () => {
    await main();

    const byName = new Map(
      planSkillCalls().map((call) => [String(call[0].where.name), call[0].create.content as string]),
    );
    const roleKeyword: Record<string, string> = {
      'plan-review-product': '用户视角',
      'plan-review-architect': '技术合理性',
      'plan-review-developer': '步骤可执行性',
      'plan-review-tester': '测试覆盖度',
      'plan-review-project_manager': '排期真实性',
    };
    const reviewContents = Object.values(REVIEW_SKILL_BY_AGENT).map((name) => byName.get(name)!);
    for (const [skillName, keyword] of Object.entries(roleKeyword)) {
      const owner = byName.get(skillName)!;
      expect(owner).toContain(keyword);
      for (const other of reviewContents) {
        if (other === owner) continue;
        expect(other).not.toContain(keyword);
      }
    }
  });

  it('旧五角色 prompt 点名其专属评审 skill（skill(plan-review-<role>)）；计划员走按需加载', async () => {
    await main();

    const templateCalls = templateAgentCalls();
    expect(templateCalls).toHaveLength(6);
    for (const call of templateCalls) {
      const id = String(call[0].where.id);
      const prompt = call[0].update.prompt as string;
      if (id === 'a_plan') {
        // 计划员无专属评审 skill：协同写明评审视角任务走各 plan-review-<role>、自己需要时加载对应 skill
        expect(prompt).toContain('plan-review-');
        continue;
      }
      expect(prompt).toContain(`skill(${REVIEW_SKILL_BY_AGENT[id]})`);
    }
  });

  it('工具目录不再 upsert plan_review（D4 单路径：server 编排评审已删，评审走成员子会话）', async () => {
    await main();

    const toolCalls = mockPrisma.tool.upsert.mock.calls;
    const planReview = toolCalls.find((call) => call[0].where.action === 'plan_review');
    expect(planReview).toBeUndefined();
  });

  it('示例团队 6 成员：a_plan 末位 tmm_0000000006 别名计划员-1，非主 Agent（主 Agent 保持首位 PM）', async () => {
    await main();

    const memberCalls = mockPrisma.teamMember.upsert.mock.calls;
    expect(memberCalls).toHaveLength(6);
    expect(memberCalls.map((call) => String(call[0].where.id))).toEqual([
      'tmm_0000000001',
      'tmm_0000000002',
      'tmm_0000000003',
      'tmm_0000000004',
      'tmm_0000000005',
      'tmm_0000000006',
    ]);
    const first = memberCalls[0][0].create;
    expect(first.agentId).toBe('a_product');
    const plan = memberCalls[5][0].create;
    expect(plan.agentId).toBe('a_plan');
    expect(plan.alias).toBe('计划员-1');
  });

  it('评审 skill 名不出现在非属角色的 prompt 中（无交叉污染，含计划员）', async () => {
    await main();

    const templateCalls = templateAgentCalls();
    expect(templateCalls).toHaveLength(6);
    const allSkills = Object.values(REVIEW_SKILL_BY_AGENT);
    for (const call of templateCalls) {
      const id = String(call[0].where.id);
      const prompt = call[0].update.prompt as string;
      for (const skillName of allSkills) {
        if (skillName === REVIEW_SKILL_BY_AGENT[id]) continue;
        expect(prompt).not.toContain(`skill(${skillName})`);
      }
    }
  });
});
