# Learnings — skills-tools-redesign

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---


## F1 MAJOR 修复：enqueueCommand 生产接线（2026-08-08）

- **根因**：T4a 建了 `WorkersService.enqueueCommand(workerId, command)` 命令通道但无生产调用点——skills/tools/mcp-servers 的 POST/PATCH 变更后 worker 不重拉注入（worker 仅启动时 injectAll 一次）。
- **广播方案**：`enqueueCommand` 是精确 workerId 语义（内存 Map，不支持 `'*'` 通配）→ **不改已有逻辑**，在 WorkersService 新增 `broadcastCommand(command): Promise<number>`（非破坏扩展）：`prisma.worker.findMany({ where: { status: { not: OFFLINE } }, select: { id } })` 逐个入队，返回广播数，无在线 worker 静默返回 0。
- **三个资源 service 接线**（skills/tools/mcp-servers）：变更落库成功后 `await this.workersService.broadcastCommand({ type: WORKER_COMMAND_TYPES.RELOAD_CONFIG, resourceVersion: new Date().toISOString() })`——resourceVersion 用 ISO 时间戳（worker 侧据此判断是否需重拉）；失败仅 logger.warn 不阻断主流程（广播是 best-effort，资源变更结果不受影响）。
  - skills：create 落库后 + updateStatus 后（含启/停两个方向）
  - tools：create + update 后；**action 冲突 409 不广播**（变更未落库）
  - mcp-servers：create/update/remove（DELETE 也有）后
- **循环模块依赖**：WorkersModule 已 imports McpServersModule（T8c 心跳 mcpStatus），McpServersModule 再 imports WorkersModule 成环 → **双向 `forwardRef(() => XxxModule)`** + service 构造注入 `@Inject(forwardRef(() => XxxService))`。skills/tools 单向 import WorkersModule 无环。
- **验证**：`tsc --noEmit` ✓；jest **534/534**（524 基线 + 10 新增：broadcastCommand 3 + 三 service 各 2-3）；`nest build` exit 0。
- **测试模式**：spec 中 `workersService = { broadcastCommand: jest.fn().mockResolvedValue(1) }` + `{ provide: WorkersService, useValue: workersService }`；断言 `broadcastCommand` 收到 `{ type: 'reload-config', resourceVersion: expect.any(String) }`；workers.service.spec 用 `jest.spyOn(service, 'enqueueCommand')` 验证逐个入队 + `service['pendingCommands']` 验证空集。



### 改动（仅 web/app/(main)/agents/page.tsx）
- **技能区**：删 `SKILL_POOL` 硬编码（7 个中文名）→ `useQuery GET /skills?enabled=true`（pageSize 100）真实技能库；`skillDrafts` 草稿（挂载时从 `agent.skillIds` 初始化）→ 勾选 toggle → PATCH 提交 `skillIds`（空数组 = 清空，后端 replaceSkills 重建）。
- **工具区**：删启发式推断为主路径 → `useQuery GET /tools?enabled=true` 目录驱动；行集合 = 目录工具（effect 取当前配置或默认 allow）+ 未收录 action（手动添加/停用残留，原 effect）；来源徽章 = 真实 source（builtin/custom/mcp → 内置/自定义/MCP），`inferToolSource` 降级为**兜底**（仅非目录 action）。
- **toolSourceMeta 键变更**：中文键（内置/自定义/MCP）→ 真实 source 枚举键（builtin/custom/mcp），加 `label` 字段展示文案。
- `UpdateAgentPayload` 增加 `skillIds?: string[]`；handleSave 非 template 时提交 `skillIds + toolEffects`（template 只读仍仅 defaultModelId）。

### 目录驱动补入草稿的时序坑
- 工具目录是异步查询：空 agent 挂载时 `toolDrafts = agent.toolEffects`（可能为空）→ catalog 加载完成后必须 **merge 补入**（目录行默认 allow），否则空 agent 工具区显示空态而非目录。
- merge 语义：**只加不删**（`tools.length===0` 时跳过避免覆盖用户快速操作；已存在的 action 不覆盖，用户删除的行不复活）。
- 停用工具残留：admin 停用工具后 GET 过滤 → 目录不含该 action → 行仍显示（toolDrafts 有残留）→ 启发式兜底徽章——符合 T3「停用不级联 agent_tool_effects」设计。

### testid 兼容
- 全部保留：skill-list / data-skill+data-checked（data-skill 由中文名改为真实技能 name）/ tool-permission-* / tool-effect-select / tool-wildcard-row / 新建弹窗全套。
- 新增 skill-empty 空态（技能库无已启用技能或加载中）。

### 验证结果
- `npx tsc --noEmit` exit 0；`npm run build` exit 0；pages project 回归 **15/15**（含 5/17 agent-config 用例）。
- 独立 node 脚本 E2E（chromium + storageState .auth/user.json）：新建 custom agent → 勾选技能（data-checked=true）→ 改工具 effect=ask → 保存 → 页面上下文 fetch 详情验证：`skillIds=["sk_..."]` 落库 ✓、`toolEffects` 6 行（含 git-status=ask）✓、停用工具 jira-query 不可见 ✓、git-status 来源徽章=「内置」✓。测试 agent 已 DELETE 清理。

### 环境/脚本陷阱（新增）
- **系统 node 是 18.15.0**，Playwright 需 ≥20 → 跑 e2e/build 前 `export PATH=/home/keta/.nvm/versions/node/v22.22.1/bin:$PATH`。
- **authStore persist key = `agent-platform-auth`**，token 字段名是 `state.token`（非 accessToken）——页面上下文 fetch 验证落库时按此读取。
- 独立验证脚本必须放 web/ 下（解析 node_modules），/tmp 下跑报 MODULE_NOT_FOUND（承 T6）。
- 3001 dev server 若 500：kill 旧进程后用 **node 22** 重启（18.15.0 直接启动会拒绝）。



## T2 后端 ToolsModule 重构（2026-08-08）

### 端点契约（09 §3.8 对齐）
- POST /tools：**去独立 source 入参**——DTO 移除 source 字段；service 推导 `execution==='mcp' ? 'mcp' : 'custom'`（code/cli/http 全落 custom，builtin 只能走 seed 数据）；schema/initCommand 透传 Json、mcpServer 可空、enabled 缺省 true。
- PATCH /tools/:id：**收敛为仅 {schema?, initCommand?, enabled?}**——name/action/execution/source/mcpServer 全移除（工具名即权限 action FR-48，注册后不改）；action 唯一校验仅保留 POST。
- **删 DELETE 路由**（controller 不再 import Delete；service.remove 方法删除）——实测 `DELETE /api/v1/tools/:id` → 404 Cannot DELETE（09 §3.8 明确工具不提供 DELETE，停用 enabled=false 替代）。
- AdminGuard：POST/PATCH 方法级 `@UseGuards(AdminGuard)`（复用 users/admin.guard.ts，module providers 单独注册）；GET 成员只读不挂守卫。member 实测 POST/PATCH → 403 FORBIDDEN_ADMIN，GET → 200。

### 白名单剥离语义（POST/PATCH 兼容性）
- main.ts 为 `ValidationPipe({ whitelist: true, forbidNonWhitelisted: false })`——**未知字段被剥离而非报错**。POST 带 source / PATCH 带 name 均静默忽略（不 400、不落库）。这给了 T6 前端过渡窗口：旧请求体多余字段无害。

### 并行轨道协作（重要）
- **T3 与 T2 共享 tools 模块文件**：T2 进行中 T3 已在 controller 加了 `findAll(query, viewer)` 成员只读链路（GET 强制 enabled=true 过滤，service 内 `isPlatformAdmin` 复刻 admin.guard 语义，同 T1 skills 模式）——该改动与 T2 契约正交，直接兼容。**spec 必须同步对齐双方签名**：controller.spec 传 `req`、service.spec 补 `prisma.user.findUnique` mock + member/admin viewer 用例。
- 并行会话活跃时勿删除库中他人数据：只清理自己明确创建的行（按 id 前缀/timeline 区分）。

### 验证结果
- `jest --runInBand tools`：20/20（controller 4 + service 16，含 source 推导 4 用例 + viewer 成员只读 3 用例）；全量 516/516；`nest build` exit 0。
- curl 实测（admin）：cli→source=custom / mcp→source=mcp / 带 source:builtin 被剥离仍推导 custom / 重复 action→409 / PATCH {enabled:false}→200 / PATCH 带 name 被剥离 name 不变 / DELETE→404 / PATCH 不存在→404 / GET?source=mcp|builtin 过滤正确 / member POST/PATCH→403、GET 仅可见已启用。
- 测试数据清理：prisma client 脚本 `deleteMany({ where: { id: { in: [...] } } })`（无 mysql 客户端时）。




## T8a MCP 服务器实体（2026-08-08）

### 端点契约
- **09 §3.8 无 mcp-servers 端点**（只有 skills/tools）→ 按 11 篇 §5.8「平台 MCP 配置管理（服务器 CRUD）」做**完整 CRUD 含 DELETE**，而非仿照 tools 砍 DELETE。
- 权限模型沿用 09 §3.8 语义：GET 成员只读；POST/PATCH/DELETE 挂 AdminGuard。实现：**类级不挂 guard，方法级 `@UseGuards(AdminGuard)`** 挂在三个管理端点上。

### schema / 迁移
- `McpServer` 表：id `ms_<seq10>`（域前缀，对齐 15 §2.2）、name @unique、type（local|remote）、command Json?（local）、url String?（remote）、headers Json?、oauth Json?（可存 `false` 表示显式禁用）、enabled default true。
- tools.mcpServer 列**保持字符串弱关联**（存 McpServer.id），不加 relation——与 agent_tool_effects 存 toolAction 字符串的弱关联风格一致；物理删 McpServer 不会级联 tools。
- 迁移：`npx prisma migrate dev --name add_mcp_servers` → `20260808041438_add_mcp_servers`（MySQL 3307 实库已应用）。

### 配置校验（service 层分支校验）
- local：command 必填且 `command.command` 为非空字符串数组（可含 cwd/environment/timeout）。
- remote：url 必填且 `^https?:\/\/.+`。
- **update 用合并后配置校验**：`effectiveType = dto.type ?? existing.type`，command/url 同理——只改 type 或只改 command/url 都会触发正确的分支校验。

### DTO 注意点
- oauth 可传对象或 `false`：用 `@ValidateIf(o => o.oauth !== false) + @IsObject()`，否则 false 会被 IsObject 拒绝。
- url 可传 null 清空（update）：`@ValidateIf(o => o.url !== null && o.url !== undefined)`。
- QueryDto enabled 过滤沿用 tools 的 `@Transform` 字符串→布尔（"true"/"false"）。

### AdminGuard 复用模式
- AdminGuard 依赖 PrismaService（@Global），在 mcp-servers.module providers 注册独立实例即可，无需 import UsersModule。
- **controller.spec 编译时 guard 会实例化**：Test.createTestingModule 需提供 `PrismaService` mock 占位（`{ user: { findUnique: jest.fn() } }`），否则 compile 失败（workers.controller.spec 的 ConfigService mock 同理）。

### 构建现状（并行轨道冲突）
- 当前 HEAD 无 `src/skills/` 目录——T1（SkillsModule 重构）处于并行开发中间状态，`nest build` 报 9 个 TS 错误全部在 skills（skill-frontmatter.util.ts / skills.service.ts / spec），**mcp-servers 零编译错误**。
- 临时 tsconfig exclude src/skills 后 tsc 通过其余全部文件 → 证明 T8a 编译干净。验收 build 需 T1 完成后整体通过。
- 测试基座 sqlite（test/setup-env.js），spec 用 mock prisma 不依赖真实库。

### curl 实测结果（MySQL 实库）
- 登录 admin/admin123 → POST local/remote 均 201；重复 name → 409 `MCP_SERVER_NAME_EXISTS`；local 缺 command → 400 `MCP_SERVER_INVALID_CONFIG`；remote 非法 url → 400（DTO 层拦截）。
- GET 过滤/详情、PATCH enabled=false、DELETE 全部正常；member 角色 POST/PATCH/DELETE → 403 `FORBIDDEN_ADMIN`，GET → 200（成员只读 ✓）。


## T4a 命令通道（server→worker，2026-08-08）

- **pull 模型落地**：心跳响应携带 `commands: WorkerCommand[]`（type='reload-config' + resourceVersion），worker 心跳定时器解析后经 `dispatchCommands` 分派；命令**一次有效**（心跳取出即清空），worker 离线期间入队命令恢复心跳后照常下发。
- **双写类型位置**：WorkerCommand/WorkerCommandType 在 `worker/src/protocol/worker-protocol.ts`（含 `WORKER_COMMAND_TYPES.RELOAD_CONFIG`），server 侧在 `workers.service.ts` 导出同构常量；一致性由 contract.spec.ts 序列化测试守护。
- **回调挂载点**：`worker/src/index.ts` 暴露 `onCommands(handler)`（T4b 注入执行器注册点）+ `dispatchCommands`（默认对 reload-config 打占位日志，未知 type 仅透传不特殊处理——09 §3.9 预留 stop/kill 可扩展）。
- **server 侧入队 API**：`WorkersService.enqueueCommand(workerId, command)`（内存 Map，T1/T2 POST/PATCH 后调用）；未注册 workerId 入队不报错。
- **向后兼容**：无待执行命令时心跳响应**不携带** commands 字段（undefined），旧 worker 解析 `?? []` 不受影响。
- **TS 陷阱**：测试里用未在联合类型中的字面量 type（如 'stop'）需 `as unknown as WorkerCommand[]` 双层断言（直接 `as` 单层会报 TS2352 不够重叠）。
- **测试基线**：server workers 套件 102 通过（新增 4 个 heartbeat commands 用例）；worker 全量 122 通过（新增命令解析/extractCommands/dispatchCommands/契约用例）。


## T5 前端 api.ts FormData + skills 页对齐（2026-08-08）

### api.ts FormData 支持
- `request()` 内 `body instanceof FormData` 判定：跳过 JSON.stringify + `delete finalHeaders["Content-Type"]`（浏览器自动带 `multipart/form-data; boundary=...`，手设 Content-Type 会丢 boundary 导致 400）；Authorization Bearer 不受影响。
- 实测（Playwright 拦截 POST /skills）：content-type 为 `multipart/form-data; boundary=...`、body 含 `name="file"; filename="..."`、文件内容完整、Bearer 保留。
- ⚠️ Playwright 陷阱：`page.getByTestId(...).setInputFiles(file)` 触发的请求在 `route` 拦截点 `postDataBuffer()` **内容为空**（CDP 传输怪癖），而页面内原生 fetch 构造的 FormData 拦截内容完整——验证 multipart body 内容必须用原生 fetch 对照，不能用 setInputFiles。

### skills 页对齐（09 §3.8 契约）
- 上传：POST /skills multipart，FormData `file` 字段携带 SKILL.md（accept 改 `.md,.markdown`；name/description/version 由后端 frontmatter 解析，前端不再发 name/fileMeta）。
- 启停：skill → `PATCH /skills/:id/status {enabled}`；tool 保持 `PATCH /tools/:id {enabled}`（契约保留 enabled）。
- **编辑功能整体移除**：09 §3.8 无编辑端点（skills 无 PATCH /:id；tools 的 PATCH /tools/:id 仅 schema/initCommand/enabled 无 name）→ 删 editMutation/编辑弹窗/四类行编辑按钮。基准 25 testid 不含 edit 相关（testids.ts 已确认），pages.spec 未引用 → 删除安全。

### 成员只读 UI（[admin] 权限）
- 前端判定：`useAuthStore(s => s.user?.roleName === "admin")`——登录响应 AuthUserView 已含 roleId/roleName/enabled，只需扩展 authStore User 接口（可选字段，旧持久化数据缺失 → 视为非 admin 只读）。
- 非 admin：隐藏上传/注册/启停按钮，仅浏览列表。实测 member 登录：upload-skill-button / skill-toggle-button count=0，skill-item 列表可见。

### 环境陷阱
- **`npm run build` 覆盖 .next 会污染 turbopack dev server**（Next.js 15 共用 .next 目录）→ dev server 500，需重启 `next dev --turbopack -p 3001` 恢复。验收顺序：先跑 Playwright 再 build，或 build 后重启 dev。
- e2e 基准：pages.spec skills 用例（skill-item/tool-item/mcp-tool-item 断言）在 seed-admin 登录态通过，无回归。


## T1 后端 SkillsModule 重构（2026-08-08）

### 端点契约（09 §3.8 对齐）
- POST /skills = **multipart/form-data**（FileInterceptor('file') + memoryStorage，limits.fileSize=100KB）；frontmatter 解析后 `content` 落库全文、fileMeta 存元数据、**enabled 固定 false**（默认停用）。
- PATCH /skills/:id/status = {enabled} 启停专用；GET /skills 成员只读强制 enabled=true；**DELETE 路由整体移除**（实测 404 Cannot DELETE）。
- PATCH /skills/:id（非契约端点）一并移除——09 §3.8 只有 status 端点，前端编辑功能已删（T5）。

### schema 迁移
- `content String @default("")` 加列：`npx prisma migrate dev --name add_skill_content` → `20260808041646_add_skill_content`（MySQL 3307 实库已应用，存量行 content='' 零迁移）。

### frontmatter 解析（免依赖手写 YAML 子集）
- 覆盖三种写法：标量 `key: value`（含引号）、块标量 `key: |`（缩进续行）、列表 `- item` / 内联 `[a, b]`；CRLF 兼容。
- **name 校验**：必填 + `^[a-z0-9]+(-[a-z0-9]+)*$`（11 §4.1）+ 长度 ≤64 → 非法抛 400 `SKILL_FRONTMATTER_INVALID`。
- 宽松策略：未知字段忽略、缺省字段 undefined，不因 SKILL.md 额外元数据拒收。
- ⚠️ TS 陷阱：`SkillFrontmatter` 键联合类型（string | string[]）直接索引赋值报 TS2322 → 内部用 `Record<string, string | string[]>`，返回前 `as SkillFrontmatter`。

### AdminGuard / 测试模式
- 模块级：skills.module providers 直接注册 `AdminGuard` 独立实例（依赖 @Global PrismaService），无需 import UsersModule（同 T8a 结论）。
- **controller.spec 编译陷阱**：@UseGuards(AdminGuard) 的类在 Test module compile 时被 Nest 实例化（非请求期）→ 必须 `.overrideGuard(AdminGuard).useValue({canActivate: () => true})`（useValue provider 不够，仍会实例化真实 guard）。
- **同步抛错断言**：controller 的 400 抛错是同步 throw 非 Promise → 用 try/catch 助手读 `exception.getResponse()`（response 是 HttpException getter，`expect.objectContaining`/`toThrow` 都匹配不到）。
- GET 成员只读判定：service 内 `isPlatformAdmin(viewer)` 复刻 admin.guard 语义（permissions.all || users.manage），不重复挂守卫——守卫管"能不能调"，service 管"过滤什么"。

### 验证结果
- `jest --runInBand skills`：32/32 通过（controller 7 + service 13 + util 12）；全量 511/511 通过；`nest build` exit 0。
- curl 实测（admin token）：POST multipart 201 + frontmatter 解析（name/description/version/allowedTools → fileMeta，content 全文）；GET admin 全量 / 成员仅 enabled；PATCH status 生效；member POST → 403 FORBIDDEN_ADMIN；无 file → 400 SKILL_FILE_REQUIRED；非法 frontmatter → 400；同名重传 → 409 SKILL_NAME_EXISTS；DELETE → 404。


## T3 注册→权限命名空间→Agent effect 联动（2026-08-08）

### GET /tools enabled 过滤（成员只读）
- **复用 T1 skills 的 viewer 模式**：controller `findAll(@Query, @Req)` 从 `req.user` 提取 `{id}` 传 service；service 内 `isPlatformAdmin(viewer)` 判定（permissions.all || users.manage，复刻 admin.guard 语义），非 admin 强制 `where.enabled = true`（忽略 query.enabled），admin 遵循 query.enabled（缺省全量）。
- **关键差异**：T1 skills 是先设 `query.enabled` 分支（`viewer && !admin` 时覆盖），T3 tools 更简洁——先构建 where 再 `if (viewer && !admin) where.enabled = true` 直接覆盖。两者等价，但 tools 写法对"query.enabled=undefined 缺省全量 + 成员强制 true"语义更直白。
- viewer 用户不存在/已禁用 → `isPlatformAdmin` 返回 false → 视为非 admin 强制 enabled=true（安全默认）。

### agent_tool_effects 悬空策略（文档化）
- **停用/删除工具不级联 agent_tool_effects**：`agent_tool_effects.tool_action` 存字符串（无 Tool FK，松耦合，通配 action 如 `jenkins-*` 无法 FK），是设计而非缺陷（11 §7.3：停用 `tools: {<tool>: false}`）。
- **worker 侧过滤职责在 T4b**：生成 permission 时过滤 enabled=false 的工具（`tools: {<tool>: false}`），effect 行保留不删——本轮只文档化（类注释 + learnings），不实现 worker 侧生成。
- GET /tools 成员只读强制 enabled=true 使**停用工具在 agent 配置页不可见**（06 §2.8 工具区数据源），与 T7 前端联动闭环。

### 种子内置工具（source=builtin 走 seed）
- seed.ts 新增 6 个 builtin 工具（bash/read/edit/write/grep/glob，对齐 11 §3.1 内置工具集）：`id=tl_builtin_<action>`（语义化 id 前缀，不用 tl_<seq>——seed 数据可预测、可幂等 upsert by action）。
- **upsert key 用 action 而非 id**：action 是业务唯一键（@unique），id 用固定字符串 `tl_builtin_<action>` 保证幂等（重复执行 seed 不产生重复行）。
- **与 onModuleInit 续号的关系**：`findFirst orderBy id desc` 会取到 `tl_builtin_xxx`（字符串排序）→ `parseInt('builtin_bash'.slice(...))` 得 NaN → `Number.isFinite` 跳过续号 → 安全。内置工具 id 不与 tl_<seq> 序号冲突（前缀不同）。
- POST /tools 的 create **不会**与内置工具冲突：execution=mcp→mcp，其余→custom，builtin 不经过 POST 路径；但 action 撞内置工具（如注册 `bash`）仍会 409 TOOL_ACTION_EXISTS（@unique 兜底）。

### 注册→权限命名空间（概念文档化）
- **action @unique 即权限点**（FR-48）：POST /tools 成功即该 action 进入权限命名空间，`agent_tool_effects` 按 toolAction 字符串引用；权限点集合随注册动态扩展、非固定枚举（11 §2 末）。
- 概念已在 tools.service 类注释文档化（T3 MUST DO），无需额外表/代码——**注册→暴露→权限过滤链路中，注册环已在 T2/T3 落地，permission 过滤环留给 T4b**。

### 测试与验证
- `jest --runInBand tools skills`：52/52 通过（tools.service 20 + tools.controller 4 + skills 28），`nest build` exit 0。
- tools.service.spec 新增 3 个成员只读用例：member 强制 enabled=true（忽略 query.enabled=false）、admin permissions.all 遵循 query.enabled、viewer 用户不存在视为非 admin。
- tools.controller.spec 由 T2 并行更新：GET 透传 viewer + AdminGuard override（复用 T8a 结论：@UseGuards 类 compile 即实例化，必须 overrideGuard）。


## T6 前端 tool-register 对齐：去 source 字段（2026-08-08）

### 改动（仅 register 页 2 处）
- **提交体去 source**：`registerMutation` 的 POST /tools body 删除 `source: execType === "mcp" ? "mcp" : "custom"`（:513），保留 name/action/execution/mcpServer/schema/initCommand/enabled——后端 T2 按 execution 推导（mcp→mcp，其余→custom）。
- **头注释同步**：:27「载荷对齐 CreateToolDto」注释去掉 source 并注明推导语义（注释与契约不一致会误导后续维护）。
- 来源徽章：register 页无列表/徽章渲染（纯注册表单），MUST DO 2 跳过；skills 页已有 skill-source pill 模式（T5），T7 处理列表侧。

### 验证
- `npx tsc --noEmit` exit 0；`npm run build` exit 0。
- **端到端实测**（node 脚本 + playwright chromium + storageState .auth/user.json）：POST /tools → **201**；拦截请求体断言**无 source 字段**（name/action/execution/enabled 齐全）；register-feedback data-state="success"。
- pages project 回归 15/15（含 14/17 tool-register 用例，56 testid 基准未动）。

### Playwright 陷阱（新增）
- **project 白名单匹配**：playwright.config.ts 各 project 有 `testMatch: /pages\.spec\.ts/` 等正则——**新建临时 spec 文件不匹配任何 project → "No tests found"**（`t6-register.spec.ts` 静默 0 tests）。临时验证用独立 node 脚本（`require("@playwright/test")` 的 chromium + storageState）最省事，注意脚本须放 web/ 下解析 node_modules。
- 承 T5 教训：先 Playwright 再 build（build 覆盖 .next 污染 dev server）。



## T4b 注入执行器（2026-08-08）

### renderCustomToolFile 泛化（worker/src/resources/custom-tool.ts）
- **git-tools.ts 保留原样**：renderGitToolsFile 的 execute 是高度定制的（`_buildGitArgs` switch 把参数映射为 git 命令），无法无损通用化；泛化落地为**新的通用渲染器 renderCustomToolFile**（git-tools.spec 全绿、部署注入行为不变），DB 工具注入走新渲染器，git 内置工具族保持专属路径——职责分离优于强行统一。
- **def 模型**：`{fileName, exports: [{exportName, description, args, execute}]}`；`exportName === 'default'` 渲染 `export default tool({...})`（工具名 = 文件名），否则 `export const <name>`（工具名 = `<fileName>_<name>`）。
- **execution 分支渲染 execute 体**（任务 MUST DO）：cli→`spawnSync(command, cmdArgs, {encoding:"utf8"})`（boolean 参数→`--<key>`，其余→positional 追加）；http→`fetch(url, {method, headers, body: hasArgs? JSON.stringify(args): undefined})`（非 2xx 抛错）；code→内联原样嵌入。
- **import 按需**：tool() 恒有；仅存在 cli 型才注入 `spawnSync` import；http/code 用 Node18+ 全局 fetch 免 import。
- **缩进**：execute 体相对 `tool()` 内层统一缩进 2 空格（否则生成代码虽可编译但可读性差，spec 断言也依赖缩进后的行）。

### 工具执行细节来源：`schema.x-execution` 约定
- **现状缺口**：09 §3.8 POST /tools 契约无 command/url/code 字段，前端 tool-register 的执行绑定（cliCommand/httpUrl）也未提交后端 → DB 里 execution 的执行细节缺失。
- **约定（非破坏扩展）**：执行细节存输入 schema 的顶层扩展键 `x-execution`（`{command?: string[], url?/method?/headers?, code?}`）。opencode tool() 只认 args schema（properties），顶层 x-execution 会被渲染器忽略——天然安全。
- **缺失策略**：`resolveExecution` 缺执行细节返回 null → injector 跳过注入（未配置完整执行细节的工具不暴露给模型，比注入必然报错的 fallback 干净——本轮实现先 fallback 后改为 skip，fallback 违反「不暴露不可用工具」）。

### 注入器（worker/src/resources/injector.ts）
- **三种注入**：injectSkills（GET /skills?enabled=true → 逐个 GET /skills/:id/content → 写 `.opencode/skills/<name>/SKILL.md`）；injectTools（GET /tools?enabled=true → renderCustomToolFile → 写 `.opencode/tools/<action>.ts`，**mcp 型跳过**留给 T8b）；injectMcp（GET /mcp-servers?enabled=true → 合并写 `opencode.json` 的 mcp 节，保留其他配置节）。
- **鉴权**：拉取带 X-Worker-Token（与注册/心跳同 token），命中 server 新增 WorkerOrJwtGuard。
- **manifest 清理**：`.opencode-worker-inject.json` 记录上次注入的文件/目录名；注入后删除 manifest 中记录但本次不在启用集的（停用资源清理），**只删自己写过的**——git.ts（installGitTools 内置）与用户手动文件不在 manifest 不误删。**陷阱**：manifest 必须在每次注入后更新（含无删除时），否则首次注入的 manifest 永不落盘、停用清理失效。
- **skills 存量数据 content=''**（T1 迁移前行）：注入会写出空 SKILL.md（frontmatter 解析仍可用）。已记录，后续 F3 或迁移回填处理。

### server 双通道鉴权：WorkerOrJwtGuard（worker/src/workers/worker-or-jwt.guard.ts）
- **背景**：skills/tools/mcp-servers 的 GET 端点原仅接受用户 JWT；worker 拉取资源需 X-Worker-Token。
- **实现**：端点挂 `@Public()`（跳过全局 JwtAuthGuard）+ `@UseGuards(WorkerOrJwtGuard)`。守卫二选一：带 X-Worker-Token → timingSafeEqual 比对 WORKER_TOKEN；否则委托 passport 'jwt' 校验（校验结果挂 req.user，skills.service 的 admin 判定继续工作）。
- **关键坑**：不能委托全局 JwtAuthGuard 实例——端点 @Public() 标记会让它直接放行（等于无鉴权）。解法：`new (AuthGuard('jwt'))()`（@nestjs/passport memoize 工厂），passport 策略由 AuthModule 初始化时全局注册，请求期必然可用。
- **@Public() 语义**：GET 端点 @Public() 后全局 JWT 不拦，WorkerOrJwtGuard 兜底两种身份；POST/PATCH 管理端点保持 AdminGuard。
- **spec 陷阱**：三个 controller.spec 都要 `.overrideGuard(WorkerOrJwtGuard)`（同 AdminGuard compile 实例化问题）。

### 接线（worker/src/index.ts）
- **启动前注入**：serveServer.start() 前 `await injector.injectAll()`（失败 warn 不阻断启动，心跳命令可重拉）——serve 启动扫描 .opencode/ 才能看到资源；原启动链 `void serveServer.start().then().catch()` 重构为 async IIFE 包注入+启动。
- **onCommands 回调**：reload-config → `await injector.injectAll()`（只注入不重启，T4c 负责重启）。

### 验证结果
- worker：`tsc --noEmit` ✓、`npm run build` ✓、jest 137/137 ✓（新增 resources 15 个：custom-tool 7 + injector 8）。
- server：`nest build` ✓、jest 516/516 ✓（新增 findContent controller/service 用例 3 个）。
- **集成实测（端口 3100 新实例，避开 3000 并行任务混合进程）**：GET /skills|/tools|/mcp-servers|/skills/:id/content 带 X-Worker-Token 全 200；错误 token → 401 WORKER_TOKEN_INVALID；无 token → 401。
- **opencode 发现实测**：注入器落盘后 `opencode mcp list --pure` 识别注入的 filesystem-demo 服务器并 `connected` ✓（opencode.json mcp 节格式 11 §5.1 验证通过）。skill/tool 的 serve 内发现留 F3 端到端 QA。
- **环境陷阱**：3000/3001 端口被并行任务/旧进程占用，验证须用独立端口新实例，否则 curl 打到旧代码进程产生假失败。


## T8b worker MCP 注入（2026-08-08）

### injectMcp 完整实现（T4b 骨架补全）
- **配置节形状（11 §5.1）**：local → `{type, command, cwd?, environment?, enabled, timeout?}`；remote → `{type, url, headers?, oauth?, enabled}`。**enabled 恒输出 true**（拉取时已过滤 enabled=true，自文档化显式声明全局开关；Oracle 实测不写 enabled 也能 connected，但写全格式更严谨）。
- **remote timeout 缺失**：McpServer 表（T8a）仅 local 有 timeout（command Json 内），remote 无 timeout 字段 → remote 配置节不输出 timeout（数据源无，非遗漏）。
- **停用清理 = manifest 比对（区别于 skills/tools 的删文件）**：opencode.json 的 mcp 节是合并空间，不能整体覆盖（会误删用户手动配置）。实现：保留 mcp 节中 **manifest.mcpServers 未记录过**的条目（用户手动域）→ 移除记录过但本次不在启用集的（停用域）→ 写入/覆盖本次注入 → 更新 manifest.mcpServers。
- **manifest 键扩展**：`InjectManifest` 加 `mcpServers?: string[]`，与 skills/tools 共用同一 `.opencode-worker-inject.json`。

### 集成实测（独立端口 3100 新实例 + 真实 filesystem-demo 数据）
- **注入 → `opencode mcp list --pure`**：识别注入的 filesystem-demo 并 `connected` ✓（--pure 只禁插件不影响配置读取，承 T4b 结论复验通过；用户全局 opencode.json 的 gitee-ent/swagger 与 workDir 配置自动合并显示）。
- **停用清理端到端**：PATCH enabled=false → 注入器再次拉取（enabled=true 过滤得空）→ mcp 节变 `{}`，`mcp list --pure` 中 filesystem-demo 消失（count=0）✓。
- **其他节合并保留实测**：opencode mcp list 期间 opencode 自身向 workDir/opencode.json 写入 `$schema` 节，注入器 readConfig 读到并原样保留（真实场景验证"合并保留其他节"）。
- **⚠️ 复用 workDir 验证坑**：验证脚本每次 `mkdtempSync` 新目录会丢失上次注入状态 → 停用清理验证必须显式复用同一 WD（`WD=... node inject.mjs`）。
- **环境**：3000 端口为并行任务旧代码进程（返回全局 JWT 守卫错误而非 WorkerOrJwtGuard 的 TOKEN_INVALID），必须独立端口新实例；worker dist 产物在 `dist/resources/`（非 `dist/src/resources/`）。

### 验证结果
- worker：`tsc --noEmit` ✓、`npm run build` ✓、jest 153/153 ✓（injector 10 个：新增 local 全字段透传 + 停用清理保留用户手动配置 2 用例；enabled 断言更新 1 处）。


## T4c 重启执行器（2026-08-08）

### OpencodeServer.restart()（stop+start 组合）
- **实现**：`restart()` = `isRunning ? stop() : skip` + `start()`。幂等语义——未运行（从未启动/已停止）直接 start，运行中先 stop（进程组 kill(-pid) 清理）再 start（重新探测端口 + spawn + 健康检查）。start() 内部对 `isRunning && baseUrlValue` 短路返回，restart 先 stop 清状态才能真重启。
- **随机端口变化**：port=0（OS 随机）时 restart 后端口几乎必变 → 调用方必须据 `serveServer.port` 重新组装注册选项（T4c reRegister）。

### 无活跃会话判定 + pending（RestartCoordinator）
- **架构**：`worker/src/restart/restart-coordinator.ts`（新目录）——依赖倒置，restart/reRegister 由 index.ts 注入（不 import server 代码）。`requestRestart(reason)` 返回 `'executed' | 'pending'`；有活跃会话（`getLoad().instances > 0`）→ 标记 pending + warn 日志，归零后 `checkPending()` 自动执行；restart 失败吞错打 error 日志不抛（serve 不可用时心跳上报 degraded，再触发 reload-config 可修复）。
- **会话归零通知**：instance-tracker 新增 `onActiveSessionsIdle(handler)` 单实例回调注册，`trackInstanceEnd` 归零瞬间触发；index.ts 注册 `() => coordinator.checkPending()`。T10 会话执行接线 trackInstanceStart/End 后自动生效（本轮未接 createSession +1，计数恒 0 → 真实运行总是立即重启）。
- **防并发**：`running` 标志位——performRestart 执行期间跳过新请求。

### reload-config 接线顺序（index.ts）
- 命令回调：① `injector.injectAll()`（T4b）→ ② `restartCoordinator.requestRestart()`（判定+执行/挂起）→ pending 时打日志。注入落盘必须先于重启——serve 启动时扫描 .opencode/ 才能看到新配置。
- **注册逻辑重构**：抽出 `buildRegisterOptions(config, port, serveVersion, cliVersion)`（T4c/T6 共用）——重启后新端口重新组装 → capabilities.baseUrl/port 更新；原 IIFE 内联注册块与 `.catch()` 收敛为 `registerCurrent()` 闭包（返回 `RegisterResponse | null`）。
- **重启后重注册失败策略**：`registerWorkerWithRetry` 自带 8 次指数退避，重试耗尽仍失败 → 仅 warn 不退出（serve 已在新端口运行，server 连旧端口报 degraded，可再触发 reload-config 修复）——区别于初始注册失败 exit(1)。

### 测试技巧
- **多子进程 mock**（restart 测试）：`mockedSpawn.mockImplementation` 每次返回新 FakeChild（pid 递增），`killSpy` 按 `-pid` 路由到对应 child——stop 清理第一个、start 拉起第二个，可断言 `kill(-pid)` 与两次 spawn。
- **void 异步触发断言**：`checkPending()` 内部 `void performRestart()` 不 await → 测试须 `await new Promise(setImmediate)` flush 微任务后再断言 restart/reRegister 调用。
- **验证结果**：worker `tsc --noEmit` ✓、`npm run build` ✓、jest 151/151 ✓（新增 14 个：opencode-server restart 3 + restart-coordinator 6 + instance-tracker idle 2 + index buildRegisterOptions 3）。


## T8b worker MCP 注入（2026-08-08）

### injectMcp 完整实现（T4b 骨架 + T8b 补齐）
- **映射对照 11 §5.1**：local → `{type:'local', command[], cwd?, environment?, timeout?}`（timeout 来自 `command.timeout`）；remote → `{type:'remote', url, headers?, oauth?, timeout?}`——**remote 顶层 timeout 由 T8b 补齐**（`McpServerRecord.timeout?`，服务端当前模型未提供该字段，兼容预留：有值才写，无则省略）。
- **enabled 语义**：injectMcp 只拉 `GET /mcp-servers?enabled=true` → 停用服务器根本不进 mcp 节；`buildMcpEntry` 仍写 `entry.enabled = server.enabled !== false`（拉取的恒 true，显式声明对齐 §5.1 格式，防御未来拉取全量）。**不用 `enabled:false` 保留条目**——停用=从配置移除（配合 manifest 清理），语义更干净。
- **mcp 节管理域 = manifest**：`injectMcp` 记录注入的服务器名到 manifest（`mcpServers` 键）；重注入时**保留未在 manifest 中的条目（用户手动配置）**，移除 manifest 记录过但本次不在启用集的条目——避免整体覆盖误删用户手动写的 mcp 配置（区别于最初"整体覆盖 mcp 节"的简化实现）。

### 并行轨道冲突（重要）
- **worker/src/resources/ 目录整体 untracked**（T4b 产物未提交），并行任务直接在磁盘文件上改动 injector.ts：`buildMcpEntry` 加了 `entry.enabled = server.enabled !== false` 引用，但 `McpServerRecord` 接口**没加 enabled 字段** → `tsc` 报 TS2339 `Property 'enabled' does not exist`（2 处）。修复：接口补 `enabled?: boolean`（服务端 Prisma 响应本就有该列）。**教训**：untracked 目录上的并行改动不留 git 痕迹，开工先 `npx tsc --noEmit` 抓编译断裂，再读文件全文确认接口/实现自洽。

### --pure 兼容实测（opencode 1.18.15）
- **项目级 opencode.json 的 mcp 节与全局配置是合并语义**（非覆盖）：注入 filesystem-demo（local）到临时 workDir 的 opencode.json 后，`opencode mcp list --pure` 同时列出全局 gitee-ent/swagger + 注入的 filesystem-demo，三者全 `connected` ✓。
- `--pure` 只禁插件不影响配置读取（复验 Oracle 结论）；`opencode mcp list --pure` 输出剥 ANSI 后 `✓ <name> connected` + 命令/url 可解析。
- **离线验证技巧**：`~/.npm/_npx/<hash>/node_modules/@modelcontextprotocol/server-filesystem` 已在缓存 → 注入 filesystem 命令无需网络下载，`connected` 状态真实可复现。
- 走真实代码路径：tsx 脚本调 `ResourceInjector.injectMcp()`（mock fetch 返回测试服务器）→ 断言生成 opencode.json → cd workDir 跑 `opencode mcp list --pure`。top-level await 在 tsx cjs 下不支持，脚本须包 async IIFE。

### 验证结果
- worker：`tsc --noEmit` ✓、`npm run build` ✓、jest 156/156 ✓（injector.spec 13 个，T8b 新增 3 个：enabled=true 过滤请求断言 + remote timeout 映射 + 配置不完整跳过（local 缺 command[]/remote 缺 url））。
- 实测：`opencode mcp list --pure` 可见注入的 filesystem-demo 且 `connected` ✓（项目级与全局合并语义确认）。

## T8c MCP 三态监控（2026-08-08）

### worker 探测器（mcp-status-probe.ts）
- **输出格式实测（opencode 1.18.15）**：`●  ✓ <name> <ANSI 灰>connected`；失败行 `●  ✗ <name> failed` + 命令详情行（剥 ANSI 后不产出额外条目）。needs_auth 状态词为 `needs auth`/`unauthorized`（OAuth 未授权）；ASCII 环境标记兜底 `v`=成功 / `x`=失败。
- **解析正则**：`^[●•*]?\s*([✓✗!xXvV])\s+([a-zA-Z0-9][a-zA-Z0-9_.-]*)\s+(.+)$`——按行匹配状态行，非状态行（标题/分隔/详情）跳过；状态词含 needs auth/unauthorized → needs_auth，fail/error/disconnected/refus/timeout 或 ✗/! 标记 → failed，其余 → connected。
- **30-60s 节流（Metis 高优补项 7）**：`McpStatusProbe` 默认 30s——`getStatus()` 距上次探测 < throttleMs 返回缓存（同一数组引用），窗口外才 `spawnSync('opencode', ['mcp','list','--pure'])`；10s 心跳下最多每 3 次心跳 spawn 一次。探测抛错保留上次缓存（不阻断心跳链路）。
- **cwd 关键**：`opencode mcp list` 基于 cwd 逐级查找 opencode.json → probe 必须传 `cwd=config.workDir`（注入配置落点），否则读不到平台注入的服务器（集成实测先漏后补）。
- **集成实测**（tsx 走真实代码路径）：临时 workDir 注入 `fs-demo`（npx filesystem）+ `broken-local`（不存在命令）→ probe 探测输出 `fs-demo=connected` / `broken-local=failed` ✓；全局 gitee-ent/swagger 一并列出（合并语义复验）；30s 节流窗口内第二次 getStatus 返回同引用 ✓。

### heartbeat 载荷扩展 + server 内存状态
- **协议双写**：worker-protocol.ts 与 heartbeat-worker.dto.ts 同步加 `mcpStatus?: {serverName, status}[]`（可选，旧 worker/server 互兼容）；worker sendHeartbeat 空数组不携带该键（防旧 server DTO 严格校验 400）。
- **存储方案：内存 Map（免 DB 迁移）**——`McpServersService.applyHeartbeatStatus()` 按 serverName 写 `Map<name, {status, updatedAt}>`，last-update-wins；`findAll/findOne` 经 `withStatus()` 合并返回（未上报 → `status: null`）。单实例语义与 Worker.lastHeartbeatAt 在线判定一致；server 重启后状态清空待下轮心跳重填。**不校验服务器是否在库**——worker 上报的可能是用户全局配置服务器（如 gitee-ent），前端按名展示。
- **模块依赖**：WorkersModule imports McpServersModule（McpServersModule exports McpServersService）——单向无循环；WorkersService 构造器注入 McpServersService，heartbeat 处理 `dto.mcpStatus.length>0` 时写入。
- **集成实测**（独立端口 3101 避开共享 3000）：注册 worker → heartbeat 带三态 → `GET /mcp-servers` 返回 `filesystem-demo=connected / test-bad-remote=failed / oauth-demo=needs_auth` ✓。

### 前端 skills 页 MCP 子 Tab
- **双键索引修复**：`mcpServerMap` 同时按 `s.id` + `s.name` 建索引——`tool.mcpServer` 是**弱关联存 server id（ms_xxx）**，用户注册时也可能直接写 server 名；只按 name 索引会 miss（先漏后补）。toMcpTool 展示 server 名用反查结果，无记录回退原始引用。
- **五态模型**：真实三态 `connected(绿✅)/failed(红❌)/needs_auth(黄🔑)` + 降级态 `disconnected(灰⚠️ 未上报)/connecting(蓝◐ 过渡动画)`；`toFrontendStatus()` 三态透传、null → disconnected。
- **E2E 实测**（Playwright chromium channel=chrome，storageState .auth/user.json）：skills 页 → 工具 Tab → MCP 子 Tab → `mcp-tool-item[data-status]` 与 `mcp-status[data-status]` = `connected` ✓。⚠️ 数据依赖：工具的 mcpServer 引用必须在 mcp_servers 表存在且有上报 status，否则显示 disconnected（数据驱动，非主套件 testMatch）。

### 验证结果
- worker：`tsc --noEmit` ✓、jest 170/170 ✓（mcp-status-probe.spec 12 个 + registry-client mcpStatus 2 个）。
- server：`nest build` ✓、jest 524/524 ✓（workers.service.spec T8c 2 个 + mcp-servers.service.spec T8c 4 个 + worker-dto.spec T8c 2 个）。
- web：`tsc --noEmit` ✓、`next build` ✓（/skills 路由含新逻辑）。
- 全链路集成：worker 探测（真实 opencode 输出）→ heartbeat 上报 → server 内存存储 → GET /mcp-servers 合并 → 前端 MCP 子 Tab 展示三态 ✓。

### ⚠ needs_auth 标记行修正（T8c 补充，2026-08-08）
- **实测发现**：needs_auth 状态行标记是 **`⚠`**（`●  ⚠ oauth-demo needs authentication`），**不是 ✓/✗**——本地 401+WWW-Authenticate 模拟服务器复验确认（opencode 对要求 OAuth 的 remote 返回 `⚠ <name> needs authentication`，对 `needs client registration` 归 needs_auth）。
- **实现修正**：解析正则标记字符类补 `⚠`：`^[●•*]?\s*([✓✗!xXvV⚠])`；否则 needs_auth 行整行被跳过（集成实测先漏后补，oauth-demo 在 heartbeat 载荷中缺失）。
- **spec**：新增「⚠ 标记行亦识别为 needs_auth」用例（mcp-status-probe.spec 现 13 个）。
- **worker jest 终值 171/171**（上述修正后全量重跑）。


## F1 MAJOR 闭环：三 service reload-config 广播 + spec mock 修复（2026-08-08）

### 接线落点（三 service 资源变更后广播）
- **skills.service.ts**：`broadcastReloadConfig()` 在 `create`（:100）与 `updateStatus`（:154）落库成功后调用。
- **tools.service.ts**：`broadcastReloadConfig()` 在 `create`（:123）与 `update`（:150）后调用。
- **mcp-servers.service.ts**：`broadcastReloadConfig()` 在 `create`（:167）、`update`（:212）、`remove`（:225）后调用（mcp 含 DELETE，另两域无）。
- **广播语义 = `WorkersService.broadcastCommand()`（非 enqueueCommand）**：`enqueueCommand(workerId, cmd)`（:205）是精确 workerId 语义不支持通配；`broadcastCommand(cmd)`（:218）查询全部在线 worker（status != offline）逐个入队，返回收到命令数。资源变更影响全部 worker → 必须走 broadcastCommand（**任务描述中的 `enqueueToAll` 名称与实现不符**，实际方法名是 `broadcastCommand`）。离线 worker 跳过（恢复上线后由注册/心跳对齐注入）。
- `WORKER_COMMAND_TYPES.RELOAD_CONFIG` 在 workers.service 导出；命令带 `resourceVersion`（ISO 时间戳）供 worker 侧对比。
- 广播失败仅 warn 不抛（落库已成功，不能因通知失败回滚业务）。

### spec 修复模式（三 service 同构）
- providers 补 `{ provide: WorkersService, useValue: workersService }`，其中 `workersService = { broadcastCommand: jest.fn().mockResolvedValue(1) }`（**只需 broadcastCommand，无需 enqueueCommand/enqueueToAll**）。
- 成功路径补断言 `expect(workersService.broadcastCommand).toHaveBeenCalledWith({ type: 'reload-config', resourceVersion: expect.any(String) })`；校验失败路径（409/400/404）补 `not.toHaveBeenCalled()`。
- mcp-servers 用 `@Inject(forwardRef(() => WorkersService))`，Test module 里按普通 provider 提供 mock 即可（forwardRef 只影响模块图解析，不影响 useValue 注入）。
- **并行轨道教训**：skills.service.spec 先被并行会话修好（运行中文件变动），tools/mcp spec 后修；统一模式是 `broadcastCommand: jest.fn().mockResolvedValue(1)`。

### 验证结果
- server 全量 jest：**38 suites / 532 tests 全绿**（skills.service 18 + tools.service 16 + mcp-servers.service 18 含 broadcast 断言）。
- `nest build`（clean dist）exit 0；`tsc --noEmit` 无输出。
- worker 侧 reload-config 处理链路（injector + restart）T4b/T4c 已就绪，未改动。


## F3-1 修复：Skill.content 列 TEXT 化（2026-08-08）

### 根因与修复（server/prisma/schema.prisma + 迁移）
- **根因**：`Skill.content String @default("")` 无 `@db.Text` → Prisma 生成 `VARCHAR(191)` → 456B SKILL.md 上传落库 500（Data too long）。F3 审计手动 `ALTER TABLE Skill MODIFY content TEXT` 后成功。
- **schema 修复**：`content String @db.Text @default("")`（**保留 @default 以兼容旧行**）。`npx prisma migrate dev --name skill_content_text` → `20260808071700_skill_content_text`。
- **⚠️ MySQL TEXT 默认值陷阱（关键）**：TEXT/BLOB/JSON 列在 MySQL **不允许 DEFAULT 字面量**（错误 1101 `BLOB, TEXT, GEOMETRY or JSON column 'content' can't have a default value`）。并行会话手工写的 `ALTER TABLE skills MODIFY content TEXT NOT NULL DEFAULT ''` 应用时直接失败——**必须让 Prisma 自己生成迁移**，它自动产出 `ALTER TABLE \`skills\` MODIFY \`content\` TEXT NOT NULL;`（丢弃不支持的 DEFAULT，schema 声明保留 @default 不影响）。手工写迁移会踩 1101 坑。
- **失败迁移恢复流程**：`npx prisma migrate resolve --rolled-back <name>` → 删除失败迁移目录 → `npx prisma migrate dev --name skill_content_text` 重新生成并应用（若报 "applied but missing" 需先 resolve 清理）。
- **验证**：`prisma migrate status` = Database schema is up to date；`prisma validate` OK；`npm run build` exit 0；jest skills 套件 37/37 全绿。

### 实证（两级）
- **Prisma client 脚本**：插入 545B content（>191 VARCHAR 上限）→ CREATE OK + READBACK 全等 → DELETE 清理。
- **真实 HTTP 上传**（PORT=3099 独立实例 + admin token + multipart）：624B SKILL.md POST /api/v1/skills → **201**，响应 content 全文（无截断），fileMeta.size=624；DB deleteMany 清理。F3 审计原始失败场景不再复现。

### 环境陷阱
- 系统 node 18.15.0 启动 dist 报 pino 模块错误 → 必须用 `/home/keta/.nvm/versions/node/v22.22.1/bin/node` 启动。
- 并行会话在 3307 MySQL 实库跑着 14:57 启动的 root server（PID 4051367）——验证用独立端口 3099 新实例，勿误杀他人进程。


## F3 MAJOR 修复：cli 型注入工具 spawnSync file 参数数组化（2026-08-08）

### 根因与修复（worker/src/resources/custom-tool.ts renderCliExecute）
- **根因**：T4b 渲染 cli execute 体为 `spawnSync(${JSON.stringify(command)}, cmdArgs, ...)`——`JSON.stringify(['jcli','issue','get'])` 产出数组字面量，node:child_process 的 **file 参数必须为字符串**，运行时必抛 `ERR_INVALID_ARG_TYPE: The "file" argument must be of type string`。F3 实测 jira-query-v2、f3-e2e-cli 两个 cli 型注入工具执行必失败。
- **修复**：拆分为 `spawnSync(fileLiteral, spawnArgs)`——`fileLiteral = JSON.stringify(command[0] ?? '')`（字符串）；`spawnArgs = command.slice(1) 有值 ? [${JSON.stringify(项).join(', ')}, ...cmdArgs] : cmdArgs`（**空命令参数时直接用 cmdArgs，避免生成 `[, ...cmdArgs]` 稀疏数组空位**）。渲染产出 `spawnSync("jcli", ["issue", "get", ...cmdArgs], { encoding: "utf8" })`。
- **不要用 `[...${JSON.stringify(command.slice(1))}, ...cmdArgs]`**：功能正确但渲染成 `[...["issue","get"], ...cmdArgs]` 双展开不干净，且 `command.slice(1)` 为空时是 `[...[], ...cmdArgs]` 无问题但形式难看——用内层数组字面量拼接（`join(', ')`）+ 三元空值降级为 `cmdArgs` 最干净。
- **command 为空数组防御**：`command[0] ?? ''` → file 渲染 `""`（语法合法，运行时抛错属配置错误，不额外兜底）。

### spec 修正（custom-tool.spec.ts + injector.spec.ts）
- **删除错误断言**：`:47` 原断言 `spawnSync(["jcli","issue","get"], cmdArgs, ...)`（断言的就是 BUG 形态）→ 改为断言 `spawnSync("jcli", ["issue", "get", ...cmdArgs], ...)` + 补 `not.toContain('spawnSync(["jcli"')` 防回归。
- **injector.spec.ts:148 同样断言了旧错误格式**（grep spawnSync 发现的第二处）——同步修正。
- **运行时语义测试**（真实执行渲染代码，非字符串断言）：
  - `evalRenderedTool(content)` 辅助：渲染输出过滤 import 行 → `export default tool({` 换 `const __toolDef = tool({` → 追加 `globalThis.__toolDef = __toolDef;` → `vm.createContext` 沙箱（stub `tool` 带 `schema` 命名空间 + **真实 `nodeSpawnSync`**）→ `vm.runInContext`。
  - **vm 沙箱是原生 JS 不转译 TS**：渲染代码里的 `const cmdArgs: string[] = [];` 类型注解需 `.replace('const cmdArgs: string[] = [];', 'const cmdArgs = [];')` 剥离，否则 SyntaxError Missing initializer。
  - `tool` stub 需 `schema.string/number/boolean`（返回链式 `.optional().describe()` 对象）——渲染的 args schema 会在沙箱内求值。
  - **成功用例**：echo 工具（command `['echo','hello']`）+ args `{suffix:'world', loud:true}` → 输出含 `hello`/`world`/`--loud`（命令前缀 + positional + boolean→--flag 全链路真实生效）。
  - **失败用例**：`['node','-e','process.exit(3)']` → `rejects.toThrow(/failed \(exit 3\)/)`（非 0 退出走错误分支）。

### 验证结果
- worker：`tsc --noEmit` ✓、`npm run build` ✓、jest **173/173**（171 基线 + 2 新增运行时语义用例）。
- **文件级 E2E**（tsx 真实加载渲染产物）：渲染 jira-query.ts + echo-hello.ts 到临时 .opencode/tools/（`@opencode-ai/plugin` 用本地 stub 模块提供 `tool`）→ tsx 加载 → `echo.execute({suffix:'world'})` 返回 `"hello world\n"` ✓——**jira-query 渲染的 execute 体已是 `spawnSync("jcli", ["issue", "get", ...cmdArgs], ...)` 正确形态，F3 失败场景不再复现**。


## F3-1 MAJOR 修复：Skill.content 列 VARCHAR(191) → TEXT（2026-08-08）

### 根因与 schema 改动（server/prisma/schema.prisma）
- **根因**：T1 迁移 `20260808041646_add_skill_content` 生成 `content VARCHAR(191) NOT NULL DEFAULT ''`——SKILL.md 全文 >191 字符落库即 500（Data too long）。F3 审计实证 456 字节 SKILL.md 上传 500；手动 `ALTER TABLE ... MODIFY content TEXT` 后成功。
- **修复**：`content String @db.Text`（F3 任务原描述是 `@db.Text @default("")`，**实际落地去掉了 @default**——见下）。
- **⚠️ MySQL TEXT 列禁止字面量默认值**（P3018 / 1101 `BLOB, TEXT, GEOMETRY or JSON column can't have a default value`）：migrate dev 生成 `MODIFY content TEXT NOT NULL DEFAULT ''` 应用必失败。MySQL 8.0.13+ 仅支持表达式默认值 `DEFAULT ('')`，而 Prisma 只能生成字面量 `DEFAULT ''` 形式（无法表达）→ **@default 与 TEXT 在 MySQL 上不可兼得**。去掉 @default 安全性论证：create 路径必传 content（skills.service.ts:95 `content: input.content`，frontmatter 无 content 则 400），存量行在 VARCHAR 阶段已被 `DEFAULT ''` 填充 → 无默认值零风险。注释中已记录该约束避免后人加回 @default。

### 迁移失败恢复流程（migrate dev 卡死处理）
- **失败状态**：migrate dev 应用失败后该迁移在 `_prisma_migrations` 表记为 failed（applied_steps_count=0，DB 结构零变化），后续 migrate dev 报 P3018 "New migrations cannot be applied before the error is recovered from"。
- **恢复步骤**（开发库未部署生产）：
  1. `npx prisma migrate resolve --rolled-back <name>` 标记回滚 → 但**不能删本地迁移目录**（`resolve` 后 migrate dev 仍报 "applied to database but missing from local migrations directory"，因为 rolled-back 记录在表里仍占位）。
  2. 正确姿势：**先从 `_prisma_migrations` DELETE 该记录**（`DELETE WHERE migration_name='<name>'`，tsx + PrismaClient `$executeRawUnsafe`），再删本地目录，最后重新 `migrate dev --name` 生成全新迁移。应用成功验证 `SHOW COLUMNS` Type='text'。
- **迁移产物**：`20260808071700_skill_content_text/migration.sql` = `ALTER TABLE skills MODIFY content TEXT NOT NULL;`（无 DEFAULT）。migrate status = "Database schema is up to date!"。

### 验证结果
- server 全量 jest：**38 suites / 534 tests 全绿**（基线一致，skills.service.spec 18/18）。
- `nest build`（clean dist）exit 0。
- **实证**（tsx + PrismaClient，MySQL 3307 实库）：插入 563 字节 content（>191）→ upsert/findUnique/delete roundtrip 成功，len=563 原文无损，测试行已清理——VARCHAR(191) 时代必 500 的场景不再复现。
