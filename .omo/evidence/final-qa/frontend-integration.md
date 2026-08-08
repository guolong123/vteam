# F3 Manual QA — B. Frontend & C. Integration Results

Date: 2026-08-07 | Web: http://localhost:3001 | Login: admin/admin123

## B. Frontend (Playwright)

| # | Scenario | Result | Evidence |
|---|----------|--------|----------|
| B1 | Login page → admin login → /projects | PASS | Login form (账号/密码 data-testid=username/password/login-button) rendered; login → redirected /projects; 2 project cards (文档协作平台, AI 智能体平台) each with 产出物 button. Screenshot: f3-b1-login-projects.png |
| B2 | /agents: agent-list-item ×4, selected template readonly, clone-template-button | PASS | agent-list-item ×6 (4 templates 产品经理/架构师/开发者/测试 + 2 clones), agent-readonly-badge ×1 (selected 产品经理 shows 模板/只读), clone-template-button ×1. Screenshot: f3-b2-agents.png |
| B3 | /users: user-stats + user-item render | PASS | user-stats ×1 (总用户3 管理员2 成员1 已禁用0), user-item ×3 with role/status badges. Screenshot: f3-b3-users.png |
| B4 | /roles: permission-matrix + Dock 7 items incl 角色权限 | PASS | permission-matrix ×1, role-item ×2; nav-item ×7 = 项目/Agent 管理/Worker 节点/技能与工具/消息中心/用户管理/角色权限. Screenshot: f3-b4-roles.png |
| B5 | /artifacts?pid=p_seed_1: 3 filters + list with acceptance badge + row expand version viewer | PASS | artifacts-filter-bar (task-filter-select + type-filter-option×4 + accepted-filter-option×3), artifact-row ×5 with artifact-accepted-badge (已验收/未验收); clicking row expands artifact-viewer + artifact-version-switch + artifact-version-timeline. Screenshot: f3-b5-artifacts.png |
| B6 | /board?pid=p_seed_1 产出物 button → /artifacts?pid=p_seed_1 | PASS | Clicked 产出物 on board → URL became /artifacts?pid=p_seed_1 |
| B7 | console 0 errors | PASS | After login: 0 errors. Only 4 pre-login 401 (expired token in localStorage from earlier session — expected auth behavior, not a defect) |

**B Summary: 7/7 PASS**

Environment note: web dev server on :3001 had corrupted .next (leftover pages/_app build-manifest ENOENT) at session start → restarted `npm run dev` with clean .next → /login 200.

## C. Integration (M3 闭环)

| Step | Action | Result |
|------|--------|--------|
| 1 | POST /agents/a_product/clone → a_0000000002 (type=clone, baseAgentId=a_product) | PASS |
| 2 | POST /projects/p_seed_1/tasks {agentIds:[a_0000000002], mainAgentId:a_0000000002} → t_0000000005, status=pending | PASS |
| 3 | POST /tasks/t_0000000005/start → in_progress | PASS |
| 4 | POST /tasks/t_0000000005/artifacts {type:doc, fileRef} → art_0000000008 v1 archived | PASS |
| 5 | Browser /artifacts?pid=p_seed_1 → new row F3 集成产出-需求说明 (未验收) visible | PASS |
| 6 | POST mark-pending-review → 201; POST accept → 201 status=completed; GET artifacts acceptedFlag=true | PASS |
| 7 | Browser /artifacts?pid=p_seed_1 → badge updated 已验收 | PASS |

**C Summary: 7/7 PASS** — Screenshot: f3-c-integration-artifacts.png

Edge cases additionally verified (beyond spec):
- doc/file type requires fileRef → 400 ARTIFACT_INVALID_DECLARATION (valid guard)
- type=bogus → 400 (A7)
- template PATCH → 403; builtin role PATCH → 403 (A2/A6)
- accepted artifact re-append (same title) → 409 ARTIFACT_ACCEPTED_IMMUTABLE (A4)
