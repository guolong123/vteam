import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

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

  const memberRole = await prisma.role.upsert({
    where: { name: 'member' },
    update: {},
    create: {
      id: 'r_member',
      name: 'member',
      permissions: { all: false },
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

  // 预置 4 类 template 角色 Agent（14 篇 §4.1 四类模板；role 与前端 task-create data-role 对齐）
  // type=template 只读；permissionScope 按 §4.1 默认权限范围最小化
  const templateAgents = [
    {
      id: 'a_product',
      name: '产品经理',
      role: 'product',
      prompt:
        '以产品经理视角拆解需求：整理业务背景、拆解用户故事，输出需求文档与验收标准。默认项目内只读 + 文档库读写。',
      permissionScope: { projects: '*', write: false, doclibOnly: true },
    },
    {
      id: 'a_architect',
      name: '架构师',
      role: 'architect',
      prompt:
        '负责技术方案设计与推演：权衡取舍，输出设计文档与关键决策记录。默认项目内只读。',
      permissionScope: { projects: '*', write: false },
    },
    {
      id: 'a_developer',
      name: '开发者',
      role: 'developer',
      prompt:
        '负责编码实现与问题排查：编写实现代码并给出说明。默认项目读写，写操作需成员确认。',
      permissionScope: { projects: '*', write: true, ask: true },
    },
    {
      id: 'a_tester',
      name: '测试',
      role: 'tester',
      prompt:
        '负责用例设计与缺陷验证：穷举边界场景，输出验证结论与缺陷报告。默认项目内只读 + 文档库读写。',
      permissionScope: { projects: '*', write: false, doclibOnly: true },
    },
  ];

  for (const agent of templateAgents) {
    await prisma.agent.upsert({
      where: { id: agent.id },
      update: {},
      create: {
        ...agent,
        type: 'template',
        baseAgentId: null,
        defaultModelId: null,
        createdBy: adminUser.id,
      },
    });
  }

  console.log('Seed 完成：');
  console.log(`  - 角色：${adminRole.name} / ${memberRole.name}`);
  console.log(`  - 用户：admin(u_admin) / seed-admin(${admin.id}) / seed-member(u_seed_member)`);
  console.log(`  - 项目：${projects.map((p) => p.name).join('、')}（owner=seed-admin）`);
  console.log(`  - 模板 Agent：${templateAgents.map((a) => `${a.name}(${a.role})`).join('、')}（type=template）`);
  console.log(`  - 管理员密码：${ADMIN_PASSWORD}`);
  console.log(`  - 初始 admin 账号：admin / admin123`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());