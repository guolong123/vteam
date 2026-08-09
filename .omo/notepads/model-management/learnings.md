# Learnings — model-management

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## E2: OBS-009 可观测性——模型调用失败快速报错（step-finish reason=error，2026-08-09，实现 + 测试完成）

- **根因（已探索确认）**：`findFinish`（worker-dispatcher.ts:75-88）只认 assistant 消息的 `step-finish(reason=stop)`；模型调用失败（无真实凭据 → 401/error）时 serve 产出 `step-finish(reason=error)`（或 error part）→ findFinish 不匹配 → 自持轮询静默等到 `DISPATCH_TIMEOUT_MS=120s` 才报错。QA 实测用户等 35s 无回复且无任何错误提示。
- **修复（两处）**：
  1. **新增导出 `findError(messages)`**：与 findFinish 同款遍历（仅 assistant 消息），命中 `step-finish(reason=error)` 或 `type==='error'` part 即返回错误文案——`p.error?.message` 优先，回退 `p.text`，再回退兜底常量 `MODEL_FAILURE_FALLBACK_MESSAGE`。`PollMessageShape.parts[].error?: {name, message}` 新增字段（serve error part 形状）。
  2. **`pollForCompletion` 轮询循环内**（findFinish 检测之前）对 `fresh`（cursor 之后新消息）做 `findError`——命中 → 立即 `clearPendingWatchdog` + `failedSessions.add` + `emitError({error: 'agent 处理失败：<serve 错误>'}）` + `broadcastAgentError({level:'retry', errorType:'model_error'})` + return（不等 120s）。
- **⚠️ 竞态坑（测试发现）**：poll 首轮可能在 `startPendingWatchdog` 注册**之前**就快速失败（`void this.pollForCompletion()` 在 dispatch 尾部 watchdog 注册前并发执行）——此时 `clearPendingWatchdog` 扑空，watchdog 照常注册并在 120s 二次 emitError。**修复：`startPendingWatchdog` 开头加守卫 `if (this.failedSessions.has(sessionId)) return;`**（dispatch 已在 promptAsync 后重置 failedSessions，守卫只拦截本轮 poll 已快速失败的场景）。两条时序都被覆盖：poll 先失败（守卫跳过注册）或 watchdog 先注册（clearPendingWatchdog 清除）。
- **保留语义**：正常完成（reason=stop）路径不变；120s 超时仍为兜底（serve 无响应/挂起）；快速失败后 failedSessions 标记 → 迟到回流（ingress/轮询 task.completed）跳过落库防双写。
- **测试**：`findError` 单测（error.message 命中 / error part 命中 / 回退 text / user 不算 / stop 不算 / 无错误 undefined）+ 2 个集成用例（step-finish error 快速 fail 且 advance 120s 无双报错 + error part 命中且迟到回流跳过落库）。**验证**：server `nest build` 通过 + jest **44 suites / 705 tests 全绿**（基线 702 + 新增 3）。
- **经验**：快速失败路径的「清除型守卫」（clearPendingWatchdog）与「注册前守卫」（startPendingWatchdog 的 failedSessions 检查）需成对实现——异步 void 并发路径上，清理时机可能晚于注册时机，只做清理不够。

---

## E1: 修复「用户管理编辑按钮完全失效」（ISSUE-002，2026-08-09，实现 + 浏览器实证完成）

- **根因（一行注释）**：`web/app/(main)/users/page.tsx` 文件头注释 :25 明写「编辑按钮：后端无 PATCH /users/:id → 保留原型占位（**无 onClick**）」——编辑按钮是纯占位，无 onClick、无弹窗、无请求。同行「重置密码」/「新增用户」正常（有完整弹窗链路）。
- **后端（三段式补齐 PATCH 链路）**：
  1. 新建 `dto/update-user.dto.ts`（UpdateUserDto）：username/displayName/email/roleId **全可选**（PATCH 部分更新语义）；email 支持 `string | null`——**null = 清空邮箱**（class-validator `@IsOptional()` 对 null 跳过校验，语义天然满足）。
  2. `UsersService.update(id, dto)`：存在校验（404）→ username 变更时唯一冲突（`dto.username !== existing.username` 才查）→ email 变更且非 null 时唯一冲突 → roleId 提供时校验角色存在 → **data 仅组装提交的字段**（`...(dto.x !== undefined ? {x: dto.x} : {})`）→ **空 data（PATCH 空 body）幂等返回 `findOne(id)`**（防 Prisma 空更新抛 PrismaClientValidationError——内部错误而非业务 400）。
  3. `UsersController @Patch(':id')` 声明在 `@Patch(':id/status')` 之后——`:id` 单段与 `:id/status` 双段互不吞，顺序无关但按「具体→一般」排可读性好。
- **前端（对齐 ResetPasswordModal 的 target 模式，不泛化 UserFormModal）**：
  - 新增独立 `EditUserModal`（`edit-user-*` testid 10 个）——「对照重置密码弹窗模式实现」任务要求字面落地；**不泛化 UserFormModal**（其 mode 分支会让新增弹窗回归风险上升，两弹窗字段集差异大：新增有密码、编辑有预填）。
  - 预填：`useEffect [open, target]` 每次打开 setUsername(target.username) / setEmail(target.email ?? "") / setRoleId(target.roleId)。
  - 提交 payload：`{username, displayName: username（兜底，与 create 一致）, email: 空串→null（清空语义）, roleId}`——email 空提交 null 而非 undefined，对齐后端「null=清空」。
  - UsersPage：`editTarget: UserItem | null`（target 非空即打开，对齐 resetTarget 模式）+ `updateMutation`（PATCH → onSuccess 关闭 + invalidate ["users"]）+ `onEdit={setEditTarget}` 传给 UserRow。
- **OBS-007 复核（无需改动）**：QA 报告称「新增用户弹窗缺角色选择」，但当前代码 `user-role-select` 角色按钮组已存在（GET /roles 驱动 + roleId 必填）——**QA 报告与代码基线不一致**（推测 QA 用受限用户测得 GET /roles 403 → 角色区空白被误判）。管理员视角实证 3 个角色按钮正常。
- **测试**：users.service.spec 新增 6 例（部分更新字段落库 / username 冲突 / email null 清空 / roleId 不存在 400 / 空 body 幂等 / 404）→ 43 suites / **689 tests 全绿**（基线 668 + 21 含并行会话增量）+ nest build。⚠️ **spec 编辑坑**：把新 describe 插到 resetPassword describe 中间时吞掉了其「目标用户不存在抛 404」用例且少一个 `});`——先读清 describe 边界再插入。
- **e2e**：reference/testids.ts user-management 条目注册 10 个 `edit-user-*`；pages.spec.ts 15/17 测试扩展：点编辑 → 弹窗 + 预填值 + 角色按钮 → 取消；新增用户弹窗角色按钮可见。**33/33 全绿**（1.2m）。
- **浏览器实证**（playwright headless，chromium-1208 executablePath 显式指定——node_modules playwright 要 1234 版本但缓存只有 1208）：11/11 PASS——点编辑弹窗出现 → 预填用户名（prefilled=T）→ 3 角色按钮 + 1 选中 → 切角色 → 保存 → 弹窗关闭 + **列表刷新显示新用户名（T-edited，PATCH 真生效）** → 再编辑还原数据 → 新增弹窗角色选择 3 按钮 → 重置密码回归 → **0 console 错误**。
- **⚠️ 实证脚本定位坑**：取行内用户名用 `row.locator("span", {hasText: /^[\w.-]+$/}).first()` 会命中**头像 span**（单大写字母）——头像（34px 圆形）与用户名（mono）同层级，用 `row.locator("div > div > div > span").first()` 精确取用户名。
- **⚠️ 环境坑（复现）**：`sudo node dist/src/main.js` 会走系统 node **v18.15.0**（pino tracingChannel 崩）——必须 `sudo /home/keta/.nvm/versions/node/v22.22.1/bin/node dist/src/main.js` 绝对路径；本机 3000 后端（PID 属 root）改后端后需 sudo kill + 绝对路径重启；3001 web dev 与 build 仍遵循 C11 教训（kill + rm -rf .next 再 build，build 后 .bin/next dev --turbopack -p 3001 重启）。

---

## D6: 修复「删除 provider 凭据失败错误不可见」（2026-08-09，实现 + 浏览器实证完成）

- **用户反馈**：删除凭据失败时"点了没反应"——`revokeMutation.onError` 设置了 `setConfigureError(err.message)`，但 `configureError` 只在 ConfigureModal 内渲染（:944），弹窗 `open={configuringProvider !== undefined}` 仅依赖 `configureOpen`（:941）；删除失败时 configureOpen 为 null → 弹窗关闭 → 错误状态设置了但无处显示（静默失败）。
- **方案 A（列表级内联错误条）落地**（providers-tab.tsx）：
  1. 新增独立 `providerError: string | null` state（与 configureError 语义分离——configureError 是"配置弹窗错误"，删除错误走列表级）。3s 自动消失 useEffect（对齐 skills 页 notice 行为）。
  2. `revokeMutation`：onSuccess 清空 providerError；onError 改设 providerError（**不再写 configureError**——原写法在弹窗未开时无效）。
  3. 删除按钮 onClick 前置 `setProviderError(null)`（重试前清旧提示）。
  4. 渲染：工具条与列表之间插入错误条（`provider-error-banner`，role=alert + ⚠ + 关闭按钮 `provider-error-dismiss` + 3s 自动消失；红系 #FEF2F2/#FECACA/#DC2626 对齐 skills 页 notice 错误态）。
- **次要优化（顺手做）**：删除按钮条件 `status !== "missing"` → `status === "configured"`——"已撤销"（revoked）状态再点删除无意义（DELETE 幂等成功、且语义混乱），仅 configured 显示删除按钮。e2e 无该按钮点击断言，安全。
- **⚠️ 验证路径坑（幂等 DELETE 无法自然触发 404）**：C12 的 `revokeCredentialByProvider` 是 findUnique 后 update revokedAt——**已软删记录重复 DELETE 仍成功（幂等）**，不存在 revokedAt=null 才删的语义。因此"先 API 直删 → 页面缓存过期 → 点删除 → 404"的路径不成立（第二次 DELETE 成功，无错误条）。浏览器实证改用 **playwright route 拦截** DELETE 返回 404（`page.route("**/api/v1/models/providers/*/credentials")` fulfill 404）——直接验证前端 onError → 错误条渲染逻辑，不依赖后端状态，更干净。
- **实证结果**（chrome headless，web dev 3001）：rows=7、deleteButtons=1（仅 opencode-go configured）、revokedButtonHidden=true（zhipu revoked 无删除按钮）、点删除 → `provider-error-banner` 可见（文本含 MODEL_CREDENTIAL_NOT_FOUND）、dismiss 后消失、无 JS console 错误。截图 `.omo/evidence/` 未存（模型不支持读图，playwright 文本断言为准）。
- **验证**：web `npx tsc --noEmit` 0 错误 + `npm run build` 通过（/models 9.52 kB）。⚠️ 环境坑：跑 build 前需 kill 3001 dev server + `rm -rf .next`（C11 教训），build 后 `node_modules/.bin/next dev --turbopack -p 3001` 重启（**npx/npm exec 的 `-p 3001` 会被解析成项目目录报错，必须直接调 .bin/next**）；dev 启动后首次编译 ~1.6s。

---

## C12: 修复「删除 provider 凭据」bug（2026-08-09，实现 + 验证完成）

- **用户反馈**：① 删除凭据不生效；② 每次点击发出多个不同编号的 DELETE 请求。
- **根因三连（explore 定位）**：
  1. `models.service.ts findAll` providerID 用 **contains 模糊匹配**——`providerID=opencode` 命中 opencode + opencode-go 两 provider 的模型。
  2. 前端 `resolveModelId` 每次裸 `GET /models?providerID=xxx` 取第一个匹配模型 id；后端 `orderBy createdAt asc` 同 createdAt 排序不稳定 → 每次点击解析到不同 model id → 多个不同编号 DELETE。
  3. **设计错配**：凭据按 providerID 粒度存（ModelCredential.providerID unique），删除却按「某模型 id」路由（`DELETE /models/:id/credentials`）→ resolveModelId 是保底 hack；且 revokeMutation 无 onError → DELETE 404（MODEL_CREDENTIAL_NOT_FOUND）静默失败 → 删除不生效。
- **后端改动**：
  1. **新端点** `DELETE /models/providers/:providerID/credentials`（AdminGuard）——`ModelsService.revokeCredentialByProvider(providerID)` 直接按 providerID `findUnique` ModelCredential → 无则 404 MODEL_CREDENTIAL_NOT_FOUND，有则 `update revokedAt=new Date()`。**不查 model 行**（worker-only provider 无模型也能删）。静态段 `providers` 声明在 `@Delete(':id')` 之前（紧跟 @Get('providers') 之后，对齐既有顺序）。
  2. **findAll providerID 改精确匹配**：`providerID: query.providerID ? query.providerID : undefined`（modelID/name 保留 contains 搜索）；`orderBy` 加第二键 `[{ createdAt: 'asc' }, { id: 'asc' }]` 保证同 createdAt 排序稳定。
- **前端改动**（providers-tab.tsx）：`revokeMutation.mutationFn` 改直接 `api.delete(\`/models/providers/${providerID}/credentials\`)`——**删除 resolveModelId 调用**（saveCredentialMutation 仍用 resolveModelId，故保留）；补 `onError: setConfigureError(isApiError(err) ? err.message : "删除失败，请稍后重试")`（对齐 saveCredentialMutation onError 模式，杜绝静默失败）。
- **⚠️ 路由顺序测试坑（沿用 C9）**：PATH_METADATA 定义在 `descriptor.value`（函数对象）上，读法 `Reflect.getMetadata(PATH_METADATA, ModelsController.prototype[method])`；声明顺序 = `Object.getOwnPropertyNames(prototype)` 顺序。新增断言 `providers/:providerID/credentials` 索引 < `:id` 索引。
- **测试**：models.service.spec 新增 revokeCredentialByProvider 3 例（按 provider 直删不查 model / 无凭据 404 / model 不存在 worker-only 也能删）+ findAll 精确匹配与 orderBy 第二键断言更新；models.controller.spec 新增 2 例（转发 + DELETE 路由顺序）。**验证**：server `npm run build` 通过 + jest **43 suites / 668 tests 全绿**（基线 663 + 新增 5）；web `npx tsc --noEmit` 0 错误 + `npm run build` 通过。
- **遗留（决策）**：POST 按 provider 保存凭据端点（`POST /models/providers/:providerID/credentials`）未做——用户问题聚焦删除，保存路径 resolveModelId 已被 findAll 精确匹配 + 稳定排序修复，不再每次漂移；如未来要支持 worker-only provider 配置凭据，可补该端点（body {token, targetWorkerIds?}）。

---

## D5: Provider 列表"只有 opencode/opencode-go 两个 provider"问题修复（2026-08-09，实现 + 验证完成）

- **根因（实证）**：`STATIC_AVAILABLE_MODELS` 8 个 seed 模型中 7 个**无 provider 前缀**（`deepseek-v4-pro`/`glm-5.1`/`glm-5.2`/`gpt-5.6-luna`/`grok-4.5`/`kimi-k2.6`/`qwen3.6-plus`）——`buildModelSeedRows`/`splitModelId` 首 `/` 拆不到 → 默认归 `opencode` → models 表 DISTINCT provider_id 只有 `opencode`/`opencode-go` 2 个 → `GET /models/providers` 聚合结果也只有 2 个 → Provider 页只有 2 行。
- **决策：provider 前缀采用 opencode models.dev 标准**（任务给定映射）：本机 `opencode models` 无凭据时只返回内置免费模型（opencode/big-pickle、gemma4/*、keta/* 等），seed 中这些模型不在实测列表，故按 models.dev 标准 id 补齐：
  - `deepseek-v4-pro` → `deepseek/deepseek-v4-pro`
  - `glm-5.1`/`glm-5.2` → `zhipu/glm-5.1`/`zhipu/glm-5.2`（GLM 属智谱）
  - `gpt-5.6-luna` → `openai/gpt-5.6-luna`
  - `grok-4.5` → `xai/grok-4.5`
  - `kimi-k2.6` → `moonshot/kimi-k2.6`
  - `qwen3.6-plus` → `qwen/qwen3.6-plus`
- **改动面**：
  1. `agent.constants.ts` STATIC_AVAILABLE_MODELS 全量携带前缀 + `TEMPLATE_DEFAULT_MODELS` 同步（a_product→zhipu/glm-5.1、a_architect→deepseek/deepseek-v4-pro、a_tester→zhipu/glm-5.2；a_developer 原 opencode-go/deepseek-v4-flash 不变）——模板默认模型必须指向目录中存在的模型，否则 agent.constants.spec 的 keys.has 断言挂。
  2. `seed.ts` **清理旧无前缀残留**：provider 前缀规范化后旧行（providerID='opencode' AND modelID IN 7 legacy）与新行唯一键不同，upsert 无法覆盖 → seed 前先 deleteMany（**先删 worker_model_availabilities 外键行，再删 model**，对齐 ModelsService.remove 的 FK Restrict 约束）；实测清理 7 行。
  3. `models.service.ts listProviders` **数据源 2（worker 上报合并）**：除 models 表 groupBy 外，追加在线 worker（status != offline）`capabilities.models`（string[]，拆 providerID）union——worker 配置凭据后上报的模型含新 provider，Provider 页自动出现；modelCount = 目录 count + worker 上报该 provider 模型数（worker-only provider 也能显示计数，重复 id 不特意去重——语义为"可用模型数"，与 worker 侧各自集合一致）。
- **⚠️ 兼容路径保留**：`splitModelId` 不含 `/` 归 opencode 的分支保留（存量 agent defaultModelId/外部上报可能仍是旧自由字符串），D5 后 seed 不再产出无前缀行，该分支仅作兼容。
- **验证**：server `nest build` 通过；jest **43 suites / 663 tests 全绿**（基线 661 + 新增 2：agent.constants.spec D5 provider≥4 断言、models.service.spec worker union 合并用例）；seed 实库重跑清理 7 行后 DISTINCT provider_id = **7 个**（deepseek/moonshot/openai/opencode-go/qwen/xai/zhipu）；`GET /models/providers`（admin token）返回 7 个 provider，模型数正确（zhipu=2 双模型）。

---

## C10: Provider 页切换后端聚合数据源，消除前端聚合冗余（2026-08-09，实现 + 验证完成）

- **背景**：Provider 页原先用「GET /models pageSize=100 全量分组 + 每 provider 并发 GET /models/:id/credentials」前端聚合（C6 期后端 providers 端点未交付时的并行时序误判）。C9 后端 `GET /models/providers` 交付后，切换为单一端点，**删除 2 个请求源**（modelsQuery 全量分组 + credentialsQuery 逐 provider 查凭据），保留 workersQuery（worker 多选数据源）。
- **类型**：`web/src/types/models.ts` 新增 `ProviderSummary {providerID, modelCount, configured, fingerprint, revokedAt}`（与后端 listProviders 响应字段一一对应）。
- **⚠️ 模型 id 闭环（保存/删除凭据的关键）**：C9 providers 响应**不含模型 id**（只聚合计数/凭据态）——保存 POST /models/:id/credentials 与吊销 DELETE 仍需目录行 md_ id。保底方案 `resolveModelId(providerID)`：`GET /models?providerID=<p>&pageSize=100` → 前端**精确 filter `m.providerID === providerID` 取首个**（⚠️ 后端 providerID 是 contains 模糊匹配，`opencode` 会误命中 `opencode-go`，必须前端二次精确过滤防前缀误命中），再 POST/DELETE `/models/<md_id>/credentials`。凭据按 provider 粒度（C4），任一模型 id 均可操作，不要求 enabled。
- **⚠️ queryKey 跨页共享陷阱**：原 credentialsQuery 用 `["model-credentials"]`（与 models 页共享，保存后两页凭据态一起刷新）；新 providersQuery 的 queryFn 是 GET /models/providers，**不能复用 ["model-credentials"]**——react-query 同 key 不同 queryFn 会互相污染缓存（models 页存 Map，providers 页存数组）。改用独立 key `["model-providers"]`，保存/吊销成功后**双 invalidate**：`["model-providers"]`（本页）+ `["model-credentials"]`（models 页共享的凭据态，保持跨页一致性）。
- **渲染逻辑零变化**：providerID + 模型数（p.modelCount）+ 三态徽章（toStatus 从 ProviderSummary 直接判定：configured → 绿 / !configured && revokedAt → 琥珀 / 否则灰）+ fingerprint（configured 时显示 p.fingerprint，其余 "—"）；配置弹窗交互（worker 多选/保存/删除）未动。
- **验证**：web `npx tsc --noEmit` 0 错误 + `npm run build` 通过（/providers 路由 7.87 kB）。后端零改动（C9 已交付）。

---

## C11: 模型管理单一入口（/models 双 Tab 合并 Provider 页）（2026-08-09，实现 + 验证完成）

- **用户需求原话**：「主入口应该只有一个模型管理，进去后通过 tab 页管理两个页面，支持切换」——Provider 页与模型页合并为单一「模型管理」入口 + Tab 切换。
- **方案**：`/models` 为主入口页，顶部 `manage-tabs`（对齐 skills 页双 Tab 模式：manage-tabs/manage-tab + TabKey state）双 Tab：**catalog（模型目录，默认）** / **providers（Provider 管理）**。`/providers` 路由保留为 server 组件 `redirect("/models")`（132 B 重定向页，URL 直达兼容）。
- **Provider 视图迁移**：原 `providers/page.tsx`（949 行）主体原样迁移到新文件 `web/app/(main)/models/providers-tab.tsx`（export default ProvidersTab；app 目录非特殊文件名不生成路由，安全 colocate）；**全部 testid 保留**（providers-root/provider-list/provider-* 22 项 + 弹窗交互）。原 providers 页删除，改 8 行重定向页。
- **models 页改造**：manage-toolbar 只放双 Tab + 搜索框（`tab === "catalog"` 条件渲染，providers tab 无搜索框）；计数徽章（X 个模型 · 已配置 Y/未配置 Z）从 toolbar 移到列表头「全部模型」行；model-hint 条件渲染（仅 catalog）；「凭证管理请前往 /providers」文案改为「切换到 Provider 管理 Tab」。
- **数据源独立（无污染）**：catalog=["models"]+["model-credentials"]，providers=["model-providers"]；`["workers"]` 双 Tab 共享——**同 key 同 queryFn 的 react-query 是缓存共享而非污染**（C10 教训的反面：污染只发生在同 key 不同 queryFn）。保存/吊销凭据后仍双 invalidate（["model-providers"]+["model-credentials"]）保持跨 Tab 一致。
- **导航精简 4 处**：nav-dock NAV_ITEMS 删 providers 项 + models label「模型目录」→「模型管理」；app-shell KEY_TO_PATH/CMDK_NAV_PATH/PAGE_TITLE 删 providers + models 标题改「模型管理 / 模型目录 · Provider 凭证管理」（**CMDK_NAV_PATH 与 cmdk-panel DEFAULT_CMDK_ITEMS 的 label 必须同步改**——handleCmdKSelect 以 label 查路径映射）；cmdk-panel DEFAULT_CMDK_ITEMS 删「Provider 管理」+「模型目录」→「模型管理」。
- **e2e 同步**：pages.spec.ts「18/18 /models」测试改为双 Tab 全流程（manage-tabs 可见 + 2 个 manage-tab + catalog 断言 + 切 providers tab 断言列表/徽章/弹窗开合 + 切回）；原 /providers 测试改为「旧路由重定向」测试（`toHaveURL(/\/models$/)` + models-manage-root 可见）。testids.ts 合并两页审计条目为单个「2.14 models-manage（模型管理：模型目录 + Provider 凭证双 Tab）」38 项 + PAGE_SMOKE /models 更新（含 provider-list）、删 /providers 行。
- **⚠️ e2e 弹窗 testid 重复**：provider-modal-cancel 出现 2 次（✕ + 底部取消），`.first()` 定位（沿用原 providers 测试写法）。
- **验证**：`npx tsc --noEmit` 0 错误 + `npm run build` 通过（/models 9.35 kB、/providers 132 B 重定向页）；playwright 实证（channel=chrome）：登录 → /models 双 Tab（2 个 tab）→ catalog 默认 → 切 providers 7 个 provider 行 + 配置弹窗开合 → 切回 catalog → /providers 重定向 /models，**0 console 错误**；e2e pages 项目 **17/17 全绿**（41s）。
- **⚠️ 环境坑（复现）**：生产 `npm run build` 与 dev server 共用 `.next` 目录——先 build 后 dev 会 ENOENT _buildManifest.js.tmp（dev 500）；修复：kill dev → `rm -rf .next` → 重启 `npm run dev`。dev server 与 build 不能并行跑同一工作区。

---


- **端点**：`GET /api/v1/models/providers`（成员只读，不挂 AdminGuard，与 GET /models 一致）。返回 `Array<{providerID, modelCount, configured, fingerprint, revokedAt}>`，Provider 页数据源（模型页纯展示）。
- **service 实现**（`ModelsService.listProviders()`，两次查询内存合并）：① `prisma.model.groupBy({by:['providerID'], where:{enabled:true}, _count:{_all:true}})` 一次取 provider + enabled 模型数；② `modelCredential.findMany()` 全量按 providerID 建 Map 取凭据状态（表很小，无复杂 join）。`configured = 存在且 revokedAt===null`；`fingerprint` 取库内已脱敏指纹，**未配置/已吊销时为 null**（明文零接触）；排序 providerID 字典序（简单稳定）。
- **⚠️ modelCount 语义**：groupBy 的 where 必须带 `enabled:true`——任务要求"该 provider 下 enabled 模型数"，与目录列表 enabled 过滤语义一致。
- **⚠️ 路由顺序关键点**：`providers` 静态段必须在 `@Get(':id')` 之前声明（NestJS 按声明顺序匹配，否则 GET /models/providers 被 :id 拦截 404）。插在 findAll 之后、findOne 之前。
- **⚠️ 测试路由顺序的 metadata 读取坑**：NestJS `@Get('providers')` 的 PATH_METADATA 定义在 **`descriptor.value`（函数对象）** 上，不是 `prototype+key`。读法必须是 `Reflect.getMetadata(PATH_METADATA, ModelsController.prototype[method])`（第二参传函数对象、无第三参）——用 `(proto, method)` 三参读法恒返回 undefined（本任务踩坑后修正）。声明顺序 = `Object.getOwnPropertyNames(prototype)` 顺序（排除 constructor），断言 `providers` 索引 < `:id` 索引。
- **mock 扩展**：`models.service.spec` 的 prisma.model mock 需补 `groupBy: jest.fn()`（groupBy 返回形如 `[{providerID, _count:{_all:n}}]`）。
- **验证**：`npm run build` 通过 + jest **43 suites / 661 tests 全绿**（基线 656 + 新增 5：service.spec listProviders 3 例（聚合/吊销 configured=false+fingerprint=null/空）、controller.spec 2 例（转发 + 路由顺序））。

## B2 修复：resolveModels 空列表重试（2026-08-09，实现 + 实证完成）

- **根因（F3 复现）**：`opencode serve` 健康检查通过（HTTP 200）≠ 模型列表就绪。容器内实测（真实凭据）：就绪 **303ms** 时 GET /api/model 返回 **0 模型**，**1573ms** 后才返回 **6212 个模型**。旧 resolveModels 单次调用拿到空数组 → 被当作"已探测无模型"上报 `capabilities.models=[]` → C3 availability 无行（详情页模型卡只能走目录兜底）。
- **修复语义变更（重要）**：resolveModels 的空列表从"已探测无模型（返回 `[]`）"改为**"未就绪（重试）"**：
  - 非空 → 返回 id 数组（正常上报）
  - **空列表 → 1s/2s/4s 指数退避重试（默认 retries=3，总探测 4 次，窗口 ~7s）**，直到非空
  - 重试耗尽仍空 → 降级 undefined（不携带 models，不阻断注册）
  - listModels **抛错 → 立即降级 undefined**（不重试，serve 未就绪/端点不支持同现状）
- **实现**（worker/src/index.ts）：`ModelListProbeOptions`（`retries`/`retryDelayMs`/`delay`）——`delay` 可注入（单测传 0ms 跳过真实等待，jest 不依赖 fake timers）；`resolveModels(lister, options)` 新增第三参。调用点 `registerCurrent` 不变（`resolveModels(driver)` 缺省选项）。
- **单测**（index.spec.ts 5 例）：首次非空只探测 1 次 / 空→空→非空 第 3 次成功（断言 listModels 调用 3 次）/ 持续空重试耗尽 → undefined（retries=2 时调用 3 次）/ 抛错立即 undefined（调用 1 次不重试）/ 既有映射成功用例保留。worker jest **17 suites / 208 tests 全绿**（基线 206 + 新增 2）+ typecheck 通过。
- **端到端实证**（compose 13000/13001 + worker 容器）：
  - 复现：容器内 spawn serve（XDG_DATA_HOME 指向真实 auth.json）→ 就绪 303ms 空、1573ms 后 6212 模型，与 F3 现象一致
  - 修复后：`npm run build` 产物 `docker cp` 覆盖容器 `/tmp/keta-worker/dist/index.js` + 预置 `/root/.local/share/opencode/auth.json`（真实凭据）→ `docker restart` → 日志：`模型列表探测为空（第 1/4 次，serve 可能仍在预热），1000ms 后重试` → **仅 1 次重试即非空** → 注册成功
  - server 库核对：`workers.capabilities.models` **26 个** + `worker_model_availabilities` **26 行**（C3 合并链路完整生效）——修复前此场景 capabilities.models=[]、availability 无行
- **⚠️ 环境坑**：
  - 本机 `docker compose build worker` 拉不到 `node:22-alpine`（docker.io 网络超时）——改用 `npm run build` + `docker cp` 覆盖容器 dist，免重建镜像
  - worker 容器内 serve 的 auth.json 是**测试假 token**（`sk-test-b1-token-0003`，provider 认证失败 → 0 模型），实证"非空"必须注入真实凭据（`/root/.local/share/opencode/auth.json`，serve 默认路径）；实证后 recreate 容器恢复基线
  - bash 工具持久 shell 对后台 spawn（opencode serve）不友好——curl 无 `--max-time` 会挂死 shell；serve 启动用 `setsid` 脱离 + 所有网络命令带超时；容器内无 curl/python3（alpine），用 node 内置 fetch



## C8: worker 默认模型配置 API + 详情页模型卡（2026-08-09，实现 + 验证完成）

- **PATCH /workers/:id（全新端点，无路由冲突）**：`workers.controller.ts` 新增 `@Patch(':id')` + `@UseGuards(AdminGuard)`（前置全局 JwtAuthGuard 鉴权）→ `WorkersService.updateDefaultModel(id, dto)`。controller.spec 需补 `PrismaService` mock（AdminGuard compile 时实例化，依赖 user.findUnique——对齐 models.controller.spec 模式）。
- **defaultModelId 格式关键点**：defaultModelId 是 **`providerID/modelID` 引用格式**（与 C2 worker 上报 id、C7 matchesModelRequirement 的 modelId 比较对象同构），**不是目录 `md_` 主键**——校验不能用 `ModelsService.findOne`，需按 @@unique(providerID, modelID) 查。新增 `ModelsService.findCatalogByRef(ref)`：复用私有 `splitModelId` 拆解约定（含 `/` 首个 `/` 拆，不含 providerID 归 opencode），select 含 enabled，返回完整行/ null。
- **updateDefaultModel 语义（三态区分）**：`defaultModelId` 非空 → findCatalogByRef 校验（不存在 **或 enabled=false** → 400 MODEL_NOT_FOUND，任务要求校验拦截）；`null`/空串 → 清除（跳过校验，落库 null）；`undefined` → 幂等跳过（data={}）。返回 `toWorkerView`（更新后完整视图）。
- **toWorkerView 扩展（Metis R11）**：入参类型与返回对象均加 `defaultModelId: string | null`——findAll/findOne/PATCH 三路径统一透出，前端详情页默认模型标识的数据源。⚠️ 测试 workerRow 需补 `defaultModelId: null` 默认值（toWorkerView 类型必填，jest 严格类型）。
- **详情页模型卡（第 7 块）**：`workers/[id]/page.tsx` 新增 `worker-detail-models` section。数据源**主选 `capabilities.models`（C2 上报持久化，离线可查）**；未上报/空 → **目录兜底 `GET /models?pageSize=100`**（enabled 全量）。每个 badge 显示 `provider / 模型名`（模型名经 catalogByRef Map 映射 `providerID/modelID → name`，缺失回退 modelID 末段；**ref 拆解复用 splitModelRef 页面内工具**，不含 `/` 旧自由字符串 providerID 归 opencode）。`worker.defaultModelId === ref` 匹配 → 绿系徽章「默认」（`worker-model-default`，data-testid）。空态 → 本地 `SectionEmpty`（page.tsx:105 本地定义，非 shared.tsx——Metis R10 确认）。
- **新 testid 注册**：`worker-detail-models` / `worker-model-badge` / `worker-model-default` 注册到 testids.ts **worker-list（2.13）条目**（worker 详情页无独立 PAGES 条目，其既有 testid 亦未单独注册——归入 worker-list 条目保持一致性）。badge 带 `data-model-id` + `data-default` 属性便于断言。
- **Web 类型扩展**：`shared.tsx` WorkerItem 加 `defaultModelId: string | null` + `capabilities.models?: string[]`（WorkerDetail 经 extends 继承）。
- **⚠️ 遗留清理**：移除 worker 详情页未使用的 `router`/`useRouter`（T13 迁移遗留，build lint 报 `no-unused-vars`）——顺手清理保持构建零新增警告。
- **⚠️ web build 缓存坑**：`npm run build` 偶发 `Cannot find module '../chunks/ssr/[turbopack]_runtime.js'`（Collecting page data 阶段，.next 缓存损坏）——`rm -rf .next` 后重建即过，非代码问题。
- **验证**：server `nest build` 通过 + jest **43 suites / 652 tests 全绿**（基线 643 + 新增 9：workers.service.spec 6（配置/不在目录 400/停用 400/null 清除/缺省跳过/404）+ toWorkerView 透出 1 + workers.controller.spec 2）；web `tsc --noEmit` 0 错误 + `npm run build` 通过（PATH 需 nvm v22.22.1），/workers/[id] 路由入表。


## C6: 前端模型管理页 + agent 页模型选择器增强（2026-08-09，实现 + 验证完成）

- **新增路由**：`web/app/(main)/models/page.tsx`（AppShell 内容区模式，root `models-manage-root` flex:1）——**导航 5 处注册**：nav-dock NAV_ITEMS 加 `{key:"models", label:"模型目录", icon:"◇"}`（第 4 位，worker 之后 skills 之前，图标 ◇ 不与现有冲突）；app-shell KEY_TO_PATH（models→/models，KEY_LOOKUP 自动反查）+ PAGE_TITLE（「模型目录 / 模型登记 / 凭据配置 / 启用停用」）+ CMDK_NAV_PATH（模型目录→/models）；cmdk-panel DEFAULT_CMDK_ITEMS 加「模型目录」导航项。Dock min-height 写死 360px 注释「7 图标」——8 图标时内容高度自然撑开（max-height calc(100% - xxl) 兜底），无需改。
- **testid 一致性验收通过**：原型 models-manage 19 个 data-testid 全部在实现页出现（`grep -oP 'data-testid="[^"]+"' 原型 | sort -u` vs 实现 comm -23 为空）。新增反馈类 testid（models-loading/models-error/models-retry/model-add-modal/model-provider-input/model-model-id-input/model-name-input/model-add-confirm/model-add-error）已注册 testids.ts（auditPage "2.14 models-manage"）+ pages.spec.ts 新测试「18/18」（文件头 17→18）。
- **模型页数据源**：GET /models 分页（pageSize=100 一次拉全量，agents 页同模式）→ 目录行（id=md_xxx）；**可用节点数 = 在线 worker（status≠offline）capabilities.models 含该模型 id 的计数**（无 availability API，worker 上报为近似源）；**凭据状态 = 每模型并发 GET /models/:id/credentials（Promise.all，单模型失败容错视同 missing）**——GET /models 不 join credential，页面级 queryKey=["model-credentials"] 一次拉全量 8 请求可接受。
- **模型页权限**：isAdmin（roleName==='admin'）控制写操作——model-add-button 条件渲染（非 admin 隐藏，源码 testid 保留不影响 grep diff）、model-toggle disabled、model-credential-save disabled（空 token 也禁用）；后端 AdminGuard 403 兜底。凭据保存 POST /models/:id/credentials {token, targetWorkerIds?}（targetWorkerIds 非空才传，对齐 C5 定向/全量语义）；启用停用 PATCH /models/:id {enabled}。
- **agents 页增强（P0.2 原型对齐）**：
  - **MODEL_NAMES 死代码删除**：前置处理 :322（AgentListItem 默认模型徽章）与 :796（currentModelName）两处引用 → 新增 **GET /models 目录查询**（queryKey=["model-catalog"]）建 `catalogByRef`（Map 双键：`providerID/modelID` + 裸 modelID——存量 defaultModelId 可能是不含 '/' 的旧自由字符串，双键兼容校验）→ `modelNameOf`（useCallback）传给 AgentListItem。
  - **AvailableModel 提取共享**：`web/src/types/models.ts`（agents 页私有定义移出；models 页不依赖它，未来 worker 详情卡可复用）。
  - **模型下拉 provider 显示**：option 文本 `${providerOf(id)} / ${name}`（providerOf=首个 '/' 前，无 '/' 原样），加 data-testid="model-option-provider"+data-model-id（对齐 P0.2）；model-source-hint 文案改为「平台模型目录（worker 上报合并入库，C3）」。
  - **token 输入（model-token-input + model-token-status 双态）**：⚠️ **凭据端点 :id 是目录行 md_xxx，而模型选择器 value 是 providerID/modelID——必须经 catalogByRef 解析 md id 才能 GET/POST /models/:id/credentials**；存量值不在目录（catalog 无行）→ 无端点可查视同未配置；保存 token 用页面级 mutation（POST 后 invalidate queryKey=["model-credential"]）。页面内新增 CredentialBadge（credentialTheme 与 models-manage 页内定义完全一致，"扩展 token"范式）。
  - **首选 worker（agent-worker-select）**：agent.workerId 可空，选项=自动调度（默认）+ GET /workers（在线优先排序，name · 在线/离线）；保存提交 `workerId: workerDraft || null`（显式 null=自动调度）；**server 侧同步补 workerId 支持**——UpdateAgentDto 加 `workerId?: string | null`（@IsString + @ValidateIf(o => o.workerId !== null) 允许 null）、agents.service AgentRow + update data + toAgentDto 透出（C1 字段此前未透出/不可 PATCH）。
  - **保存校验**：defaultModelId 非空但不在目录 → model-stale-warning 警告条（黄，不阻断保存，存量兼容）。
- **验证**：web `npx tsc --noEmit` 0 错；`npm run build` 通过（/models 路由注册 9.17 kB）；server `nest build` 通过 + jest **43 suites / 643 tests 全绿**；e2e **pages 16/16 + login/guard 17 全绿**（新增 18/18 models 测试）。
- **⚠️ 环境踩坑**：e2e 首轮 models 页 model-list 不可见——web dev 代理 /api/v1 → localhost:3000，而 3000 跑的是 **Aug08 旧 dist 实例**（无 /models 路由，404）；修复：`npm run build`（server）后 kill 旧进程重启 `node dist/src/main.js`（tmux api-dev 会话）。web dev server 旧 .next 缓存报 vendor-chunks MODULE_NOT_FOUND → `rm -rf .next` 重启（tmux web-dev2）。**C6 后 e2e 依赖后端含 ModelsModule 的最新 dist。**
- **agent-config 原型 testid 对齐**：原型模型区 7 个（model-config/model-select/model-option-provider/model-token-status/model-token-input/agent-worker-select/model-source-hint）实现全含；P0.2 原型的「保存」按钮无 testid，实现沿用（保存按钮无独立 testid 不违反 diff 契约）。agents 页 CredentialBadge 复用 data-testid="model-credential-status"（与 models 页同 testid，e2e 按页路由隔离断言无冲突）；模型页新增 model-add-cancel 弹窗出现 2 次（关闭 ✕ + 底部取消），原型无此 testid 属实现新增。

## C7: 模型解析优先级 + assignWorker 按模型过滤（2026-08-09，实现 + 测试完成）

- **模型解析优先级链**（`worker-dispatcher.ts`，Metis P1 修复后完整实现）：
  1. **Agent.defaultModelId**（显式非空直接用）→ 2. **沿 baseAgentId 链向上取最近非空 defaultModelId**（模板默认；`resolveAgentModelId` 私有方法，`MAX_BASE_AGENT_CHAIN_DEPTH=20` 防御异常链/环；链上遇 `type='template'` 或 `baseAgentId=null` 终止）→ 3. **执行 worker 的 defaultModelId**（兜底，`agentModelId ?? workerRow.defaultModelId ?? null`）→ 4. **null**（不指定，serve 默认）。解析结果 null → **跳过模型过滤**（回归现状：未配模型 agent 仍可调度任意 worker）。
- **dispatchForTarget 接线**（C 部分）：解析模型 → 组 `assignmentReq`（非空 modelId 才传）→ **两个 assignWorker 调用点（未绑定 :407 / 复用 worker offline 重分配 :435）都传 assignmentReq** → promptAsync 用解析后最终模型（:460）。Worker 行 select 增加 `defaultModelId`（阶段 2 兜底数据源）。
- **assignWorker 过滤**（`workers.service.ts`，Metis P1-3）：
  - `AssignmentRequirement` 增加可选 `modelId?`；候选查询 `include: { modelAvailabilities: { include: { model: { select: { enabled: true } } } } }`。
  - `matchesModelRequirement`（私有）判定顺序：modelId 省略/空 → 通过（现状回归）；`worker.defaultModelId === modelId` → 通过；**availability 无行（从未上报）→ 通过（过渡期降级，Metis P1-3 写死）**；已上报但 availability 不含该 enabled 模型 → 排除。
  - 排序保持：online 优先 + 剩余容量降序（filter 链在 sort 之前，不改变既有语义）。
- **3 调用点回归**（Metis P2-7）：worker-dispatcher.ts:407、:435 传 `assignmentReq`（含 modelId）；**agents.service.ts:291（getAvailableModels pull 兜底）保持无参调用**——目录空时仍返回任意可用 worker，再 listModels 探测，无回归。
- **测试**：43 suites / **643 tests** 全绿（基线 632 + 新增 11）——workers.service.spec 6 例（availability 含 enabled 模型选中 / 不含排除 / disabled 排除 / 从未上报降级 / defaultModelId 匹配 / modelId 未指定不过滤）、worker-dispatcher.spec C7 describe 3 例（Agent 显式 defaultModelId → assignWorker 携带 modelId + createSession 用拆分模型 / 沿 baseAgentId 多层 clone 链取模板默认 / Agent 模板均未配 → 跳过过滤 + worker.defaultModelId 兜底）+ 既有调用点回归（复用 worker 场景 select 含 defaultModelId 不破坏）。
- **⚠️ 测试契约修复**：跑全量 jest 发现 `agents.service.spec findAll` keys 契约断言缺 `workerId`——C1 的 toAgentDto 已含 `workerId`（Agent.workerId 软绑定字段）但 spec 期望数组未同步（并行 session 遗漏）。补 `'workerId'` 后全绿。教训：C1 加 toAgentDto 字段时须同步 findAll/update 的 keys 契约断言。
- **⚠️ 并行会话状态**：本任务启动时工作区已有并行 session 落地 C7 主体（resolveAgentModelId + assignmentReq 接线 + matchesModelRequirement + 测试），本会话负责**回归验证 + 测试契约修复 + 文档同步**。实现完全符合任务规格（含 null 跳过过滤、availability 缺失降级、3 调用点回归），无需改动业务代码。

## C4: 模型凭据加密存储（2026-08-08，实现完成）

- **schema**：`ModelCredential` 表（id `mc_` 前缀零填充、`providerID` unique（uk_model_credentials_provider）、`credentialRef`（AES-256-GCM 密文）、`fingerprint`（脱敏）、`revokedAt` 软撤销、createdAt/updatedAt）。**不建 FK**——凭据按 providerID 全局粒度（关键决策①），models.provider_id 非唯一，逻辑关联经 ModelsService 查询 model 解析 providerID。
- **迁移**：`20260808154421_add_model_credentials`（> 20260808145108 基线），对 MySQL 3307 实库应用成功，migrate status clean。
- **加密服务**（`server/src/common/credential-crypto.service.ts`）：AES-256-GCM（node:crypto 内置，零依赖），密钥来自 env `MODEL_CREDENTIAL_KEY`（支持 64 位 hex / base64 / 32 字节 utf8）。**缺失策略**：production 启动抛错（拒绝弱 key）；development/test 用硬编码显式标记的开发密钥 + logger.warn（可追溯）。密文格式 `ivHex:authTagHex:ciphertextHex`，解密 authTag 校验失败即抛错（防篡改/错 key）。**fingerprint**：前 4 + `****` + 后 4（如 `sk-a****89xz`），短 token（≤8）折半掩码。
- **模块**（`server/src/models/`，参照 mcp-servers 骨架）：ModelsModule（imports RealtimeModule 取 IdGeneratorService；providers ModelsService/CredentialCryptoService/AdminGuard；exports 两者供 C5 下发读取解密）。控制器 `models.controller.ts`：POST/DELETE `:id/credentials` 挂 AdminGuard，GET 成员只读（只出脱敏 fingerprint，无明文敏感信息）。
- **端点决策**：POST body 支持可选 `providerID`——显式提供须与 model 一致（不一致 → 400 MODEL_PROVIDER_MISMATCH），缺省取 model.providerID（防 GET 按 model.providerID 查不到）。同 provider 重复 POST 覆盖更新（幂等决策，任务要求）；DELETE 软撤销（revokedAt 置当前时间，保留审计轨迹）；GET 未配置返回 configured=false 不 404。
- **id-resync**：`mc_` 前缀复用通用 resyncIdPrefix（ModelsService.onModuleInit 调用），单测新增 mixed id 用例（数字序号 + 命名 id → 取数字最大）。
- **验证**：`npm run build` 通过；jest 43 suites / 595 tests 全绿（基线 559 + C4 新增 ~36：加密服务 15、models service 12、controller 5、id-resync mc_ 1、seed 相关）。实库核对：model_credentials 表可插入/查询/软删。
- **⚠️ 并行会话注意**：实现期间另一会话同时推进 C2/C5（workers/agents 文件被改），models 目录文件被并行增强（providerID 校验 + createdAt 字段）。C5 实现时以本 learnings + 当前 models 目录为唯一事实源，避免重复定义。


## C2: worker capabilities.models + defaultModelId 上报（2026-08-08，实现 + 验证完成）

- **models 字段结构（最终）**：`capabilities.models` 采用 **`string[]`（id 格式 `providerID/modelID`，如 `opencode-go/deepseek-v4-flash`）**。与 C1 目录 id 拆解约定天然对齐（STATIC id 含 `/` 按首个 `/` 拆 providerID/modelID），C3 合并入库直接复用拆解逻辑；server DTO `models?: string[]`（@IsOptional + @IsArray + @IsString({each:true})），worker-protocol 双写同构，无 whitelist 剥离/ValidateNested 400 风险。
- **⚠️ 并行会话冲突复盘**：实现期间另一活跃会话（boulder `model-management-b9263bc4`，同时推进 C3/C4）采用 `string[]` + env `WORKER_DEFAULT_MODEL` 方案，并覆盖了 worker-protocol.ts / register-worker.dto.ts / workers.service.ts(+spec) / worker-dto.spec.ts / config.ts / .env.example / README 等。我最初按 task 字面（对象数组 + `MODEL_DEFAULT_ID`）实现，两次恢复后被再次覆盖。**最终决策：对齐并行会话的 `string[]` + `WORKER_DEFAULT_MODEL`**——原因：① 该方案已被并行会话在协议/DTO/服务/测试四层建立且自洽，继续对抗会使工作区持续不可编译；② 与 C1 目录 id 格式内聚；③ 未来 C3 消费端由并行会话按此实现，对齐避免 C2/C3 契约断裂。经验：多会话并行同计划文件时，先 `git diff` + 核对 boulder task_sessions 判断活跃会话，避免与活跃会话反复互改同一文件。
- **异步化改造点清单**（worker/src/index.ts）：`buildCapabilities` → async（透传 models?: string[]）；`buildRegisterOptions` → async（透传 models + defaultModelId）；`registerCurrent` → async（serve 就绪后 `await resolveModels(driver)` 探测真实模型，结果传入 buildRegisterOptions）；启动链（原 :336-343）原本已 `await registerCurrent()` 无需改；`dispatchCommands`（:71-83）纯命令透传不涉注册组装，**无需改**——reload-config 链路经 restartCoordinator → reRegister → registerCurrent 自动刷新 models。
- **降级语义**：`resolveModels` 独立导出（可注入 mock listModels）：成功 → `string[]`（可为空 `[]`，表达"已探测无模型"）；失败 → undefined（不携带 models，不阻断注册，console.warn 可观测）→ server 侧 C3 以"未上报"区分降级。成功空数组与失败缺省语义不同，测试覆盖两态。
- **defaultModelId 上报**：config.ts 新增 `WORKER_DEFAULT_MODEL` env（`(env.X ?? '').trim() || undefined`，类型 `defaultModelId?: string`）→ buildRegisterOptions 非空才携带 → registry-client body 条件透传 → server RegisterWorkerDto.defaultModelId（@IsOptional + @IsString）→ workers.service.register 落 `Worker.defaultModelId` 列。
- **server 落库语义（精细版）**：`...(dto.defaultModelId !== undefined ? { defaultModelId: dto.defaultModelId || null } : {})`——**区分"未上报"与"显式清空"**：worker 未携带 defaultModelId 字段 → 不写入（保留 C8/PATCH 已配值，防误清）；显式携带（含空串）→ 写值或 null。capabilities 整块 Json 已含 models 透传（无需改落库逻辑）；toWorkerView 透传 capabilities 已含 models（C8 才加 defaultModelId 透出）。
- **验证**：worker build + jest 16 suites / 189 tests 全绿（基线 178 + 新增 11：index.spec 8 个 + contract.spec 3 个）；server build + jest 43 suites / 595 tests 全绿（基线 559 + C2 4 个 worker-dto 用例 + 并行 C4 新增）。

## C2 finalize：统一协议为 string[] + WORKER_DEFAULT_MODEL（2026-08-08）

- **背景**：上一条 C2 记录（对象数组 `Array<{providerID, modelID, name}>` + env `MODEL_DEFAULT_ID`）来自并行会话，其依据的 task 版本与本会话 task 规格不一致。本会话 task 规格白纸黑字要求 `WorkerCapabilities.models?: string[]`（id 格式 `providerID/modelID`）与 env `WORKER_DEFAULT_MODEL`。
- **决策**：以本会话 task 规格为准，将 worker-protocol/index/config/registry-client/contract.spec/index.spec + server register-worker.dto/worker-dto.spec 全部统一为 `models?: string[]` + `WORKER_DEFAULT_MODEL`；删除并行会话引入的 `WorkerModelInfo`/`WorkerModelInfoDto` 对象结构（ValidateNested 校验不再需要）。
- **C3 消费说明**：C3 合并入库时按 C1 learnings 的 id 拆解约定（含 `/` 按首个 `/` 拆 providerID/modelID，不含 `/` providerID 归 `opencode`）解析 string id，信息与对象数组等价，免二次拆分。
- **server 落库修正**：register 的 defaultModelId 改为**条件更新**——`dto.defaultModelId !== undefined ? { defaultModelId: dto.defaultModelId || null } : {}`。并行实现 `?? null` 会在旧 worker 重注册（不携带字段）时把已有值清空，误清 C8/PATCH 配置；条件更新只在显式提供时写入。
- **验证**：worker `tsc` + jest 16 suites / 189 tests 全绿；server `nest build` + jest 43 suites / 595 tests 全绿。


## C5a: opencode auth.json 注入机制（2026-08-08，实测完成）

**结论（写死进 C5）**：
- **路径解析优先级**：`$XDG_DATA_HOME/opencode/auth.json` > `$HOME/.local/share/opencode/auth.json`（实验 3 两者同时设置时 XDG 胜出；strace 证实 serve 真实打开 `$XDG_DATA_HOME/opencode/auth.json`）
- **格式**：`{providerID: {type:'api', key}}`（本机 9 provider 全 type=api）
- **无 `--config` 支持**：`opencode serve --help` / `opencode --help` 均无 `--config` 参数；注入只能走 env（HOME 或 XDG_DATA_HOME）
- **主选方案**：worker 设置进程级 `XDG_DATA_HOME=<worker-data-dir>` + 写 `<dir>/opencode/auth.json`（600 权限）→ `spawnServe` env=`{...process.env}`（opencode-server.ts:282）自动继承 → 调 `restart()`（:201-206）生效。不改 spawnServe 签名、不动 cwd
- **加载实证**：auth.json 含 deepseek → `opencode models deepseek` 列出 4 模型；空 auth.json → `Provider not found`。auth.json 是 provider 可用性的唯一开关
- **降级**：无 auth.json → 0 credentials 静默降级，serve 正常启动（C5 失败态不会崩 worker）
- 证据：`.omo/evidence/c5a-auth-json.md`

## C5: 模型凭据下发（WorkerCommand model-credentials + auth.json 注入）（2026-08-08，实现 + 测试完成）

- **协议双写**：`WorkerCommand` 增加 type `model-credentials` + 可选 `payload?: ModelCredentialsPayload`（`{providerKeys: Array<{providerID, key}>, targetWorkerIds?: string[]}`，targetWorkerIds 空=全量）。worker-protocol.ts 与 workers.service.ts 双写一致，contract.spec 新增 round-trip（含 targetWorkerIds 缺省 / reload-config 无 payload 向后兼容）3 例。**向后兼容**：reload-config 命令不携带 payload，既有结构不受影响。
- **下发唯一化（Metis R4）**：`WorkersService.dispatchModelCredentials(providerKeys, targetWorkerIds?)`——非空 → enqueueCommand 逐个精确下发；空 → broadcastCommand 原样广播（**不改 broadcastCommand 签名**）。ModelsService.setCredential 保存成功后调用（`dispatchAfterSave` 私有方法，token 只经下行命令明文传输，失败 warn 不阻断保存——注册回放兜底）。
- **POST body 扩展**：SetModelCredentialDto 加 `targetWorkerIds?: string[]`（@IsOptional + @IsArray + @IsString each），controller 4 参转发 service。Swagger 注释文档化定向/全量语义。
- **注册/心跳回放（Metis R5）**：register 成功后 `replayModelCredentials(worker.id)`——查 ModelCredential revokedAt=null → CredentialCryptoService.decrypt 解出明文 → enqueueCommand 组装 providerKeys；**并行会话补充** heartbeat 中 worker 从 offline 恢复时也回放（`worker.status === OFFLINE` 判断，select 已含 status）；一直在线心跳不重复回放（避免每 10s 重启 serve）。回放失败（解密/DB 错）warn 不阻断注册。
- **模块循环依赖**：ModelsService 需 WorkersService（触发下发）+ WorkersService 需 CredentialCryptoService（注册回放）→ **双向 forwardRef**：models.module imports forwardRef(WorkersModule)、workers.module imports forwardRef(ModelsModule)。⚠️ 注意并行会话 C3 曾把 workers.module 的 ModelsModule 写成非 forwardRef，我改为 forwardRef 解环。
- **worker 注入（C5a 方案落地）**：新文件 `worker/src/credentials/model-credential-injector.ts`：
  - `buildAuthJson(providerKeys)` → `{providerID: {type:'api', key}}`（C5a 实测格式）；空/空白 providerID/空 key 条目静默跳过
  - `writeAuthJson(providerKeys, {dir?})` → mkdir -p `<dir>/opencode` + writeFileSync(mode 600) + chmodSync 600；dir 缺省 `os.tmpdir()/keta-auth-<random>`（路径随机化，仿 git-credentials.ts）
  - `cleanupAuthJson(dataDir)` → rmSync recursive force（幂等，仿 git-credentials cleanup）
- **index.ts 接线**：dispatchCommands 对 model-credentials 打 providerID 清单日志（**token 绝不进日志**）；onCommands 回调处理——先 cleanup 上次注入目录（旧凭据明文不留存）→ writeAuthJson → `process.env.XDG_DATA_HOME = dataDir`（serve spawn env={...process.env} 自动继承，无需改 spawnServe 签名）→ restartCoordinator.requestRestart（活跃会话挂起）；**shutdown 时 cleanupAuthJson(injectedAuthDir) 兜底清理**（worker 退出明文 key 不留存，幂等）。
- **验证**：worker build 通过 + jest **17 suites / 206 tests 全绿**（基线 189 + 新增 17：injector.spec 12、contract.spec 3、index.spec 2）；server build 通过 + jest **43 suites / 632 tests 全绿**（基线 595 + 新增 37，含并行会话 C3/heartbeat 回放 + 心跳恢复回放 2 例：offline 恢复回放 / 一直 online 不重复回放）。
- **⚠️ 并行会话协作**：models.service.ts / workers.service.ts / agents.service.ts 被并行会话（C3）扩展（CRUD + available-models 接入 + heartbeat 回放），我基于其最新状态叠加 C5，未冲突。第一轮 server jest 出现 agents.service.spec TS2304（并行会话编辑中），等其完成后再跑即 630 全绿——**并行会话编辑窗口期测试失败属瞬时态**。
- **F3 端到端待验证**：注册 token → 指定 worker 定向（targetWorkerIds）→ worker 心跳取命令 → 写 auth.json（600）→ restart → opencode serve 调模型成功；全量广播 + 新 worker 注册回放两条路径单测已覆盖。

## C1: 模型目录数据层（2026-08-08，实现完成）

- **schema 变更**：新增 `Model`（id `md_` 前缀零填充，@@unique([providerID, modelID])，capabilities Json?，enabled 默认 true）+ `WorkerModelAvailability`（workerId+modelId 复合主键，双 FK RESTRICT）；`Worker.defaultModelId String? @map("default_model_id")`（worker 默认模型兜底，C8 用）；`Agent.workerId String? @map("worker_id")`（软绑定首选 worker，可空 null=自动调度，Metis R1）。**Agent.workerId 无 FK relation**——软绑定语义：worker 离线/不存在不阻断 agent 生命周期，C7 调度层运行时校验，不建数据库外键。
- **迁移**：`20260808145108_add_models_catalog`（> 20260808071700 基线），`prisma migrate dev` 对 MySQL 3307 实库成功，SQL 含 2 ALTER + 2 CREATE TABLE + 2 FK。
- **id-resync**：`md_` 前缀复用现有 `resyncIdPrefix`（工具已是通用实现，无需改码）；单测新增 mixed id 用例（md_ 数字序号 + 命名 id → 只统计数字最大续号到 9）。C3 建 ModelsService 时在 onModuleInit 调用 `resyncIdPrefix(this.prisma.model, 'md', idGen)` 即可（参照 tools.service.ts:59-60 模式）。
- **seed 预置**：`buildModelSeedRows()` 由 STATIC_AVAILABLE_MODELS 8 模型生成 models 行（防空目录回归，Metis P1-2），`md_0000000001`~`md_0000000008` 固定序号（幂等不漂移）；`TEMPLATE_DEFAULT_MODELS` 预置四模板 defaultModelId（模板只读 PATCH 403 堵死配置通道，只能 seed 预设，Metis R3）。
- **id 拆解约定**：STATIC 模型 id 含 `/`（如 `opencode-go/deepseek-v4-flash`）按首个 `/` 拆 providerID/modelID；不含 `/`（如 `deepseek-v4-pro`）providerID 归为 `opencode` 默认 provider。模板默认模型映射：产品=`opencode/glm-5.1`（通用对话）、架构=`opencode/deepseek-v4-pro`（推理）、开发=`opencode-go/deepseek-v4-flash`（代码）、测试=`opencode/glm-5.2`（推理）。
- **seed 幂等注意**：模板 upsert 必须走 `update: { defaultModelId: ... }`（不能 `update: {}`）——旧库模板行已存在（defaultModelId=null），只有 update 分支能补上预置值。
- **验证**：`npm run build` 通过；jest 40 suites / 559 tests 全绿（+2 新 spec：id-resync md_ mixed id、agent.constants seed 行断言）。实库核对：models 8 行 enabled=true、四模板 defaultModelId 就位、Worker.defaultModelId 字段可用。

## P0.2: agent-config 原型模型区增强（2026-08-08，实现 + QA 完成）

- **改动范围**：仅 `docs/agent-platform/prototypes/agent-config/index.tsx`——modelPool（4 项产品命名）替换为 modelCatalog（8 项目录语义，对齐 models-manage：providerID/modelID + name + note + enabled + credential + fingerprint）；五模板 defaultModel 映射为目录 id；模型区块新增凭据行 + 首选 worker 行；model-select/model-config/model-source-hint testid 原样保留。
- **模板默认模型映射（原型 mock 值，仅示意）**：产品→`opencode-go/deepseek-v4-flash`（通用对话）、架构→`opencode-go/deepseek-v4-pro`（推理）、开发→`zhipu/glm-5.1`（代码）、测试→`opencode-go/deepseek-v4-pro`（推理）、发布管家→`zhipu/glm-5.1`（代码）。⚠️ **与 C1 seed 预置值不一致**（C1：产品=opencode/glm-5.1、开发=opencode-go/deepseek-v4-flash 等）——原型为产品视角语义映射（flash=日常/通用、pro=推理、glm=代码），实现期 C6 的模板默认展示应跟随 **seed 预置值**（C1 是唯一事实源），勿照抄原型 mock。
- **凭据双态展示方案**：model-token-status 行依据当前选中模型 credential 条件渲染——configured 显示绿徽章 + 脱敏 fingerprint（mono，如 `sk-****d2k9`）；missing 显示灰徽章 + token 输入框（model-token-input，type=password）+ 保存按钮。模型下拉做成受控（useState selectedModelId 联动凭据态）——这是本页唯一交互（文件头注释已同步说明），其余区块保持纯静态。
- **下拉选项**：`{provider} / {name}`（如 "opencode-go / DeepSeek V4 Flash"），仅列 enabled 模型（grok-4.5 停用不可选）；option 带 data-testid="model-option-provider" + data-model-id + data-credential。
- **首选 worker**：agent-worker-select（非受控 defaultValue=""），选项 = 自动调度（默认）+ 3 个 mock worker（worker-linux-01/02 在线、worker-mac-01 离线，选项带 ·在线/离线 后缀）；说明文案「未选则自动调度到任意可用 worker（软绑定）」。
- **语义色**：credentialTheme（configured 绿 #059669/#ECFDF5/#A7F3D0、missing 灰 #64748B/#F1F5F9/#E2E8F0）页面内定义，与 models-manage 页内完全一致（"扩展 token"范式，不碰 _shared/styles）。
- **QA**：md-docs build 退出码 0；playwright 13 断言全绿（保留 testid 回归 ×3 + 新 testid ×3 + provider 前缀 + 默认已配置态 + 切换 glm-5.1 → 未配置态输入框出现 + worker 选项 4 项 + 0 console 错误）。证据 `.omo/evidence/agent-config-model-enhanced.png`。
- **QA 环境踩坑**：① 静态 build 产物（/tmp/site）运行时「0 个项目」——项目数据需 dev server 动态提供，原型走查必须用 dev server（`md-docs --host 127.0.0.1 --port <p>`，cwd=仓库根，勿传 `--docs` 指向项目本身否则扫描不到项目）；② 原型为懒加载模块，playwright goto 后需等 ≥3s（networkidle 不够）；③ 本机 playwright python 版本与 chromium-1208 不匹配，launch 需显式 executable_path 指向 chromium-1208。

## C4: model_credentials 表 + token CRUD + AES-256-GCM 加密（2026-08-08，实现 + 测试完成）

- **schema**：新增 `ModelCredential`（id `mc_` 前缀零填充，providerID **@@unique(uk_model_credentials_provider)** 按 provider 粒度、credentialRef（加密密文）、fingerprint（脱敏）、revokedAt 软删）。**不建 FK 到 models**——models.provider_id 非唯一，凭据按 provider 粒度全局唯一（auth.json 顶层键 = providerID，C5a 实测），逻辑关联经 ModelsService 按 model.providerID 解析。
- **迁移**：`20260808154421_add_model_credentials`（> C1 的 20260808145108），`prisma migrate dev` 实库 MySQL 3307 应用成功，`model_credentials` 表结构确认（provider_id UNI / credential_ref / fingerprint / revoked_at datetime(3)）。
- **加密服务**：`server/src/common/credential-crypto.service.ts`——AES-256-GCM（node:crypto 内置，无新依赖），密文格式 `ivHex:authTagHex:ciphertextHex` 三段；key 来自 env `MODEL_CREDENTIAL_KEY`（32 字节，支持 64 hex / base64 / utf8 三编码解析）；**缺失策略**：production → 启动抛错拒绝（绝不静默弱 key），development/test → 硬编码 DEV 密钥 + `logger.warn` 显式标记。fingerprint = `前4****后4`（如 `sk-a****89xz`），短 token（≤8）折半掩码。
- **端点**（`server/src/models/`，ModelsModule，路由 `/models/:id/credentials`）：
  - POST（AdminGuard）`{token, providerID?}`——按 provider 粒度 upsert（同 provider 重复 POST 覆盖更新 + 清除 revokedAt）；**providerID 校验一致策略**：body 显式提供时须与 model.providerID 一致，冲突 → 400 MODEL_PROVIDER_MISMATCH（避免 GET 按 model.providerID 查不到）。
  - GET（**成员只读**，不挂 AdminGuard——只出脱敏 fingerprint 无敏感信息）→ `{id, providerID, configured, fingerprint, revokedAt, createdAt}`；**绝不返回 credentialRef/明文 token**（明文零接触，17 篇 §3.4）。
  - DELETE（AdminGuard）→ 软删（revokedAt 标记，保留 fingerprint 审计轨迹）；未配置 → 404 MODEL_CREDENTIAL_NOT_FOUND。
  - model 不存在 → 404 MODEL_NOT_FOUND（三条端点先 resolveProviderID）。
- **续号**：`resyncIdPrefix(this.prisma.modelCredential, 'mc', idGen)`（onModuleInit），复用 C1 通用工具。
- **安全**：明文 token 只在 POST body 与 decrypt 时存在；日志只打 fingerprint；响应无明文。logger 用 `model=... provider=... fingerprint=...` 格式。
- **测试**：43 suites / **595 tests** 全绿（基线 559 + 新增 36）——credential-crypto.spec（roundtrip/随机 iv/三编码 key/错 key authTag 抛错/篡改/格式非法/生产缺 key 抛错/开发缺 key 警告可用/fingerprint 短 token）、models.service.spec（首次 create/重复 POST 覆盖更新/未配置 configured=false/providerID 冲突 400/吊销 revokedAt/404）、models.controller.spec（转发 + 无明文断言）。
- **决策记录**：遗留实现（先前会话）主体复用，修正三处与任务要求差异——① GET 由 AdminGuard 改**成员只读**（任务要求，fingerprint 非敏感）；② POST body 补 `providerID?` 可选 + 校验一致（任务要求 body {token, providerID?}）；③ 视图补 createdAt 字段（任务返回契约）。

## P0.3: 原型验收与文档同步（2026-08-08，完成）

- **build 验证**：`md-docs build --docs docs/agent-platform --out-dir /tmp/site` 退出码 0（node v22，默认 shell v18 会报 rolldown styleText 错误；验证注册无错）。⚠️ 注意 build 用 `--docs docs/agent-platform` 可以成功（前端包自带项目元信息），但 build 产物运行时「0 个项目」——项目数据由 dev server 动态注入，build 只是编译静态前端，不打包 docs 内容。
- **dev server 配置陷阱（与 P0.2 踩坑①一致，已复验）**：`md-docs --docs docs/agent-platform --host 0.0.0.0 --port 5177` 会把 docs 根直接指向项目目录 → scanner 认为 docs 下无项目（0 个项目）。**正确姿势：`md-docs --docs docs --host 0.0.0.0 --port 5177`（docs 根=仓库根下 docs/，项目=顶层子目录 agent-platform）**。修复后 192.168.10.78:5177 外部访问正常，显示「1 个项目 · 20 篇文档 · 18 个原型」。
- **models-manage 走查**：`#/p/agent-platform/protos/models-manage`（dev server 8933 内网 + 5177 外网均验证）——models-manage-root/model-list/model-search/credential-section/model-credential-input/model-credential-target-workers/model-credential-save 等 testid 断言 true；model-item/model-toggle/model-provider/model-name/model-id/model-credential-status 因列表多行返回「matched multiple elements」（属正常渲染）；0 console 错误。截图 `.omo/evidence/models-manage-proto.png`。
- **agent-config 增强区走查**：model-config/model-select/model-source-hint 既有 testid 回归通过；新增 model-token-status + agent-worker-select 可见；**model-token-input 默认不可见是预期**——受控条件渲染（仅当前选中模型 credential=missing 时才显示输入框，默认选中已配置模型故隐藏），不是缺陷。
- **全量走查 18 页**：login/project-list/task-create/task-board/group-chat/dm-chat/task-detail/agent-config/user-management/role-permission/worker-list/worker-install/skills-tools-manage/tool-register/nav-rail/nav-cmdk/nav-hybrid/models-manage 全部无 console 错误。⚠️ grep console 累积日志会误报（vite HMR/React DevTools info 命中 error 关键词），正确做法是每页 goto 前 `console --clear` 再 `console --errors`。
- **文档同步四处 17→18（/8→18）**：06 篇清单表加 models-manage 行（业务页）+ 页面范围「15 业务原型 + 3 导航方案 = 18」+ 新增 §2.13 模型目录管理页交互章节；18-原型审计报告加 §2.14 models-manage 盘点（testid 19 项）+ 汇总统计 18 + 使用矩阵 18 页 + 页面总数 18；05 篇 §3.1 交付表「18 个原型页面」+ 原型清单补 models-manage 块；docs/README.md「8 个原型」→「18 个原型」。
- **models-manage testid 清单（19 项）**：models-manage-root, manage-toolbar, model-search, model-add-button, model-list, model-item, model-toggle, model-provider, model-name, model-id, model-credential-status, credential-section, model-credential-select, model-credential-input, model-credential-select-all, model-credential-target-workers, model-credential-save, model-credential-cancel, model-hint（C6 实现页 testid diff 基准）。

### P0.3 补充（2026-08-08，验收复验）

- **dev server 实际启动参数**：5177 端口此前由 `md-docs --docs docs/agent-platform --host 0.0.0.0 --port 5177` 启动（PID 494825，cwd=仓库根），项目列表显示「0 个项目」——`--docs` 指向项目内部而非 docs 根，scanner 找不到顶层项目。**已 kill 重启为 `md-docs --docs docs --host 0.0.0.0 --port 5177`（tmux md-docs 会话）**，外部 `192.168.10.78:5177` 访问正常（1 个项目 · 18 个原型）。
- **全量走查 18 页**：全部无 console 错误。⚠️ group-chat 首轮报 4 条 `ERR_NETWORK_CHANGED`（网络波动，非代码错误），单独重测 3 次全过。走查脚本注意：`page.remove_listener` 对 lambda 包装器会 KeyError，**每页用独立 context 即可**（context.close 自动清理监听）。
- **第 5 处计数同步**：除计划内 4 处（06 清单表 / 18 审计报告 / 05 §3.1 / docs/README.md）外，`18-推进计划（分阶段实施）.md:40` 计划基线表也有「17 个原型页面」清单，已同步为 18 并补 models-manage（列在 agent-config 之后、role-permission 之前）。
- **文档渲染验证**：dev server 热更新后 playwright 断言——06 篇清单表含 models-manage 行 + 「18 个原型」；05 篇 §3.1 交付表「18 个原型页面」+ 模型目录管理；原型 tab 显示「18 个原型」+ 模型目录管理。05 篇文档 id 是 `nonfunc-acceptance`（非 `non-functional`），走查 URL 需用正确 id。

## C3: ModelsModule 目录服务（CRUD + worker 上报合并 + available-models 三路径，2026-08-09）

- **并行会话对齐**：工作区存在活跃并行会话（boulder model-management-b9263bc4）同时推进 C3/C5，已写好 DTO（create/update/query-models）+ models.service CRUD + controller CRUD + WorkersModule import ModelsModule。本会话复用其实现，统一两处与任务规格差异：① 错误码 MODEL_ID_CONFLICT → **MODEL_EXISTS**（任务要求 409 MODEL_EXISTS，前端无引用可自由对齐）；② 方法名 mergeWorkerModels → **syncFromWorkerCapabilities(workerId, models[])**（任务验收点名该名；service 定义 + register 调用 + spec 三处同步改名）。
- **ModelsService CRUD**（参照 mcp-servers 骨架）：
  - `findAll`：enabled 过滤 + providerID/modelID/name contains 搜索 + 分页 {items,total,page,pageSize}（$transaction count+findMany）
  - `create`：providerID+modelID 撞 @@unique → 先查后抛 409 MODEL_EXISTS（assertProviderModelAvailable，对齐 mcp-servers assertNameAvailable）；enabled 缺省 true；capabilities Json? 透传
  - `update`：部分更新 {name?, capabilities?, enabled?, providerID?, modelID?}；改唯一键时按合并后最终值校验并**排除自身**
  - `remove`：物理删除 + **先清 worker_model_availabilities 再删 model**（FK onDelete Restrict，非级联，需服务层显式编排）
  - `onModuleInit`：md_ + mc_ 双前缀续号（resyncIdPrefix 复用）
- **syncFromWorkerCapabilities（C3 核心集成点）**：worker 注册后 capabilities.models（string[]，providerID/modelID 格式）→ 逐条 splitModelId 拆解（含 `/` 按首个 `/` 拆，不含 → providerID=opencode）→ upsert 目录（findUnique 查存在复用，不存在 create name=modelID 默认）→ upsert availability（workerId_modelId 复合键 upsert）。**空数组/缺省 → 返回 0 不触碰目录**（C2 降级语义：未上报保留旧数据）。
- **WorkersService.register 接线**：upsert worker 后调用 `syncFromWorkerCapabilities(worker.id, dto.capabilities?.models)`，**包 try-catch 失败不阻断注册**（warn 可观测）——放在 C5 replayModelCredentials 之前。模块：WorkersModule import ModelsModule（**单向无环，ModelsService 不反向依赖 WorkersService，普通 import 无需 forwardRef**，与并行会话结论一致）。
- **getAvailableModels 三路径**（agents.service，Metis P1-2 优先级写死）：① 目录优先 listCatalogModels（enabled=true → [{id: providerID/modelID, name}]，无在线 worker 也可查）；② pull 兜底（目录空 + worker 在线 → WorkerClient.listModels）；③ STATIC fallback（两者皆空 → STATIC_AVAILABLE_MODELS + source:'fallback'）。返回结构保持纯数组 [{id,name}]（前端 agents/page.tsx 双形态兼容）。AgentsModule 新增 import ModelsModule。
- **测试**：43 suites / **630 tests** 全绿（基线 595 + 新增 35）——models.service.spec（CRUD 12 + sync 2 + listCatalog 1 + onModuleInit 改造）、models.controller.spec（CRUD 端点 5）、workers.service.spec（**集成验收**：register 上报 models → sync 透传 workerId+models 断言 + 未上报 undefined 透传 + sync 抛错不阻断注册 3 个）、agents.service.spec（三路径 5：目录优先/pull 兜底/无 worker 降级/listModels 异常/空列表）。`nest build`（tsc）通过。
- **⚠️ 提交注意**：工作区未提交改动混杂并行会话的 C5（workers.service MODEL_CREDENTIALS 命令 + replayModelCredentials + setCredential targetWorkerIds 参数）与 skills/tools 重构，本会话未执行 git commit——C3 提交 `feat(models): ModelsModule 目录服务与 available-models 接入` 需在并行会话协调后统一执行（避免把 C5 改动误带入 C3 commit）。

## C3 finalize：模块依赖修正与测试基线校正（2026-08-08）

- **⚠️ 模块依赖修正**：上一条 C3 记录写「ModelsModule 不反向依赖 WorkersService，单向 import 无需 forwardRef」——**与最终代码不符**。C5 落地后 ModelsModule 为「凭据保存后触发下发」在构造函数注入 `WorkersService`（dispatchAfterSave），ModelsService 亦被 WorkersService 依赖（注册回放 + 模型合并），**形成双向模块循环**：`models.module.ts: forwardRef(() => WorkersModule)` + `workers.module.ts: forwardRef(() => ModelsModule)`，**两边都必须 forwardRef**，任一缺失启动即报 Nest can't resolve dependencies。
- **C3 接线点（register）**：upsert worker 后 `try { await this.modelsService.syncFromWorkerCapabilities(worker.id, dto.capabilities?.models) } catch { warn 不阻断 }`，位于 C5 replayModelCredentials 之前。
- **available-models 三路径**（agents.service getAvailableModels）：目录优先 `modelsService.listCatalogModels()`（enabled=true，返回 `[{id: providerID/modelID, name}]`）→ 目录空且 worker 在线 pull 兜底 → 两者皆空 STATIC fallback；前端纯数组契约保持。
- **jest 类型严格差异**：`npx tsc --noEmit` 通过但 jest（ts-jest 更严格）报 TS2367——heartbeat 中 `status !== WORKER_STATUS.OFFLINE` 因 status 类型为 `"online"|"degraded"`（与 offline 无重叠）。修复：简化条件为 `if (worker.status === WORKER_STATUS.OFFLINE)`（新状态恒非 offline，语义等价）。
- **最终基线**：43 suites / **632 tests** 全绿（基线 595 + C3 新增 37）——models.service.spec idGen mock 改为按前缀生成（`nextId(prefix) => prefix_<seq>`），修正 sync 合并新建行 id 断言；workers.service.spec 补 ModelsService import；agents.service.spec 补 ModelsService mock + provider。`npm run build` 通过。
- **DTO 校验**：`create-model.dto.ts` 导出 `MODEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-_.]*$/`（providerID/modelID slug，update 复用 import），query-models.dto enabled 布尔 transform 对齐 mcp-servers。全局 whitelist（main.ts）已启用，无需改。

## B1（F3 CRITICAL）：凭据循环重启修复（2026-08-09，修复 + 实证完成）

- **根因（F3 实证）**：`workers.service.ts register()` **无条件调用 `replayModelCredentials(workerId)`**——凭据命令 → worker 写 auth.json → serve restart → reRegister（走同一 register()）→ 再回放 → 无限循环。实测旧镜像保存凭据后 worker 每 ~10s 重启一次（27+ 次循环），worker 详情 capabilities.models 恒为空。心跳路径有 OFFLINE 保护（仅 offline→online 回放），register 路径没有。
- **修复（`server/src/workers/workers.service.ts register()`）**：upsert 前先 `findUnique({ where: { id }, select: { status: true } })` 查原状态；回放条件改为 `if (!existing || existing.status === WORKER_STATUS.OFFLINE)`——仅首次注册（原不存在）或原 offline 时回放；已在线 worker 的 reRegister（serve 重启触发）**不回放**。与心跳路径语义一致：凭据只在 worker 首次上线或从离线恢复时下发一次。dispatchAfterSave（管理员保存后主动下发）保留不动。
- **配套修复（`worker/src/index.ts` RestartCoordinator restart 回调）**：serve 重启（随机端口变化）后须同步 `driver.baseUrl = await serveServer.restart()` 的返回值——否则 reRegister 的 resolveModels 探测打到旧端口 `fetch failed`，capabilities.models 恒空。B2（空列表预热重试）只覆盖"空列表"，不覆盖"fetch 到死端口"。
- **单测（`workers.service.spec.ts` register describe +4）**：① 首次注册（原不存在）→ 回放；② 已在线 reRegister → 不回放（modelCredential.findMany 不被调用）；③ 原 offline reRegister → 回放；④ 循环不复现（首次回放一次，在线 reRegister 不新增命令，命令不累积）。server jest **43 suites / 656 tests 全绿**（基线 652 + 4）。
- **实证（compose 13000/13001 实库）**：旧镜像保存凭据 → worker 循环重启（server 日志"模型凭据回放"刷屏 + worker 连续 execute restart）→ DELETE 凭据循环即停（replay 查 revokedAt=null 返回空）→ 部署修复后 server 保存凭据 → 45s+ 仅 1 次凭据注入重启（dispatchAfterSave 预期行为，循环切断）→ capabilities.models 上报 **26 个真实模型**，worker 稳定 online。
- **⚠️ docker cp 嵌套坑**：`docker cp <src>/dist <container>:/app/dist` 当目标已存在时**不会覆盖而是嵌套**成 `/app/dist/dist/...`（md5 不一致、容器仍跑旧代码）。正确姿势：`docker cp <src>/dist/. <container>:/app/dist/`（`.` 后缀强制覆盖内容）。且 compose worker 容器的实际工作目录是 **`/tmp/keta-worker`**（WORK_DIR），dist 拷贝目标是 `/tmp/keta-worker/dist` 而非 `/app/dist`。
- **⚠️ compose 环境构建限制**：本机 docker build 拉取 docker/dockerfile:1 frontend 元数据超时（registry-1.docker.io 不可达），无法 `docker compose build`——用"本地 `npm run build` + `docker cp` + `docker compose restart`"绕过（server 容器 dist 路径 `/app/dist`，worker 容器 `/tmp/keta-worker/dist`）。
- **⚠️ compose server 容器重启后 worker 状态**：server 容器 restart 会短暂中断 worker 心跳；markStaleWorkersOffline 仅在 status != offline 且 30s 未心跳时标 offline，worker 心跳间隔 10s，快速恢复不受影响。

## C6 拆分：Provider 管理页 + 模型列表页（纯展示）（2026-08-09，实现完成）

- **用户需求原话**：「模型列表不太对，应该不是新增模型，而是新增凭证，新增时要选择provider，输入key就好了。要有专门的凭证管理，可以列出所有的provider，已经配置凭证的显示已配置状态。点击配置弹出输入框。provider支持同步到节点。也就是现有的模型管理要分成2个页面，provider列表和模型列表，模型列表只做展示」
- **决策：前端聚合替代后端 providers 端点**——任务计划依赖「后端 GET /models/providers 聚合端点（并行任务）」，但该并行任务未交付（controller/service 无 providers 方法，spec 中 providers 仅为 Nest 测试 providers 数组）。采用前端聚合：`GET /models?pageSize=100` 拉全量 → 按 providerID 分组（Map 聚合）→ 每 provider 用**首个模型 id** 查 `GET /models/:id/credentials`（凭据按 provider 粒度 C4，同 provider 下任一模型 id 均可查询）。零后端改动、非侵入，规避 server 回归风险。
- **新页面 `web/app/(main)/providers/page.tsx`（/providers，Provider 管理）**：
  - 列表行 = providerID + 模型数 + 凭据状态徽章（**三态**：已配置绿 / 未配置灰 / 已撤销琥珀——`configured=true` 优先，否则 `revokedAt` 非空 → revoked）+ fingerprint（仅已配置显示）
  - 配置弹窗：provider 预填只读 + key 输入（password）+ 同步到节点（worker 多选，未选=全部广播 C5）+ 保存 → POST /models/:id/credentials {token, targetWorkerIds?}
  - 删除凭据（已配置/已撤销时显示）→ DELETE → 软撤销 revokedAt → 徽章变未配置
  - isAdmin 控制配置/删除；成员只读（无操作列）
  - 新增 testid 22 项：providers-root/toolbar/list/item/id/model-count/credential-status/fingerprint/configure-button/delete-button/config-modal/modal-provider/modal-key-input/modal-select-all/modal-workers/modal-save/modal-cancel/modal-error/hint/loading/error/retry
- **模型页 `web/app/(main)/models/page.tsx` 重构为纯展示**：
  - 移除：新增模型弹窗（CreateModelModal + model-add-button）、凭据配置区（credential-section + model-credential-* 全部）、启停开关（ToggleSwitch + model-toggle）
  - 保留：搜索 + 模型列表（provider/名称/模型ID/可用节点/凭据状态徽章）+ model-hint
  - enabled 改为**只读徽章 model-enabled-badge**（已启用蓝/已停用灰，替代写操作开关）
  - 共享类型提取到 `web/src/types/models.ts`（ApiModel/ModelsResponse/ApiWorker/CredentialView，原页面私有）
- **导航注册 5 处**：nav-dock NAV_ITEMS（models 后插入 providers，9 项——icons 区 overflow-y:auto 兜底不溢出）+ app-shell KEY_TO_PATH + PAGE_TITLE（models subtitle 改「模型目录只读展示」，providers 新增「凭证管理与节点同步」）+ CMDK_NAV_PATH + cmdk-panel DEFAULT_CMDK_ITEMS
- **e2e 同步**：pages.spec.ts /models 测试移除 credential-section 断言（改 model-enabled-badge + credential-section toHaveCount(0) 反断言）+ 新增 /providers 测试（列表 + 徽章 + 弹窗开合）；testids.ts models 审计页 testid 精简为 14 项展示类 + 新增 providers 审计页 22 项 + PAGE_SMOKE 双页更新
- **⚠️ TS 陷阱**：`useState(false)` 推断 boolean，存 providerID 字符串报 TS2367/TS2345——需 `useState<string | false>(false)`（双语义状态：false=关闭 / 字符串=open 的 providerID）
- **验证**：`npx tsc --noEmit` 通过 + `npm run build` 通过（/providers 路由生成）。e2e 未实跑（需 dev server + 后端），build 门已过

## D4: docker-compose 配置层对齐（WORKER_DEFAULT_MODEL + 注释同步）（2026-08-09，完成）

- **worker service 补 WORKER_DEFAULT_MODEL（C2 新增）**：environment 加 `WORKER_DEFAULT_MODEL: ${WORKER_DEFAULT_MODEL:-}`（可空占位，未设 = 空串，worker/src/config.ts:77 `(env.X ?? '').trim() || undefined` → 不指定、serve 默认）。注释说明：worker 默认模型兜底（Agent 未配模型时用，C7 模型解析优先级第 3 级）。已实测：未设 → `""`、设 `opencode-go/deepseek-v4-flash` → 透传。
- **init seed 注释**：说明用编译产物 `node dist/prisma/seed.js`（`npm run build` 产出；runner 镜像无源码不能 ts-node）——对齐 F3 修复（D1 原用 `npx prisma db seed` ts-node 编译失败）。
- **server MODEL_CREDENTIAL_KEY 注释**：模型 provider token 加密密钥（C4 AES-256-GCM，64 hex；生产必改，默认值仅本地 dev）。默认 dev key `05afa7cd...` 保留不动。
- **文件头注释**：worker 行补模型管理功能说明（WORKER_DEFAULT_MODEL 兜底 + 凭据下发注入 auth.json）。
- **验证**：`docker compose config` 通过（YAML 合法 + env 解析正确，无未定义变量警告）；未重建镜像（仅配置层更新，`docker compose up -d --build` 生效）。四服务 + init 结构未动，未加新服务。

## D6: workers 页去"新增 Worker" + curl 下载地址动态化（2026-08-09，实现 + 验证完成）

- **用户需求原话**：「worker里面，有两个添加worker的功能，去掉新增worker，只保留安装worker。另外curl安装时，下载地址需要走默认的当前页面访问地址，现在看着是一个example地址」。
- **① workers 页去"新增 Worker"（page.tsx）**：删除 `add-worker-button` 按钮（原型 testid）+ `WorkerGuide` 组件 + `GUIDE_STEPS` + `guideOpen` state + 空态自动展开 effect + `{guideOpen && <WorkerGuide/>}`——操作行仅剩 `install-worker-link`（「安装 Worker」→ /workers/install）。**决策：worker-guide 注册指引整体移除**（与 install 向导功能重叠且删除入口后无可达路径）；空态 EmptyState 文案同步改为「点击右上角安装 Worker」；文件头注释 testid 清单同步（删 add-worker-button/worker-guide）。⚠️ **workerCards 数据依赖登录 token**——playwright 浏览器旧 storageState token 过期时 workers 页显示「未认证或 token 无效/已过期」（API 401），需重新表单登录 seed-admin/Admin@123456（e2e auth.setup.ts 凭据，不是 Admin@123）。
- **② install 页 curl 下载地址动态化（install/page.tsx）**：`curlCommand` 下载 URL 从硬编码 `https://platform.example.com/install-worker.sh` 改为 **`${pageOrigin}/install-worker.sh`**；`serverUrl` 默认值从 `http://platform:8080` 改为当前 origin。**实现细节（hydration）**：pageOrigin 用 `useState("")` + `useEffect(() => setPageOrigin(window.location.origin))` 挂载后填充——直接 `useState(() => window.location.origin)` 会 SSR/hydrate 首帧不一致（mismatch 警告），空串首帧毫秒级被 effect 覆盖，可忽略；serverUrl 用第二个 effect `setServerUrl(cur => cur ? cur : pageOrigin)` 跟随 origin（用户改过就不覆盖）。
- **③ web/public/install-worker.sh（下载目标）**：一键安装脚本（`bash -n` 通过，chmod +x）。参数 `--server/--worker-id/--concurrency/--opencode/--token/--repo/--dir`；流程 = 前置校验（git/node≥18/opencode）→ `git clone --depth 1`（缺省 `git@gitee.com:xishuhq/aiagents.git`）→ npm install → 生成 .env（SERVER_URL/WORKER_ID/X_WORKER_TOKEN，不覆盖已有）→ token 校验 → build → `exec ./scripts/start.sh`。**⚠️ --concurrency 为预留参数**：worker 侧 `maxInstances` 硬编码 1（worker/src/index.ts:186，无 env 配置项），脚本仅提示不生效——已写入脚本注释与 curlSteps 文案（「拉取源码」而非「下载二进制」）。
- **e2e 同步**：pages.spec.ts 17/18 改为断言 `install-worker-link` 可见 + `add-worker-button`/`worker-guide` **toHaveCount(0)**（断言不存在元素，防回归）；testids.ts 2.13 worker-list 条目 `add-worker-button`→`install-worker-link`、删 `worker-guide`；PAGE_SMOKE /workers 同步。
- **验证**：web `npx tsc --noEmit` 0 错误 + `npm run build` 通过（/workers 4.37 kB、/workers/install 4.21 kB）；playwright 实证：workers 页 install-worker-link=1 + add-worker-button=0 + worker-guide=0 + 7 worker 卡片；install 页 curl 命令 = `curl -fsSL http://localhost:3001/install-worker.sh | bash -s -- --server http://localhost:3001 --worker-id worker-05 ...`（动态 origin 无 example）+ serverUrl 默认 http://localhost:3001；`GET /install-worker.sh` 200；e2e pages 3 项（setup + 16/17 + 17/18）全绿（8.6s）。
- **⚠️ 环境坑复现（C11 已知）**：生产 build 后 dev server ENOENT `_buildManifest.js.tmp`（.next 缓存损坏，持久 500）——修复：kill dev → `rm -rf .next` → 重启 dev（nohup 后台即可；tmux 会话 C-c 时 server 偶发整个销毁，nohup + 日志文件更稳）。

---

## QA-009/010/003: 后端校验缺陷修复（2026-08-09，实现 + 测试完成）

- **背景**：QA 报告（qa-report-192-168-10-78-13001-2026-08-09.md）三类后端校验缺陷——① POST /agents {"name":"","type":"custom"} 返回 201；② POST /workers/register 缺 capabilities → Prisma upsert 收到 undefined → 500；③ Provider key "abc" 可保存成功。
- **根因统一模式**：`@IsString()/@MaxLength()` 允许空串（empty string 是合法 string）、`@ValidateNested()/@Type()` 遇 undefined 直接跳过（不报错）→ 校验层放行，缺陷值穿透到 service/Prisma。
- **修复**：
  1. **CreateAgentDto.name + UpdateAgentDto.name** 补 `@IsNotEmpty()`（在 @IsString 后）→ 空名/显式空串 400。⚠️ `@IsOptional()` 只忽略 `undefined`/`null`，**不忽略空串**——UpdateAgentDto 补 @IsNotEmpty 后 `{name:""}` 仍被拒、缺省 name 仍可选，语义正确。
  2. **RegisterWorkerDto.capabilities + load** 补 `@IsObject() + @IsNotEmpty()`（在 @ValidateNested 前）→ 缺字段 400 非 500。worker 侧 buildCapabilities 恒返回对象、load 恒为 `{instances}`（registry-client `load: opts.load ?? {instances:0}` 兜底），加必填不破坏真实 worker 注册。
  3. **SetModelCredentialDto.token** 补 `@Matches(/^sk-[A-Za-z0-9_-]{8,}$/, {message:'token 需以 sk- 开头且至少 8 位…'})` → "abc"/无 sk- 前缀/过短 400。**决策**：用放宽版 `{8,}`（opencode 真实 token 均 sk- 前缀 + 长后缀；测试固定 token `sk-test-b1-token-0003`、`sk-raw-token` 均匹配）。
- **测试范式（沿用 tasks.controller.spec DTO 校验 describe）**：`validate(plainToInstance(cls, obj))` 断言 errors 非空/为空，比 e2e 轻量且直击 class-validator 行为：
  - agents.controller.spec 新增 5 例（create 空名/缺失/合法 + update 空串/缺省可选）
  - worker-dto.spec 新增 4 例（缺 capabilities/缺 load/标量 capabilities/完整对象通过）
  - models.controller.spec 新增 4 例（abc/无前缀/过短/合法）
- **⚠️ 全量 jest 瞬时红坑**：并行会话编辑 users.service.ts/spec 期间跑全量 jest 会报 `users.service.spec.ts` **babel 解析错误（expect '}'）**——文件被半写入的瞬时态，非代码问题；等会话写完重跑即 43 suites / 687 tests 全绿（基线 668 + 本任务 13 + 并行会话 ISSUE-002 6）。
- **验证**：`npm run build` 通过 + jest **43 suites / 687 tests 全绿**。
- **顺手加固 CloneAgentDto.name**：同类缺口（显式 `{name:""}` clone 会创建空名副本）——补 `@IsNotEmpty()` + 2 测试（空串拒/缺省过）。最终 agents.controller.spec 7 例、worker-dto.spec 4 例、models.controller.spec 4 例，合计 **+15 tests**（668 → 683，含并行会话 ISSUE-002 后 689）。

## E1: 修复 QA ISSUE-001 任务看板页头计数硬编码（2026-08-09，实现 + tsc 验证完成）

- **用户反馈（QA ISSUE-001）**：`/board?pid=...` 页头显示「任务看板 **5 个任务** · 4 个 Agent 在线」，但 `GET /projects/:pid/tasks` 实际 `total: 1`，看板各列只渲染 1 个任务卡片；项目列表卡片（`_count.tasks`）与页头、API 三方数据互不一致。
- **根因（精确定位）**：页头 subtitle 由 **AppShell 的 `PAGE_TITLE.board` 静态映射**提供（`web/src/components/layout/app-shell.tsx`），迁移时把原型 mock 值**原样硬编码**——原型 `docs/agent-platform/prototypes/task-board/index.tsx:349` 是 `subtitle={`${tasks.length} 个任务 · 4 个 Agent 在线`}`（tasks 为 mock 5 条），实现侧写成死字符串 `"5 个任务 · 4 个 Agent 在线"`，与真实数据完全脱节。**不是**看板页调错 API，board/page.tsx 的数据源（`["tasks", pid, status]` → `GET /projects/:pid/tasks`）本身就是对的，只有 AppShell 顶栏副标题写死。
- **修复方案（AppShell 动态 subtitle）**：
  1. `PAGE_TITLE.board.subtitle` 清空（死 mock 值删除），board 路由 subtitle 改由组件内动态组装。
  2. AppShell 内 `isBoard = pathname.split("/")[1] === "board"` + effect 读 `?pid=`（`new URLSearchParams(window.location.search)`，对齐 board/page.tsx 既有模式，避开 `useSearchParams` 的 Suspense 边界问题）。
  3. 两个 `useQuery`（QueryClientProvider 在 root layout，AppShell 可直接用）：
     - `["board-tasks", pid]` → `GET /projects/:pid/tasks?page=1&pageSize=1` 取 **total**（与看板页同源，三方对照基准）；
     - `["workers"]` → `GET /workers` 统计 **status !== 'offline'** 数量作为「Agent 在线」（**决策**：Agent 无在线态（agents.service 无 status 字段），Worker 才有 online/offline/degraded；「Agent 在线」映射为平台在线 worker 数，与 agents 页「在线优先」worker 语义一致）。queryKey `["workers"]` 与 agents 页同 key 同 queryFn → react-query **缓存共享非污染**（C10 教训的反面），跨页省一次请求。
  4. subtitle = `${total} 个任务 · ${onlineCount} 个 Agent 在线`；数据未就绪（total/online 任一 undefined）→ 空字符串（NavTopBar 隐藏，避免闪烁错误数字）。
  5. enabled 条件 `hydrated && !!token && isBoard`——登录水合完成 + 有 token 才发请求（AppShell 登录守卫同源判断）。
- **⚠️ 环境坑（build 并发冲突）**：本任务与并行会话（ISSUE-002 users 页面开发）同时工作——web 的 `.next` 是共享的，**两个 `next build` 同时跑会互相覆盖 `.next` 导致 ENOENT（routes-manifest.json / *_client-reference-manifest.js copyfile 失败）**，且并行会话编辑中的 users/page.tsx 会在 tsc/build 中产生瞬时 type error（`UserRow` 缺 `onEdit` prop——并行会话已修复，重跑即过）。教训：并行会话活跃期间，验证 build 须**先等对方 build 结束再独占 `.next` 跑**，或干脆只跑 tsc（tsc 不写 `.next`，无冲突）。
- **遗留观察**：项目列表卡片「{taskCount} 个任务 · **0 已完成**」的「已完成」计数（projects/page.tsx:161）仍是 `EMPTY_TASK_COUNT=0` 硬编码兜底（Phase 1 无统计端点），若项目含已完成任务会与 API 不一致——本次未处理（ISSUE-001 聚焦页头），后续可加任务状态计数端点或复用 tasks API 按 status 聚合。

## ISSUE-006: 后端权限矩阵覆盖不全修复（2026-08-09，实现 + 单测 + 运行时实证完成）

- **根因（QA 报告）**：AdminGuard 只挂在 users/roles 控制器；workers/models/skills 的 GET 仅依赖全局 JwtAuthGuard（登录即放行）；agents/projects 完全无守卫 → 受限用户（仅 3 个 view 权限点）可读 workers/models/skills、可 POST 创建 agents/projects（实测 201）。权限矩阵（8 资源 × 6 操作）实际只对 users/roles 生效。
- **决策（方案 A：精细权限模型）**：设计文档 09 篇 §2.3 明确「PermissionsModule 按角色权限矩阵（资源×操作）拦截」+ roles.constants.ts 固定 8 资源（tasks/chats/artifacts/agents/workers/skills/users/roles）× 6 操作（view/create/edit/delete/review/manage）→ 实现通用 `PermissionGuard`（`server/src/common/guards/permission.guard.ts`）+ `@RequirePermission('resource.action')` 方法级装饰器。
- **PermissionGuard 三种权限格式兼容**（对存量 seed 数据零迁移）：
  1. `permissions.all === true`（seed admin 简写）→ 全放行；
  2. `permissions.all === false`（seed member 简写）→ view 放行（成员只读）、写操作（create/edit/delete/manage）拒绝——对齐 09 篇「成员只读可见 + 写操作 [admin]」语义；
  3. 完整矩阵 `{ [resource]: { [action]: boolean } }` → 严格按权限点（缺省 false）。QA 的自定义角色（48 权限点矩阵）即此格式。
- **挂载范围（对齐 09 篇端点表）**：agents 全端点（view/create/edit/delete）；projects POST `projects.create`（8 矩阵无 projects 域 → admin/显式授权者放行、member 写拒绝）；workers GET 列表/详情 `workers.view`（09 §3.9 GET [admin]）、PATCH 保留 AdminGuard；skills GET 列表/content `skills.view`。**GET /projects 不加权限点**——09 §3.3 是 [project]（成员仅见已加入），service 层已按 userId 经 project_members 过滤，无越权语义。
- **⚠️ skills GET 双通道关键设计**：skills GET 挂 `@Public() + WorkerOrJwtGuard + PermissionGuard`。WorkerOrJwtGuard 先做两选一鉴权（X-Worker-Token 通过 → 挂 `request.workerToken`；否则走 JWT → 挂 `request.user`）。PermissionGuard 首步检测 `request.workerToken` 存在即**放行**（D1：worker token 与用户 JWT 隔离，T4b worker 注入拉取无用户上下文）——不破坏 worker 拉取；用户通道则严格校验 skills.view。实测：worker token GET /skills/:id/content → 200，受限用户同端点 → 403。
- **保持成员只读（非越权，不挂权限点）**：**models / tools / mcp-servers** 不在 8 资源矩阵（roles.constants.ts 固定 8 域，无 models/tools/mcp-servers 资源行），且 models.controller.ts 注释明示「GET（成员只读）不挂 AdminGuard——目录/凭据状态只读可见」、09 §3.8 tools GET 标记「成员只读可见」。**决策：保持成员只读，不做权限点校验**——QA 报告的 models.view 越权读是基于测试者假设的权限点，非设计语义。若未来要在矩阵中纳入这些资源，需先扩展 roles.constants.ts PERMISSION_RESOURCES。
- **模块注册**：PermissionGuard 依赖 PrismaService + Reflector（均为全局提供），挂载方模块须在 providers 注册（agents/projects/workers/skills.module.ts 均加）。
- **测试**：permission.guard.spec.ts 12 例（防御空标记/401/禁用/all:true/矩阵 true/矩阵 false 403/缺省资源 403/member 简写 view 放行 + 写拒绝/**workerToken 放行且不查用户**）+ skills.controller.spec overrideGuard(PermissionGuard)；**server 44 suites / 701 tests 全绿**（基线 689 + 新增）+ tsc 通过。
- **运行时实证（compose 13000/13001 部署，curl 受限用户）**：GET /workers 403、GET /skills 403、GET /users 403、GET /agents 200（有 agents.view）、GET /projects 200（成员过滤）、GET /models 200（成员只读）；POST /agents 403 `FORBIDDEN_PERMISSION agents.create`、POST /projects 403；admin 全通（POST agents 201）；worker token GET /skills 200。测试用户已禁用、验证 agent 已删除，受限角色保留（被引用 409，与 QA 报告遗留一致）。
- **⚠️ spec 陷阱**：permission.guard.spec.ts 的 `import { PrismaService } from '../prisma/...'` 少一级 `../`（spec 在 src/common/guards/，应为 `../../prisma/...`）会 TS2307 编译失败；给 controller 挂 PermissionGuard 后，该 controller 的 spec 必须 `overrideGuard(PermissionGuard)` 否则 compile 时 Nest 实例化守卫解析不到 PrismaService 报错。

## ISSUE-005: 前端无权限感知修复（导航过滤 + 路由守卫 + 顶栏真实角色）（2026-08-09，实现 + tsc + jest + build + 浏览器实证完成）

- **根因（QA 报告）**：受限用户（仅 tasks.view/chats.view/agents.view）登录后仍显示全部 8 项导航；直接访问 /users /roles /workers 等 URL 可进入页面（后端 403 兜底已生效但页面骨架暴露）；顶栏角色硬编码「项目管理员」（NavTopBar 默认值，AppShell 未传 userRole）。
- **数据源决策**：探索确认**登录响应 AuthUserView 原不含 permissions**（auth.service.ts toUserView 只透传 id/username/displayName/email/roleId/roleName/enabled）→ **方案：后端 toUserView 增加 permissions 字段**（`(user.role.permissions ?? {})` 兜底空对象），login/profile 的 `include: { role: true }` 本就含 permissions Json（Prisma role: true 全字段），仅接口+转换函数两处改动。前端一次登录拿到权限，无需额外 GET /roles/:id 请求。
- **前端权限判定工具（新建 web/lib/permissions.ts）**：`hasPermission(perms, resource, action='view')` + `isPlatformAdmin(perms)`，**三格式兼容对齐后端守卫语义**：`{all:true}` 全放行 / `{all:false}` 仅 view 放行（member 只读）/ 完整矩阵 `{[resource]:{[action]:bool}}` 精确匹配。isPlatformAdmin = all:true 或 `users.manage===true`（对齐 AdminGuard）。
- **导航过滤映射（app-shell.tsx NAV_VISIBLE）**：对齐**后端实际守卫语义**（ISSUE-006 实证），不是简单按 8 资源矩阵全映射：
  - 无权限点恒显示：project（GET /projects 成员过滤无权限点）、models（成员只读，models.controller 明示不挂 AdminGuard）、messages（chat.controller 无权限点仅 JWT）；
  - agents/workers/skills → 矩阵 view 权限点（PermissionGuard）；
  - users/roles → AdminGuard 语义（isPlatformAdmin）。
  - **实测受限用户（tasks/chats/agents view）导航显示 4 项：project/agents/models/messages**；member（all:false）显示 6 项（+workers/skills，view 类只读放行）。
- **路由守卫（app-shell.tsx ROUTE_GUARD）**：路由首段 → 判定（与导航同源，tools 段归 skills 资源）；无权限 → `router.replace(首个有权限导航的 KEY_TO_PATH)`（project 无权限点恒可进 → 落点 /projects）。AppShell 统一守卫（任务指定方案），复用既有 hydrated/token 登录守卫模式，effect 依赖 [hydrated, token, pathname, user, router]。
- **Cmd+K 命令面板同步过滤**：DEFAULT_CMDK_ITEMS「导航」组与导航可见性同源过滤（label→CMDK_NAV_PATH→路由段→ROUTE_GUARD），被禁路由不可从命令面板唤起；「操作」组保留。cmdk-panel.tsx 的 DEFAULT_CMDK_ITEMS 由 const 改 export，layout/index.ts 同步导出。
- **NavDock 非侵入扩展**：加 `items?: NavItem[]` 可选 prop（默认 NAV_ITEMS），收起态图标列 + 展开态列表两处 map 共用 navItems——组件保持通用无权限逻辑，过滤在 AppShell（有 authStore 上下文）。
- **顶栏角色（OBS-008）**：AppShell 传 `userRole={user ? roleLabel(user.roleName) : undefined}`，ROLE_LABEL admin→管理员/member→成员（对齐 users 页），自定义角色显示原名；NavTopBar 默认「项目管理员」仅未登录兜底。
- **旧持久化数据兼容**：authStore User.permissions 可选字段，旧 localStorage user 无 permissions → hasPermission 全 false → 导航全隐藏（保守安全）+ 受限路由全重定向。**副作用**：旧会话刷新后导航变少，重新登录即恢复（新登录响应带 permissions）——浏览器实证中实测到该行为（playwright 旧 storageState 登录后仅 3 项，重新表单登录后 8 项）。
- **验证**：server 44 suites / 702 tests 全绿（auth.service.spec +1 例 permissions 透传）；web tsc 0 错误 + build 通过；浏览器实证（本地 nest 3000 + dev 3001 代理，API_PROXY_TARGET 默认 localhost:3000）：
  - admin：8 项导航全显 + 顶栏「管理员」；
  - 受限用户 restricted-qa（新建角色「受限观察员」矩阵格式，tasks/chats/agents view）：导航 4 项（project/agents/models/messages）+ 顶栏「受限观察员」；
  - /users /workers 直达 → 重定向 /projects（重定向前页面瞬时数据请求被后端 403，双层防护）；/models 直达放行（成员只读）。
- **⚠️ 环境坑**：localhost:3000 被 root 的旧 node 进程（PID 见当时 lsof，命令行含 dist/main 或 nest 旧实例）占用——`pkill -f nest` 杀不到（命令行不匹配），需 `sudo lsof -i :3000` 定位后 `sudo kill`；新 nest 用 `nohup npm run start`（nest start 先编译 dist 再启动，dist 即新代码）。dev 3001 在 prod build 后必现 ENOENT _buildManifest.js.tmp（C11 已知），`rm -rf .next` 重启即可。受限用户/角色创建走 API（POST /roles 矩阵 + POST /users），留在本地 dev DB。

## F1: 修复「登录页立即注册死链」（ISSUE-011，2026-08-09，实现 + 浏览器实证完成）

- **根因**：`web/app/login/page.tsx` register-link 是**纯 span**（无 onClick、无 Link）——死链；`/register`、`/signup` 路由均不存在（无注册页文件）。后端 `POST /auth/register` 全链路可用（QA 报告已证：注册→登录→refresh 全通过）。
- **关键决策——注册返回结构决定跳转策略**：`AuthService.register()` 仅返回 `{id, username, displayName}`（**不含 token**，见 auth.service.ts:96-100）；`login()` 才返回 accessToken/refreshToken/user。因此注册成功后**不能直接登录**，走「跳 `/login?registered=1` → 登录页读 query 显示『注册成功，请登录』」协议。
- **RegisterDto 字段（对齐注册页表单）**：username 必填 max64、password 必填 **min6** max128、displayName **必填** max128、email 可选 @IsEmail max255——前端注册页 4 字段全对齐，前端校验含「密码至少 6 位」+ 简单邮箱正则（`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`，对齐后端 IsEmail 即时反馈）。
- **共享组件提取（设计系统复用而非复制）**：从 login/page.tsx 提取 `web/src/components/auth/BrandPanel.tsx`——导出 BrandPanel / useIsMobile / pageBg / authCardStyle / authInputStyle / authSubmitStyle / authLabelStyle 七个共享件，登录/注册两页共用，**文案与样式零改动**（纯迁移，回归风险可控）。
- **跨页面 query 协议注意（SSR 安全）**：注册成功提示不能放 useState 初始值读 `window.location.search`（SSR 时 window 未定义会崩）——必须 useEffect 内读取；且读完用 `history.replaceState` 清掉 `registered` 参数避免刷新重复提示。
- **验证**：web `npx tsc --noEmit` 0 错误 + `npm run build` 通过（/register 1.79 kB 静态生成）；playwright 浏览器实证 **9/9 PASS**（register-link 跳转→注册页 6 testid→空表单校验→短密码校验→完整注册→跳 /login?registered=1→成功提示→新账号登录→/projects→去登录链接→已登录访问 /register 重定向 /projects），0 console error；e2e login.spec **7/7 全绿**（含新增 3 例：死链修复跳转 + 两例前端校验，均不提交表单避免污染 seed）。
- **⚠️ 环境坑（沿用 C11/D6）**：build 前 kill 3001 dev + `rm -rf .next`；build 命令 5 分钟超时被杀但产物已完整（重跑增量秒过）；chromium 可执行路径是 `~/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome`（**linux64** 后缀，不是 linux）。
- **测试数据清理**：curl 探测创建的用户（`__probe_probe__`）无 DELETE API，用 server 目录 `node -e` + PrismaClient `deleteMany({where:{username}})` 直删；浏览器注册的 `qa_issue011_*` 用户保留（真实注册验证产物，member 角色无害）。

## F2: OBS-010 任务状态流转前端操作 UI（2026-08-09，实现 + tsc + build + 浏览器全链路实证完成）

- **背景**：QA 报告 OBS-010（中）——看板卡片仅 pending 有「开始任务」，in_progress/pending_review/completed 无「提交验收/验收通过/驳回/归档」按钮；任务详情页 TaskPanel 纯静态无状态操作。后端五态端点完整（tasks.controller.ts:103-154：start / mark-pending-review / accept / reject（RejectTaskDto.reason 可选 max512）/ archive），前端零调用。
- **共享组件（新建 web/src/components/tasks/task-status-actions.tsx）**：`TaskStatusActions({taskId, status})` 按五态渲染操作组（pending→start / in_progress→mark-pending-review / pending_review→accept+reject / completed→archive / archived 终态返回 null），board 卡片与详情页 TaskPanel 复用。组件内自持单 useMutation（mutationFn 按 action 拼 `/tasks/:id/:action`，reject 带 `{reason}`），onError 记错误、**onSettled 双失效 `["tasks"]` + `["task", id]` 缓存**（SSE task.status.changed 亦失效，双保险）。data-testid 对齐既有约定：start-task-button / start-task-hint / task-submit-review / task-accept / task-reject / task-archive / reject-modal / reject-reason-input / reject-confirm / reject-cancel。
- **⚠️ 关键坑：按钮冒泡**——board 卡片 section 带 `onClick → router.push(/tasks/[id])`，共享组件按钮必须 `e.stopPropagation()`（board 原 start 按钮有，迁移时易漏），否则点击操作直接跳详情页中断流程。
- **reject 原因弹窗**：复用项目 Modal 模式（absolute inset:0 相对宿主 + 遮罩点击关闭 + Esc 关闭，铁律 T15 无 fixed）——**宿主必须 position:relative**（board section 与 detail aside 均补上）；每次打开重置 reason；textarea maxLength 512 对齐 RejectTaskDto；确认提交后关闭弹窗，reason 空串转 undefined（不发空 body）。
- **board 页瘦身**：原 startState/startMutation/handleStart（乐观更新 + 回滚）整体迁入共享组件，页面删除约 60 行；「开始前检查」hint（start-task-hint + 失败红字）保留在组件内（仅 pending 且 pending/error 时展示）。共享组件不做乐观更新（依赖 invalidate + SSE 刷新，本地延迟可忽略），换取两页通用性。
- **验证**：web tsc 0 错误 + build 通过；playwright 浏览器实证 2/2 PASS（channel:"chrome" 用系统 Chrome，缓存只有 chromium-1208 而 playwright 期望 1234）：
  - 看板卡片全生命周期：start → 提交验收 → 驳回（reject-modal 填原因→确认）→ 状态回 in_progress → 提交验收 → 验收通过 → 归档 → 卡片 data-status=已归档 且无操作按钮；
  - 详情页 TaskPanel 同款按钮 + reject 弹窗（absolute 相对 aside 宿主）全链路通过；
  - reject 带 reason 请求被后端接受（DTO 校验失败会 400 显示 task-action-error），task_events 无读取端点故 reason 落库仅由状态回退间接证明。
- **⚠️ 环境坑（沿用 C11/D6/F1）**：next.config API_PROXY_TARGET 默认 localhost:3000（后端占 3000），QA 后端在 13001——验证 dev server 需 `env API_PROXY_TARGET=http://localhost:13001 npm run dev -- -p 3002`；playwright.config testMatch 白名单（pages/perf/guard...）不匹配任意新 spec 文件名 → 需临时独立 config（testDir ./e2e + testMatch 指定文件）跑验证脚本，跑完删除。种子任务 p_seed_1 仅 in_progress×1 + archived×1，全生命周期验证需先 POST /projects/p_seed_1/tasks 创建 pending 任务（agentIds 必填非空）。
