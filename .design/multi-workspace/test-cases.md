# 多工作空间隔离 · 测试用例设计（v1）

> 目标：验证「空间 = 租户」在多用户场景下的隔离性——数据不可见、不可改、不可越权访问，
> 平台资源只读共享，管理员跨空间只读与资源迁移受控。
>
> 自动化位置：
> - API 级：`web/e2e/workspace-isolation.api.spec.ts`（基础链路）、
>   `web/e2e/workspace-isolation.resources.api.spec.ts`（资源/详情/列表隔离矩阵）
> - UI 级：`web/e2e/workspace-ui.spec.ts`（浏览器）
> - 单元级：`server/src/common/tenant/*.spec.ts`、`workers.service.spec.ts` 等
>
> 运行方式（需后端已迁移+seed；默认 compose 测试栈 `13200`）：
> ```bash
> cd web
> WORKSPACE_API_BASE=http://127.0.0.1:13200/api/v1 npx playwright test --config=playwright.api.config.ts
> WORKSPACE_API_BASE=http://127.0.0.1:13200/api/v1 WORKSPACE_WEB_BASE=http://127.0.0.1:13201 \
>   npx playwright test --config=playwright.workspace-ui.config.ts
> ```

## 0. 测试账号与前置

| 账号 | 密码 | 角色 | 说明 |
|---|---|---|---|
| admin | admin123 | 平台管理员（permissions.all） | 可建空间/邀请/迁移/跨空间只读 |
| seed-admin | Admin@123456 | 平台管理员 | 备选管理员 |
| seed-member | Admin@123456 | 普通成员 | 用于越权/隔离断言 |

前置数据：两个普通空间 W（admin 创建）、M（seed-member 创建），各自建团队/资源；系统空间 `ws_system` 含内置模板。

---

## 1. 空间与账号（WS）

| ID | 用例 | 步骤 | 预期 | 自动化 |
|---|---|---|---|---|
| WS-01 | 登录返回当前空间与空间列表 | 登录 admin | `user.currentWorkspaceId` 非空；`workspaces[]` 至少含默认空间 + 系统空间（isSystem=true） | API/UI |
| WS-02 | 空间列表只返回「我加入的 + 系统空间」 | seed-member 列出空间（未加入 admin 的 W） | 列表不含 W；只含自己加入的空间 + `ws_system` | API |
| WS-03 | 非成员不能切到他人空间 | seed-member `POST /auth/workspace {W}` | 403 | API |
| WS-04 | 成员被邀请后可切/可读 | admin 邀请 seed-member 进 W → 成员切 W 并读团队 | 切换成功；能看到 W 的团队 | API |
| WS-05 | 被移除后立即失去访问 | admin 移除 seed-member → 成员再切/带 header 访问 W | 403 | API |
| WS-06 | 管理员跨空间只读：读 200 / 写 403 | admin 用 `X-Workspace-Id: M` 读团队、建团队 | 读 200 且能看到 M 团队；写 403 `TENANT_CROSS_WORKSPACE_WRITE_FORBIDDEN` | API |
| WS-07 | 普通用户伪造 `X-Workspace-Id` | seed-member 带 `X-Workspace-Id: W`（非成员） | 403 `WORKSPACE_FORBIDDEN` | API |

## 2. 资源隔离 · 列表（RES-L）

| ID | 用例 | 步骤 | 预期 | 自动化 |
|---|---|---|---|---|
| RES-L01 | 团队列表隔离 | W/M 各建团队，分别列出 | 各自只看到本空间团队 | API |
| RES-L02 | 同名团队可跨空间共存 | W、M 各建同名团队 `同名-<ts>` | 均 201；各自列表各自一条 | API |
| RES-L03 | 同空间唯一键冲突 | W 内重复团队名 | 409 `TEAM_NAME_CONFLICT` | API |
| RES-L04 | Agent 列表隔离 | W 建自定义 Agent；分别列出 | W 可见；M 不可见（但系统模板空间 M 也可见） | API |
| RES-L05 | 成员库（数字员工）隔离 | 默认空间列表 vs W 空间列表 | 新的 W 空间成员数为 0（默认空间有存量成员），互不串 | API |
| RES-L06 | Worker 列表隔离 | 默认空间（有 w_ws_test）vs W 空间（无 worker） | 默认空间可见节点；W 空间列表为空（不泄露他人 worker） | API |
| RES-L07 | 技能/工具/模型目录：平台资源共享、自建不共享 | W 列表 vs M 列表 | 系统空间的技能/工具/模型目录在两边都可见（只读）；W 自建资源 M 不可见 | API |

## 3. 资源隔离 · 按 ID 直接访问（RES-D，水平越权）

| ID | 用例 | 步骤 | 预期 | 自动化 |
|---|---|---|---|---|
| RES-D01 | 跨空间团队详情 | M 用户 `GET /teams/{W团队id}` | 403（非团队成员） | API |
| RES-D02 | 跨空间团队改名/删除 | M 用户 `PATCH/DELETE /teams/{W团队id}` | 403；W 团队名称未变 | API |
| RES-D03 | 跨空间 Agent 详情 | M 用户 `GET /agents/{W自建Agent id}` | 404（按不存在处理，不泄露存在性） | API |
| RES-D04 | 跨空间 Agent 编辑/克隆 | M 用户 `PATCH /agents/{id}`、`POST /agents/{id}/clone` | 404；W 的 Agent 未被修改 | API |
| RES-D05 | 跨空间技能内容 | M 用户 `GET /skills/{W自建技能id}/content` | 404/403 | API（若可造数据） |
| RES-D06 | 跨空间任务/产出物 | M 用户 `GET /tasks/{W任务id}`、`GET /artifacts/{W产出物id}` | 403/404 | API |

## 4. 文件与上传（FILE）

| ID | 用例 | 步骤 | 预期 | 自动化 |
|---|---|---|---|---|
| FILE-01 | 上传 URL 带空间段 | W 空间上传文件 | `url` 形如 `/uploads/workspaces/<W>/<uuid>__<name>`，静态可访问 | API |
| FILE-02 | 带他人 taskId 归档被拒 | M 上传时带 W 任务 id | 403/404，不落归档 | API（M0 已覆盖） |
| FILE-03 | 跨空间读取 uploads（MCP/控件面） | M 请求 W 空间文件引用 | 403 `UPLOAD_WORKSPACE_MISMATCH`（静态 UUID URL 除外，见已知边界） | 单元 |

## 5. 凭据（CRED）

| ID | 用例 | 步骤 | 预期 | 自动化 |
|---|---|---|---|---|
| CRED-01 | Provider key 空间内唯一、跨空间不可见 | W/M 各自配置同名 provider（若开放 API） | 各自生效互不影响；列表不暴露 key | 单元/后续 |
| CRED-02 | 凭据只下发本空间 worker | W 配 key；检查默认空间 worker auth.json | W 的 key 不出现在其它空间 worker 上 | 单元（dispatch 收敛） |
| CRED-03 | A 改 key 不影响 B | W 改/吊销 key，M 模型可用性不变 | 互不影响 | 单元/后续 |

## 6. 运行时（RUN）

| ID | 用例 | 步骤 | 预期 | 自动化 |
|---|---|---|---|---|
| RUN-01 | 事件回流在 worker 空间上下文执行 | worker 事件 ingress | 会话/消息写入落 worker 所属空间 | 单元 |
| RUN-02 | SSE 连接只收本空间事件 | A/B 各连 `/events?scope=all`，A 触发事件 | B 连接收不到 A 的事件 | 单元（subscribe/getEventsSince 空间过滤） |
| RUN-03 | 工作目录空间化 | 非默认空间任务/团队 | 目录含 `workspaces/<ws>/`；默认空间保持旧路径 | 单元 |
| RUN-04 | 唯一读兜底（findUnique 跨空间） | 直接按 id 查他空间行 | 返回 null（按不存在） | 单元 |

## 7. 共享与资源迁移（SHARE）

| ID | 用例 | 步骤 | 预期 | 自动化 |
|---|---|---|---|---|
| SHARE-01 | 迁移到系统空间 = 发布共享 | admin 把 W 的自定义 Agent 迁到 `ws_system` | 201 `moved=true`；M 空间列表可见该 Agent | API |
| SHARE-02 | 从系统空间回收 | 再迁回 W | 201；M 不再可见 | API |
| SHARE-03 | 迁移唯一键冲突 | W、M 各有同 agentKey Agent；把 W 的迁到 M | 409 `WORKSPACE_RELOCATE_CONFLICT` | API |
| SHARE-04 | 有跨空间引用时拒绝回收 | 目标空间资源仍被引用 | 409 `WORKSPACE_RELOCATE_IN_USE`（单元覆盖引用矩阵） | 单元 |
| SHARE-05 | 非管理员不能迁移 | seed-member 调用迁移 | 403 | API |
| SHARE-06 | 迁移审计可查且仅管理员 | admin 查审计；member 查 | admin 200 且含记录；member 403 | API |
| SHARE-07 | 业务数据不可迁移 | 迁移 `team` / `task` | 400 `WORKSPACE_RELOCATE_UNSUPPORTED` | API |

## 8. 前端（UI）

| ID | 用例 | 步骤 | 预期 | 自动化 |
|---|---|---|---|---|
| UI-01 | 顶栏空间切换器 | 管理员登录 /workspaces | 下拉列出可切换空间；切换后当前空间值变化 | UI |
| UI-02 | 跨空间只读横幅 | 点「管理员只读查看」 | 黄色只读横幅出现/文案含「只读」；退出后消失 | UI |
| UI-03 | 普通成员权限收敛 | seed-member 打开 /workspaces | 页面可用；无管理员迁移面板 | UI |

## 9. 已知边界（当前实现接受，不计失败）

1. `/uploads/*` 静态服务当前不鉴权（UUID 文件名 + 空间路径）；签名 URL/鉴权列为后续增强。
2. 平台共享 worker（系统空间）上的跨空间文件仍可能通过 workDir/tmp 读取；per-worker 密钥/空间白名单为后续增强。
3. 管理员跨空间只读仅覆盖「读」；SSE 连接绑定 token 当前空间（切换空间会重连），不提供跨空间实时事件。
4. 共享池方案未采用（每空间 worker 起步）；共享节点凭据派发校验为后续增强。

## 10. 执行记录（2026-11-12，compose 测试栈 13200/13201）

| 套件 | 用例数 | 结果 |
|---|---|---|
| API 基础链路（`workspace-isolation.api.spec.ts`） | 1 | ✅ passed |
| API 隔离矩阵（`workspace-isolation.resources.api.spec.ts`） | 16 | ✅ passed |
| 浏览器 UI（`workspace-ui.spec.ts`） | 3 | ✅ passed |
| server 单元/集成（`jest --runInBand`） | 222 suites / 5057 tests | ✅ 5056 passed（1 skipped） |

覆盖状态：
- ✅ WS-02/03/04/05/06/07；RES-L01/02/03/04/05/06/07；RES-D01/D02/D03/D04；FILE-01；SHARE-01/02/03/05/06/07。
- ✅ 单元覆盖：RUN-01（事件回流空间上下文）、RUN-02（SSE 订阅/补拉空间过滤）、RUN-03（工作目录空间化）、RUN-04（findUnique 越权行兜底）、FILE-03（跨空间读 uploads）、SHARE-04（跨空间引用阻断）。
- ⏳ 待补：RES-D05（技能内容按 id）、RES-D06（任务/产出物按 id）、CRED-01/02/03（凭据下发端到端）、RUN-02 的双连接浏览器级验证。

### 第十五轮：真实页面 CRUD 验收（2026-11-13）

- 新增浏览器用例 `workspace-crud.ui.spec.ts` 10 条：角色、技能、消息/通知渠道、MCP Server、
  Git 凭证+仓库、成员、Agent、Provider、Agent 岗位、团队，全部走页面新建/编辑/删除。
- 发现并修复：MCP 自动同步失败导致技能/工具页整页错误态（有缓存时应保留列表）。
- 结果：页面 CRUD 10 passed；UI 合计 13、功能 8、API 44、server 5091。

### 第十四轮：平台资源 CRUD 全面体检（2026-11-13）

- 新增两个 API 套件共 18 条：平台资源 10 条 + 空间内资源 8 条，均在独立新空间执行。
- 覆盖资源：角色/岗位/Agent/执行策略/Provider+模型/技能/工具/MCP/Worker/上传/
  空间与成员/用户/团队与成员/Git 凭证与仓库/消息与通知渠道/任务/问题/私聊/记忆边界。
- 结果：API 44 passed、功能验收 8 passed、UI 3 passed、server 5091 passed；
  报告 `test-report-crud.md`。
- 无新增产品缺陷；仓库创建 500 的修复已在上一轮完成。

### 第十三轮：仓库创建复合唯一键回归（2026-11-13）

- 缺陷：多空间后 GitRepo 唯一键改 `(workspaceId,repoUrl)`，create 仍 `findUnique({repoUrl})` → 500。
- 修复：`tenantUniqueWhere('GitRepo', { repoUrl })`。
- 回归：API `GIT-REPO-01`（创建 201 / 同空间重复 409 / 跨空间同 URL 可建）；UI 创建仓库成功（截图 31）。

### 第十二轮：用户编辑所属空间（2026-11-13）

- 后端：`PATCH /users/:id` 支持 `workspaceIds`（全量集合，增删成员关系）+ `currentWorkspaceId`；
  owner 空间不可移除、当前空间须在集合内；列表返回 `lastWorkspaceId`/`workspaceMembers`。
- 单测：users.service 27 passed（空间同步/owner 拦截/非法当前空间）。
- API：`USER-SPACE-PATCH-01`（加入+切换当前空间 → 重新登录验证 → 移除成员关系 → 非法入参）。
- 浏览器：功能验收第 8 条路径——编辑用户勾选空间、切换当前空间、保存后重新登录校验（截图 29）。

### 第十一轮：第二批资源所属空间（2026-11-13）

- 岗位列表（/agents 角色 Tab）显示平台共享徽章；集成渠道页创建入口显示创建目标空间。
- 后端：AgentRoleDto/MemoryItem 补 workspaceId；渠道行本身已含。
- 浏览器：功能验收第 7 条路径通过（截图 27/28）。

### 第十轮：平台资源所属空间展示（2026-11-13）

- 浏览器：功能验收第 6 条路径——Provider 行显示「当前空间」、技能行显示「平台共享」，
  创建入口显示「创建到：<当前空间>」；截图 25/26。
- 后端：Worker/Provider/Agent/Git 仓库列表返回 workspaceId；前端统一 SpaceBadge/CreateSpaceHint。

### 第九轮：正常产品流程（建团队/成员 → 群聊 → 真实回复，2026-11-13）

- 按页面流程建团队（按岗位新建）→ 设置成员模型 → 团队群聊发消息 → Agent 群聊回复「收到」。
- 回归用例：`TEAM-MEMBER-01`（新空间按岗位建团队自动建成员、重名自动序号不 500）。
- 修复：team 成员重名查询、控制面按 worker 令牌派发（dispatch_token_ref）、worker 资源拉取
  接受空间令牌（含 skills 路由租户上下文）。

### 第八轮：真实模型端到端（qwen3.8-27b，2026-11-13）

- 单令牌安装 worker → 配置 OpenAI 兼容 provider（192.168.10.10:18020/v1）+ 凭据 → 下发到节点 →
  真实调用 `qwen3.8-27b` 返回 `pong`；默认空间节点未串入该 provider/凭据。
- 详见 `test-report-qwen-e2e.md`；截图 25/26。

### 第七轮：单令牌安装（空间注册令牌）（2026-11-13）

- 浏览器：第 5 条路径改为「安装命令只带一个 token」——`X_WORKER_TOKEN=wst_...` /
  `--token wst_...`，命令中不再出现 `WORKSPACE_ID` / `WORKER_JOIN_TOKEN`（curl、docker 两种方式）。
- API：`TOKEN-SINGLE-01`——仅用空间令牌注册（无空间参数）→ 归属反查正确 → 同一令牌心跳鉴权 →
  用其它空间令牌操作该 worker → 403 `WORKER_SPACE_MISMATCH`。
- 单测：WorkerTokenGuard 空间令牌解析/归属校验/首注册放行；register 空间令牌覆盖归属。

### 第五轮：真实 worker 安装 · 凭据隔离（2026-11-13）

- 两个真实 worker 容器分别注册 A/B 空间（加入码），验证 `auth.json` 空间隔离、
  同 provider 不同 key、B 独有 provider 不串、轮换/吊销只影响本空间、worker 列表跨空间不可见。
- 详见 `test-report-worker-credentials.md`。结论：CRED-01/02/03 由「单元/设计覆盖」升级为**真实安装验证**。

### 第四轮：平台管理员 vs 空间管理员

- API：`ROLE-01`（平台角色 member + 空间角色 admin 的用户：可建团队/管理本空间 MCP；
  不能列全部空间、账号管理、迁移、跨空间 header）；`MCP-ISO-01`（JWT 通道与 worker 通道
  的 MCP 列表都只返回本空间 + 系统空间）。
- 浏览器：功能验收第 4 条路径「空间管理员：可管本空间，但没有跨空间/平台级入口」，
  含 `/system/users` 被重定向（截图 19/20/21）。
- 单测：WorkspaceAdminGuard 6 例、PermissionGuard 空间管理员兜底 3 例、
  三处控制器守卫元数据契约同步更新。
- 修复：硬刷新后登录态水合 TDZ（路由守卫失效）。

### 第三轮：创建用户支持选择空间

- API：`USER-WS-01`（管理员建用户并选空间 → 新用户登录当前空间=所选空间、空间列表含该空间、可读该空间团队；平台空间不可加入）。
- 浏览器：功能验收第 3 条路径「管理员：新增用户时可选择工作空间」（截图 17/18）。
- 单测：users.service 新增 4 例（事务内建成员+lastWorkspaceId、空间角色、空间不存在、平台空间拒绝）。

### 第二轮：已知问题修复后的新增自动化

- API：JOIN-01（worker 加入码签发/拒绝/通过 + 落空间）、UPLOAD-SIGN-01（签名 URL 200 / 无签名 403 / 篡改 403），共 19 例全绿。
- 单测：join token（workers 注册 4 例 + workspaces 签发 3 例）、platform 权限点守卫 2 例、上传签名 3 例、迁移后凭据隔离 1 例。
- 浏览器：切换器改为可搜索面板、只读态写入口置灰（`10-管理员-只读态新建团队置灰.png` / `11-管理员-只读态创建页提示.png`）。

### 用户视角功能验收（真实浏览器页面操作）

见 `.design/multi-workspace/test-report-ui.md`：2 条端到端用户路径（管理员/普通成员）全部通过，
15 张逐步截图存于 `.design/multi-workspace/shots/functional/`。走查发现并修复 8 个用户可感知问题
（管理员无法浏览他人空间、只读横幅布局错乱、只读视图刷新丢失、创建后看不到新空间、
操作反馈不可见、当前空间不直观、角色中英混杂、徽章重复等）。

### 本轮测试发现并修复的隔离缺口

1. **Worker 列表跨空间泄露**：`workers.service.findAll()` 走原生 SQL 绕过 Prisma 中间件 → 已按 `workspace_id IN (本空间, ws_system)` 显式过滤（无上下文保持内部全量语义）。
2. **按 id 的详情读取跨空间**：`findUnique` 无法在 where 注入空间条件 → 中间件新增 `guardUniqueReadResult` 返回值兜底：用户态模型只允许本空间、平台模型允许本空间/系统空间，越权行按「不存在」返回 null（读取 Agent 等详情时表现为 404）；写入路径因服务层先读后写同样被拦。
3. **成员会话状态 500**：遗留的 `tenantUniqueWhere('Session', {memberKey})` 与「memberKey 保持全局唯一」的最终 schema 不一致 → 改回单键查询（首次创建成员即暴露的回归）。
