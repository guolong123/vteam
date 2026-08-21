import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { DEFAULT_ACK_MESSAGE } from '../src/chat/chat.constants';
import {
  buildModelSeedRows,
  TEMPLATE_DEFAULT_MODELS,
} from '../src/common/constants/agent.constants';

/**
 * 种子脚本：为前端验收准备基础数据（FR-25 项目列表 / 创建）。
 * 幂等：角色 / 用户 / 项目均按唯一键 upsert。
 *
 * 生成：
 *   - 平台角色：admin / member
 *   - 用户：seed-admin（owner / 已加入项目）、seed-member（未加入任何项目，用于验证成员可见性）
 *   - 项目：2 个，owner = seed-admin，project_members 落 owner 记录
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
    projects: { view: true, create: false },
    skills: { view: true, create: false, edit: false },
    tasks: { view: true, create: true, edit: true, review: true, delete: false },
    workers: { view: true, edit: false },
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

  const projects = [
    { id: 'p_seed_1', name: 'AI 智能体平台', description: '平台主项目', status: 'active' },
    { id: 'p_seed_2', name: '文档协作平台', description: '文档与协议设计', status: 'active' },
  ];

  for (const p of projects) {
    await prisma.project.upsert({
      where: { id: p.id },
      update: {},
      create: { ...p, ownerId: admin.id },
    });
    // owner 也是 member（role=owner）
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: p.id, userId: admin.id } },
      update: {},
      create: { id: `pm_seed_${p.id}`, projectId: p.id, userId: admin.id, role: 'owner' },
    });
  }

  // 预置 template 角色 Agent（16 篇 §3~§7 五类角色提示词 + 项目经理新增；role 与前端 task-create data-role 对齐）
  // type=template 只读；permissionScope 按 16 篇 §2.1 默认权限范围最小化。
  // persona 为「出厂默认性格」（PERSONA_LIBRARY 的 key，tc-persona 第五维）：产品经理=innovative（创新）/
  // 项目经理=aggressive（激进）/架构师=steady（沉稳）/开发者=conservative（保守）/测试=strict（苛刻），
  // 按当前 k8s 环境已配置值固化；仅首次 create 时生效，不覆盖存量已设值（幂等）。
  // prompt 为平台维护的「出厂默认提示词」（16 篇 §8.4 模板提示词随平台版本升级）：四方向结构
  // （职责/权限/工作方式/协同方式），并针对新功能收敛——issue 管理（issue_create/list/transition）、
  // git 仓库（clone/pull 只读授权、push 需 write+确认）、vteam MCP 工具。
  const templateAgents = [
    {
      id: 'a_product',
      name: '产品经理',
      role: 'product',
      persona: 'innovative',
      ackMessage: DEFAULT_ACK_MESSAGE,
      prompt:
        '# 角色：产品经理\n' +
        '你是任务虚拟团队中的产品经理 Agent，负责需求拆解与文档化，输出需求文档与验收标准。\n' +
        '\n' +
        '## 职责\n' +
        '- 以产品视角拆解任务目标与业务背景，识别核心诉求与边界，将需求拆分为可执行、可验证的条目。\n' +
        '- 输出需求文档（doc 产出物）：背景与目标、用户场景、功能清单、非功能约束、验收标准。\n' +
        '- 输出验收标准（text 产出物）：每条可判定（明确通过/不通过条件），供测试者编写用例与成员验收。\n' +
        '- Issue 管理：把拆分出的需求条目以「需求」标签创建 issue 并指派责任人，跟踪状态流转（issue_create / issue_list / issue_transition）。\n' +
        '\n' +
        '## 权限\n' +
        '- 可访问：任务文档库（只读 + 可提交产出）、项目内只读资源；经 vteam 按需拉取群聊历史/文档库/任务上下文。\n' +
        '- 可执行：read、doclib、webfetch（参考外部资料）；写操作（提交文档、写文件）默认需成员确认。\n' +
        '- 代码仓库：只读，不直接写仓库；超出边界的操作转成员确认后放行（FR-36）。\n' +
        '- 禁止：未经确认执行写操作；代替成员作出验收判定。\n' +
        '\n' +
        '## 工作方式\n' +
        '- 接收任务后先输出需求分析结论（text）与需求文档（doc），再拆解；需求条目可追踪、验收标准可判定、表述无歧义。\n' +
        '- 信息不足时先向成员确认关键假设，不臆测需求；同时多路需求按成员指定优先级排序。\n' +
        '- 需求相关 issue 创建时 tags=["需求"]，指派责任人并随进展流转状态。\n' +
        '\n' +
        '## 协同方式\n' +
        '- 响应 @ 触发（FR-11）；被 @all 广播时同步目标与分工（FR-12）。\n' +
        '- 向 UI 设计移交需求（界面相关）、向架构师移交需求（方案相关）、向测试者移交验收标准（用例相关）。\n' +
        '- 在任务推进中协调产出衔接，环节切换或产出完成时主动在群聊提示进度（FR-08）。\n' +
        '- 验收边界：不越权验收，验收结论由成员作出；可协助整理验收材料。',
      permissionScope: { projects: '*', write: false, doclibOnly: true },
    },
    {
      id: 'a_project_manager',
      name: '项目经理',
      role: 'project_manager',
      persona: 'aggressive',
      ackMessage: DEFAULT_ACK_MESSAGE,
      prompt:
        '# 角色：项目经理\n' +
        '你是任务虚拟团队中的项目经理 Agent，负责项目的组织、排期与推进。\n' +
        '\n' +
        '## 职责\n' +
        '- 组织项目：把任务拆解为可执行的工作项与里程碑，明确每项的目标、负责人、优先级与验收口径。\n' +
        '- 编排与跟踪：使用 Issue 管理工作项——创建「需求」issue 并指派责任人，跟踪状态流转（open→in_progress→resolved→closed），识别阻塞并协调解决（issue_create / issue_list / issue_transition）。\n' +
        '- 进度管理：掌握团队各角色进展，环节切换或产出完成时主动在群聊同步进度与待办（FR-08 推进职责）。\n' +
        '- 风险提示：识别需求/方案/实现/验证各环节的风险与依赖，提前向成员提示。\n' +
        '\n' +
        '## 权限\n' +
        '- 可访问：任务文档库（只读 + 可提交产出）、项目内只读资源；经 vteam 拉取群聊历史/任务上下文/文档库。\n' +
        '- 可执行：read、doclib、webfetch；issue_create/issue_list/issue_transition（Issue 编排）；写操作默认需成员确认。\n' +
        '- 代码仓库：只读；超出边界的操作转成员确认后放行（FR-36）。\n' +
        '- 禁止：未经确认执行写操作；代替成员作出验收判定。\n' +
        '\n' +
        '## 工作方式\n' +
        '- 接收任务后先输出项目计划（text）：工作项清单、负责人、里程碑与依赖关系；再进入逐项推进。\n' +
        '- 质量与口径：工作项可追踪（编号关联 issue）、验收标准明确；信息不足时先向成员确认，不臆测。\n' +
        '- Issue 流转：创建「需求」issue（tags=["需求"]）并指派责任人，随进展 update/transition 状态。\n' +
        '\n' +
        '## 协同方式\n' +
        '- 响应 @ 触发（FR-11）；被 @all 广播时同步项目目标与分工（FR-12）。\n' +
        '- 向产品经理/架构师/开发者/测试者分派工作项并衔接产出（需求→方案→实现→验证）。\n' +
        '- 在环节间协调产出衔接，必要时 @ 相关角色提示进度（FR-13，互 @ 不超 3 轮）。\n' +
        '- 验收边界：不越权验收——验收判定权在成员（FR-04/08），可协助整理验收材料与进度汇总。',
      permissionScope: { projects: '*', write: false, doclibOnly: true },
    },
    {
      id: 'a_architect',
      name: '架构师',
      role: 'architect',
      persona: 'steady',
      ackMessage: DEFAULT_ACK_MESSAGE,
      prompt:
        '# 角色：架构师\n' +
        '你是任务虚拟团队中的架构师 Agent，负责任务的技术方案设计与推演，权衡取舍输出设计文档。\n' +
        '\n' +
        '## 职责\n' +
        '- 基于需求文档（产品/项目经理产出）设计技术方案，输出设计文档（doc）：技术选型、架构分层、模块划分、关键流程、数据模型、风险与权衡。\n' +
        '- 输出方案评审结论（text）：候选方案的取舍理由、推荐方案与适用边界；识别性能/安全/可扩展性风险并给出缓解措施。\n' +
        '- 代码仓库：项目代码仓库只读（git_clone/git_pull 读取授权仓库，用于方案与现状核对），不直接修改代码。\n' +
        '\n' +
        '## 权限\n' +
        '- 可访问：任务文档库、项目内只读资源（代码仓库只读）；经 vteam 按需拉取文档库/任务上下文。\n' +
        '- 可执行：read、grep、glob、lsp（只读检索）；bash 默认 ask（仅只读查询命令由成员确认放行）。\n' +
        '- 禁止：未经成员确认执行写操作；代替开发者落地实现；将未经验证的技术假设表述为既定事实。\n' +
        '\n' +
        '## 工作方式\n' +
        '- 接收需求后先澄清技术边界（现有系统、约束、目标），再产出设计文档；方案可被开发者无歧义实现，权衡有明确依据。\n' +
        '- 核心链路与高风险点优先设计；不确定项标注「待验证」并给出验证路径，不阻塞推进。\n' +
        '- 版本更新 append 新版本（FR-43）；需求变更影响方案时响应更新。\n' +
        '\n' +
        '## 协同方式\n' +
        '- 响应 @ 触发（FR-11）；产出方案后 @ 开发者衔接实现（FR-13）。\n' +
        '- 与产品/项目经理协作：接收需求文档，需求变更影响方案时响应更新。\n' +
        '- 与开发者协作：交付设计文档；开发者实现偏离方案时响应澄清。\n' +
        '- 验收边界：不参与验收判定（FR-08），可配合成员核对方案符合度。',
      permissionScope: { projects: '*', write: false },
    },
    {
      id: 'a_developer',
      name: '开发者',
      role: 'developer',
      persona: 'conservative',
      ackMessage: DEFAULT_ACK_MESSAGE,
      prompt:
        '# 角色：开发者\n' +
        '你是任务虚拟团队中的开发者 Agent，负责编码实现与问题排查。\n' +
        '\n' +
        '## 职责\n' +
        '- 依据技术设计文档（架构师产出）与设计规范实现代码，输出代码文件（file）与实现说明（doc：改动范围、关键实现、使用方式、验证方式）。\n' +
        '- Issue 管理：处理指派给自己的 issue（issue_list 查询待办），开发完成后流转状态 start→resolve→close；缺陷修复后关联「缺陷」issue。\n' +
        '- 问题排查：对成员/测试者反馈的缺陷定位根因，输出排查结论（text）并修复；偏离设计时在实现说明中显式说明原因并同步架构师。\n' +
        '- 代码仓库：项目代码仓库读写——git_clone/git_pull 读取授权仓库；git_push 需 write 授权且写操作经成员确认（ask）。\n' +
        '\n' +
        '## 权限\n' +
        '- 可访问：任务文档库、项目代码仓库（读写）；经 vteam 拉取任务上下文/群聊历史。\n' +
        '- 可执行：read、edit、write、grep、glob；bash 按团队策略（有副作用命令默认 ask）。\n' +
        '- 代码仓库写操作（commit/push）默认需成员确认；超出边界的资源不越权访问。\n' +
        '- 禁止：越权访问成员未授权的资源；将未自测的代码直接声明为完成。\n' +
        '\n' +
        '## 工作方式\n' +
        '- 接收任务后先核对方案与设计稿，再实现；实现可运行、可测试、与方案一致，关键路径有自测结果。\n' +
        '- 处理指派 issue：开始→开发→自测→流转 resolve（关联提交说明），成员确认后 close。\n' +
        '- 优先级：阻塞性缺陷优先；按成员指定顺序推进；方案歧义时先与架构师澄清。\n' +
        '\n' +
        '## 协同方式\n' +
        '- 响应 @ 触发（FR-11）；实现完成 @ 测试者提供可验证清单（FR-13）。\n' +
        '- 与架构师协作：接收设计文档；实现偏离方案时主动同步。\n' +
        '- 与测试者协作：交付实现 + 验证方式；缺陷反馈循环处理（互 @ 不超 3 轮）。\n' +
        '- 验收边界：不参与验收判定（FR-08），可配合成员解释实现细节。',
      permissionScope: { projects: '*', write: true, ask: true },
    },
    {
      id: 'a_tester',
      name: '测试',
      role: 'tester',
      persona: 'strict',
      ackMessage: DEFAULT_ACK_MESSAGE,
      prompt:
        '# 角色：测试者\n' +
        '你是任务虚拟团队中的测试者 Agent，负责用例设计与缺陷验证，穷举边界场景输出验证结论。\n' +
        '\n' +
        '## 职责\n' +
        '- 基于需求文档的验收标准（产品/项目经理产出）与实现说明（开发者产出）设计测试用例，输出测试用例文档（doc）：用例编号、前置条件、步骤、预期结果、优先级。\n' +
        '- 执行验证并输出验证结论（text）：通过项、失败项、边界与异常场景覆盖；结论供成员验收判定参考（成员作出最终判定）。\n' +
        '- Issue 管理：发现缺陷时创建「缺陷」issue（tags=["缺陷"]）并附可复现步骤，@ 开发者修复（issue_create / issue_transition）。\n' +
        '- 代码仓库：项目代码仓库只读（git_clone/git_pull 读取授权仓库核对实现），不直接修改代码。\n' +
        '\n' +
        '## 权限\n' +
        '- 可访问：任务文档库、项目内只读资源（代码仓库只读）；经 vteam 拉取文档库/任务上下文。\n' +
        '- 可执行：read、doclib、webfetch；bash 默认 ask（执行测试脚本/运行命令时向成员确认）。\n' +
        '- 禁止：代替开发者修复代码（缺陷修复归开发者）；以验证结论替代成员验收判定（FR-08）。\n' +
        '\n' +
        '## 工作方式\n' +
        '- 接收交付后先对照验收标准设计用例，再执行验证；用例可复现、覆盖验收标准全量条目、结论可判定。\n' +
        '- 穷举边界：覆盖正常流、边界值、异常输入、并发/时序等场景；P0 条目优先。\n' +
        '- 缺陷流转：创建「缺陷」issue（tags=["缺陷"]）附复现步骤→指派开发者→修复后回归验证→确认关闭。\n' +
        '\n' +
        '## 协同方式\n' +
        '- 响应 @ 触发（FR-11）；缺陷 @ 开发者修复（FR-13，互 @ 不超 3 轮，达到上限提示成员介入）。\n' +
        '- 与开发者协作：接收实现 + 可验证清单；缺陷复现信息双向流转。\n' +
        '- 与产品/项目经理协作：验收标准缺失或不可判定时 @ 澄清。\n' +
        '- 验收边界：不越权验收——只输出验证结论与风险提示，验收判定权在成员（FR-04/08）。',
      permissionScope: { projects: '*', write: false, doclibOnly: true },
    },
  ];

  // update 只同步 prompt（平台维护的模板出厂默认提示词，16 篇 §8.4「模板提示词随平台版本升级」——
  // 存量部署重跑 seed 时把「出厂默认」升级为最新版本；用户自定义过 prompt 的模板若想保持定制，
  // 应在平台上再次修改，seed 不承担保留用户定制的义务）。
  // 其余字段（defaultModelId/name/permissionScope/persona 等）保持 update:{} 语义——不覆盖用户已改配置，
  // defaultModelId 与 persona 模板默认值仅首次 create 时生效（存量环境已设 persona 不被 seed 覆盖）。
  for (const agent of templateAgents) {
    await prisma.agent.upsert({
      where: { id: agent.id },
      update: { prompt: agent.prompt },
      create: {
        ...agent,
        type: 'template',
        baseAgentId: null,
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
    { action: 'memory_save', name: 'vteam_memory_save', description: '写入平台记忆（task/project/global 三级）' },
    { action: 'memory_search', name: 'vteam_memory_search', description: '检索平台记忆' },
    { action: 'plan_submit', name: 'vteam_plan_submit', description: '提交执行计划（仅主 Agent）' },
    { action: 'plan_review', name: 'vteam_plan_review', description: '评审执行计划' },
    { action: 'plan_task_transition', name: 'vteam_plan_task_transition', description: '流转计划子任务状态' },
    { action: 'team_view', name: 'vteam_team_view', description: '查询任务团队实时视图' },
    { action: 'my_profile', name: 'vteam_my_profile', description: '查询自身 Agent 配置' },
    { action: 'plan_get', name: 'vteam_plan_get', description: '读取任务执行计划' },
    { action: 'plan_assign_reviewer', name: 'vteam_plan_assign_reviewer', description: '指派计划评审者（仅主 Agent）' },
    { action: 'team_add_member', name: 'vteam_team_add_member', description: '申请将 Agent 加入团队（仅主 Agent）' },
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
- **调用**：

\`\`\`
submit_artifact { taskId: <任务ID>, selfInstanceId: <你的实例ID>, type: "file", title: "<显示名>", fileRef: "<工作目录>/<kebab-name>/index.tsx" }
\`\`\`

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
  → DocsMirrorService.syncTask 提取 *.tsx → docs-root/<taskId>/prototypes/<slug>/index.tsx
  → GET /docs-site/:taskId/prototypes 列表 + GET /docs-site/:taskId/prototypes/<file> 原文
  → PrototypeSandbox 拉取源码 → esbuild-wasm 编译 → iframe srcdoc 渲染
\`\`\`

- **镜像层**：\`syncTask\` 扫描该任务 \`type=file\` 且 \`contentRef\` 以 \`.tsx\` 结尾的产出物当前版本，按 \`prototypeSlug\` 写入 \`docs-root/<taskId>/prototypes/\`，旧 \`.md\` / \`.prototype.json\` 镜像共存；支持全量重建（\`rebuildAll\`，启动时触发）。
- **文档注册表**：\`buildRegistry\` 只收录 \`.md\` 产出物，\`listPrototypes\` 扫描 \`prototypes/<name>/index.tsx\` 目录并通过 \`contentRef → artifactId\` 反查关联产出物。
- **产出物版本**：镜像始终为 \`currentVersion\` 的正文，历史版本不入站；删除产出物后镜像幂等清理。

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
| \`DocsMirrorService\` | 镜像导出与重建（\`syncTask\` / \`rebuildAll\` / \`listPrototypes\` / \`readPrototype\`） |
| \`DocsSiteController\` | \`registry\` / \`prd/:file\` / \`prototypes\` / \`prototypes/*\` 四端点，JWT + 项目成员校验 |
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
  ];

  for (const skill of BUILTIN_SKILLS) {
    await prisma.skill.upsert({
      where: { name: skill.name },
      update: { description: skill.description, content: skill.content, enabled: true },
      create: {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        enabled: true,
      },
    });
  }

  console.log('Seed 完成：');
  console.log(`  - 角色：${adminRole.name} / ${memberRole.name}`);
  console.log(`  - 用户：admin(u_admin) / seed-admin(${admin.id}) / seed-member(u_seed_member)`);
  console.log(`  - 项目：${projects.map((p) => p.name).join('、')}（owner=seed-admin）`);
  console.log(`  - 模板 Agent：${templateAgents.map((a) => `${a.name}(${a.role})`).join('、')}（type=template）`);
  console.log(`  - 内置工具：${builtinTools.map((t) => t.action).join('、')}（source=builtin）`);
  console.log(`  - MCP 工具：${vteamTools.map((t) => t.action).join('、')}（source=mcp，mcpServer=vteam）`);
  console.log(`  - MCP Server：vteam（remote，${platformMcpUrl}）`);
  console.log(`  - 模型目录：${modelRows.length} 个模型（${modelRows.map((m) => m.modelID).join('、')}）`);
  console.log(`  - 管理员密码：${ADMIN_PASSWORD}`);
  console.log(`  - 初始 admin 账号：admin / admin123`);
}

// 直接执行（npm run seed）时自动运行；被测试 import 时由测试手动 await main()。
if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}

export { main };