# repro BEFORE fix (UTC 2026-09-08T00:34:41Z)

## F-A cold start (team has current task, no team session yet)
### probe1 existing team tm_0000000002 @developer tmm_0000000007 (no session)
{"message":{"id":"m_0000000021","channelId":"c_0000000002","senderType":"user","senderId":"u_seed_admin","senderInstanceId":null,"content":{"text":"@dev fa-repro2","parts":[]},"mentions":[{"type":"agent","agentId":"a_developer","instanceId":"tmm_0000000007"}],"attachmentUrl":null,"attachmentName":null,"attachmentType":null,"status":"sent","createdAt":"2026-09-08T00:34:41.794Z"},"triggers":[{"agentId":"a_developer","instanceId":"tmm_0000000007","sessionId":null,"status":"no_session"}]}
HTTP:201

### probe2 fresh team tm_0000000003 already showed m_0000000020 no_session (see repro-fa-fresh.log)

### poll c_0000000002 (only user msgs, no agent reply for fa probes)
m_0000000010:user:@产品经理-1 t2 group ping
m_0000000012:agent:@产品经理-1 t2 group ping 收到，在线。有任务需求请直接下达。
m_0000000016:agent:收到回传确认，消息链路正常。等待任务指令。
m_0000000019:user:@dev fa-probe
m_0000000021:user:@dev fa-repro2

## F-B archived latest task bricks sends
### POST c_0000000004 after t_0000000003 archived
{"code":"TASK_ARCHIVED","message":"归档任务频道不允许发消息"}
HTTP:409

## DB state
id	title	status	team_id
t_0000000001	smoke task su-clean	archived	tm_0000000002
t_0000000002	su-clean-t2	pending	tm_0000000002
t_0000000003	gsf-fb-task	archived	tm_0000000003
id	type	team_id
c_0000000003	private	tm_0000000002
c_0000000002	team_group	tm_0000000002
c_0000000004	team_group	tm_0000000003
id	team_id	team_member_id
s_0000000001	tm_0000000002	tmm_0000000006
id	channel_id	sender_type	LEFT(JSON_EXTRACT(content,'$.text'),60)
m_0000000021	c_0000000002	user	"@dev fa-repro2"
m_0000000020	c_0000000004	user	"@pm cold start probe"
m_0000000019	c_0000000002	user	"@dev fa-probe"
m_0000000016	c_0000000002	agent	"?????????????????????"
m_0000000012	c_0000000002	agent	"@????-1 t2 group ping ?????????????????"
m_0000000010	c_0000000002	user	"@????-1 t2 group ping"
m_0000000009	c_0000000002	system	"--- Task su-clean-t2 started ---"
m_0000000001	c_0000000002	user	"@????-1 smoke ping su-clean"

## git status (dirty worktree pre-existing, must stay untouched except chat.service.ts+spec)
 M .omo/boulder.json
 M .omo/evidence/phase5-t9-playwright.json
 M .omo/notepads/team-centric-session/learnings.md
 M .omo/start-work/ledger.jsonl
 M README.md
 M "docs/agent-platform/02-\347\224\250\346\210\267\344\270\216\345\234\272\346\231\257.md"
 M "docs/agent-platform/03-\345\212\237\350\203\275\351\234\200\346\261\202-\344\273\273\345\212\241\344\270\216\347\276\244\350\201\212\345\215\217\344\275\234.md"
 M "docs/agent-platform/04-\345\212\237\350\203\275\351\234\200\346\261\202-Agent\344\270\216\344\272\247\345\207\272\347\211\251.md"
 M "docs/agent-platform/05-\351\235\236\345\212\237\350\203\275\344\270\216\351\252\214\346\224\266\350\276\271\347\225\214.md"
 M "docs/agent-platform/06-\344\272\244\344\272\222\344\270\216\351\241\265\351\235\242\350\256\276\350\256\241.md"
 M "docs/agent-platform/08-\345\271\263\345\217\260\346\236\266\346\236\204\350\256\276\350\256\241.md"
 M "docs/agent-platform/09-API\350\256\276\350\256\241.md"
 M "docs/agent-platform/10-\347\276\244\350\201\212\344\270\216\346\266\210\346\201\257\346\234\272\345\210\266.md"
 M "docs/agent-platform/13-\344\273\273\345\212\241\347\212\266\346\200\201\346\234\272\344\270\216\345\205\250\347\224\237\345\221\275\345\221\250\346\234\237.md"
 M "docs/agent-platform/16-\345\206\205\347\275\256Agent\350\247\222\350\211\262\344\270\216\346\217\220\347\244\272\350\257\215\345\272\223.md"
 M "docs/agent-platform/17-\344\273\223\345\272\223\346\235\203\351\231\220\344\270\216\345\207\255\350\257\201\346\234\272\345\210\266.md"
 M "docs/agent-platform/18-\346\216\250\350\277\233\350\256\241\345\210\222\357\274\210\345\210\206\351\230\266\346\256\265\345\256\236\346\226\275\357\274\211.md"
 M "docs/agent-platform/28-\345\233\242\351\230\237\346\250\241\345\236\213\344\270\216\346\216\222\351\230\237\350\256\276\350\256\241.md"
 M docs/agent-platform/prototypes/role-permission/index.tsx
 M docs/code-review-2026-08-report.md
 M docs/deployment.md
 M "docs/test-cases/00-\346\200\273\350\247\210\344\270\216\347\264\242\345\274\225.md"
 M "docs/test-cases/01-\350\256\244\350\257\201\344\270\216\347\224\250\346\210\267\350\247\222\350\211\262\347\256\241\347\220\206.md"
 M "docs/test-cases/02-\351\241\271\347\233\256\344\270\216\344\273\273\345\212\241\347\256\241\347\220\206.md"
 M "docs/test-cases/03-\347\276\244\350\201\212\344\270\216\345\256\236\346\227\266\351\200\232\344\277\241.md"
 M "docs/test-cases/04-Agent\344\270\216\346\250\241\345\236\213\347\256\241\347\220\206.md"
 M "docs/test-cases/06-Worker\344\270\216\344\272\247\345\207\272\347\211\251\347\256\241\347\220\206.md"
 M server/README.md
 M server/prisma/schema.prisma
 M server/prisma/seed.ts
