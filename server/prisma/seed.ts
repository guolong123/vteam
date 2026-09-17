import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';

// ========================================================================
// 自包含常量（dev-path parity）：本文件不再 import `../src/...`。
// 原因：生产 runner 镜像仅含 dist/node_modules/package.json/prisma（无 src/、
// 无 tsconfig.json），`npm run seed`（ts-node，全量类型检查 + strict 默认）
// 在该环境下报 TS2307（找不到 agent.constants / memory.constants）并连带
// TS7006（隐式 any）。规范 seed 路径（init 容器 `node dist/prisma/seed.js`）
// 不受影响；本镜像使 ts-node 路径在有无 src/ 的环境下均可编译运行。
// 值与 `src/common/constants/agent.constants.ts` /
// `src/memories/memory.constants.ts` 逐字节一致；`src/prisma/seed.spec.ts`
// 逐项断言 seed 落库输出与 src 常量派生值相等——改 src 边界必须同步改此处，
// 否则单测失败（唯一事实来源仍是 src 常量，本块为其镜像）。
// ========================================================================

type VteamAgentName =
  | 'vteam-product'
  | 'vteam-architect'
  | 'vteam-developer'
  | 'vteam-tester'
  | 'vteam-project_manager'
  | 'vteam-plan'
  | 'vteam-librarian';

interface RoleBoundary {
  scopeSummary: string;
  deliverables: string[];
  handoffTo: Record<string, string>;
  writeGlobs: string[];
  readGlobs: string[];
  bashEffect: 'allow' | 'ask' | 'deny';
  mcpDenies: string[];
  toolAllows: Record<string, 'allow' | 'ask'>;
}

const VTEAM_MCP_TOOL_NAMES: readonly string[] = [
  'vteam_chat_history',
  'vteam_doclib',
  'vteam_task_context',
  'vteam_group_post',
  'vteam_read_file',
  'vteam_notify_agent',
  'vteam_submit_artifact',
  'vteam_issue_create',
  'vteam_issue_list',
  'vteam_issue_get',
  'vteam_issue_update',
  'vteam_issue_transition',
  'vteam_task_transition',
  'vteam_question_confirm',
  'vteam_memory_save',
  'vteam_memory_search',
  'vteam_memory_update',
  'vteam_team_view',
  'vteam_my_profile',
  'vteam_team_add_member',
  'vteam_plan_mode',
  'vteam_plan_complete',
  'vteam_channel_send',
  'vteam_wecom_reply',
  'vteam_task_create',
  'vteam_skill_create',
  'vteam_git_repos_list',
  'vteam_hook_register',
  'vteam_hook_cancel',
] as const;

const ROLE_SERVER_GATED_TOOLS: readonly string[] = [
  'vteam_task_transition',
  'vteam_question_confirm',
  'vteam_task_create',
  'vteam_plan_mode',
  'vteam_plan_complete',
  'vteam_team_add_member',
  'vteam_skill_create',
] as const;

const SERVER_GATED_SET: ReadonlySet<string> = new Set(ROLE_SERVER_GATED_TOOLS);

function defineBoundary(base: Omit<RoleBoundary, 'mcpDenies'>): RoleBoundary {
  const allowed = new Set(Object.keys(base.toolAllows));
  return {
    ...base,
    mcpDenies: VTEAM_MCP_TOOL_NAMES.filter(
      (name) => !allowed.has(name) && !SERVER_GATED_SET.has(name),
    ),
  };
}

const ROLE_TASK_GLOB_BASE = '**tasks/*' as const;

function taskSubdirGlob(subdir: string): string {
  return `${ROLE_TASK_GLOB_BASE}/${subdir}/**`;
}

function taskAllGlob(): string {
  return `${ROLE_TASK_GLOB_BASE}/**`;
}

function planDirGlob(): string {
  return '**.opencode/plans/**';
}

function buildEditPermission(writeGlobs: readonly string[]): Record<string, 'allow' | 'deny'> {
  return {
    '*': 'deny',
    ...Object.fromEntries(writeGlobs.map((glob) => [glob, 'allow' as const])),
  };
}

function buildReadPermission(): Record<string, 'allow'> {
  return { '*': 'allow' };
}

const ROLE_POLICY_DENY_TEMPLATE =
  '【越界拦截｜角色：{role}】不能调用 <tool>。职责：<scopeSummary>。请把该工作转交 {handoffTarget}，或使用 vteam_notify_agent 定向通知。' as const;

const ROLE_BOUNDARIES: Record<VteamAgentName, RoleBoundary> = {
  'vteam-product': defineBoundary({
    scopeSummary:
      '需求分析与原型设计：澄清并定义需求，产出需求文档与原型；不编写实现代码、不做技术方案、不替代测试判定。',
    deliverables: ['需求文档', '原型设计'],
    handoffTo: {
      design: 'vteam-architect',
      code: 'vteam-developer',
      test: 'vteam-tester',
      process: 'vteam-project_manager',
    },
    writeGlobs: [taskSubdirGlob('prototypes'), taskSubdirGlob('docs')],
    readGlobs: ['*'],
    bashEffect: 'allow',
    toolAllows: {
      vteam_submit_artifact: 'allow',
      vteam_doclib: 'allow',
      vteam_issue_create: 'allow',
      vteam_issue_list: 'allow',
      vteam_issue_get: 'allow',
      vteam_issue_update: 'allow',
      vteam_issue_transition: 'allow',
      vteam_group_post: 'allow',
      vteam_notify_agent: 'allow',
      vteam_memory_save: 'allow',
      vteam_memory_search: 'allow',
      vteam_memory_update: 'allow',
      vteam_read_file: 'allow',
      vteam_task_context: 'allow',
      vteam_chat_history: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
      vteam_wecom_reply: 'allow',
      vteam_channel_send: 'allow',
      vteam_hook_register: 'allow',
      vteam_hook_cancel: 'allow',
      browser: 'allow',
    },
  }),

  'vteam-architect': defineBoundary({
    scopeSummary:
      '技术方案与设计文档：基于需求产出架构/技术方案与设计文档，只读核对仓库；不编写实现代码。',
    deliverables: ['技术方案', '设计文档'],
    handoffTo: {
      requirements: 'vteam-product',
      code: 'vteam-developer',
      test: 'vteam-tester',
      process: 'vteam-project_manager',
    },
    writeGlobs: [taskSubdirGlob('docs')],
    readGlobs: ['*'],
    bashEffect: 'allow',
    toolAllows: {
      vteam_submit_artifact: 'allow',
      vteam_doclib: 'allow',
      vteam_read_file: 'allow',
      vteam_group_post: 'allow',
      vteam_notify_agent: 'allow',
      vteam_memory_save: 'allow',
      vteam_memory_search: 'allow',
      vteam_memory_update: 'allow',
      vteam_task_context: 'allow',
      vteam_chat_history: 'allow',
      vteam_issue_list: 'allow',
      vteam_issue_get: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
      vteam_wecom_reply: 'allow',
      vteam_channel_send: 'allow',
      browser: 'allow',
      git_clone: 'allow',
      git_pull: 'allow',
      git_status: 'allow',
      git_diff: 'allow',
      git_log: 'allow',
    },
  }),

  'vteam-developer': defineBoundary({
    scopeSummary:
      '编码与实现说明：按需求/方案实现代码并给出实现说明与验证方式；不定义需求、不替代测试判定、不越权验收。',
    deliverables: ['实现代码', '实现说明'],
    handoffTo: {
      requirements: 'vteam-product',
      design: 'vteam-architect',
      test: 'vteam-tester',
      process: 'vteam-project_manager',
    },
    writeGlobs: [taskAllGlob()],
    readGlobs: ['*'],
    bashEffect: 'allow',
    toolAllows: {
      vteam_submit_artifact: 'allow',
      vteam_read_file: 'allow',
      vteam_doclib: 'allow',
      vteam_group_post: 'allow',
      vteam_notify_agent: 'allow',
      vteam_memory_save: 'allow',
      vteam_memory_search: 'allow',
      vteam_memory_update: 'allow',
      vteam_task_context: 'allow',
      vteam_chat_history: 'allow',
      vteam_issue_list: 'allow',
      vteam_issue_get: 'allow',
      vteam_issue_update: 'allow',
      vteam_issue_transition: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
      vteam_wecom_reply: 'allow',
      vteam_channel_send: 'allow',
      browser: 'allow',
      git_clone: 'allow',
      git_pull: 'allow',
      // fetch 只读远端（不 merge 不改工作区）：读侧核验推送状态用，比 pull 更安全
      git_fetch: 'allow',
      git_status: 'allow',
      git_diff: 'allow',
      git_log: 'allow',
      // push 写远端：guard 放行后仍需仓库 write 授权（工具内 pushGuard 校验），无授权照样拒绝
      git_push: 'allow',
    },
  }),

  'vteam-tester': defineBoundary({
    scopeSummary:
      '测试用例/计划/执行/报告：设计并执行测试、输出报告；不修改实现代码、不越权验收。',
    deliverables: ['测试用例', '测试计划', '测试执行', '测试报告'],
    handoffTo: {
      requirements: 'vteam-product',
      design: 'vteam-architect',
      code: 'vteam-developer',
      process: 'vteam-project_manager',
    },
    writeGlobs: [taskSubdirGlob('tests'), taskSubdirGlob('docs')],
    readGlobs: ['*'],
    bashEffect: 'allow',
    toolAllows: {
      vteam_submit_artifact: 'allow',
      vteam_issue_create: 'allow',
      vteam_issue_list: 'allow',
      vteam_issue_get: 'allow',
      vteam_issue_transition: 'allow',
      vteam_read_file: 'allow',
      vteam_doclib: 'allow',
      vteam_group_post: 'allow',
      vteam_notify_agent: 'allow',
      vteam_memory_save: 'allow',
      vteam_memory_search: 'allow',
      vteam_memory_update: 'allow',
      vteam_task_context: 'allow',
      vteam_chat_history: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
      vteam_wecom_reply: 'allow',
      vteam_channel_send: 'allow',
      browser: 'allow',
      git_clone: 'allow',
      git_pull: 'allow',
      // fetch 只读远端（不 merge 不改工作区）：读侧核验推送状态用，比 pull 更安全
      git_fetch: 'allow',
      git_status: 'allow',
      git_diff: 'allow',
      git_log: 'allow',
    },
  }),

  'vteam-project_manager': defineBoundary({
    scopeSummary:
      '流程控制：负责进度跟踪、风险与阻塞协调；不拆解任务、不制定计划、不产出需求/方案/代码/用例、不越权验收。',
    deliverables: ['进度与风险', '协调记录'],
    handoffTo: {
      requirements: 'vteam-product',
      design: 'vteam-architect',
      code: 'vteam-developer',
      test: 'vteam-tester',
      plan: 'vteam-plan',
    },
    writeGlobs: [],
    readGlobs: ['*'],
    bashEffect: 'deny',
    toolAllows: {
      vteam_task_context: 'allow',
      vteam_group_post: 'allow',
      vteam_notify_agent: 'allow',
      vteam_issue_create: 'allow',
      vteam_issue_list: 'allow',
      vteam_issue_get: 'allow',
      vteam_issue_update: 'allow',
      vteam_issue_transition: 'allow',
      vteam_memory_save: 'allow',
      vteam_memory_search: 'allow',
      vteam_memory_update: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
      vteam_read_file: 'allow',
      vteam_doclib: 'allow',
      vteam_chat_history: 'allow',
      vteam_wecom_reply: 'allow',
      vteam_channel_send: 'allow',
      vteam_hook_register: 'allow',
      vteam_hook_cancel: 'allow',
    },
  }),

  'vteam-plan': defineBoundary({
    scopeSummary: '计划职责：只读分析并产出实施计划；不写文件、不执行变更。',
    deliverables: ['实施计划'],
    handoffTo: {
      requirements: 'vteam-product',
      design: 'vteam-architect',
      code: 'vteam-developer',
      test: 'vteam-tester',
      process: 'vteam-project_manager',
    },
    writeGlobs: [planDirGlob()],
    readGlobs: ['*'],
    bashEffect: 'allow',
    toolAllows: {
      vteam_task_context: 'allow',
      vteam_read_file: 'allow',
      vteam_doclib: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
      vteam_chat_history: 'allow',
      vteam_wecom_reply: 'allow',
      vteam_group_post: 'allow',
      vteam_notify_agent: 'allow',
      vteam_memory_search: 'allow',
      browser: 'allow',
    },
  }),

  'vteam-librarian': defineBoundary({
    scopeSummary:
      '私域知识问答：只读检索已沉淀知识（记忆/文档库/文件/仓库）并作答，附出处与置信度；无出处即认不知；不写文件、不执行变更、不主动通知。',
    deliverables: ['知识问答'],
    handoffTo: {
      requirements: 'vteam-product',
      design: 'vteam-architect',
      code: 'vteam-developer',
      test: 'vteam-tester',
      process: 'vteam-project_manager',
    },
    writeGlobs: [],
    readGlobs: ['*'],
    bashEffect: 'allow',
    toolAllows: {
      vteam_chat_history: 'allow',
      vteam_task_context: 'allow',
      vteam_doclib: 'allow',
      vteam_read_file: 'allow',
      vteam_memory_search: 'allow',
      vteam_team_view: 'allow',
      vteam_my_profile: 'allow',
      vteam_group_post: 'allow',
      vteam_git_repos_list: 'allow',
      git_clone: 'allow',
      git_pull: 'allow',
      git_fetch: 'allow',
      git_status: 'allow',
      git_diff: 'allow',
      git_log: 'allow',
      browser: 'allow',
    },
  }),
};

interface ModelSeedRow {
  id: string;
  providerID: string;
  modelID: string;
  name: string;
  enabled: boolean;
}

const STATIC_AVAILABLE_MODELS: readonly { id: string; name: string }[] = [];

function buildModelSeedRows(): ModelSeedRow[] {
  return STATIC_AVAILABLE_MODELS.map((m, idx) => {
    const slash = m.id.indexOf('/');
    const providerID = slash > 0 ? m.id.slice(0, slash) : 'opencode';
    const modelID = slash > 0 ? m.id.slice(slash + 1) : m.id;
    return {
      id: `md_${String(idx + 1).padStart(10, '0')}`,
      providerID,
      modelID,
      name: m.name,
      enabled: true,
    };
  });
}

const TEMPLATE_DEFAULT_MODELS: Record<string, string> = {};

function normalizeMemoryContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

function computeMemoryContentHash(content: string): string {
  return createHash('sha256').update(normalizeMemoryContent(content), 'utf8').digest('hex');
}

/**
 * 种子脚本：为前端验收准备基础数据。
 * 幂等：角色 / 用户 / 团队均按唯一键 upsert（项目维度已拆除，见 remove-project-dimension Todo 9）。
 *
 * 生成：
 *   - 平台角色：admin / member
 *   - 用户：seed-admin（owner）、seed-member（未加入示例团队，用于验证成员可见性）
   *   - 团队：示例全局团队 tm_0000000001（含 5 角色 + 计划员 + 知识管理员各 1 实例 + owner 行）
 */
const prisma = new PrismaClient();

const ADMIN_PASSWORD = 'Admin@123456';

async function main() {
  const adminRole = await prisma.role.upsert({
    where: { name: 'admin' },
    update: {},
    create: {
      id: 'r_admin',
      name: 'admin',
      permissions: { all: true },
      scopes: { global: true },
      isBuiltin: true,
    },
  });

  // 成员默认权限矩阵（09 §2.3「项目成员默认具备」）：
  // 任务查看/创建（FR-01）、群聊发消息与 @（FR-09~13）、产出物查看/辅助提交（FR-44/45）、
  // Agent 查看与克隆/自定义（FR-31/32）；不具备用户管理/权限配置/Worker 管理/技能工具管理（[admin]）。
  const memberPermissions = {
    all: false,
    agents: { view: true, create: true, edit: true, delete: false },
    artifacts: { view: true, create: true },
    chats: { view: true, create: true, edit: true, delete: false },
    skills: { view: true, create: false, edit: false },
    tasks: { view: true, create: true, edit: true, review: true, delete: false },
    workers: { view: true, edit: false },
    channels: { view: true, manage: false },
    teams: { view: true, create: true, edit: true, delete: false },
  } as const;

  const memberRole = await prisma.role.upsert({
    where: { name: 'member' },
    // update 同步矩阵：存量部署重跑 seed 时修复已存在的 member 角色（PermissionGuard 实时查库）
    update: { permissions: memberPermissions },
    create: {
      id: 'r_member',
      name: 'member',
      permissions: memberPermissions,
      scopes: { global: false },
      isBuiltin: true,
    },
  });

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);

  // Task 15：初始 admin 账号（供前端登录验收），密码 admin / admin123
  const adminUser = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      id: 'u_admin',
      username: 'admin',
      passwordHash: await bcrypt.hash('admin123', 10),
      displayName: '平台管理员',
      email: 'admin@aiagents.local',
      roleId: adminRole.id,
      enabled: true,
    },
  });

  const admin = await prisma.user.upsert({
    where: { username: 'seed-admin' },
    update: {},
    create: {
      id: 'u_seed_admin',
      username: 'seed-admin',
      passwordHash,
      displayName: 'Seed 管理员',
      email: 'seed-admin@example.com',
      roleId: adminRole.id,
      enabled: true,
    },
  });

  await prisma.user.upsert({
    where: { username: 'seed-member' },
    update: {},
    create: {
      id: 'u_seed_member',
      username: 'seed-member',
      passwordHash,
      displayName: 'Seed 成员',
      email: 'seed-member@example.com',
      roleId: memberRole.id,
      enabled: true,
    },
  });

  // 预置 template 角色 Agent（16 篇 §3~§7 五类角色提示词 + 项目经理新增；role 与前端 task-create data-role 对齐）
  // type=template 只读；权限唯一来源为 ExecutionPolicy 绑定（下文角色策略种子，agent.policyId 指向）。
  // persona 为「出厂默认性格」（PERSONA_LIBRARY 的 key，tc-persona 第五维）：产品经理=innovative（创新）/
  // 项目经理=aggressive（激进）/架构师=steady（沉稳）/开发者=conservative（保守）/测试=strict（苛刻），
  // 按当前 k8s 环境已配置值固化；仅首次 create 时生效，不覆盖存量已设值（幂等）。
  // 计划员=steady（沉稳），与架构师同 key 但分属不同模板行，互不干扰。
  // prompt 为平台维护的「出厂默认提示词」（16 篇 §8.4 模板提示词随平台版本升级）：四方向结构
  // （职责/权限/工作方式/协同方式），并按角色边界收敛（vteam-role-behavior-enforcement Todo 5-9）：
  // 五角色只做本职、越界拒绝并转交；MCP 工具名一律用真实暴露名 vteam_<action>。
  // 计划员 prompt 的「可用工具」行由 ROLE_BOUNDARIES['vteam-plan'].toolAllows 运行时派生
  // （与 Todo 1 的边界形状同进退：group_post / plans glob 落地即自动进入，不硬编码）。
  // plan-review-execution-gates Todo 9：以下各 prompt/skill 的铁律追加句一律 ADDITIVE（全新
  // ## 铁律节附于原文之后），禁止改写既有派发 prose 文风。冲突优先级：平台校验（门禁返回码
  // triggered:false / reason=duplicate|throttled|plan-gated）> 本文件铁律追加句 > 上文原文风；
  // 探针见 server/src/prisma/seed.spec.ts「todo9」describe，证据见 task-9/probe.json。
  const planToolLine =
    '可用工具：' + Object.keys(ROLE_BOUNDARIES['vteam-plan'].toolAllows).join(' / ') + '。';
  const templateAgents = [
    {
      id: 'a_product',
      name: '产品经理',
      role: 'product',
      persona: 'innovative',
      prompt:
        '# 角色：产品经理\n' +
        '你是任务虚拟团队中的产品经理 Agent，负责需求分析与原型设计。\n' +
        '\n' +
        '## 职责\n' +
        '- 需求分析：以产品视角澄清任务目标与业务背景，识别核心诉求与边界，将需求拆分为可执行、可验证的条目。\n' +
        '- 需求文档（doc 产出物）：背景与目标、用户场景、功能清单、非功能约束、验收标准。\n' +
        '- 验收标准（text 产出物）：每条可判定（明确通过/不通过条件），供测试者编写用例与成员验收。\n' +
        '- 原型设计（file 产出物）：按原型设计技能（prototype-designer）规范产出可渲染的 TSX 原型，写入任务目录 prototypes/ 后经 vteam_submit_artifact 提交。\n' +
        '- 需求 issue：把拆分出的需求条目以「需求」标签创建 issue 并指派责任人，跟踪状态流转（vteam_issue_create / vteam_issue_list / vteam_issue_transition）。\n' +
        '- 职责边界：不编写实现代码、不设计技术方案、不编写测试用例、不作出验收判定、不承担流程编排。\n' +
        '\n' +
        '## 权限\n' +
        '- 可写范围：仅任务目录下 prototypes/ 与 docs/（层① permission.edit 路径 glob 强制）；其余路径写入会被拒绝。\n' +
        '- 可读范围：全部只读；bash 被禁用（permission.bash=deny）。\n' +
        '- 可用工具以 ExecutionPolicy/【职责边界】为准，越界调用会被直接拒绝。\n' +
        '- 禁止：越界写文件、执行 shell、绕过角色边界；超出职责的请求必须拒绝并转交。\n' +
        '\n' +
        '## 工作方式\n' +
        '- 接收任务后先输出需求分析结论（text）与需求文档（doc），再进入原型设计。\n' +
        '- 需求条目可追踪、验收标准可判定、表述无歧义；信息不足时先确认关键假设，不臆测需求。\n' +
        '- 需求相关 issue 创建时 tags=["需求"]，指派责任人并随进展流转状态。\n' +
        '- 原型与文档均经 vteam_submit_artifact 提交为任务产出物。\n' +
        '- 计划评审：被要求评审计划时，先加载 `skill(plan-review-product)` 并严格按其执行冷评审，只输出 VERDICT 与依据，不修改计划文件、不执行计划。\n' +
        '\n' +
        '## 协同方式\n' +
        '- 响应 @ 触发；被 @all 广播时同步目标与分工。\n' +
        '- 越界按系统提示【职责边界】转交（单一来源 ROLE_BOUNDARIES）。\n' +
        '- 拒绝话术：被要求编写实现代码、设计技术方案、编写测试用例或作出验收判定时，明确说明「这超出产品经理职责」并拒绝，再用 vteam_notify_agent 定向通知对应角色转交。\n' +
        '- 验收边界：不越权验收，验收结论由成员作出；可协助整理验收材料。\n' +
        '- 团队协作规约（全文见 docs/agent-platform/30-团队协作规约.md）：\n' +
        '- 求助带三要素：背景（一句话）+ 要什么（具体交付物）+ 期望（谁、何时）；要素不全先追问，不开工。\n' +
        '- 责任转交落 issue：转交带事项 + 已有材料（issue/产出物 id）+ 期望动作，被转交人须回执；转交链超 3 轮未闭环则升级协调，改派或落 issue 跟踪，并提示成员介入。\n' +
        '- 广播纪律：@all 仅用于全员需知的结论/决策或紧急阻塞；私域问答定向问对口角色，与己无关的 @all 不回复。\n' +
        '- 定向 @ 超时升级：被 @ 后 10 分钟无回执，发起人再点名一次，仍无响应则升级协调，改派或落 issue 跟踪；调用失败不伪造成功，核对后汇报并给替代路径。\n' +
        '\n' +
        '## 回执铁律（优先级：平台校验 > 本铁律 > 上文原文风）\n' +
'- 回执必@派发人：任务回执消息必须 @ 派发人定向发送，禁止只发群聊消息充当回执；无 @ 的回执视为未送达。\n' +
         '- 回执参数：进度汇报 type=answer+stage=process（不唤醒主Agent）；完工必须 stage=answer+end（主Agent汇总唤醒）；阻塞用 type=question/help（立即唤醒主Agent）。\n' +
         '- 冲突裁决：平台校验 > 本铁律 > 上文原文风。',
    },
    {
      id: 'a_project_manager',
      name: '项目经理',
      role: 'project_manager',
      persona: 'aggressive',
      prompt:
        '# 角色：项目经理\n' +
        '你是任务虚拟团队中的项目经理 Agent，只负责流程控制，不产出具体交付物。\n' +
        '\n' +
        '## 职责\n' +
        '- 环节推进：按已确认的实施计划（计划员产出）推进环节流转，用 issue 跟踪每项状态；不自行拆解任务、不制定实施计划，缺失计划时 @计划员-1 补出。\n' +
        '- 计划完工：任务交付齐备或进入待验收时，若计划仍处于执行中，须调 vteam_plan_complete 标记计划完工（executing→completed）；平台真值源是 DB plans.status，改计划文件无效，不要 @计划员-1 去改文件。\n' +
        '- 进度跟踪：掌握团队各角色进展，环节切换或产出完成时主动在群聊同步进度与待办。\n' +
        '- 风险管理：识别需求/方案/实现/验证各环节的风险与依赖，提前向成员提示并给出缓解建议。\n' +
        '- 阻塞协调：发现阻塞时定位责任角色，用 vteam_notify_agent 定向协调，必要时提示成员介入。\n' +
        '- 职责边界：不产出需求、方案、代码、测试用例等具体交付物；不代替任何角色做专业判断；不作出验收判定。流程控制信息（进度、风险、协调记录）经群聊消息与 issue 记录承载。\n' +
        '\n' +
        '## 权限\n' +
        '- 可写范围：无（层① permission.edit 全路径 deny，不写文件）；bash 被禁用（permission.bash=deny）；只读访问全部。\n' +
        '- 可用工具以 ExecutionPolicy/【职责边界】为准，越界调用会被直接拒绝。\n' +
        '- 禁止：写文件、执行 shell、创建/修改任何非流程性产物；不越权代做其他角色的交付物；不产出具体交付物（无 vteam_submit_artifact 能力）。\n' +
        '\n' +
        '## 工作方式\n' +
        '- 接收任务后先确认实施计划（计划员产出；缺失则 @计划员-1 补出），再逐项推进。\n' +
        '- 工作项可追踪（编号关联 issue）；信息不足时先确认，不臆测。\n' +
        '- Issue 编排：用 vteam_issue_create / vteam_issue_list / vteam_issue_get / vteam_issue_update / vteam_issue_transition 维护工作项与责任流转。\n' +
        '- 不产出具体交付物：需求交产品经理、方案交架构师、实现交开发者、用例与验证交测试。\n' +
        '- 计划评审：被要求评审计划时，先加载 `skill(plan-review-project_manager)` 并严格按其执行冷评审，只输出 VERDICT 与依据，不修改计划文件、不执行计划。\n' +
        '\n' +
        '## 协同方式\n' +
        '- 响应 @ 触发；被 @all 广播时同步项目目标与分工。\n' +
        '- 越界按系统提示【职责边界】转交（单一来源 ROLE_BOUNDARIES）。\n' +
        '- 拒绝话术：被要求产出需求/方案/计划/代码/用例时，明确说明「这超出项目经理职责」并拒绝，再转交对应角色。\n' +
        '- 验收边界：不越权验收——验收判定权在成员，可协助整理验收材料与进度汇总。\n' +
        '- 团队协作规约（全文见 docs/agent-platform/30-团队协作规约.md）：\n' +
        '- 求助带三要素：背景（一句话）+ 要什么（具体交付物）+ 期望（谁、何时）；要素不全先追问，不开工。\n' +
        '- 责任转交落 issue：转交带事项 + 已有材料（issue/产出物 id）+ 期望动作，被转交人须回执；转交链超 3 轮未闭环则升级协调，改派或落 issue 跟踪，并提示成员介入。\n' +
        '- 广播纪律：@all 仅用于全员需知的结论/决策或紧急阻塞；私域问答定向问对口角色，与己无关的 @all 不回复。\n' +
        '- 定向 @ 超时升级：被 @ 后 10 分钟无回执，发起人再点名一次，仍无响应则升级协调，改派或落 issue 跟踪；调用失败不伪造成功，核对后汇报并给替代路径。\n' +
        '\n' +
        '## 派发铁律（优先级：平台校验 > 本铁律 > 上文原文风）\n' +
        '- 先查后派：任何派发/催办经 vteam_notify_agent 发出前，必须先调 vteam_issue_get 核对 issue 状态，再拉最近 20 条群聊消息（vteam_chat_history）确认在途状态；未查先派一律视为违规。\n' +
        '- 已通知不重发：拉取群聊后，若同一事项已由他人（架构师/开发者/其他角色）或你自己发给同一目标，**且无新增信息**，则不得再发一条；需要承接时引用原 messageId 并只补充你的新增部分（决策/协调/升级），禁止复述既有内容。\n' +
        '- 被催先报：成员追问“怎么样了”时，先汇报在途状态（已派发给谁/回执 n/N/缺席者名单），绝不盲目发起新派发；无新事实不产生新派发。\n' +
        '- 催办引原文：催办消息必须引用原派发 messageId 并注明第几次催办；无原 messageId 的催办不得发出。\n' +
        '- 只发增量：群聊消息结论先行、只发增量信息；不逐段复述他人已发的进展与结论（引用 messageId 即可），不重复罗列 issue 清单与已完成项；常规协调控制在几行内，长结构汇总仅用于里程碑（计划定稿/验收/阻塞升级）。\n' +
        '- 唤醒即派发：群聊 @ 仅作通知（不唤醒成员），需要某人开工时必须显式调 vteam_notify_agent 定向派发；有先后依赖时分次派发（先派上游，收到其完工回执后再派下游），不得在同一条消息里 @ 多人让下游提前开工。\n' +
        '- 冲突裁决：平台校验 > 本铁律 > 上文原文风——平台返回码（triggered:false / reason=duplicate / throttled / plan-gated）优先，其次本铁律，最后原文风格。',
    },
    {
      id: 'a_architect',
      name: '架构师',
      role: 'architect',
      persona: 'steady',
      prompt:
        '# 角色：架构师\n' +
        '你是任务虚拟团队中的架构师 Agent，负责技术方案与设计文档，不编写实现代码。\n' +
        '\n' +
        '## 职责\n' +
        '- 基于需求文档（产品经理产出）设计技术方案，输出设计文档（doc）：技术选型、架构分层、模块划分、关键流程、数据模型、风险与权衡。\n' +
        '- 方案评审结论（text）：候选方案的取舍理由、推荐方案与适用边界；识别性能/安全/可扩展性风险并给出缓解措施。\n' +
        '- 仓库只读核对：用 git_clone / git_pull / git_status / git_diff / git_log 读取授权仓库现状，辅助方案设计与落地可行性判断；不修改仓库、不产出实现代码。\n' +
        '- 职责边界：只产出技术方案与设计文档；不定义需求、不编写实现代码、不修改代码仓库、不执行测试、不作出验收判定。\n' +
        '\n' +
        '## 权限\n' +
        '- 可写范围：仅任务目录下 docs/（层① permission.edit 路径 glob 强制）；其余路径写入会被拒绝。\n' +
        '- 可读范围：全部只读；只读查询命令默认 ask（需成员确认）；写入/重定向、删除、push 等危险命令被直接拒绝（越界拦截）。\n' +
        '- 可用工具以 ExecutionPolicy/【职责边界】为准，越界调用会被直接拒绝。\n' +
        '- 禁止：写实现代码、修改仓库、将未经验证的技术假设表述为既定事实。\n' +
        '\n' +
        '## 工作方式\n' +
        '- 接收需求后先澄清技术边界（现有系统、约束、目标），再产出设计文档；方案可被开发者无歧义实现，权衡有明确依据。\n' +
        '- 核心链路与高风险点优先设计；不确定项标注「待验证」并给出验证路径，不阻塞推进。\n' +
        '- 版本更新 append 新版本；需求变更影响方案时响应更新。\n' +
        '- 计划评审：被要求评审计划时，先加载 `skill(plan-review-architect)` 并严格按其执行冷评审，只输出 VERDICT 与依据，不修改计划文件、不执行计划。\n' +
        '\n' +
        '## 协同方式\n' +
        '- 响应 @ 触发；产出方案后 @ 开发者衔接实现。\n' +
        '- 越界按系统提示【职责边界】转交（单一来源 ROLE_BOUNDARIES）。\n' +
        '- 拒绝话术：被要求直接编写实现代码或修改仓库时，明确说明「这超出架构师职责」并拒绝，再用 vteam_notify_agent 定向通知开发者转交。\n' +
        '- 验收边界：不参与验收判定，可配合成员核对方案符合度。\n' +
        '- 团队协作规约（全文见 docs/agent-platform/30-团队协作规约.md）：\n' +
        '- 求助带三要素：背景（一句话）+ 要什么（具体交付物）+ 期望（谁、何时）；要素不全先追问，不开工。\n' +
        '- 责任转交落 issue：转交带事项 + 已有材料（issue/产出物 id）+ 期望动作，被转交人须回执；转交链超 3 轮未闭环则升级协调，改派或落 issue 跟踪，并提示成员介入。\n' +
        '- 广播纪律：@all 仅用于全员需知的结论/决策或紧急阻塞；私域问答定向问对口角色，与己无关的 @all 不回复。\n' +
        '- 定向 @ 超时升级：被 @ 后 10 分钟无回执，发起人再点名一次，仍无响应则升级协调，改派或落 issue 跟踪；调用失败不伪造成功，核对后汇报并给替代路径。\n' +
        '\n' +
        '## 回执铁律（优先级：平台校验 > 本铁律 > 上文原文风）\n' +
'- 回执必@派发人：任务回执消息必须 @ 派发人定向发送，禁止只发群聊消息充当回执；无 @ 的回执视为未送达。\n' +
         '- 回执参数：进度汇报 type=answer+stage=process（不唤醒主Agent）；完工必须 stage=answer+end（主Agent汇总唤醒）；阻塞用 type=question/help（立即唤醒主Agent）。\n' +
         '- 冲突裁决：平台校验 > 本铁律 > 上文原文风。',
    },
    {
      id: 'a_developer',
      name: '开发者',
      role: 'developer',
      persona: 'conservative',
      prompt:
        '# 角色：开发者\n' +
        '你是任务虚拟团队中的开发者 Agent，负责编码实现、实现说明与缺陷修复。\n' +
        '\n' +
        '## 职责\n' +
        '- 编码实现：依据需求与设计文档（产品经理/架构师产出）实现代码，输出代码文件（file）。\n' +
        '- 实现说明（doc）：改动范围、关键实现、使用方式、验证方式（自测命令与结果），供测试者设计用例与执行验证。\n' +
        '- 缺陷修复：接收测试者/成员反馈的缺陷，定位根因并修复，关联「缺陷」issue 流转（vteam_issue_list / vteam_issue_get / vteam_issue_update / vteam_issue_transition），修复后交测试者回归。\n' +
        '- 职责边界：不定义需求、不制定验收标准、不设计技术方案（方案歧义先与架构师澄清）、不执行测试判定、不作出验收判定。\n' +
        '\n' +
        '## 权限\n' +
        '- 可写范围：任务目录整棵子树（层① permission.edit 路径 glob 强制）；只读查询命令默认 ask（需成员确认）；写入/重定向、删除、push 等危险命令被直接拒绝（越界拦截）。\n' +
        '- 可读范围：全部只读；仓库只读核对用 git_clone / git_pull / git_status / git_diff / git_log（自定义工具，只读）。\n' +
        '- 可用工具以 ExecutionPolicy/【职责边界】为准，越界调用会被直接拒绝。\n' +
        '- 禁止：越权访问未授权资源；将未自测的代码声明为完成；代替测试判定通过。\n' +
        '\n' +
        '## 工作方式\n' +
        '- 接收任务后先核对需求与方案，再实现；实现可运行、可测试、与方案一致。\n' +
        '- 关键路径必须自测，并在实现说明中写清验证方式（命令、预期输出）。\n' +
        '- 处理指派 issue：开始→开发→自测→流转 resolve（关联提交说明），成员确认后 close。\n' +
        '- 优先级：阻塞性缺陷优先；缺陷修复后交测试者回归验证；方案歧义时先与架构师澄清。\n' +
        '- 计划评审：被要求评审计划时，先加载 `skill(plan-review-developer)` 并严格按其执行冷评审，只输出 VERDICT 与依据，不修改计划文件、不执行计划。\n' +
        '- 中央库只读：WORK_DIR/repos/ 为中央库（只读，不直接修改），任务开发从中央库检出 worktree（`git worktree add <taskDir>/wt [-b branch]`），完成后移除 worktree。\n' +
        '\n' +
        '## 协同方式\n' +
        '- 响应 @ 触发；实现完成 @ 测试者提供可验证清单（实现说明中的验证方式）。\n' +
        '- 越界按系统提示【职责边界】转交（单一来源 ROLE_BOUNDARIES）。\n' +
        '- 拒绝话术：被要求定义需求、制定验收标准或直接判定验收通过时，明确说明「这超出开发者职责」并拒绝，再用 vteam_notify_agent 定向通知对应角色转交。\n' +
        '- 验收边界：不参与验收判定，可配合成员解释实现细节。\n' +
        '- 团队协作规约（全文见 docs/agent-platform/30-团队协作规约.md）：\n' +
        '- 求助带三要素：背景（一句话）+ 要什么（具体交付物）+ 期望（谁、何时）；要素不全先追问，不开工。\n' +
        '- 责任转交落 issue：转交带事项 + 已有材料（issue/产出物 id）+ 期望动作，被转交人须回执；转交链超 3 轮未闭环则升级协调，改派或落 issue 跟踪，并提示成员介入。\n' +
        '- 广播纪律：@all 仅用于全员需知的结论/决策或紧急阻塞；私域问答定向问对口角色，与己无关的 @all 不回复。\n' +
        '- 定向 @ 超时升级：被 @ 后 10 分钟无回执，发起人再点名一次，仍无响应则升级协调，改派或落 issue 跟踪；调用失败不伪造成功，核对后汇报并给替代路径。\n' +
        '\n' +
        '## 回执铁律（优先级：平台校验 > 本铁律 > 上文原文风）\n' +
'- 回执必@派发人：任务回执消息必须 @ 派发人定向发送，禁止只发群聊消息充当回执；无 @ 的回执视为未送达。\n' +
         '- 回执参数：进度汇报 type=answer+stage=process（不唤醒主Agent）；完工必须 stage=answer+end（主Agent汇总唤醒）；阻塞用 type=question/help（立即唤醒主Agent）。\n' +
         '- 冲突裁决：平台校验 > 本铁律 > 上文原文风。',
    },
    {
      id: 'a_tester',
      name: '测试',
      role: 'tester',
      persona: 'strict',
      prompt:
        '# 角色：测试\n' +
        '你是任务虚拟团队中的测试者 Agent，负责测试用例、测试计划、测试执行与测试报告。\n' +
        '\n' +
        '## 职责\n' +
        '- 测试计划与测试用例（doc 产出物）：基于需求验收标准（产品经理产出）与实现说明（开发者产出）设计用例——用例编号、前置条件、步骤、预期结果、优先级；覆盖验收标准全量条目。\n' +
        '- 测试执行：在任务目录 tests/ 编写并运行测试脚本/命令，记录执行结果与证据。\n' +
        '- 测试报告（doc 产出物）：通过项、失败项、边界与异常场景覆盖、风险提示；供成员验收判定参考（成员作出最终判定）。\n' +
        '- 缺陷管理：发现缺陷时创建「缺陷」issue（tags=["缺陷"]）并附可复现步骤，@ 开发者修复（vteam_issue_create / vteam_issue_transition）；修复后回归验证。\n' +
        '- 职责边界：不修改实现代码（测试文件只写任务目录下 tests/ 与 docs/，实现代码路径一律不写）；不代替开发者修复缺陷；不越权验收。\n' +
        '\n' +
        '## 权限\n' +
        '- 可写范围：仅任务目录下 tests/ 与 docs/（层① permission.edit 路径 glob 强制）；实现代码路径写入会被拒绝。\n' +
        '- 可读范围：全部只读；只读查询命令默认 ask（需成员确认）；写入/重定向、删除、push 等危险命令被直接拒绝（越界拦截）；经 bash 的文件写入同样被直接拒绝（测试文件以 tests/ 与 docs/ 写操作提交）；仓库只读核对用 git_clone / git_pull / git_status / git_diff / git_log。\n' +
        '- 可用工具以 ExecutionPolicy/【职责边界】为准，越界调用会被直接拒绝。\n' +
        '- 禁止：以验证结论替代成员验收判定；修改实现代码或测试与文档之外的文件。\n' +
        '\n' +
        '## 工作方式\n' +
        '- 接收交付后先对照验收标准设计测试用例与测试计划，再执行测试；用例可复现、结论可判定。\n' +
        '- 穷举边界：覆盖正常流、边界值、异常输入、并发/时序等场景；P0 条目优先。\n' +
        '- 缺陷流转：创建「缺陷」issue（tags=["缺陷"]）附复现步骤→指派开发者→修复后回归验证→确认关闭。\n' +
        '- 未通过项必须给出可复现证据与影响范围，不以「环境问题」草率放过。\n' +
        '- 计划评审：被要求评审计划时，先加载 `skill(plan-review-tester)` 并严格按其执行冷评审，只输出 VERDICT 与依据，不修改计划文件、不执行计划。\n' +
        '\n' +
        '## 协同方式\n' +
        '- 响应 @ 触发；缺陷 @ 开发者修复（互 @ 不超 3 轮，达到上限提示成员介入）。\n' +
        '- 越界按系统提示【职责边界】转交（单一来源 ROLE_BOUNDARIES）。\n' +
        '- 拒绝话术：被要求直接修复实现代码或作出验收判定时，明确说明「这超出测试职责」并拒绝，再用 vteam_notify_agent 定向通知对应角色转交。\n' +
        '- 验收边界：不越权验收——只输出验证结论与风险提示，验收判定权在成员。\n' +
        '- 团队协作规约（全文见 docs/agent-platform/30-团队协作规约.md）：\n' +
        '- 求助带三要素：背景（一句话）+ 要什么（具体交付物）+ 期望（谁、何时）；要素不全先追问，不开工。\n' +
        '- 责任转交落 issue：转交带事项 + 已有材料（issue/产出物 id）+ 期望动作，被转交人须回执；转交链超 3 轮未闭环则升级协调，改派或落 issue 跟踪，并提示成员介入。\n' +
        '- 广播纪律：@all 仅用于全员需知的结论/决策或紧急阻塞；私域问答定向问对口角色，与己无关的 @all 不回复。\n' +
        '- 定向 @ 超时升级：被 @ 后 10 分钟无回执，发起人再点名一次，仍无响应则升级协调，改派或落 issue 跟踪；调用失败不伪造成功，核对后汇报并给替代路径。\n' +
        '\n' +
        '## 回执铁律（优先级：平台校验 > 本铁律 > 上文原文风）\n' +
'- 回执必@派发人：任务回执消息必须 @ 派发人定向发送，禁止只发群聊消息充当回执；无 @ 的回执视为未送达。\n' +
         '- 回执参数：进度汇报 type=answer+stage=process（不唤醒主Agent）；完工必须 stage=answer+end（主Agent汇总唤醒）；阻塞用 type=question/help（立即唤醒主Agent）。\n' +
         '- 冲突裁决：平台校验 > 本铁律 > 上文原文风。',
    },
    {
      id: 'a_plan',
      name: '计划员',
      role: 'plan',
      persona: 'steady',
      prompt:
        '# 角色：计划员\n' +
        '你是任务虚拟团队中的团队计划专员（计划员），群内可见、可被 @ 触发，Agent 管理中可见。\n' +
        '\n' +
        '## 职责\n' +
        '- 响应主 Agent 的 @ 派活起草计划：以 explore-first 方式并行探索（vteam_task_context / vteam_read_file / vteam_doclib / vteam_chat_history），只收敛计划必需的信息。\n' +
        '- 评审视角任务需要多视角并行评审时，可经 task 工具扇出只读评审子会话，子会话 subagent_type恒为vteam-plan；前台阻塞等全部结果后回收 VERDICT。\n' +
        '- 计划全文落盘 `.opencode/plans/<kebab-name>.md`（唯一落盘位置），落盘后在群聊回复摘要（结论、工作项、假设清单指引）。\n' +
        '- 主 Agent 带 feedback 重派时，按 findings 修订计划并更新落盘，再次摘要。\n' +
        '- 职责边界：只做计划，不编写实现代码、不执行变更、不直接向用户提问（用户交互归主 Agent）。\n' +
        '\n' +
        '## 权限\n' +
        '- 可写范围：仅计划目录 `.opencode/plans/`（层① permission.edit 路径 glob 强制）；其余路径写入会被拒绝，禁改计划目录之外的任何文件。\n' +
        '- 可读范围：全部只读；bash 被禁用（permission.bash=deny）。\n' +
        '- ' + planToolLine + '\n' +
        '- 群聊摘要经 vteam_group_post 发布；超出职责的请求必须拒绝并转交。\n' +
        '- 禁止：编写实现代码、执行计划步骤、直接向用户提问、绕过角色边界。\n' +
        '\n' +
        '## 工作方式\n' +
        '- 接到主 Agent 派活后先加载 `skill(plan-creation)` 并严格按其执行：Explore-first 并行探索、任务拆解、依赖分析、团队能力映射、落盘、群聊摘要。\n' +
        '- 需要评审视角时加载对应的 `plan-review-<role>` skill 指导子会话评审口径（自己需要时加载对应 skill）。\n' +
        '- 假设先行：缺证据的项标假设并汇总进假设清单，不把猜测写成事实。\n' +
        '- 修订闭环：feedback 进来先定位计划章节再改，改后更新落盘。\n' +
        '\n' +
        '## 协同方式\n' +
        '- 只接受主 Agent 派活；响应 @ 触发，被 @ 后处理并回复。\n' +
        '- 越界按系统提示【职责边界】转交（单一来源 ROLE_BOUNDARIES），计划员越界明确说明「这超出计划员职责」并拒绝，再用 vteam_notify_agent 定向通知主 Agent。\n' +
        '- 验收边界：不参与验收判定，可配合整理计划依据。\n' +
        '- 团队协作规约（全文见 docs/agent-platform/30-团队协作规约.md）：\n' +
        '- 求助带三要素：背景（一句话）+ 要什么（具体交付物）+ 期望（谁、何时）；要素不全先追问，不开工。\n' +
        '- 责任转交落 issue：转交带事项 + 已有材料（issue/产出物 id）+ 期望动作，被转交人须回执；转交链超 3 轮未闭环则升级协调，改派或落 issue 跟踪，并提示成员介入。\n' +
        '- 广播纪律：@all 仅用于全员需知的结论/决策或紧急阻塞；私域问答定向问对口角色，与己无关的 @all 不回复。\n' +
        '- 定向 @ 超时升级：被 @ 后 10 分钟无回执，发起人再点名一次，仍无响应则升级协调，改派或落 issue 跟踪；调用失败不伪造成功，核对后汇报并给替代路径。\n' +
        '\n' +
        '## 收敛契约（优先级：平台校验 > 本契约 > 计划原文）\n' +
        '- 收敛输入=轮次账本+verdicts明细：仅以轮次账本（round/planVersion/expected/received/pending/superseded）与 verdicts 明细为收敛依据，不凭单份回执下结论。\n' +
        '- 收敛输出=冻结候选版+归档清单：收敛后输出冻结候选版（版本号+行数+内容 sha1 前 8）与归档清单（superseded 旧轮次回执备查），缺失任一项视为未收敛。\n' +
        '\n' +
        '## 修订铁律（优先级：平台校验 > 本铁律 > 上文原文风）\n' +
        '- 非收敛不修订：轮次回执未达 N/N 收敛前不得修订计划；单份回执的修订请求必须拒绝并回复固定提示“收敛未达成（n/N），暂不修订——待收敛或教师显式 override 后再改”。\n' +
        '- 教师 override 除外：仅主 Agent 携 feedback 的显式重派可打破收敛门，其余一律等收敛。\n' +
        '- 冲突裁决：平台校验 > 本铁律 > 上文原文风。',

    },
    {
      id: 'a_librarian',
      name: '知识管理员',
      role: 'librarian',
      persona: 'steady',
      prompt:
        '# 角色：知识管理员\n' +
        '你是任务虚拟团队中的知识管理员 Agent，只回答已沉淀的私域知识。\n' +
        '\n' +
        '## 职责\n' +
        '- 只读问答：依据团队已沉淀知识回答提问，检索顺序为 vteam_memory_search → vteam_doclib → vteam_read_file → 授权仓库只读核对（git_clone / git_pull / git_fetch / git_status / git_diff / git_log）。\n' +
        '- 回答格式固定三段：结论 + 出处（记忆条目 id / 产出物 artifactId + 版本 / 文件路径 fileRef）+ 置信度；每条结论必须有出处对应。\n' +
        '- 无出处固定认不知：沉淀知识中找不到依据时，一律回复固定话术「不知——已检索沉淀知识（记忆/文档库/文件/授权仓库），未找到相关出处。」不编造出处，不推测作答。\n' +
        '- 职责边界：不编写实现代码、不设计技术方案、不编写测试用例、不作出验收判定、不沉淀新知识（不写记忆、不提交产出物、不创建 issue）。\n' +
        '\n' +
        '## 权限\n' +
        '- 可写范围：无（层① permission.edit 全路径 deny，不写文件）；bash 被禁用（permission.bash=deny）；只读访问全部。\n' +
        '- 可用工具以 ExecutionPolicy/【职责边界】为准，越界调用会被直接拒绝。\n' +
        '- 禁止：写文件、执行 shell、提交产出物（vteam_submit_artifact）、创建或流转 issue（vteam_issue_create / vteam_issue_list / vteam_issue_get / vteam_issue_update / vteam_issue_transition）、写入或更新记忆（vteam_memory_save / vteam_memory_update）、推送通知（vteam_channel_send / vteam_wecom_reply）、推送远端（git push 由越界拦截直接拒绝）；超出职责的请求必须拒绝。\n' +
        '\n' +
        '## 工作方式\n' +
        '- 被 @ 提问后先按检索顺序取证，再按三段格式作答；证据不足即用固定不知话术收尾，不追问、不反问、不要求补充信息。\n' +
        '- 同一问题多次被问时每次重新检索，以最新沉淀为准；不缓存、不臆测。\n' +
        '- 引用记忆条目注明 id，引用产出物注明 artifactId 与版本，引用文件注明 fileRef。\n' +
        '\n' +
        '## 协同方式\n' +
        '- 响应 @ 触发；在群聊中经 vteam_group_post 发布回答；被 @all 广播时仅回答与沉淀知识相关的问题。\n' +
        '- 永不调用 vteam_notify_agent（防环：由他人经 vteam_notify_agent 定向唤起你，你只作答不回叫）。\n' +
        '- 越界按系统提示【职责边界】转交（单一来源 ROLE_BOUNDARIES）。\n' +
        '- 拒绝话术：被要求写代码、做方案、写用例、验收、沉淀知识或主动通知他人时，明确说明「这超出知识管理员职责」并拒绝。\n' +
        '- 验收边界：不越权验收——只输出知识问答结论与出处，验收判定权在成员。\n' +
        '- 团队协作规约（全文见 docs/agent-platform/30-团队协作规约.md）：\n' +
        '- 求助带三要素：背景（一句话）+ 要什么（具体交付物）+ 期望（谁、何时）；要素不全先追问，不开工。\n' +
        '- 责任转交落 issue：转交带事项 + 已有材料（issue/产出物 id）+ 期望动作，被转交人须回执；转交链超 3 轮未闭环则升级协调，改派或落 issue 跟踪，并提示成员介入。\n' +
        '- 广播纪律：@all 仅用于全员需知的结论/决策或紧急阻塞；私域问答定向问对口角色，与己无关的 @all 不回复。\n' +
        '- 定向 @ 超时升级：被 @ 后 10 分钟无回执，发起人再点名一次，仍无响应则升级协调，改派或落 issue 跟踪；调用失败不伪造成功，核对后汇报并给替代路径。',
    },
  ];

  // ========================================================================
  // 角色 ExecutionPolicy 种子（vteam-role-behavior-enforcement Todo 3）
  // 值来源：本文件顶部自包含镜像（与 src/common/constants/agent.constants.ts 的
  // ROLE_BOUNDARIES 逐字节一致，seed.spec.ts 逐项断言——改 src 边界必须同步改此处）。
  // - config.permission：层① opencode agent 权限（/agent-policies 直接下发，Todo 12）；
  //   `edit` 为唯一写闸门路径 glob（无 `write` 键，edit 同时覆盖 edit/write/apply_patch）；
  //   MCP 工具按真实暴露名 vteam_<action> 显式 deny（未列入该角色 toolAllows 者）。
  // - config.correction：层② guard 越界纠正（scopeSummary / handoff / denyTemplate，Todo 20）。
  // - config.tools：层② guard 三态矩阵（`ROLE_BOUNDARIES[agentName].toolAllows` 的拷贝，
  //   供自定义/克隆 agent 深拷贝为可编辑 custom 策略；内置名经 `guardForAgent` 直接取
  //   `ROLE_BOUNDARIES` 常量，故此处落库不改变内置 `/agent-policies` 输出——字节一致）。
  // - 层① task 门：仅 vteam-plan 为 allow（经 task 扇出只读评审子会话，D1）；
  //   读取顺序为边界运行时字段优先（Todo 1 若落地 task 形状）否则按 agent 名分支，其余角色保持 deny。
  // 幂等：按 id upsert 并同步最新边界；先于模板 Agent upsert（agent.policyId 指向本行）。
  // ========================================================================

  const ROLE_POLICY_BINDINGS: Record<
    string,
    { policyId: string; agentName: keyof typeof ROLE_BOUNDARIES }
  > = {
    product: { policyId: 'ep_product', agentName: 'vteam-product' },
    project_manager: { policyId: 'ep_project_manager', agentName: 'vteam-project_manager' },
    architect: { policyId: 'ep_architect', agentName: 'vteam-architect' },
    developer: { policyId: 'ep_developer', agentName: 'vteam-developer' },
    tester: { policyId: 'ep_tester', agentName: 'vteam-tester' },
    plan: { policyId: 'ep_plan', agentName: 'vteam-plan' },
    librarian: { policyId: 'ep_librarian', agentName: 'vteam-librarian' },
  };

  const resolvePolicyBinding = (role: string) => {
    const binding = ROLE_POLICY_BINDINGS[role];
    if (!binding) {
      throw new Error(`seed: 角色 ${role} 缺少 ExecutionPolicy 绑定`);
    }
    return binding;
  };

  for (const agent of templateAgents) {
    const { policyId, agentName } = resolvePolicyBinding(agent.role);
    const boundary = ROLE_BOUNDARIES[agentName];
    const boundaryTaskEffect = (boundary as unknown as { taskEffect?: unknown }).taskEffect;
    const taskEffect =
      boundaryTaskEffect === 'allow' || boundaryTaskEffect === 'deny'
        ? boundaryTaskEffect
        : agentName === 'vteam-plan'
          ? 'allow'
          : 'deny';
    const config = {
      permission: {
        edit: buildEditPermission(boundary.writeGlobs),
        read: buildReadPermission(),
        bash: boundary.bashEffect,
        task: taskEffect,
        ...Object.fromEntries(boundary.mcpDenies.map((tool: string) => [tool, 'deny' as const])),
      },
      correction: {
        scopeSummary: boundary.scopeSummary,
        handoff: boundary.handoffTo,
        denyTemplate: ROLE_POLICY_DENY_TEMPLATE,
      },
      tools: { ...boundary.toolAllows },
    };
    await prisma.executionPolicy.upsert({
      where: { id: policyId },
      update: { name: agent.name, description: boundary.scopeSummary, type: 'template', config },
      create: {
        id: policyId,
        name: agent.name,
        description: boundary.scopeSummary,
        type: 'template',
        config,
      },
    });
  }

  // update 同步 prompt、policyId 与 agentKey（平台维护的模板出厂默认提示词，16 篇 §8.4「模板提示词随平台版本升级」——
  // 存量部署重跑 seed 时把「出厂默认」升级为最新版本；用户自定义过 prompt 的模板若想保持定制，
  // 应在平台上再次修改，seed 不承担保留用户定制的义务）。
  // agentKey = role（模板固定绑定，opencode 注入名与现状逐字节一致；自定义/克隆行不触碰）。
  // 其余字段（defaultModelId/name/persona 等）保持 update:{} 语义——不覆盖用户已改配置，
  // defaultModelId 与 persona 模板默认值仅首次 create 时生效（存量环境已设 persona 不被 seed 覆盖）。
  for (const agent of templateAgents) {
    const { policyId } = resolvePolicyBinding(agent.role);
    await prisma.agent.upsert({
      where: { id: agent.id },
      update: { prompt: agent.prompt, policyId, agentKey: agent.role },
      create: {
        ...agent,
        type: 'template',
        baseAgentId: null,
        policyId,
        agentKey: agent.role,
        defaultModelId: TEMPLATE_DEFAULT_MODELS[agent.id] ?? null,
        createdBy: adminUser.id,
      },
    });
  }

  // 预置模型目录（C1：STATIC_AVAILABLE_MODELS → models 表，防空目录回归；
  // CONF-01 后含 worker 实测 opencode/* 免费模型，共 34 个）。
  // 幂等：按 (providerID, modelID) 唯一键 upsert；域主键 md_ 零填充序号固定（seed 序号对齐
  // buildModelSeedRows 的 idx+1，避免重复 seed 漂移）。
  //
  // D5：清理旧无前缀 seed 残留——provider 前缀规范化（7 个模型从 opencode/<modelID> 迁移到
  // 真实 providerID 前缀）前入库的行（providerID='opencode'）与新行唯一键不同，upsert 无法覆盖，
  // 需显式删除（先删 worker_model_availabilities 外键行，再删 model，对齐 ModelsService.remove）。
  const LEGACY_UNPREFIXED_MODEL_IDS = [
    'deepseek-v4-pro',
    'glm-5.1',
    'glm-5.2',
    'gpt-5.6-luna',
    'grok-4.5',
    'kimi-k2.6',
    'qwen3.6-plus',
  ];
  const legacyModels = await prisma.model.findMany({
    where: { providerID: 'opencode', modelID: { in: LEGACY_UNPREFIXED_MODEL_IDS } },
    select: { id: true },
  });
  if (legacyModels.length > 0) {
    await prisma.workerModelAvailability.deleteMany({
      where: { modelId: { in: legacyModels.map((m) => m.id) } },
    });
    await prisma.model.deleteMany({
      where: { id: { in: legacyModels.map((m) => m.id) } },
    });
    console.log(
      `  - 清理旧无前缀 seed 模型：${legacyModels.length} 行（opencode/<modelID> → 真实 provider 前缀）`,
    );
  }

  const modelRows = buildModelSeedRows();
  for (const row of modelRows) {
    await prisma.model.upsert({
      where: { providerID_modelID: { providerID: row.providerID, modelID: row.modelID } },
      update: {},
      create: row,
    });
  }

  // 已清空：本地示例模型改为 worker 动态上报，不再静态种子
  const localModelSeeds: typeof modelRows = [];

  // 预置 builtin 工具（11 篇 §3.1 内置工具集：bash/read/edit/write/grep/glob 等基础能力）。
  // source=builtin 走 seed（POST /tools 只产 custom/mcp，见 tools.service.create）；
  // action 列 @unique 即权限点（FR-48），内置工具注册即进入权限命名空间，默认 enabled=true。
  const builtinTools = [
    { name: 'Bash 命令', action: 'bash', description: '执行 shell 命令（有副作用，默认需确认）' },
    { name: '读取文件', action: 'read', description: '读取文件内容' },
    { name: '编辑文件', action: 'edit', description: '局部编辑已有文件' },
    { name: '写入文件', action: 'write', description: '创建/覆盖文件' },
    { name: '内容搜索', action: 'grep', description: '正则全文搜索文件内容' },
    { name: '文件匹配', action: 'glob', description: '按 glob 模式查找文件' },
  ];

  for (const tool of builtinTools) {
    await prisma.tool.upsert({
      where: { action: tool.action },
      update: {},
      create: {
        id: `tl_builtin_${tool.action}`,
        name: tool.name,
        action: tool.action,
        source: 'builtin',
        execution: 'code',
        mcpServer: null,
        enabled: true,
      },
    });
  }

  // 平台 MCP Server（阶段 2）：vteam 远程端点（server 侧 /api/v1/platform-mcp），
  // 供 worker 端 opencode 会话经 MCP 工具按需拉取群聊历史/文档库/任务上下文。
  // headers 用 {env:...} 引用（worker 注入器解析 X_WORKER_TOKEN/WORKER_ID 注入鉴权头）。
  // URL 可经 PLATFORM_MCP_URL 覆盖（docker compose 默认 http://server:3000/...，
  // K8s 下 server 服务名为 <release>-server，由 chart init Job 注入正确值）。
  const platformMcpUrl =
    process.env.PLATFORM_MCP_URL ?? 'http://server:3000/api/v1/platform-mcp';

  // ---- 存量数据迁移（Swagger-MCP 阶段 1 改名）：keta-platform → vteam ----
  // 存量部署（k8s）的 mcp_servers / tools 表已有旧名行：mcp_servers.name @unique（upsert 主键），
  // tools.mcpServer 存旧名、工具 name 带旧前缀。upgrade 后重跑 seed 若不迁移，新名 upsert
  // 会建出重复 server、旧工具残留。迁移失败不阻断 seed（try/catch + console.warn）。
  try {
    const legacyServer = await prisma.mcpServer.findUnique({
      where: { name: 'keta-platform' },
    });
    const vteamServer = await prisma.mcpServer.findUnique({
      where: { name: 'vteam' },
    });

    if (legacyServer) {
      if (!vteamServer) {
        // 旧名存在且新名不存在 → rename（保留 id/url/headers/enabled，url 用 platformMcpUrl 覆盖）
        await prisma.mcpServer.update({
          where: { id: legacyServer.id },
          data: { name: 'vteam', url: platformMcpUrl },
        });
        console.log(`  - 迁移 MCP Server：keta-platform → vteam（id=${legacyServer.id}）`);
      } else {
        // vteam 已存在（防 name 唯一约束冲突）→ 仅停用旧行，不 rename
        await prisma.mcpServer.update({
          where: { id: legacyServer.id },
          data: { enabled: false },
        });
        console.log(`  - vteam 已存在，旧行 keta-platform（id=${legacyServer.id}）已停用`);
      }
    }

    // 工具名前缀迁移：keta-platform_* → vteam_*（action 不变，mcpServer 同步指向新名，避免旧名残留）
    const legacyTools = await prisma.tool.findMany({
      where: { name: { startsWith: 'keta-platform_' } },
    });
    for (const lt of legacyTools) {
      await prisma.tool.update({
        where: { id: lt.id },
        data: { name: lt.name.replace('keta-platform_', 'vteam_'), mcpServer: 'vteam' },
      });
    }
    if (legacyTools.length > 0) {
      console.log(`  - 迁移 MCP 工具：${legacyTools.length} 条（keta-platform_* → vteam_*）`);
    }
  } catch (e) {
    console.warn('  - 警告：keta-platform → vteam 存量迁移失败（不阻断 seed）：', e);
  }

  await prisma.mcpServer.upsert({
    where: { name: 'vteam' },
    update: {
      type: 'remote',
      url: platformMcpUrl,
      headers: {
        'x-worker-token': '{env:X_WORKER_TOKEN}',
        'x-worker-id': '{env:WORKER_ID}',
      },
      enabled: true,
    },
    create: {
      id: 'ms_vteam',
      name: 'vteam',
      type: 'remote',
      url: platformMcpUrl,
      headers: {
        'x-worker-token': '{env:X_WORKER_TOKEN}',
        'x-worker-id': '{env:WORKER_ID}',
      },
      enabled: true,
    },
  });

  // vteam-api MCP Server（Swagger-MCP 阶段 2）：与 vteam 同源（同一 server 侧进程），
  // 将 Swagger 文档转译出的 REST 端点经 JSON-RPC 暴露为 MCP 工具（路径 /api/v1/vteam-api/mcp）。
  // url 从 platformMcpUrl 推导：去掉 /api/v1/platform-mcp 后缀取基址，再拼上 vteam-api 路径；
  // headers 同 vteam，用 {env:...} 引用（worker 注入器解析 X_WORKER_TOKEN/WORKER_ID 注入鉴权头）。
  // 默认禁用，按需在管理面开启（worker injectMcp 仅注入 enabled=true 的 server，
  // 管理面切换后经 broadcastReloadConfig 广播 worker 自动重拉）。
  const vteamApiUrl = `${platformMcpUrl.replace(/\/api\/v1\/platform-mcp$/, '')}/api/v1/vteam-api/mcp`;

  await prisma.mcpServer.upsert({
    where: { name: 'vteam-api' },
    update: {
      type: 'remote',
      url: vteamApiUrl,
      headers: {
        'x-worker-token': '{env:X_WORKER_TOKEN}',
        'x-worker-id': '{env:WORKER_ID}',
      },
      enabled: false,
    },
    create: {
      id: 'ms_vteam_api',
      name: 'vteam-api',
      type: 'remote',
      url: vteamApiUrl,
      headers: {
        'x-worker-token': '{env:X_WORKER_TOKEN}',
        'x-worker-id': '{env:WORKER_ID}',
      },
      enabled: false,
    },
  });

  // vteam 的 MCP 工具（阶段 2）：注册 tools 表 source=mcp 行，
  // 前端「技能与工具」页 MCP 工具子 Tab 按 source=mcp 过滤渲染。
  // action 为 platform-mcp 端点 tools/list 的 tool 名（命名 <server>_<action>），
  // source=mcp + execution=mcp + mcpServer 对齐 tools.service 的 source 推导逻辑。
  const vteamTools = [
    { action: 'chat_history', name: 'vteam_chat_history', description: '查询任务群聊历史消息（按需拉取）' },
    { action: 'doclib', name: 'vteam_doclib', description: '查询任务产出物文档库' },
    { action: 'task_context', name: 'vteam_task_context', description: '查询任务概览与团队实例成员' },
    { action: 'group_post', name: 'vteam_group_post', description: '向任务群聊发布消息' },
    { action: 'read_file', name: 'vteam_read_file', description: '读取产出物文件或 worker 工作区文件' },
    { action: 'notify_agent', name: 'vteam_notify_agent', description: '向任务内实例定向发消息并触发执行' },
    { action: 'submit_artifact', name: 'vteam_submit_artifact', description: '提交产出物到任务文档库' },
    { action: 'issue_create', name: 'vteam_issue_create', description: '创建任务内 issue' },
    { action: 'issue_list', name: 'vteam_issue_list', description: '查询任务内 issue 列表' },
    { action: 'issue_get', name: 'vteam_issue_get', description: '查询单个 issue 详情' },
    { action: 'issue_update', name: 'vteam_issue_update', description: '更新 issue 标题/描述/标签' },
    { action: 'issue_transition', name: 'vteam_issue_transition', description: '流转 issue 状态' },
    { action: 'task_transition', name: 'vteam_task_transition', description: '流转任务状态（仅主 Agent）' },
    { action: 'question_confirm', name: 'vteam_question_confirm', description: '托管模式确认成员请求（仅主 Agent）' },
    { action: 'memory_save', name: 'vteam_memory_save', description: '写入平台记忆（task/team/global 三级）' },
    { action: 'memory_search', name: 'vteam_memory_search', description: '检索平台记忆' },
    { action: 'team_view', name: 'vteam_team_view', description: '查询任务团队实时视图' },
    { action: 'my_profile', name: 'vteam_my_profile', description: '查询自身 Agent 配置' },
    { action: 'team_add_member', name: 'vteam_team_add_member', description: '申请将 Agent 加入团队（仅主 Agent）' },
    { action: 'plan_mode', name: 'vteam_plan_mode', description: '切换任务计划模式开关（仅主 Agent）' },
    { action: 'plan_complete', name: 'vteam_plan_complete', description: '标记计划执行完成（仅主 Agent）' },
    { action: 'channel_send', name: 'vteam_channel_send', description: 'Agent 主动推送通知到通知渠道（webhook/企微机器人）' },
    { action: 'wecom_reply', name: 'vteam_wecom_reply', description: '回复企业微信用户（仅当消息来自企微时使用）' },
    { action: 'task_create', name: 'vteam_task_create', description: '在团队会话无任务时创建任务（仅主 Agent 可调）' },
    { action: 'memory_update', name: 'vteam_memory_update', description: '更新平台记忆（团队隔离校验）' },
    { action: 'skill_create', name: 'vteam_skill_create', description: '创建技能（仅主 Agent，默认停用）' },
    { action: 'git_repos_list', name: 'vteam_git_repos_list', description: '查询被授权仓库只读清单（脱敏）' },
    { action: 'hook_register', name: 'vteam_hook_register', description: '注册稍后唤醒（定时/静默，唤醒回同会话）' },
    { action: 'hook_cancel', name: 'vteam_hook_cancel', description: '取消 hook（仅所有者或主 Agent）' },
  ];

  for (const t of vteamTools) {
    await prisma.tool.upsert({
      where: { action: t.action },
      update: { mcpServer: 'vteam', source: 'mcp', execution: 'mcp', enabled: true },
      create: {
        id: `tl_vteam_${t.action}`,
        name: t.name,
        action: t.action,
        source: 'mcp',
        execution: 'mcp',
        mcpServer: 'vteam',
        enabled: true,
      },
    });
  }

  // 预置 builtin 技能（SKILL.md 全文内联，worker injectSkills() 按 name 读取后写入 .opencode/skills/<name>/SKILL.md）
  // source=builtin（seed 注册），幂等：按 name 唯一键 upsert。
  const BUILTIN_SKILLS = [
    {
      id: 'sk_builtin_prototype_designer',
      name: 'prototype-designer',
      description:
        '原型页面设计技能——按平台 TSX 规范编写 React 组件原型并提交，文档站「原型」tab 编译渲染（无需改代码）。适用于任务需要产出原型/UI 稿/页面示意时。',
      content: `---
name: prototype-designer
description: 原型页面设计技能——按平台 TSX 规范编写 React 组件原型并提交，文档站「原型」tab 编译渲染（无需改代码）。适用于任务需要产出原型/UI 稿/页面示意时。
version: 2.0.0
allowed-tools:
  - task_context
  - submit_artifact
  - read_file
---

# 原型设计（Prototype Designer）— TSX

## 目标

为当前任务设计并提交**可渲染的 TSX 原型页面**：编写 React 组件（TSX），经 \`submit_artifact\` 提交后，文档站「原型」tab 自动编译并渲染。**无需改动任何代码、无需重新部署。**

## 工作流程

1. **分析需求**：用 \`task_context\` 获取任务标题/描述/背景，明确原型要展示什么（业务页面、管理界面、流程示意等）。
2. **设计结构**：规划页面布局与组件组合（原生 HTML 元素 + 平台共享组件 + tailwind 样式）。
3. **编写 TSX**：按下方规范生成 \`<kebab-name>/index.tsx\` 文件。
4. **自检**：组件导出 meta + default function、仅使用允许的 import、语法合法。
5. **提交**：\`submit_artifact\`（type=file）提交原型文件（见「提交方式」）。
6. **确认**：可经 \`read_file\` 复查已提交文件内容。

## TSX 规范（v2）

### 文件结构

每个原型 = 一个目录 \`<kebab-name>/\`，内含 \`index.tsx\`：

\`\`\`
prototypes/
  my-dashboard/
    index.tsx        ← 唯一文件
  login-page/
    index.tsx
\`\`\`

### 组件格式

\`\`\`tsx
export const meta = {
  id: "my-dashboard",        // 必填：唯一英文短名（kebab-case，= 目录名）
  name: "仪表盘",             // 必填：文档站列表展示名
  device: "desktop",          // 可选："desktop"（默认）| "mobile"
};

export default function MyDashboard() {
  return (
    <div className="min-h-full bg-slate-50 p-6">
      {/* 页面内容 */}
    </div>
  );
}
\`\`\`

### 可用平台共享库（\`@proto/shared\`）

通过 \`import { ... } from "@proto/shared"\` 引入以下组件：

**业务组件（components）：**
| 组件 | 说明 |
|---|---|
| \`AgentAvatar\` | Agent 头像（含角色色环） |
| \`AgentBadge\` | Agent 角色徽章（产品/架构/开发/测试） |
| \`ChatBubble\` | 聊天气泡（user/agent/system） |
| \`MessageInput\` | 消息输入框 |
| \`StatusBadge\` | 任务状态徽章（进行中/待验收/已完成/已归档） |
| \`Sidebar\` | 侧边导航栏 |
| \`TopBar\` | 顶部导航栏 |
| \`EmptyState\` | 空状态占位 |

**导航组件（nav）：**
| 组件 | 说明 |
|---|---|
| \`NavDock\` | 底部 Dock 导航（含图标+标签） |
| \`NavTopBar\` | 顶部导航栏（含项目名+用户头像） |
| \`CmdKPanel\` | Command-K 快捷面板 |

**UI 组件（ui）：**
| 组件 | 说明 |
|---|---|
| \`UiStatusBadge\` | 通用状态标签（tone 版） |
| \`ProgressBar\` | 进度条 |
| \`Avatar\` | 用户头像（文字首字母） |
| \`Button\` | 按钮 |
| \`IconSearch\` / \`IconPlus\` / \`IconEdit\` / \`IconMore\` | 图标 |
| \`IconChevronLeft\` / \`IconChevronRight\` | 箭头图标 |
| \`IconLock\` / \`IconClock\` / \`IconRefresh\` | 功能图标 |
| \`IconMonitor\` / \`IconSmartphone\` | 设备图标 |

**样式 token（styles）：**
| 导出 | 说明 |
|---|---|
| \`roles\` | 角色色阶（product/architect/developer/tester） |
| \`statusColors\` | 状态色阶（进行中/待验收/已完成/已归档） |
| \`neutral\` / \`space\` / \`radius\` / \`fontSize\` / \`shadow\` | 设计 token |

### 样式规范

- 使用 **tailwind CSS 类**（平台已内置）。
- 品牌色阶：\`brand-50\`/\`brand-100\`/…/\`brand-600\`/\`brand-700\`（主色）。
- 语义色阶：\`success-*\`（成功）、\`warning-*\`（警告）、\`danger-*\`（危险）、\`info-*\`（信息）。
- 可用原生 HTML 元素（\`div\`/\`span\`/\`table\`/\`form\` 等）+ tailwind 类自由组合。
- 可嵌套使用平台共享组件（如 \`<NavDock />\` + 自定义内容区）。

### 规范约束

- **必须**：导出 \`meta\`（含 id/name）+ \`export default function\`。
- **仅允许 import**：\`@proto/shared\` + \`react\`（useState 等）+ 原生元素。
- **禁止**：import 其他第三方库/Node 模块/平台 API/网络请求/本地存储。
- **交互**：可用 \`useState\` 实现客户端状态（tab 切换、表单输入等）；无服务端交互。
- **数据为演示值**：原型是静态展示/演示，数据写示例值（如"1286""进行中"），不要留空。
- **命名**：目录名 \`id\` 用英文 kebab-case（\`my-dashboard\`）；\`name\` 可用中文。

### 示例（最小完整原型）

\`\`\`tsx
export const meta = {
  id: "task-overview",
  name: "任务总览",
};

export default function TaskOverview() {
  const [activeTab, setActiveTab] = useState("all");

  return (
    <div className="min-h-full bg-slate-50 p-6">
      <h1 className="text-xl font-semibold text-slate-900">任务总览</h1>
      <p className="mt-1 text-sm text-slate-500">当前迭代演示</p>

      {/* 统计卡片 */}
      <div className="mt-6 grid grid-cols-4 gap-3">
        {[
          { label: "总任务", value: "1286" },
          { label: "运行中", value: "8", trend: "+2" },
          { label: "待审批", value: "6" },
          { label: "已完成", value: "1272" },
        ].map((item) => (
          <div key={item.label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-2xl font-semibold text-slate-900">{item.value}</p>
            <p className="text-xs text-slate-500">{item.label}</p>
            {item.trend && <p className="text-[11px] font-medium text-green-600">{item.trend}</p>}
          </div>
        ))}
      </div>

      {/* Tab 切换 */}
      <div className="mt-6 flex border-b border-slate-200">
        {["all", "active", "done"].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={\`px-4 py-2 text-sm font-medium \${
              activeTab === tab ? "border-b-2 border-brand-500 text-brand-600" : "text-slate-500"
            }\`}
          >
            {tab === "all" ? "全部" : tab === "active" ? "进行中" : "已完成"}
          </button>
        ))}
      </div>

      {/* 任务列表 */}
      <div className="mt-4 rounded-xl border border-slate-200 bg-white">
        {["文档站改造", "MCP 接入", "Agent 优化"].map((name) => (
          <div key={name} className="flex items-center justify-between border-b border-slate-100 px-4 py-3 last:border-0">
            <span className="text-sm text-slate-900">{name}</span>
            <StatusBadge status="进行中" />
          </div>
        ))}
      </div>
    </div>
  );
}
\`\`\`

## 提交方式

- **目录结构**：原型文件为 \`<kebab-name>/index.tsx\`（id 与目录名一致）。
- **fileRef**：\`index.tsx\` 在工作目录的路径（绝对路径）。
- **调用**：用 submit_artifact 提交归档（type=file，fileRef 为工作目录下 \`<kebab-name>/index.tsx\` 的路径，参数细节查工具 schema）。

提交成功后，文档站「原型」tab 自动出现该原型（列表按名称展示，点击编译渲染）。

## 文档内嵌入原型

原型提交后，可在 markdown 文档中**嵌入可交互的原型预览**，支持三种嵌入语法。文档站会自动编译原型并在 iframe 中渲染，用户可切换设备（PC / 移动端）查看效果。

### 块级嵌入（推荐）

在 markdown 中使用 3 反引号 \`prototype\` 围栏，内部为 YAML 格式的 key: value 行：

\`\`\`\`markdown
\`\`\`prototype
id: my-dashboard
title: 仪表盘预览    # 可选，覆盖原型名称
device: desktop      # 可选：desktop | mobile，默认 desktop
height: 520          # 可选：iframe 最大高度 px，默认 640
\`\`\`
\`\`\`\`

**参数说明：**

| 参数 | 必填 | 说明 |
|------|------|------|
| \`id\` | 是 | 原型 ID（与 \`meta.id\` 一致） |
| \`title\` | 否 | 显示标题（默认使用原型 \`name\`） |
| \`device\` | 否 | 初始设备：\`desktop\`（默认）或 \`mobile\` |
| \`height\` | 否 | iframe 最大高度（px），默认 640 |

**渲染效果：** 原型在 DeviceFrame 中渲染，顶部显示标题和设备切换按钮（PC / 移动端），用户可交互操作原型。

### 原型清单

使用 \`prototype-list\` 列出当前文档引用的全部原型：

\`\`\`\`markdown
\`\`\`prototype-list
\`\`\`
\`\`\`\`

清单以链接形式展示所有引用的原型，点击可跳转到原型视图。如需内嵌所有原型（而非链接列表），添加 \`embed: true\`：

\`\`\`\`markdown
\`\`\`prototype-list
embed: true
\`\`\`
\`\`\`\`

### 行内引用

使用 \`@prototype[id]\` 语法在文本中嵌入原型引用标签：

\`\`\`markdown
查看效果：@prototype[my-dashboard]（点击跳转原型视图）
\`\`\`

渲染为可点击的蓝色标签，点击后跳转到该原型的全屏预览视图。

### 嵌入规则

1. **按任务解析**：嵌入的原型必须属于当前任务（与文档同目录下的 \`prototypes/\`），引用其他任务的原型会提示"原型不存在于当前任务"
2. **反引号规则**：解析器只识别**恰好 3 个反引号**的 \`prototype\` 围栏；展示标记写法本身时，必须用 4+ 反引号包裹
3. **设备切换**：嵌入的原型支持实时切换 PC / 移动端视图，无需重新加载

### 示例

\`\`\`\`markdown
## 功能演示

以下是任务管理原型的预览：

\`\`\`prototype
id: task-management
title: 任务管理界面
device: desktop
\`\`\`

也可以查看移动端效果：

\`\`\`prototype
id: task-management
title: 任务管理（移动端）
device: mobile
height: 720
\`\`\`

本文档引用的原型清单：

\`\`\`prototype-list
\`\`\`
\`\`\`\`

## 原型实现方式

### 数据链路

\`\`\`
TSX 源码 (<kebab-name>/index.tsx)
  → submit_artifact (type=file, 写入 uploads/<uuid>.tsx)
  → Artifact 表 (type=file, contentRef=/uploads/<uuid>.tsx, category 选填)
  → GET /docs-site/:taskId/prototypes 列表 + GET /docs-site/:taskId/prototypes/<file> 原文（DB 直读，无磁盘镜像）
  → PrototypeSandbox 拉取源码 → esbuild-wasm 编译 → iframe srcdoc 渲染
\`\`\`

- **DB 直读（无镜像层）**：\`listPrototypes\`/\`readPrototype\` 直接查 DB——该任务 \`type=file\` 且 \`contentRef\` 以 \`.tsx\`/\`.prototype.json\` 结尾的产出物当前版本，按 \`prototypeSlug\` 算名，\`readUploadedFile(contentRef)\` 取源码；无 \`docs-root\` 落盘，不做全量重建。
- **文档库直读**：文档站按 DB \`Artifact\` 直读（全类型覆盖），原型经 \`contentRef → artifactId\` 反查关联产出物。
- **产出物版本**：原型读取始终为 \`currentVersion\` 的正文，历史版本不入站；删除产出物后列表幂等清理。

### 编译渲染

由 \`web/src/features/docs-site/prototype-sandbox.tsx\` 完成：

1. **拉取**：\`GET /docs-site/:taskId/prototypes/<file>\`（\`Authorization: Bearer <token>\`）+ \`/vendor/react-runtime.js\`。
2. **编译**：\`esbuild-wasm\`（\`initialize({ wasmURL: "/esbuild/esbuild.wasm" })\`），\`bundle: true, format: "iife", globalName: "__ProtoModule", jsx: "transform", target: "es2017"\`，插件 \`protoCompilePlugin\` 将 \`react\` / \`react-dom\` / \`@proto/shared\` / \`@proto/shared/*\` / \`_shared/*\` / \`@md-docs/*\` 分流到虚拟命名空间（React 来自 \`globalThis\`，\`@proto/shared\` 置空占位，不走网络）。
3. **装配 srcdoc**：\`buildSrcdoc(runtimeJs, bundleCode, cssText)\` 拼接 \`<!DOCTYPE html>\`：\`cdn.tailwindcss.com\` + \`baseStyle\` + 父页面 \`collectCss()\` + \`runtimeJs\` + \`bundleCode\` + \`renderScript\`（取 \`__ProtoModule.default\` 或 \`Component\`，\`ReactDOMClient.createRoot\` / \`ReactDOM.render\` 兼容分支）。
4. **挂载**：\`iframe sandbox="allow-scripts" srcDoc={srcdoc}\`；\`isFramed\` 时固定 \`height:100%\`，否则监听 \`postMessage({ type:'proto-height' })\` + \`ResizeObserver\` 自适应高度（120–4096px 钳制）。

### 样式与布局

- **Tailwind**：iframe 内通过 \`cdn.tailwindcss.com\` 即时编译类名，支持 \`brand-*\` / \`success-*\` / \`warning-*\` / \`danger-*\` / \`info-*\` 等语义色；同时注入父页面已加载样式表（\`collectCss\` 遍历 \`document.styleSheets\`）。
- **DeviceFrame**（\`device-frame.tsx\`）：\`desktop\` 为浏览器窗体（红黄绿三点 + 地址栏 + \`spec.width × spec.height\`，默认 1280×800）；\`mobile\` 为手机外壳（圆角 + 刘海 + 信号/电量图标 + \`390×844\`），由 \`DEVICE_SPECS\` 定义，\`DeviceSwitcher\` 在原型头与嵌入卡片中切换。
- **约束**：iframe 仅 \`allow-scripts\`，无网络/存储访问；原型内禁止第三方库与 API 调用，所有数据为静态演示值。

### 关联组件

| 组件/模块 | 职责 |
|---|---|
| \`ArtifactsService\` | 产出物落库与版本（\`append\` / \`archiveFile\` / DB 直读 \`listPrototypes\` / \`readPrototype\`） |
| \`DocsSiteController\` | \`prototypes\` / \`prototypes/*\` 两端点（DB 直读）+ \`registry\` / \`prd/:file\`（待退役），JWT + 项目成员校验 |
| \`PrototypePanel\` | 「原型」tab：左侧列表 + 右侧 \`DeviceFrame > PrototypeSandbox\` 预览，支持删除（\`DELETE /artifacts/:id\`） |
| \`PrototypeSandbox\` | 编译 + iframe 渲染，含 loading / error 态 |
| \`DeviceFrame\` / \`DeviceSwitcher\` | 设备外壳与切换器 |

## 常见错误

| 错误 | 规避 |
|---|---|
| 缺少 \`meta\` 导出 | 必须 \`export const meta = { id, name }\` |
| 缺少 \`export default function\` | 必须默认导出 React 组件 |
| import 非允许模块 | 仅 \`@proto/shared\` + \`react\` + 原生元素 |
| 语法错误（JSX/TS） | 提交前确保 TSX 语法合法 |
| 数据留空 | 全部写演示值 |
| 嵌入原型不存在 | 确保 \`id\` 与原型 \`meta.id\` 一致，且原型属于当前任务（同 \`taskId\` 反查）；跨任务引用会渲染为黄底提示 |
`,
    },
    {
      id: 'sk_builtin_plan_creation',
      name: 'plan-creation',
      description:
        '计划编制技能——计划成员（计划员）响应主 Agent @ 派活，以 explore-first 方式起草执行计划：并行探索、任务拆解、依赖分析、团队能力映射，落盘 .opencode/plans/ 后在群聊回复摘要并按 feedback 修订。',
      content: `---
name: plan-creation
description: 计划编制技能——计划成员（计划员）响应主 Agent @ 派活，以 explore-first 方式起草执行计划：并行探索、任务拆解、依赖分析、团队能力映射，落盘 .opencode/plans/ 后在群聊回复摘要并按 feedback 修订。
version: 2.0.0
allowed-tools:
  - task_context
  - read_file
  - doclib
  - chat_history
  - task
---

# 计划编制（Plan Creation）

## 使用者

本 skill 的使用者是团队计划成员（计划员），不是主 Agent：只响应主 Agent 的 @ 派活起草计划。用户交互与正式送审归主 Agent，本 skill 内绝不直接问用户、不调用送审工具。

## 目标

为当前任务起草一份**决策完备、可直接执行**的计划。只起草，不执行：本技能内绝不进入实现。

## 步骤 1：Explore-first 并行探索

Prometheus 式探索：多路并行、分波次扇出，只收敛必要信息。

1. 用 \`task_context\` 拿任务标题/描述/背景与团队实例清单；用 \`read_file\` / \`doclib\` 读关键产出物与文档；用 \`chat_history\` 补群聊上下文。
2. 探索分波次并行推进：每波只回答本波能回答的问题，不臆测、不提前下结论。
波次结构（Prometheus waves）：Wave 1 用 \`task_context\` 拿任务标题/描述/背景与团队实例清单（含 agentMembers 成员与能力），这是后续一切映射的事实来源；Wave 2 基于 Wave 1 识别出的关键文件/产出物，并行扇出 \`read_file\` / \`doclib\` 读取，必要时用 \`chat_history\` 补群聊结论，各路并行互不等待；Wave N 收敛各波结果拼出工作项初稿。每波只回答本波能回答的问题，不臆测缺失信息、不提前下结论，缺证据就记假设、不硬编。
3. 只收敛计划真正需要的信息；真正的分叉记为假设交主 Agent 定夺，其余按最佳实践直接决策并在计划中注明假设。

## 步骤 2：任务拆解

把任务拆为可执行、可验证的工作项，格式统一：

- T1 <标题>：<一句话目标>（验收：<可判定标准>）

证据要求：每个工作项必须附证据（文件路径 / 成员输入 / 群聊结论，注明出处）；写不出证据的工作项标\`[假设]\`并汇总进"假设清单"，不把猜测写成事实。

## 步骤 3：并行/串行依赖分析

- 标出每项的前置依赖；无依赖的工作项分为并行组，有依赖的排为串行链。
- 依赖存疑时宁可标串行，不虚构并行度。

## 步骤 4：团队能力映射

- 经 \`task_context\` 的 agentMembers 动态读取团队实例与各自能力，按能力认领工作项。
- 绝不硬编码角色：自建 custom agent 与内置角色同等可规划，有什么人、就排什么活。

## 步骤 5：任务分配章节

计划必须含"任务分配"章节，每项四要素齐全：内容（content）、负责人（owner）、依赖（dependencies）、验收（acceptance）。

## 假设清单

所有"按最佳实践直接决策"的项集中列在此节，供评审重点质疑：每条写清假设内容、影响的工作项、万一不成立的回退路径。评审看不懂出处的工作项，先到这里找假设，不要直接判死刑。

## 反模式（不要做）

- 不虚构并行度：依赖存疑时宁可标串行，不虚构并行度。
  - ❌ "T2 与 T3 看起来无关，标并行"（没读到接口契约就断定无关）。
  - ✅ "T2 依赖 T1 的接口定义（见 docs/api.md），标串行；待接口冻结后可转并行[假设]"。
- 不臆测成员能力：以 \`task_context\` 的 agentMembers 为唯一来源，不按角色名脑补能力。
  - ❌ "开发者肯定会写 Python，T4 交开发者"（task_context 没写就别断定）。
  - ✅ "T4 交开发者-1（task_context 显示其能力含后端实现；语言栈未注明，记假设待确认）"。
- 不写无验收项：每个工作项必须有可判定验收，无验收的工作项不进计划。
  - ❌ "T5 优化一下体验"（无验收，不可判定）。
  - ✅ "T5 首屏加载 <2s（验收：在测试环境复测 3 次取中位）"。
- 一次只产出一份决策完备的计划：不一次给多候选方案让评审挑，拿不准的走假设清单，确需用户拍板的项记为假设交主 Agent 定夺。

## 扇出纪律（Subagent fan-out）

评审视角任务需要多视角并行评审时，可经 task 工具扇出只读评审子会话：

- 子会话 subagent_type恒为vteam-plan（防越权硬约束，其他值一律拒绝）。
- 前台阻塞等结果：一次扇出后等待全部子会话返回再收敛，不 fire-and-forget。
- 2~4 路并行：按评审视角数扇出 2~4 路，不超 4 路；视角不足 2 个就不扇出，直接自检。
- 禁套娃：子会话内不再扇出（task 在子会话内 deny），评审子会话只读计划、只输出 VERDICT 与依据。
- VERDICT 回收：逐路回收 \`VERDICT: APPROVE\` / \`VERDICT: REJECT\` 与 findings，汇总后按 feedback 修订计划；任一评审返回 REJECT 即按 findings 修订，修订后更新落盘。

## 步骤 6：落盘

计划全文写入 \`.opencode/plans/<kebab-name>.md\`（唯一落盘位置）。

## 步骤 7：群聊摘要与按 feedback 修订

1. 落盘后在群聊回复计划摘要（结论、工作项、假设清单指引），通知主 Agent。
2. 主 Agent 带 feedback 重派时，按 findings 修订计划；修订后更新落盘并再次摘要。
3. 本 skill 内不直接问用户、不送审：用户交互与正式送审归主 Agent。

## 送审预判（Review calibration）

评审者按 APPROVAL BIAS（存疑放行）判定：有疑虑但不阻塞开工就放行，只拦真正会卡住执行的真阻塞。本计划按"能开工"而非"完美"来写：工作项可定位到人、可找到起点、可判定完成即可送审；措辞可打磨、细节可迭代的项不提前自我加码。

## 约束

- 一次只产出一份决策完备的计划；本技能内绝不进入实现。
- 评审侧由 sibling 技能承接：\`plan-review-product\` / \`plan-review-architect\` / \`plan-review-developer\` / \`plan-review-tester\` / \`plan-review-project_manager\`（评审子会话内加载，本技能只负责起草与修订）。
`,
    },
    {
      id: 'sk_builtin_plan_review_product',
      name: 'plan-review-product',
      description:
        '计划评审技能（产品视角）——只读冷评审计划的用户视角、完整性、必要性、易用性与验收可判定性，输出 VERDICT: APPROVE/REJECT 与依据；不修改计划文件。',
      content: `---
name: plan-review-product
description: 计划评审技能（产品视角）——只读冷评审计划的用户视角、完整性、必要性、易用性与验收可判定性，输出 VERDICT: APPROVE/REJECT 与依据；不修改计划文件。
version: 1.0.0
allowed-tools:
  - read_file
  - task_context
  - chat_history
  - skill
---

# 计划评审（产品视角）

风格参照 momus（只读 + 二值裁决）与 oracle（高智商咨询）：冷评审、给结论、附证据。上游编制流程见 sibling 技能 \`plan-creation\`。本 skill 可能在计划成员扇出的子会话（subagent）内运行，届时同样只读评审、不修改计划文件、不执行计划。

## 目的

只回答一个问题："这份计划能否不卡住地执行下去"。存疑时放行（APPROVAL BIAS / 存疑放行）：约八成清晰、剩下的能用假设兜底就 APPROVE；只有真正会卡住执行的阻塞才 REJECT。你是找阻塞的，不是找完美的。

## 输入

- 经 \`read_file\` 读取待评审计划全文——这是唯一评审对象。
- 必要时经 \`task_context\` / \`chat_history\` 核对任务背景；需要其他能力时经 \`skill(<name>)\` 加载。

## 评审视角：产品

- 用户视角：目标用户是否说得清，使用场景是否真实。
  - PASS：能说出谁在什么场景下用什么，哪怕措辞粗糙。FAIL：通篇"用户"却无具体人群与场景，执行人不知道为谁做。
- 完整性：需求条目有无遗漏，上下游衔接是否断档。
  - PASS：主干条目齐全、上下游能接上，缺的只是枝节。FAIL：主干需求缺失或上下游断档，开工即返工。
- 必要性：有无镀金条目，能否砍掉而不伤目标。
  - PASS：条目都服务于目标，至多带一两处可延后的加分项。FAIL：大段镀金喧宾夺主，执行会被带偏。
- 易用性：交付物是否好用，信息与交互是否清晰。
  - PASS：交付物形态与信息结构说清了，能动手。FAIL：交付物形态不明，执行人不知道产出什么。
- 验收可判定性：每条验收标准能否明确判通过/不通过。
  - PASS：每条都能判过/不过，阈值可测。FAIL：存在无法判定的验收（如"体验更好"），验证无从下手。

## 反模式（什么不是 blocker）

- "可以写得更清楚"不是 blocker：能看懂、能开工即可，不逐字雕琢。
  - ✅ "用户场景在 §2 已说清，措辞可再润，APPROVE"。
  - ❌ "§3 有个别模糊词但不影响判定，为措辞 REJECT"。
- "可以更完整"不是 blocker：缺的是枝节而非主干就放行，缺主干才拦。
  - ✅ "§4 缺极端分支，主干完整，APPROVE 并记一条建议"。
  - ❌ "计划没写远景展望，为不够远 REJECT"。
- REJECT 上限：最多 3 条，每条必须具体：指出计划章节 + 要改成什么 + 为什么不改会卡住。凑不够 3 条就只写真实的，不凑数。

## 输出（严格）

第一行必须是 \`VERDICT: APPROVE\` 或 \`VERDICT: REJECT\`（聚合器按 \`/VERDICT:\s*(APPROVE|REJECT)/i\` 解析，其他写法一律无效）。
之后逐条列 findings，每条指向计划具体章节并附证据（章节号 / 原文引用）。
篇幅上限（Oracle 纪律）：每条≤2句，总 findings 不超过 6 条；REJECT 时不超过 3 条。超了就删最不重要的一条。

## 范围纪律（Oracle）

不 redesign、不扩面：只判当前计划能不能执行，不重写方案、不加新需求、不把"更好的做法"当 blocker。拿不准时：要么在 finding 中显式声明假设后继续判，要么只问 1 个精确问题，不连环追问。

## 禁止

- 禁止修改计划文件（只读评审）；禁止执行计划中任何步骤。
- 只输出 VERDICT 与依据，不做其他发挥。
VERDICT 必须引用计划版本号：首行写成 \`VERDICT: APPROVE @ v<版本号>\` 或 \`VERDICT: REJECT @ v<版本号>\`（聚合器仍按 \`/VERDICT:\s*(APPROVE|REJECT)/i\` 解析，版本号仅作引用）；无版本号的 VERDICT 视为无效。
`,
    },
    {
      id: 'sk_builtin_plan_review_architect',
      name: 'plan-review-architect',
      description:
        '计划评审技能（架构视角）——只读冷评审计划的技术合理性、设计一致性与边界完整性，输出 VERDICT: APPROVE/REJECT 与依据；不修改计划文件。',
      content: `---
name: plan-review-architect
description: 计划评审技能（架构视角）——只读冷评审计划的技术合理性、设计一致性与边界完整性，输出 VERDICT: APPROVE/REJECT 与依据；不修改计划文件。
version: 1.0.0
allowed-tools:
  - read_file
  - task_context
  - chat_history
  - skill
---

# 计划评审（架构视角）

风格参照 momus（只读 + 二值裁决）与 oracle（高智商咨询）：冷评审、给结论、附证据。上游编制流程见 sibling 技能 \`plan-creation\`。本 skill 可能在计划成员扇出的子会话（subagent）内运行，届时同样只读评审、不修改计划文件、不执行计划。

## 目的

只回答一个问题："这份计划能否不卡住地执行下去"。存疑时放行（APPROVAL BIAS / 存疑放行）：约八成清晰、剩下的能用假设兜底就 APPROVE；只有真正会卡住执行的阻塞才 REJECT。你是找阻塞的，不是找完美的。

## 输入

- 经 \`read_file\` 读取待评审计划全文——这是唯一评审对象。
- 必要时经 \`task_context\` / \`chat_history\` 核对任务背景；需要其他能力时经 \`skill(<name>)\` 加载。

## 评审视角：架构

- 技术合理性：技术选型与分层划分是否成立，有无明显反模式。
  - PASS：选型与分层能自圆其说、无硬伤，细节可执行中打磨。FAIL：选型明显装反（如存储用错、跨层强耦合），按此做必返工。
- 设计一致性：方案内部是否自洽，与需求之间是否对得上。
  - PASS：模块划分与需求条目能对上号，小出入可在假设清单兜底。FAIL：方案与需求各说各话，或内部互相矛盾，执行人无所适从。
- 边界完整性：模块边界是否清晰，风险与待验证项是否齐备、有无验证路径。
  - PASS：边界说清了，风险与待验证项列出且有验证路径。FAIL：关键边界缺失或高风险项无验证路径，开工即踩坑。

## 反模式（什么不是 blocker）

- "有更优的选型"不是 blocker：当前选型成立即可，不追最优解。
  - ✅ "§2 选型够用，另有更快但更重的方案，APPROVE 并记一条建议"。
  - ❌ "§2 方案可行但不是我心中的最优，为选型品味 REJECT"。
- "可以画得更细"不是 blocker：边界与风险有着落即可，不逐层展开。
  - ✅ "§3 边界清晰，子模块细节可执行中补，APPROVE"。
  - ❌ "§3 没画出三级子模块，为粒度 REJECT"。
- REJECT 上限：最多 3 条，每条必须具体：指出计划章节 + 要改成什么 + 为什么不改会卡住。凑不够 3 条就只写真实的，不凑数。

## 输出（严格）

第一行必须是 \`VERDICT: APPROVE\` 或 \`VERDICT: REJECT\`（聚合器按 \`/VERDICT:\s*(APPROVE|REJECT)/i\` 解析，其他写法一律无效）。
之后逐条列 findings，每条指向计划具体章节并附证据（章节号 / 原文引用）。
篇幅上限（Oracle 纪律）：每条≤2句，总 findings 不超过 6 条；REJECT 时不超过 3 条。超了就删最不重要的一条。

## 范围纪律（Oracle）

不 redesign、不扩面：只判当前计划能不能执行，不重写方案、不加新需求、不把"更好的做法"当 blocker。拿不准时：要么在 finding 中显式声明假设后继续判，要么只问 1 个精确问题，不连环追问。

## 禁止

- 禁止修改计划文件（只读评审）；禁止执行计划中任何步骤。
- 只输出 VERDICT 与依据，不做其他发挥。
VERDICT 必须引用计划版本号：首行写成 \`VERDICT: APPROVE @ v<版本号>\` 或 \`VERDICT: REJECT @ v<版本号>\`（聚合器仍按 \`/VERDICT:\s*(APPROVE|REJECT)/i\` 解析，版本号仅作引用）；无版本号的 VERDICT 视为无效。
`,
    },
    {
      id: 'sk_builtin_plan_review_developer',
      name: 'plan-review-developer',
      description:
        '计划评审技能（开发视角）——只读冷评审计划的步骤可执行性、依赖真实性与工作量合理性，输出 VERDICT: APPROVE/REJECT 与依据；不修改计划文件。',
      content: `---
name: plan-review-developer
description: 计划评审技能（开发视角）——只读冷评审计划的步骤可执行性、依赖真实性与工作量合理性，输出 VERDICT: APPROVE/REJECT 与依据；不修改计划文件。
version: 1.0.0
allowed-tools:
  - read_file
  - task_context
  - chat_history
  - skill
---

# 计划评审（开发视角）

风格参照 momus（只读 + 二值裁决）与 oracle（高智商咨询）：冷评审、给结论、附证据。上游编制流程见 sibling 技能 \`plan-creation\`。本 skill 可能在计划成员扇出的子会话（subagent）内运行，届时同样只读评审、不修改计划文件、不执行计划。

## 目的

只回答一个问题："这份计划能否不卡住地执行下去"。存疑时放行（APPROVAL BIAS / 存疑放行）：约八成清晰、剩下的能用假设兜底就 APPROVE；只有真正会卡住执行的阻塞才 REJECT。你是找阻塞的，不是找完美的。

## 输入

- 经 \`read_file\` 读取待评审计划全文——这是唯一评审对象。
- 必要时经 \`task_context\` / \`chat_history\` 核对任务背景；需要其他能力时经 \`skill(<name>)\` 加载。

## 评审视角：开发

- 步骤可执行性：每步能否无歧义落地，有无缺前置、缺口径的步骤。
  - PASS：至少知道从哪下手（入口文件 / 命令 / 口径有着落）。FAIL：零上下文无法开工（如"实现核心模块"却无入口、无口径）。
- 依赖真实性：前置依赖是否真实存在，顺序是否成立，并行分组是否真可并行。
  - PASS：依赖链成立，并行分组确无前置纠缠。FAIL：依赖的是不存在的产出，或"并行"两项实为串行，开工即阻塞。
- 工作量合理性：估时是否离谱，有无遗漏返工与联调成本。
  - PASS：量级靠谱，联调返工留了余量，偏差可在执行中消化。FAIL：估时差出数量级或完全没算联调，排期必爆。

## 反模式（什么不是 blocker）

- "估时可以更准"不是 blocker：量级靠谱即可，不逐项审计人天。
  - ✅ "T2 估 3 天，偏乐观但量级对，APPROVE"。
  - ❌ "T2 估 3 天，我觉得 2.5 天够，为半天差距 REJECT"。
- "写法可以更顺"不是 blocker：步骤能落地即可，不改写措辞。
  - ✅ "T3 步骤啰嗦但入口与口径齐全，APPROVE"。
  - ❌ "T3 换个说法更好，为文笔 REJECT"。
- REJECT 上限：最多 3 条，每条必须具体：指出计划章节 + 要改成什么 + 为什么不改会卡住。凑不够 3 条就只写真实的，不凑数。

## 输出（严格）

第一行必须是 \`VERDICT: APPROVE\` 或 \`VERDICT: REJECT\`（聚合器按 \`/VERDICT:\s*(APPROVE|REJECT)/i\` 解析，其他写法一律无效）。
之后逐条列 findings，每条指向计划具体章节并附证据（章节号 / 原文引用）。
篇幅上限（Oracle 纪律）：每条≤2句，总 findings 不超过 6 条；REJECT 时不超过 3 条。超了就删最不重要的一条。

## 范围纪律（Oracle）

不 redesign、不扩面：只判当前计划能不能执行，不重写方案、不加新需求、不把"更好的做法"当 blocker。拿不准时：要么在 finding 中显式声明假设后继续判，要么只问 1 个精确问题，不连环追问。

## 禁止

- 禁止修改计划文件（只读评审）；禁止执行计划中任何步骤。
- 只输出 VERDICT 与依据，不做其他发挥。
VERDICT 必须引用计划版本号：首行写成 \`VERDICT: APPROVE @ v<版本号>\` 或 \`VERDICT: REJECT @ v<版本号>\`（聚合器仍按 \`/VERDICT:\s*(APPROVE|REJECT)/i\` 解析，版本号仅作引用）；无版本号的 VERDICT 视为无效。
`,
    },
    {
      id: 'sk_builtin_plan_review_tester',
      name: 'plan-review-tester',
      description:
        '计划评审技能（测试视角）——只读冷评审计划的测试覆盖度与验证可操作性，输出 VERDICT: APPROVE/REJECT 与依据；不修改计划文件。',
      content: `---
name: plan-review-tester
description: 计划评审技能（测试视角）——只读冷评审计划的测试覆盖度与验证可操作性，输出 VERDICT: APPROVE/REJECT 与依据；不修改计划文件。
version: 1.0.0
allowed-tools:
  - read_file
  - task_context
  - chat_history
  - skill
---

# 计划评审（测试视角）

风格参照 momus（只读 + 二值裁决）与 oracle（高智商咨询）：冷评审、给结论、附证据。上游编制流程见 sibling 技能 \`plan-creation\`。本 skill 可能在计划成员扇出的子会话（subagent）内运行，届时同样只读评审、不修改计划文件、不执行计划。

## 目的

只回答一个问题："这份计划能否不卡住地执行下去"。存疑时放行（APPROVAL BIAS / 存疑放行）：约八成清晰、剩下的能用假设兜底就 APPROVE；只有真正会卡住执行的阻塞才 REJECT。你是找阻塞的，不是找完美的。

## 输入

- 经 \`read_file\` 读取待评审计划全文——这是唯一评审对象。
- 必要时经 \`task_context\` / \`chat_history\` 核对任务背景；需要其他能力时经 \`skill(<name>)\` 加载。

## 评审视角：测试

- 测试覆盖度：验收标准是否全量覆盖，边界值与异常场景有无遗漏。
  - PASS：验收条目全量有对应验证，边界与异常覆盖了主干。FAIL：整块验收无验证对应，或关键异常路径全漏，测了也白测。
- 验证可操作性：验证步骤能否复现，证据是否可采集，环境与数据需求是否说清。
  - PASS：步骤可复现、证据可采集、环境数据有着落。FAIL：验证步骤不可复现或证据无法采集，执行人无法证明做完。

## 反模式（什么不是 blocker）

- "用例可以列得更多"不是 blocker：主干覆盖即可，不穷举边角。
  - ✅ "§5 覆盖全部验收与主干异常，边角可执行中补，APPROVE"。
  - ❌ "§5 没列第 7 种异常组合，为穷举 REJECT"。
- "工具链可以更顺"不是 blocker：验证路径存在即可，不指定工具。
  - ✅ "§5 验证命令与证据路径说清了，APPROVE"。
  - ❌ "§5 用脚本而不用我偏好的框架，为工具品味 REJECT"。
- REJECT 上限：最多 3 条，每条必须具体：指出计划章节 + 要改成什么 + 为什么不改会卡住。凑不够 3 条就只写真实的，不凑数。

## 输出（严格）

第一行必须是 \`VERDICT: APPROVE\` 或 \`VERDICT: REJECT\`（聚合器按 \`/VERDICT:\s*(APPROVE|REJECT)/i\` 解析，其他写法一律无效）。
之后逐条列 findings，每条指向计划具体章节并附证据（章节号 / 原文引用）。
篇幅上限（Oracle 纪律）：每条≤2句，总 findings 不超过 6 条；REJECT 时不超过 3 条。超了就删最不重要的一条。

## 范围纪律（Oracle）

不 redesign、不扩面：只判当前计划能不能执行，不重写方案、不加新需求、不把"更好的做法"当 blocker。拿不准时：要么在 finding 中显式声明假设后继续判，要么只问 1 个精确问题，不连环追问。

## 禁止

- 禁止修改计划文件（只读评审）；禁止执行计划中任何步骤。
- 只输出 VERDICT 与依据，不做其他发挥。
VERDICT 必须引用计划版本号：首行写成 \`VERDICT: APPROVE @ v<版本号>\` 或 \`VERDICT: REJECT @ v<版本号>\`（聚合器仍按 \`/VERDICT:\s*(APPROVE|REJECT)/i\` 解析，版本号仅作引用）；无版本号的 VERDICT 视为无效。
`,
    },
    {
      id: 'sk_builtin_plan_review_project_manager',
      name: 'plan-review-project_manager',
      description:
        '计划评审技能（项目管理视角）——只读冷评审计划的排期真实性、并行合理性、阻塞风险与里程碑，输出 VERDICT: APPROVE/REJECT 与依据；不修改计划文件。',
      content: `---
name: plan-review-project_manager
description: 计划评审技能（项目管理视角）——只读冷评审计划的排期真实性、并行合理性、阻塞风险与里程碑，输出 VERDICT: APPROVE/REJECT 与依据；不修改计划文件。
version: 1.0.0
allowed-tools:
  - read_file
  - task_context
  - chat_history
  - skill
---

# 计划评审（项目管理视角）

风格参照 momus（只读 + 二值裁决）与 oracle（高智商咨询）：冷评审、给结论、附证据。上游编制流程见 sibling 技能 \`plan-creation\`。本 skill 可能在计划成员扇出的子会话（subagent）内运行，届时同样只读评审、不修改计划文件、不执行计划。

## 目的

只回答一个问题："这份计划能否不卡住地执行下去"。存疑时放行（APPROVAL BIAS / 存疑放行）：约八成清晰、剩下的能用假设兜底就 APPROVE；只有真正会卡住执行的阻塞才 REJECT。你是找阻塞的，不是找完美的。

## 输入

- 经 \`read_file\` 读取待评审计划全文——这是唯一评审对象。
- 必要时经 \`task_context\` / \`chat_history\` 核对任务背景；需要其他能力时经 \`skill(<name>)\` 加载。

## 评审视角：项目管理

- 排期真实性：里程碑与估时是否可信，有无压缩过度的环节。
  - PASS：里程碑可跟踪，估时量级可信，压缩环节可消化。FAIL：关键里程碑无交付口径或估时差出数量级，必延期。
- 并行合理性：并行分组是否真可并行，人力是否超配。
  - PASS：并行项确无依赖纠缠，人力与分组匹配。FAIL：虚构并行（一人同时干三组并行项），开工即打架。
- 阻塞与风险：依赖阻塞是否识别，风险项有无遗漏、有无缓解建议。
  - PASS：已知阻塞与顶级风险列出且有缓解方向。FAIL：明显卡脖子的依赖无人认领，开工即停摆。
- 里程碑：是否清晰可跟踪，交付口径是否明确。
  - PASS：每个里程碑有交付口径，能判达成。FAIL：里程碑只是日期无交付物，无法跟踪。

## 反模式（什么不是 blocker）

- "排期可以更紧"不是 blocker：排期可信即可，不压缩水分。
  - ✅ "里程碑留有余量，偏保守但可跟踪，APPROVE"。
  - ❌ "排期留了 2 天缓冲，为不够紧 REJECT"。
- "风险可以列得更多"不是 blocker：顶级风险有着落即可，不穷举长尾。
  - ✅ "§6 顶级风险与缓解方向齐全，APPROVE"。
  - ❌ "§6 没列十年一遇的极端情况，为穷举 REJECT"。
- REJECT 上限：最多 3 条，每条必须具体：指出计划章节 + 要改成什么 + 为什么不改会卡住。凑不够 3 条就只写真实的，不凑数。

## 输出（严格）

第一行必须是 \`VERDICT: APPROVE\` 或 \`VERDICT: REJECT\`（聚合器按 \`/VERDICT:\s*(APPROVE|REJECT)/i\` 解析，其他写法一律无效）。
之后逐条列 findings，每条指向计划具体章节并附证据（章节号 / 原文引用）。
篇幅上限（Oracle 纪律）：每条≤2句，总 findings 不超过 6 条；REJECT 时不超过 3 条。超了就删最不重要的一条。

## 范围纪律（Oracle）

不 redesign、不扩面：只判当前计划能不能执行，不重写方案、不加新需求、不把"更好的做法"当 blocker。拿不准时：要么在 finding 中显式声明假设后继续判，要么只问 1 个精确问题，不连环追问。

## 禁止

- 禁止修改计划文件（只读评审）；禁止执行计划中任何步骤。
- 只输出 VERDICT 与依据，不做其他发挥。
VERDICT 必须引用计划版本号：首行写成 \`VERDICT: APPROVE @ v<版本号>\` 或 \`VERDICT: REJECT @ v<版本号>\`（聚合器仍按 \`/VERDICT:\s*(APPROVE|REJECT)/i\` 解析，版本号仅作引用）；无版本号的 VERDICT 视为无效。
`,
    },
    {
      id: 'sk_builtin_learning_mode',
      name: 'learning-mode',
      description:
        '师徒单步带教：群内触发进入学习模式后先问主题目标完成标准，再单步复述执行汇报等待，每步至多 5 次工具调用，遇错歧义多方案停下问，只认触发者，结束输出新 skill 草案加记忆条目加归档索引。',
      content: `---
name: learning-mode
description: 师徒单步带教：群内触发进入学习模式后先问主题目标完成标准，再单步复述执行汇报等待，每步至多 5 次工具调用，遇错歧义多方案停下问，只认触发者，结束输出新 skill 草案加记忆条目加归档索引。
version: 0.1.0
---

# learning-mode（师徒学习模式）

> 本 skill 适用于挂载了本 skill 的全部 Agent（D2：所有 Agent 均可进入带教态）。
> 软约束声明（D1）：单步 5 次工具调用为 prompt 级软约束，本轮不做硬性计数闸门。

## 1. 触发（Trigger）

- 触发短语：\`进入学习模式\`（群聊消息正文包含该短语即触发，允许前后有称呼或标点）。
- 触发后进入学习态，并在群内用一句话确认，例如：
  \`已进入学习模式，我是你的学生，请告诉我：主题 / 目标 / 完成标准。\`
- 若同时有多人发送触发短语：以第一条触发消息的发送者为老师（见 §6），后触发者按普通消息处理。

## 2. 首动作：必问三要素（First action）

- 进入学习态后的第一个动作必须是提问，不做任何工具调用、不做任何探索。
- 必须问清以下三项才可开始带教：
  1. \`主题\`：这次要学什么（具体任务或知识点）；
  2. \`目标\`：学会后能做到什么（可观察的行为）；
  3. \`完成标准\`：做到什么程度算学会（done-criteria，可验证的判据）。
- 三项缺任何一项都不得进入单步循环；逐项追问，直到三项齐备，并复述确认：
  \`我理解的主题是 X，目标是 Y，完成标准是 Z，对吗？请确认或纠正。\`
- 用户确认后才进入 §3。

## 3. 单步循环（Single-step loop，每步至多 5 次工具调用）

每个用户指令只走一轮以下四步，完成后必须停下等待，不自行进入下一步：

1. \`复述理解（restate-understanding）\`：用 1-3 句话复述本步要做什么以及为什么，不复述不执行。
2. \`执行（execute）\`：执行本步。同一用户指令下工具调用（tool calls）上限为 5 次
   （含 MCP 工具、文件读写、命令执行等一切工具调用，D1 软约束：达到 5 次无论是否做完都必须停下）。
3. \`汇报（report）\`：汇报本步做了什么、结果是什么、还剩什么；若 5 次用满仍未做完，必须如实报告
   \`本步已用满 5 次调用，停在此处，剩余部分请指示。\`并列出已用调用清单。
4. \`等待（wait）\`：明确请求下一步指示，例如 \`请给出下一步指示。\`然后停止输出，等待老师消息。

- 禁止一次用户指令执行多步；禁止“顺手把下一步也做了”。
- 汇报必须与执行结果一致，不编造未执行的结果。

## 4. 停下问（Stop-and-ask）

出现以下任一情况时，必须立即停止执行并提问，不猜测、不二选一自决：

- \`出错\`：工具报错、结果与预期明显不符、前置条件缺失；
- \`歧义\`：指令有多种合理解释、关键参数缺失或模糊；
- \`多方案\`：存在两种以上可行做法且各有代价（必须列出选项 + 各自利弊 + 推荐项，等老师拍板）。

提问格式：\`卡住原因 + 已知信息 + 需要老师决定的问题（尽量给选项）\`。等到老师回复后，从 §3 第 1 步重新开始本步。

- 工具缺失判据（实测教训）：若所需工具不在自己的可用函数列表中，先用 \`my_profile\`
  核对 \`effectivePermission\` 与 \`serverGated\` 名单——在名单但不在函数列表 = 会话启动早于工具上线，
  不得臆断为“被拒绝”；停下问老师（建议老师重启会话或代建），不自行改道。

## 5. 禁止自主探索与后台委托（No autonomous exploration）

- 学习态下禁止自主探索：不得在没有老师明确授权的情况下自行扩大范围、深挖调用链、批量检索或试错。
- 禁止后台委托：不得使用后台任务、子 Agent 委托、并行探索等机制，除非老师在当前学习任务中明确说出
  （如 \`你可以后台去查\` / \`去委托子 Agent\`）。口头授权仅对当步有效，不延续到后续步骤。
- 抽查判据：无明确授权却发生自主探索，即视为违反本 skill。

## 6. 只认触发者（Teacher identity，D3）

- 老师身份 = 触发消息的 \`senderInstanceId\`。学习态全程只认该 ID。
- 只有老师的消息能推进步骤（确认、纠正、下一步指示、结束学习）。
- 非老师（其他 sender）的群消息一律不推进步骤：不执行、不计入确认、不重置等待；
  可简短说明 \`当前在学习模式中，只跟随老师 <senderInstanceId> 的指示。\`然后继续等待老师。
- 老师身份在一次学习任务中不可变更；换老师须先结束当前学习（见 §7），再重新触发。

## 7. 结束与三件套（Closing）

- 老师说 \`结束学习\` / \`学完了\` / 确认已达成完成标准时，进入结算。
- 结算输出必须包含以下三件套草案，并逐项请求确认（不经确认不得调用任何沉淀类工具）：
  1. \`新 skill 草案（new-skill draft）\`：含 \`name\`（小写字母数字中划线分段）、\`description\`、
     \`version\` 及正文要点，标注 \`默认停用、须人审启用\`；
  2. \`记忆条目（memory entries）\`：按条列出拟写入团队记忆的知识点（每条一句话 + 出处步骤）；
  3. \`归档索引（archive index）\`：本次学习涉及的产出物/关键消息索引（标题 + 位置/链接占位）。
- 确认语示例：
  \`以上三件套请确认：可用 / 需修改（请指出条目）。确认后我再走沉淀流程（skill 默认停用+人审）。\`
- 老师确认前不写记忆、不建 skill、不归档；老师要求修改则改后重新确认。
- 入库门（实测教训）：只有老师说出明确的入库指令（如 \`可以入库\` / \`开始沉淀\` / \`调用 skill_create\`）
  才可调用沉淀类工具；\`确认可用\` / \`学会了\` / \`收下了\` 等评价性词语不是入库授权，不得据此写记忆或建 skill。
  每次调用沉淀工具前逐项报备（调什么工具、写什么内容），等老师逐项放行。

## 8. 退出条件

- 老师明确说结束；或三件套已确认交付后，用一句话总结并退出学习态，恢复常规行为。
- 退出后在本会话内不再自称学生，不再沿用单步循环。
`,
    },
  ];

  for (const skill of BUILTIN_SKILLS) {
    await prisma.skill.upsert({
      where: { name: skill.name },
      // L1：重跑不覆盖 enabled——管理员手动停用（enabled=false）后重跑 seed 不得强制启用；
      // 新建行默认启用（create.enabled=true）。
      update: { description: skill.description, content: skill.content },
      create: {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        enabled: true,
      },
    });
  }

  const seedTeamId = 'tm_0000000001';
  const seedTeamName = 'vteam开发团队';
  await prisma.team.upsert({
    where: { id: seedTeamId },
    update: {},
    create: {
      id: seedTeamId,
      name: seedTeamName,
      description: '全局示例团队（e2e）',
      reuseSession: true,
      createdBy: admin.id,
      version: 0,
    },
  });
  const teamRoleMap: Record<string, string> = {
    a_product: 'product',
    a_project_manager: 'project_manager',
    a_architect: 'architect',
    a_developer: 'developer',
    a_tester: 'tester',
    a_plan: 'plan',
    a_librarian: 'librarian',
  };
  const teamRoleLabels: Record<string, string> = {
    product: '产品经理',
    project_manager: '项目经理',
    architect: '架构师',
    developer: '开发者',
    tester: '测试',
    plan: '计划员',
    librarian: '知识管理员',
  };
  function sanitizeWorkDirNameSeed(name: string): string {
    const raw = String(name ?? '').trim();
    return (
      raw
        .replace(/[^\p{L}\p{N}._-]/gu, '-')
        .replace(/^[._-]+|[._-]+$/g, '')
        .replace(/\.{2,}/g, '.') || 'agent'
    );
  }
  const seedMemberAgents = [
    { agentId: 'a_product', name: '产品经理' },
    { agentId: 'a_project_manager', name: '项目经理' },
    { agentId: 'a_architect', name: '架构师' },
    { agentId: 'a_developer', name: '开发者' },
    { agentId: 'a_tester', name: '测试' },
    // 计划员附在末位：非主 Agent，主 Agent 为项目经理（项目经理）。
    { agentId: 'a_plan', name: '计划员' },
    // 知识管理员附于计划员之后：只读问答，同样非主 Agent。
    { agentId: 'a_librarian', name: '知识管理员' },
  ];
  for (let i = 0; i < seedMemberAgents.length; i++) {
    const m = seedMemberAgents[i];
    const id = `tmm_${String(i + 1).padStart(10, '0')}`;
    const role = teamRoleMap[m.agentId] ?? '';
    const alias = `${teamRoleLabels[role] ?? m.name}-1`;
    const workDir = `/data/vteam-worker/${sanitizeWorkDirNameSeed(m.name)}`;
    await prisma.teamMember.upsert({
      where: { id },
      update: {},
      create: {
        id,
        teamId: seedTeamId,
        agentId: m.agentId,
        alias,
        seq: 1,
        workDir,
      },
    });
  }
  // 默认主 Agent 为项目经理（仅未设置时填充，不覆盖用户已改值）。
  const pmIndex = seedMemberAgents.findIndex((m) => m.agentId === 'a_project_manager');
  const pmMemberId = `tmm_${String(pmIndex + 1).padStart(10, '0')}`;
  await prisma.team.updateMany({
    where: { id: seedTeamId, mainAgentMemberId: null },
    data: { mainAgentMemberId: pmMemberId },
  });

  // 种子团队创建者即 owner（team_user_members；create() 同事务行为的种子等价）
  await prisma.teamUserMember.upsert({
    where: { teamId_userId: { teamId: seedTeamId, userId: admin.id } },
    update: {},
    create: {
      id: 'tum_0000000001',
      teamId: seedTeamId,
      userId: admin.id,
      role: 'owner',
      joinedAt: new Date(),
    },
  });

  // 平台初始管理员 admin(u_admin)亦为示例团队 owner，开箱即用可管理演示团队（seed-admin 仍保留 owner）。
  await prisma.teamUserMember.upsert({
    where: { teamId_userId: { teamId: seedTeamId, userId: adminUser.id } },
    update: {},
    create: {
      id: 'tum_admin_seed',
      teamId: seedTeamId,
      userId: adminUser.id,
      role: 'owner',
      joinedAt: new Date(),
    },
  });

  // 团队协作规约 team 记忆（30 篇转正）：示例团队预置一条 team 级记忆，供 librarian 检索作答。
  // 幂等：按固定 id me_team_collab_charter upsert；contentHash 经 computeMemoryContentHash 与 save 语义一致。
  const charterMemoryContent =
    '团队协作规约（全文见 docs/agent-platform/30-团队协作规约.md）。\n' +
    '总则：群聊是工作区；默认点对点，能 @ 单人就不 @all；谁接活谁闭环（做完/做不了/转给谁）。\n' +
    '求助三要素：背景（一句话）+ 要什么（具体交付物）+ 期望（谁、何时）；要素不全先追问，不开工。\n' +
    '转交闭环：责任转移一律落 issue（标题 + 指派到实例 + 验收口径）；格式为事项 + 已有材料 + 期望动作，被转交人须回执；越界拒绝 + 指路不代做；转交链超 3 轮未闭环升级主 Agent。\n' +
    '广播纪律：@all 仅用于全员需知的结论/决策、点名长期不回复者、紧急阻塞；私域问答先问 librarian，再定向问对口角色；无关 @all 不回复，禁 @all 收尾。\n' +
    '超时升级：被 @ 后 10 分钟无回执，发起人再点名一次，仍无响应升级主 Agent 改派或落 issue；失败即报（不伪造成功，核对 team_view 后汇报 + 给替代路径）。\n' +
    '升级路径：成员互助 → 主 Agent 协调 → 落 issue 跟踪 → 提示成员介入，全程留痕。';
  await prisma.memory.upsert({
    where: { id: 'me_team_collab_charter' },
    update: {
      content: charterMemoryContent,
      contentHash: computeMemoryContentHash(charterMemoryContent),
      teamId: seedTeamId,
    },
    create: {
      id: 'me_team_collab_charter',
      level: 'team',
      taskId: null,
      teamId: seedTeamId,
      content: charterMemoryContent,
      contentHash: computeMemoryContentHash(charterMemoryContent),
      description: '团队协作规约：求助三要素/转交落 issue/广播纪律/10 分钟超时升级',
      createdBy: admin.id,
      sourceType: 'system',
    },
  });

  console.log('Seed 完成：');
  console.log(`  - 角色：${adminRole.name} / ${memberRole.name}`);
  console.log(`  - 用户：admin(u_admin) / seed-admin(${admin.id}) / seed-member(u_seed_member)`);
  console.log(`  - 模板 Agent：${templateAgents.map((a) => `${a.name}(${a.role})`).join('、')}（type=template）`);
  console.log(`  - 角色策略：${templateAgents.map((a) => resolvePolicyBinding(a.role).policyId).join('、')}（type=template）`);
  console.log(`  - 内置工具：${builtinTools.map((t) => t.action).join('、')}（source=builtin）`);
  console.log(`  - MCP 工具：${vteamTools.map((t) => t.action).join('、')}（source=mcp，mcpServer=vteam）`);
  console.log(`  - MCP Server：vteam（remote，${platformMcpUrl}）`);
  console.log(`  - 模型目录：${modelRows.length} 个模型（${modelRows.map((m: ModelSeedRow) => m.modelID).join('、')}）`);
  console.log(`  - 示例团队：${seedTeamName}(${seedTeamId}) 含 ${seedMemberAgents.length} 成员（5 角色 + 计划员 + 知识管理员各 1，主 Agent 为产品经理）`);
  console.log(`  - 管理员密码：${ADMIN_PASSWORD}`);
  console.log(`  - 初始 admin 账号：admin / admin123`);
}

// 直接执行（npm run seed）时自动运行；被测试 import 时由测试手动 await main()。
// 双模式判定：CJS（宿主 ts-node 走 tsconfig commonjs / dist 产物）用 require.main；
// ESM（无 tsconfig 环境下 Node ≥22 原生 .ts strip-types 以 ESM 加载，无 require）
// 用 argv[1] 文件名回退。被 import 时 argv[1] 为 jest/prisma 等宿主进程，不触发。
const isDirectRun =
  (typeof require !== 'undefined' && require.main === module) ||
  /(^|[\\/])seed\.(ts|js)$/.test(process.argv[1] ?? '');
if (isDirectRun) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}

export { main };