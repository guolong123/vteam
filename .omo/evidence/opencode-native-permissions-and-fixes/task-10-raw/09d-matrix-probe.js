const { PrismaClient } = require('@prisma/client');
const { ExecutionPolicyService } = require('/app/dist/src/execution-policies/execution-policy.service.js');
const { PlatformToolPermissionService } = require('/app/dist/src/platform-mcp/platform-tool-permission.service.js');
(async () => {
  const prisma = new PrismaClient();
  const ps = Object.create(ExecutionPolicyService.prototype); ps.prisma = prisma;
  const gate = new PlatformToolPermissionService(prisma, ps);
  const members = await prisma.teamMember.findMany({ where: { teamId: 'tm_0000000001' }, select: { id: true, agent: { select: { agentKey: true } } } });
  const out = [];
  for (const m of members) {
    const tools = ['my_profile','task_transition','group_post','memory_save'];
    for (const t of tools) {
      try { await gate.assertToolAllowed(m.id, t); out.push({member:m.id,agent:m.agent.agentKey,tool:t,decision:'allow'}); }
      catch(e){ const r=e.getResponse?e.getResponse():{}; out.push({member:m.id,agent:m.agent.agentKey,tool:t,decision:'deny',code:String(r.message||'').match(/PLATFORM_MCP_[A-Z_]+/)?.[0]}); }
    }
  }
  process.stdout.write(JSON.stringify(out,null,1));
  await prisma.$disconnect();
})();
