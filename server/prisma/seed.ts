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
  // prompt 为平台维护的「出厂默认提示词」（16 篇 §8.4 模板提示词随平台版本升级）：四方向结构
  // （职责/权限/工作方式/协同方式），并针对新功能收敛——issue 管理（issue_create/list/transition）、
  // git 仓库（clone/pull 只读授权、push 需 write+确认）、vteam MCP 工具。
  const templateAgents = [
    {
      id: 'a_product',
      name: '产品经理',
      role: 'product',
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
  // 其余字段（defaultModelId/name/permissionScope 等）保持 update:{} 语义——不覆盖用户已改配置，
  // defaultModelId 模板默认值仅首次 create 时生效。
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

  // vteam 的 MCP 工具（阶段 2）：注册 tools 表 source=mcp 行，
  // 前端「技能与工具」页 MCP 工具子 Tab 按 source=mcp 过滤渲染。
  // action 为 platform-mcp 端点 tools/list 的 tool 名（命名 <server>_<action>），
  // source=mcp + execution=mcp + mcpServer 对齐 tools.service 的 source 推导逻辑。
  const vteamTools = [
    { action: 'chat_history', name: 'vteam_chat_history', description: '查询任务群聊历史（按需拉取）' },
    { action: 'doclib', name: 'vteam_doclib', description: '查询任务产出物文档库' },
    { action: 'task_context', name: 'vteam_task_context', description: '查询任务概览与团队' },
    { action: 'group_post', name: 'vteam_group_post', description: '向任务群聊发布消息' },
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