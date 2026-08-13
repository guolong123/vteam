---
title: Worker与产出物管理测试用例
id: testcases-workers-artifacts
order: 6
kind: 测试用例
description: Worker 节点注册心跳、产出物协议归档与文件上传功能测试用例（正向+反向）
---

# Worker 与产出物管理测试用例

## 1. 模块范围与环境

本文档覆盖三个模块：**Worker 节点管理（Workers）**、**产出物与文档库（Artifacts）**、**文件上传（Uploads）**，对应需求 `docs/agent-platform/03-功能需求-任务与群聊协作.md` 的 FR-26、`04-功能需求-Agent与产出物.md` §2（FR-38~43）与 §3（FR-44~46）、`06-交互与页面设计.md` §2.7/§2.11/§3.3、`09-API设计.md` §3.6/§3.9/§5.3/§5.4，以及 `12-产出物协议与文档库.md`（全篇）、`19-worker-agent-任务关系梳理.md`、`20-E2E验证问题清单.md`（P2/P3/P5 已修复点：产出物落盘、归档链路、心跳稳定）。

**测试环境**

| 项 | 值 |
|----|----|
| Web 入口 | http://192.168.10.78:13001 |
| API 入口 | http://192.168.10.78:13000/api/v1 |
| 管理员 | `admin` / `admin123`（角色 admin，`permissions: {all:true}`） |
| Worker Token | `compose-worker-token`（docker-compose.yml `WORKER_TOKEN` 默认值，Header：`X-Worker-Token`） |
| 线上 Worker | `w_compose_worker`（opencodeVersion `1.18.15`，status `online`，实测） |
| 认证方式 | 用户端点 JWT Bearer；worker 注册/心跳/事件端点用 `X-Worker-Token`，与用户 JWT 完全隔离 |

**冒烟命令**（登录拿 token 后用于 API 用例）：

```bash
curl -X POST http://192.168.10.78:13000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
# 返回 {accessToken, refreshToken, user}
```

**实现与需求差异说明**（用例预期均以**实际实现为准**，关键分支已在上线环境实测）：

1. `09 §3.9` 的 `POST /workers/:id/stop`、`POST /workers/:id/kill` **实际实现为** `POST /workers/:id/restart`、`POST /workers/:id/shutdown`（`workers.controller.ts`）。shutdown 双管齐下：立即将 worker 标 `offline`（调度器停止分配）+ 心跳下行 `SHUTDOWN` 命令触发优雅退出；restart 仅入队 `RESTART` 命令（经心跳下行，worker 侧 RestartCoordinator 重启 serve）。
2. `GET /workers` **实际返回数组（无分页）**，非 09 §2.2 的 `{items, total}` 结构（`findAll` 全量返回，按 `registeredAt` 倒序）；`GET /workers/:id` 返回含 `mcpStatus`（worker 心跳上报的 MCP 三态内存态，T9），而非需求所述「任务组实例列表」。
3. **worker 事件回流端点** `POST /api/v1/worker/events`（单数 worker，`worker-events.controller.ts`，X-Worker-Token 鉴权）恒返回 `202 Accepted`：未注册 workerId → 404 `WORKER_NOT_FOUND`；同一 `(workerId, eventId)` 重复投递被内存去重窗口（最近 1000 条）跳过；`task.completed`/`message.part.delta` 等的落库与广播由 `WorkerEventIngress` 消费。
4. `GET /tasks/:id/artifacts` 对**不存在的任务返回 200 空列表**（无任务存在校验，实测 `{items:[],total:0}`）；而 `POST /tasks/:id/artifacts` 归档到不存在任务会因 `Artifact.taskId` 外键约束（schema `onDelete: Restrict`）触发数据库错误（500），非 404。
5. 产出物列表**无 `search?` 参数**：`QueryArtifactsDto` 仅含 `type`/`accepted`/`page`/`pageSize`（`12 §6.1` 提及的名称筛选未实现）。
6. 产出物端点仅挂 `artifacts.view` / `artifacts.create` 权限点（`PermissionGuard`），**未实现 09 §2.3 的 `[project]` 项目成员校验**：member 角色（`{all:false}`）对 `view` 放行、对 `create` 拒绝，即成员可查看任意任务产出物列表（跨项目也可见，属实现现状）。
7. **doc/file 产出物落盘**（P2 修复）：worker 回流携带真实内容（`content` 非空）时经 `FileStorageService.saveTextFile` 落盘 `server/uploads/` 生成可访问 `/uploads/<uuid>.<ext>` URL，替换 worker 容器路径占位；仅 `fileRef` 无 `content` 时 `fileUrl` 归一化为 `/uploads/<basename>`，磁盘缺失则 `fileSize=null`，前端降级为纯文本展示（不再渲染死链）。
8. **上传大小上限为 10MB**（`uploads.constants` `FILE_SIZE_LIMIT`），非 12 篇 §5.2 所述 50MB（50MB 是控制面拉取产出物的协议上限，上传端点不适用）；类型白名单按**扩展名**校验：pdf/doc/docx/xls/xlsx/csv/png/jpg/jpeg/gif/md/txt。
9. 心跳响应实际为 `{workerId, status, lastHeartbeatAt, commands?}`（携带下行命令数组，pull 模型，一次有效）；离线判定 30s（10s 心跳 × 3 周期，`WORKER_OFFLINE_TIMEOUT_MS=30_000`），HealthChecker 每 10s 扫描。
10. `PATCH /workers/:id` 请求体仅 `{defaultModelId?}`（C8 默认模型配置）：非空须存在于 models 目录且 enabled，否则 400 `MODEL_NOT_FOUND`；`null`=清除；缺省=幂等跳过。
11. **无扩展名文件上传被拒**：原用例预期「无扩展名上传 201、纯 UUID 文件名」，实际 `uploads.service.ts` 校验 `!ext` 直接拦截（400 `UPLOAD_FILE_TYPE_NOT_ALLOWED`，白名单仅接受扩展名文件），`TC-UPL-055` 已按实现改为反向用例。

**执行安全提示**：

- `POST /workers/:id/restart`、`POST /workers/:id/shutdown` 会真实作用于线上 worker，**用例标注「需谨慎执行」**——默认仅验证权限/404/参数校验分支，不真实重启/下线 `w_compose_worker`。
- 离线判定（TC-WKR-007）会中断线上 worker 心跳，**需谨慎执行**，建议用临时注册的测试 worker 验证，或用 20 篇 P5 的已修复结论做回归依据。
- 产出物/文件用例会真实写盘（uploads volume），执行后建议清理创建的测试数据。

---

## 2. Worker 节点管理用例（TC-WKR）

> workers 用户侧端点挂 `PermissionGuard`：`GET /workers`、`GET /workers/:id` 需 `workers.view`，`PATCH /workers/:id`、`POST /workers/:id/restart`、`POST /workers/:id/shutdown` 需 `workers.edit`（admin `{all:true}` 全部放行；member `{all:false}` 仅 view 放行）。`register`/`heartbeat`/`events` 挂 `WorkerTokenGuard`（X-Worker-Token），与用户 JWT 隔离。所有响应**不含 tokenHash**。以下 API 用例默认前置条件为「已用 `admin`/`admin123` 登录获得 admin accessToken」与「Worker Token = `compose-worker-token`」。

### 2.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-WKR-001 | Worker 注册成功并入池（FR-26） | 正向 | P0 | 可用 Worker Token；测试 workerId `w_test_reg_<ts>` | 1. `POST /api/v1/workers/register`，Header：`X-Worker-Token: compose-worker-token`，body：`{"workerId":"w_test_reg_<ts>","name":"测试worker","opencodeVersion":"1.18.15","capabilities":{"maxInstances":1,"skills":[],"tools":["bash"],"models":["opencode/deepseek-v4-flash-free"]},"load":{"instances":0}}`<br>2.（联动）`GET /api/v1/workers` 查看 | 1. 返回 `201 Created`，响应体为 `{workerId, heartbeatIntervalMs, serverTime}`，`heartbeatIntervalMs=10000`<br>2. 列表出现该 worker，`status=online`、`lastHeartbeatAt` 非空（注册即入池，调度器立即可用）<br>3. 注册时上报的 `capabilities.models` 合并入库 |
| TC-WKR-002 | 重复注册更新能力声明（upsert） | 正向 | P0 | `TC-WKR-001` 已注册 `w_test_reg_<ts>` | 1. 再次 `POST /api/v1/workers/register`，同 workerId，`opencodeVersion` 改为 `1.18.16`、`capabilities.maxInstances` 改为 `2` | 1. 返回 `201 Created`（upsert 语义，不因已存在报错）<br>2. `GET /workers` 中该 worker `opencodeVersion=1.18.16`、`maxInstances=2`（能力声明被覆盖更新）<br>3. worker 换 token 重新注册时 `tokenHash` 同步更新（心跳鉴权以新 token 为准） |
| TC-WKR-003 | 心跳正常上报刷新状态与负载 | 正向 | P0 | worker `w_test_reg_<ts>` 已注册在线 | 1. `POST /api/v1/workers/w_test_reg_<ts>/heartbeat`，Header：`X-Worker-Token`，body：`{"workerId":"w_test_reg_<ts>","load":{"instances":1},"health":"ok"}` | 1. 返回 `200 OK`，响应体 `{workerId, status:"online", lastHeartbeatAt}`<br>2. `GET /workers` 中该 worker `load.instances=1`、`status=online`、`lastHeartbeatAt` 刷新为最新时间 |
| TC-WKR-004 | 心跳上报 degraded 进入降权态 | 正向 | P1 | worker `w_test_reg_<ts>` 已注册 | 1. `POST /api/v1/workers/w_test_reg_<ts>/heartbeat`，body：`{"workerId":"w_test_reg_<ts>","load":{"instances":0},"health":"degraded"}` | 1. 返回 `200 OK`，`status:"degraded"`<br>2. 调度器 `assignWorker` 中 degraded 仍为候选但**降权排后**（仅无 online worker 时才被选中）；degraded 不改变 30s 离线判定 |
| TC-WKR-005 | Worker 列表展示运维字段（admin） | 正向 | P0 | admin accessToken；存在已注册 worker | 1. `GET /api/v1/workers` | 1. 返回 `200 OK`，为**数组**（无分页），按 `registeredAt` 倒序<br>2. 每项含 `id/name/opencodeVersion/capabilities/load/status/lastHeartbeatAt/registeredAt/defaultModelId/mcpStatus`，**不含 tokenHash**<br>3. `status` 字段为 `online`/`degraded`/`offline` 之一（实测线上 `w_compose_worker` 为 `online`） |
| TC-WKR-006 | Worker 详情（admin） | 正向 | P1 | admin accessToken；worker `w_compose_worker` | 1. `GET /api/v1/workers/w_compose_worker` | 1. 返回 `200 OK`，字段与列表项一致且含 `mcpStatus` 数组（worker 心跳上报的 MCP 三态快照；未上报为空数组）<br>2. 不含 tokenHash |
| TC-WKR-007 | 心跳超时自动判离线（30s 无心跳） | 正向 | P0 | 临时注册测试 worker（**需谨慎执行**，勿中断线上 worker 心跳） | 1. 注册 `w_test_offline_<ts>` 后**停止发送心跳**<br>2. 等待 ≥40s（10s 扫描周期 × 3 周期 = 30s 阈值 + 容差）<br>3. `GET /api/v1/workers` | 1. 测试 worker `status` 变为 `offline`（HealthChecker 仅更新 `status != offline 且 lastHeartbeatAt < now-30s` 的行）<br>2. `assignWorker` 调度候选排除 offline worker（其任务组进入待重调度）<br>3. 验证后清理测试 worker |
| TC-WKR-008 | 配置 worker 默认模型（C8） | 正向 | P1 | admin accessToken；worker 存在；`models` 目录存在可用模型 `opencode/deepseek-v4-flash-free` | 1. `PATCH /api/v1/workers/w_test_reg_<ts>`，body：`{"defaultModelId":"opencode/deepseek-v4-flash-free"}` | 1. 返回 `200 OK`，响应 worker 视图 `defaultModelId="opencode/deepseek-v4-flash-free"`<br>2. 该 worker 在 `assignWorker` 的模型过滤中作为兜底默认模型参与匹配 |
| TC-WKR-009 | 清除 worker 默认模型（null） | 正向 | P2 | admin accessToken；worker 已配默认模型 | 1. `PATCH /api/v1/workers/w_test_reg_<ts>`，body：`{"defaultModelId":null}` | 1. 返回 `200 OK`，`defaultModelId=null`（清除成功）<br>2.（变体）body 缺 `defaultModelId` 时返回 200 且值不变（缺省=幂等跳过） |
| TC-WKR-010 | 远程重启命令经心跳下行入队 | 正向 | P1 | admin accessToken；worker `w_test_reg_<ts>` 在线 | 1. `POST /api/v1/workers/w_test_reg_<ts>/restart`（**需谨慎执行**，仅验证入队语义） | 1. 返回 `200 OK`，响应体 `{workerId, command:"restart", queued:true}`（命令一次有效，worker 心跳取出即清空）<br>2. 该 worker 下一次心跳响应 `commands` 数组含 `{type:"restart"}`（RESTART 命令经 T4a pull 模型下行，worker 侧 RestartCoordinator 重启 serve 并 reRegister） |
| TC-WKR-011 | 远程下线：立即标 offline + 命令下发 | 正向 | P1 | admin accessToken；worker `w_test_reg_<ts>` 在线 | 1. `POST /api/v1/workers/w_test_reg_<ts>/shutdown`（**需谨慎执行**，仅验证入队语义） | 1. 返回 `200 OK`，响应体 `{workerId, command:"shutdown", queued:true, status:"offline"}`<br>2. `GET /workers` 中该 worker 立即为 `offline`（调度器停止分配新任务）<br>3. 心跳响应含 SHUTDOWN 命令，worker 优雅退出进程（停心跳 + flush 事件 + stop serve + exit） |
| TC-WKR-012 | Worker 节点页功能走查（Web） | 正向 | P0 | 浏览器可用 `admin`/`admin123` 登录 | 1. 登录后点击侧边栏「Worker 节点」<br>2. 查看节点列表（状态/opencode 版本/能力/负载/健康）<br>3. 点击「新增 Worker」查看安装引导<br>4. 查看节点行内启停操作 | 1. 列表逐行展示 Worker 状态（在线/离线）、opencode 版本、能力声明、负载与健康状态，离线节点以醒目标签标记并提示任务组待重调度（FR-26）<br>2. 「新增 Worker」展示 serverUrl/workerId/能力声明配置方式（对齐 worker-install 原型）<br>3. 行内提供优雅停止/强制终止入口（对应 restart/shutdown 端点） |

### 2.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-WKR-013 | 注册：无 / 错误 X-Worker-Token | 反向 | P0 | 无 | 1. `POST /api/v1/workers/register`，body 完整但**不带** `X-Worker-Token`<br>2.（变体）带 `X-Worker-Token: wrong-token` | 1. 均返回 `401 Unauthorized`，`code=WORKER_TOKEN_INVALID`，message「X-Worker-Token 无效」（实测）<br>2. worker 未注册（列表不出现） |
| TC-WKR-014 | 注册：缺少必填字段 | 反向 | P0 | 可用 Worker Token | 1. `POST /api/v1/workers/register`，body：`{"workerId":"w_test_bad_<ts>","opencodeVersion":""}`（缺 capabilities/load） | 1. 返回 `400 Bad Request`，message 数组同时列出 `opencodeVersion should not be empty`、`capabilities should not be empty / must be an object`、`load should not be empty / must be an object`（class-validator，实测）<br>2. worker 未注册 |
| TC-WKR-015 | 注册：能力/负载字段非法 | 反向 | P1 | 可用 Worker Token | 1. `POST /api/v1/workers/register`，body：`{"workerId":"w_test_bad_<ts>","opencodeVersion":"1.18.15","capabilities":{"maxInstances":-1,"skills":"not-array","tools":[]},"load":{"instances":0}}`<br>2.（变体）`capabilities.maxInstances` 传字符串 `"1"` | 1. 返回 `400 Bad Request`（`@IsInt`/`@Min(0)`/`@IsArray` 校验失败，`maxInstances` 负数或非整数均被拒）<br>2. worker 未注册 |
| TC-WKR-016 | 心跳：worker 不存在 | 反向 | P0 | 可用 Worker Token | 1. `POST /api/v1/workers/w_not_exist/heartbeat`，Header：`X-Worker-Token: compose-worker-token`，body：`{"workerId":"w_not_exist","load":{"instances":0},"health":"ok"}` | 1. 返回 `404 Not Found`，`code=WORKER_NOT_FOUND`，message「Worker w_not_exist 不存在」（实测） |
| TC-WKR-017 | 心跳：X-Worker-Token 错误 | 反向 | P0 | worker `w_compose_worker` 在线 | 1. `POST /api/v1/workers/w_compose_worker/heartbeat`，Header：`X-Worker-Token: wrong-token`，body：`{"workerId":"w_compose_worker","load":{"instances":0},"health":"ok"}` | 1. 返回 `401 Unauthorized`，`code=WORKER_TOKEN_INVALID`，message「X-Worker-Token 无效」（实测）<br>2. worker 状态/心跳时间不被更新 |
| TC-WKR-018 | 心跳：共享 token 正确但与该 worker 注册 tokenHash 不匹配 | 反向 | P0 | 用 token A 注册的测试 worker（**需谨慎执行**，避免误伤线上 worker） | 1. 用 token A 注册 `w_test_tok_<ts>`<br>2. 改用 token B 调 `POST /api/v1/workers/w_test_tok_<ts>/heartbeat`，body health=ok | 1. 返回 `401 Unauthorized`，`code=WORKER_TOKEN_INVALID`，message「X-Worker-Token 与 worker … 注册 token 不匹配」（F2 M2：guard 只校验共享 token，service 再比对注册时落库的 bcrypt tokenHash，防共享 token 持有者冒充任意已注册 workerId）<br>2. 心跳不生效 |
| TC-WKR-019 | 心跳：health 非法 / workerId 缺失 | 反向 | P1 | worker `w_compose_worker` 在线 | 1. `POST /api/v1/workers/w_compose_worker/heartbeat`，body：`{"workerId":"w_compose_worker","load":{"instances":0},"health":"fatal"}`<br>2.（变体）body 缺 `workerId` | 1. 第 1 步返回 `400 Bad Request`，message 含 `health must be one of the following values: ok, degraded`（实测）<br>2. 第 2 步返回 `400 Bad Request`（`@IsNotEmpty` 校验失败）<br>3. 均不更新 worker 状态 |
| TC-WKR-020 | 列表：未认证访问 | 反向 | P0 | 无 token | 1. `GET /api/v1/workers`（不带 Authorization 头） | 1. 返回 `401 Unauthorized`，`code=AUTH_UNAUTHORIZED`，message「未认证或 token 无效/已过期」（实测） |
| TC-WKR-021 | 管理操作：非管理员越权 | 反向 | P0 | 已用 `seed-member`/`Admin@123456` 登录拿到 member accessToken | 1. `GET /api/v1/workers`（member token）<br>2.（变体）`PATCH /api/v1/workers/w_compose_worker`，body：`{"defaultModelId":null}`（member token）<br>3.（变体）`POST /api/v1/workers/w_compose_worker/restart`（member token） | 1. 第 1 步返回 `200 OK`（member 简写 `{all:false}` 对 `view` 放行，运维只读）<br>2. 第 2/3 步返回 `403 Forbidden`，`code=FORBIDDEN_PERMISSION`，message「缺少 workers.edit 权限」（write 操作被拒） |
| TC-WKR-022 | 详情：worker 不存在 | 反向 | P1 | admin accessToken | 1. `GET /api/v1/workers/w_not_exist` | 1. 返回 `404 Not Found`，`code=WORKER_NOT_FOUND`，message「Worker w_not_exist 不存在」 |
| TC-WKR-023 | 配置默认模型：worker 不存在 | 反向 | P1 | admin accessToken | 1. `PATCH /api/v1/workers/w_not_exist`，body：`{"defaultModelId":"opencode/deepseek-v4-flash-free"}` | 1. 返回 `404 Not Found`，`code=WORKER_NOT_FOUND` |
| TC-WKR-024 | 配置默认模型：模型不存在 / 已停用 | 反向 | P1 | admin accessToken；worker 存在 | 1. `PATCH /api/v1/workers/w_test_reg_<ts>`，body：`{"defaultModelId":"provider/not-exist-model"}` | 1. 返回 `400 Bad Request`，`code=MODEL_NOT_FOUND`，message「默认模型 … 不存在于可用模型目录（或已停用）」<br>2. worker 的 `defaultModelId` 不变 |
| TC-WKR-025 | 重启 / 下线：worker 不存在 | 反向 | P1 | admin accessToken | 1. `POST /api/v1/workers/w_not_exist/restart`<br>2.（变体）`POST /api/v1/workers/w_not_exist/shutdown` | 1. 均返回 `404 Not Found`，`code=WORKER_NOT_FOUND`<br>2. 不产生任何下行命令 |
| TC-WKR-026 | 事件回流：X-Worker-Token 错误 | 反向 | P0 | worker `w_compose_worker` 在线 | 1. `POST /api/v1/worker/events`，Header：`X-Worker-Token: wrong-token`，body：`{"workerId":"w_compose_worker","eventId":"evw_1","type":"session.updated","payload":{"sessionId":"s_x","status":"idle"},"seq":1}` | 1. 返回 `401 Unauthorized`，`code=WORKER_TOKEN_INVALID`（实测）<br>2. 事件不被消费 |
| TC-WKR-027 | 事件回流：worker 未注册 | 反向 | P0 | 可用 Worker Token | 1. `POST /api/v1/worker/events`，Header：`X-Worker-Token: compose-worker-token`，body：`{"workerId":"w_ghost","eventId":"evw_1","type":"session.updated","payload":{"sessionId":"s_x","status":"idle"},"seq":1}` | 1. 返回 `404 Not Found`，`code=WORKER_NOT_FOUND`，message「Worker w_ghost 不存在（未注册）」（实测；未注册 workerId 的事件直接拒绝，防伪造注入） |
| TC-WKR-028 | 事件回流：非法事件 type / 缺字段 | 反向 | P1 | 已注册测试 worker `w_test_reg_<ts>` | 1. `POST /api/v1/worker/events`，Header：`X-Worker-Token`，body：`{"workerId":"w_test_reg_<ts>","eventId":"evw_1","type":"no.such.type","payload":{},"seq":1}`<br>2.（变体）body 缺 `eventId` | 1. 均返回 `400 Bad Request`（`@IsIn` 枚举校验 / `@IsNotEmpty` 校验失败）<br>2. 事件不被消费 |

---

## 3. 产出物与文档库用例（TC-ART）

> artifacts 端点挂 `PermissionGuard`：读端点（`GET /tasks/:id/artifacts`、`GET /artifacts/:id`、`GET /artifacts/:id/versions/:version`）需 `artifacts.view`，旁路补充提交 `POST /tasks/:id/artifacts` 需 `artifacts.create`（member 简写 `{all:false}`：view 放行、create 拒绝）。产出物落库主路径是事件驱动回流（worker `task.completed` / `message.part.delta`），本模块的 `POST /tasks/:id/artifacts` 仅为成员/主 Agent 手动补充提交的**旁路入口（P1）**。以下 API 用例默认前置条件为「已用 `admin`/`admin123` 登录获得 admin accessToken；已存在一个任务（如 `t_0000000009`）」。

### 3.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-ART-029 | 手动提交结论文本产出物（旁路，FR-40） | 正向 | P0 | admin accessToken；任务 `t_0000000009` | 1. `POST /api/v1/tasks/t_0000000009/artifacts`，body：`{"type":"text","title":"验收结论","content":"接口耗时已定位为慢查询"}`<br>2.（联动）`GET /api/v1/tasks/t_0000000009/artifacts` | 1. 返回 `201 Created`，响应 `{status:"archived", artifact:{id, taskId, type:"text", title:"验收结论", currentVersion:1, acceptedFlag:false, createdAt, updatedAt}}`<br>2. 列表出现该产出物，`currentVersion=1`<br>3. `GET /artifacts/<id>/versions/1` 返回正文「接口耗时已定位为慢查询」、`sha256` 为内容哈希非空 |
| TC-ART-030 | 同标题再次提交 append 新版本（FR-43） | 正向 | P0 | 任务已有产出物「验收结论」v1（`TC-ART-029`） | 1. `POST /api/v1/tasks/t_0000000009/artifacts`，body：`{"type":"text","title":"验收结论","content":"v2 修订：同时修复了连接池超时"}` | 1. 返回 `201 Created`，`artifact.currentVersion=2`（同 taskId+type+title 合并 append，**不覆盖** v1）<br>2. `GET /artifacts/<id>` 的 `versions` 列表含 v1 与 v2 两条，`currentVersion=2`<br>3. 版本演进可追溯（`createdAt` 递增） |
| TC-ART-031 | 不同标题提交新建独立产出物 | 正向 | P1 | admin accessToken；任务 `t_0000000009` | 1. `POST /api/v1/tasks/t_0000000009/artifacts`，body：`{"type":"text","title":"设计文档","content":"架构说明"}` | 1. 返回 `201 Created`，新建产出物 `currentVersion=1`（新标题不并入「验收结论」）<br>2. 列表 `total` 增加 1，两个产出物各自独立 |
| TC-ART-032 | doc 产出物带内容落盘 uploads 生成可访问 URL（P2 修复） | 正向 | P0 | admin accessToken；任务存在 | 1. `POST /api/v1/tasks/t_0000000009/artifacts`，body：`{"type":"doc","title":"需求文档","fileRef":"/tmp/opencode/req.md","content":"# 需求\n本文档经平台落盘"}`<br>2.（联动）`GET /api/v1/artifacts/<id>/versions/1` | 1. 返回 `201 Created`，`status:"archived"`<br>2. 版本 DTO 含 `fileUrl`（`/uploads/<uuid>.md` 格式）、`fileName`、`fileExt="md"`、`fileSize` 非空（磁盘真实存在）——worker 容器路径占位 `/tmp/opencode/req.md` 被可访问 URL 替换<br>3. `GET <fileUrl>`（经 `/api/v1` 或静态服务）返回 200 且内容为「# 需求\n本文档经平台落盘」 |
| TC-ART-033 | file 产出物带内容落盘（附件形态） | 正向 | P1 | admin accessToken；任务存在 | 1. `POST /api/v1/tasks/t_0000000009/artifacts`，body：`{"type":"file","title":"补丁文件","fileRef":"/tmp/opencode/patch.txt","content":"diff --git a/x b/x"}` | 1. 返回 `201 Created`，版本 DTO 含 `fileUrl="/uploads/<uuid>.txt"`、`fileSize` 非空、`sha256` 非空<br>2. 下载 `GET <fileUrl>` 返回 200，内容一致 |
| TC-ART-034 | 相同内容重复提交幂等去重（sha256） | 正向 | P0 | 任务已有产出物「验收结论」v2 | 1. 再次 `POST /api/v1/tasks/t_0000000009/artifacts`，body：`{"type":"text","title":"验收结论","content":"v2 修订：同时修复了连接池超时"}`（与 `TC-ART-030` 完全相同内容） | 1. 返回 `201 Created`，`status:"duplicate"`（同 taskId+type+sha256 已归档 → 跳过，**版本不增**）<br>2. `GET /artifacts/<id>` 的 `currentVersion` 仍为 2（幂等，对齐 09 §5.4 去重语义） |
| TC-ART-035 | 文档库列表返回分页结构（FR-44） | 正向 | P0 | 任务已有若干产出物 | 1. `GET /api/v1/tasks/t_0000000009/artifacts?page=1&pageSize=2` | 1. 返回 `200 OK`，结构 `{items, total, page, pageSize}`（page=1、pageSize=2）<br>2. `items` 元素含 `id/taskId/type/title/currentVersion/acceptedFlag/authorAgentId/createdAt/updatedAt`，按 `createdAt` 倒序<br>3. `total` 为该任务产出物总数（不因分页变化） |
| TC-ART-036 | 列表按类型筛选（type=doc） | 正向 | P1 | 任务同时有 text 与 doc 产出物 | 1. `GET /api/v1/tasks/t_0000000009/artifacts?type=doc` | 1. 返回 `200 OK`，仅含 `type="doc"` 的产出物，`total` 与 doc 数量一致 |
| TC-ART-037 | 列表按验收状态筛选（accepted） | 正向 | P1 | 任务中既有已验收又有未验收产出物（经 `POST /tasks/:id/accept` 联动验收） | 1. `GET /api/v1/tasks/t_0000000009/artifacts?accepted=true`<br>2.（变体）`?accepted=false` | 1. 第 1 步仅返回当前版本 `acceptedFlag=true` 的产出物<br>2. 第 2 步仅返回 `acceptedFlag=false` 的产出物（按 currentVersion 的 acceptedFlag 过滤） |
| TC-ART-038 | 产出物详情 + 全版本列表（FR-45） | 正向 | P0 | 任务有含多版本的产出物（如「验收结论」v1/v2） | 1. `GET /api/v1/artifacts/<id>` | 1. 返回 `200 OK`：`{id, taskId, type, title, currentVersion, createdAt, updatedAt, versions[]}`<br>2. `versions` 按 `version` 升序，每条含 `id/artifactId/version/contentRef/filePath/sha256/acceptedFlag/authorAgentId/changeNote/createdAt`<br>3. `currentVersion` 指向最新版本 |
| TC-ART-039 | 指定版本内容查看与历史回看 | 正向 | P0 | 产出物含 v1/v2 | 1. `GET /api/v1/artifacts/<id>/versions/1`<br>2.（变体）`GET /api/v1/artifacts/<id>/versions/2` | 1. 均返回 `200 OK`<br>2. v1 返回首次内容、v2 返回修订内容（历史版本内容各自保留，可回看）<br>3. text 返回 `contentRef` 为正文；doc/file 返回 `fileUrl` 下载地址 |
| TC-ART-040 | doc 产出物下载链接可访问（文档库闭环） | 正向 | P0 | `TC-ART-032` 已归档 doc 产出物 | 1. 从版本 DTO 取 `fileUrl`<br>2. `GET http://192.168.10.78:13000/api/v1/<fileUrl>`（或静态 `/uploads/...`） | 1. 返回 `200 OK`，`Content-Type` 与文件类型匹配，响应体与归档内容一致（20 篇 P2 已修复：doc/file 不再 404）<br>2. `sha256` 与归档时一致、`fileSize` 非空 |
| TC-ART-041 | 已完成任务追加产出物自动退回进行中（验收联动） | 正向 | P1 | 任务状态为 `completed`（经验收完成）；admin accessToken | 1. `POST /api/v1/tasks/<已完成任务id>/artifacts`，body：`{"type":"text","title":"验收后更新","content":"新版本产出"}`<br>2.（联动）`GET /api/v1/tasks/<id>` | 1. 返回 `201 Created`，产出物归档成功<br>2. 任务状态自动退回 `in_progress`（`task.updateMany where status=completed` → `in_progress`，版本号 increment）<br>3. 广播 `task.status.changed`（前端实时刷新）；新版本需重新验收（FR-04 验收后更新） |
| TC-ART-042 | 任务详情文档库页功能走查（Web） | 正向 | P0 | 浏览器可用 `admin`/`admin123` 登录；任务有产出物 | 1. 进入任务详情页<br>2. 查看 Tab 栏（群聊/产出物/文档库）与产出物数量<br>3. 点击文档库列表项，右侧查看器打开<br>4. 在版本历史间切换（v1/v2） | 1. 文档库默认激活并显示产出物数量（产出物与文档库同源两种视图，FR-42）<br>2. 列表项标注类型（结论文本/文档/文件）与版本，点击后右侧查看器展示内容<br>3. 版本切换在当前版本高亮，历史版本内容可回看（FR-45）<br>4. 文档只读，无编辑/删除入口（FR-43 边界） |

### 3.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-ART-043 | 提交：产出物类型非法 | 反向 | P0 | admin accessToken；任务存在 | 1. `POST /api/v1/tasks/t_0000000009/artifacts`，body：`{"type":"video","title":"x","content":"y"}`<br>2.（变体）body 缺 `type` | 1. 均返回 `400 Bad Request`，`code=ARTIFACT_INVALID_DECLARATION`（type 必填且枚举 text/doc/file；回退普通消息语义，不产生归档记录）<br>2. 列表 `total` 不变 |
| TC-ART-044 | 提交：标题缺失 / 空白 | 反向 | P0 | admin accessToken；任务存在 | 1. `POST /api/v1/tasks/t_0000000009/artifacts`，body：`{"type":"text","content":"无标题内容"}`<br>2.（变体）`"title":"   "` | 1. 均返回 `400 Bad Request`，`code=ARTIFACT_INVALID_DECLARATION`，message「title 必填且非空字符串」<br>2. 不产生归档 |
| TC-ART-045 | 提交：content/fileRef 交叉校验失败 | 反向 | P1 | admin accessToken；任务存在 | 1. `POST /api/v1/tasks/t_0000000009/artifacts`，body：`{"type":"text","title":"x"}`（text 缺 content）<br>2.（变体）`{"type":"doc","title":"x"}`（doc 缺 fileRef）<br>3.（变体）`{"type":"file","title":"x"}`（file 缺 fileRef） | 1. 均返回 `400 Bad Request`，`code=ARTIFACT_INVALID_DECLARATION`（text→content 必填；doc/file→fileRef 必填）<br>2. 不产生归档记录 |
| TC-ART-046 | 归档到不存在的任务（外键约束） | 反向 | P1 | admin accessToken | 1. `POST /api/v1/tasks/t_not_exist/artifacts`，body：`{"type":"text","title":"孤儿产出物","content":"x"}` | 1. 返回 `5xx`（`Artifact.taskId` 外键 `onDelete: Restrict` 触发数据库约束错误；实现无任务存在前置校验，非 404）<br>2. 数据库中不残留孤儿产出物行 |
| TC-ART-047 | 产出物详情：不存在 | 反向 | P0 | admin accessToken | 1. `GET /api/v1/artifacts/art_x` | 1. 返回 `404 Not Found`，`code=ARTIFACT_NOT_FOUND`，message「产出物 art_x 不存在」（实测） |
| TC-ART-048 | 指定版本：版本不存在 | 反向 | P0 | 产出物仅 v1 | 1. `GET /api/v1/artifacts/<id>/versions/99` | 1. 返回 `404 Not Found`，`code=ARTIFACT_VERSION_NOT_FOUND`，message「产出物 … 版本 99 不存在」（实测） |
| TC-ART-049 | 指定版本：版本号非整数 | 反向 | P1 | admin accessToken；产出物存在 | 1. `GET /api/v1/artifacts/<id>/versions/abc` | 1. 返回 `400 Bad Request`，message「Validation failed (numeric string is expected)」（`ParseIntPipe`，实测） |
| TC-ART-050 | 产出物端点：未认证访问 | 反向 | P0 | 无 token | 1. `GET /api/v1/tasks/t_0000000009/artifacts`（不带 Authorization）<br>2.（变体）`POST /api/v1/tasks/t_0000000009/artifacts`（不带 Authorization） | 1. 均返回 `401 Unauthorized`，`code=AUTH_UNAUTHORIZED` |
| TC-ART-051 | 已验收版本不可覆盖（append 拒绝） | 反向 | P0 | 产出物当前版本已 `acceptedFlag=true`（经 `POST /tasks/:id/accept` 验收） | 1. 对该产出物再次 `POST /api/v1/tasks/<id>/artifacts`，body 使用与已验收版本**不同内容** | 1. 返回 `409 Conflict`，`code=ARTIFACT_ACCEPTED_IMMUTABLE`，message「产出物…当前版本已验收锁定（vN），不可追加」（FR-04/43 已验收版本不可覆盖）<br>2. 版本不增；Agent 只能在其后 append 新版本（本端点不支持直接覆盖已验收版本）<br>3. **需谨慎执行**：验收状态由任务验收流程控制，执行后建议按 FR-04 语义回退或记录测试数据 |

---

## 4. 文件上传用例（TC-UPL）

> `POST /api/v1/uploads` 为通用文件上传端点（multipart，字段名 `file`），全局 `JwtAuthGuard` 认证（登录用户即可上传，普通成员能力）；返回 `{url, name, size, ext}`，落盘 `server/uploads/`（`UPLOAD_DIR` 可覆盖），静态服务 `/uploads/*` 由 `main.ts` 挂载可访问。类型白名单按扩展名：pdf/doc/docx/xls/xlsx/csv/png/jpg/jpeg/gif/md/txt；大小上限 10MB。以下 API 用例默认前置条件为「已用 `admin`/`admin123` 登录获得 admin accessToken」。

### 4.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-UPL-052 | 上传合法文件成功 | 正向 | P0 | admin accessToken；本地准备 `需求说明.md` | 1. `POST /api/v1/uploads`，Header：`Authorization: Bearer <accessToken>`，form-data 字段 `file=@需求说明.md` | 1. 返回 `201 Created`，响应体 `{url:"/uploads/<uuid>.md", name:"需求说明.md", size:<字节数>, ext:"md"}`<br>2. `url` 以 `/uploads/` 开头且文件名含 UUID（杜绝重名） |
| TC-UPL-053 | 上传后经 /uploads URL 下载验证 | 正向 | P0 | `TC-UPL-052` 已返回 `url` | 1. `GET http://192.168.10.78:13000/api/v1/uploads/<uuid>.md`（或 web 入口 `/uploads/...`） | 1. 返回 `200 OK`，响应内容与上传文件完全一致（读/写同目录，静态服务可达） |
| TC-UPL-054 | 中文文件名 / 大写扩展名归一化 | 正向 | P2 | admin accessToken；准备 `需求报告.PDF`、`报告.txt` | 1. `POST /api/v1/uploads`，file=`需求报告.PDF`<br>2.（变体）file=`报告.txt` | 1. 返回 `201 Created`，`ext` 一律为小写（`"pdf"`/`"txt"`），`name` 保留原始文件名（含中文/大小写），`url` 含小写扩展名 |
| TC-UPL-055 | 无扩展名文件上传被拒 | 反向 | P2 | admin accessToken；准备 `README`（无扩展名） | 1. `POST /api/v1/uploads`，file=`README` | 1. 返回 `400 Bad Request`，`code=UPLOAD_FILE_TYPE_NOT_ALLOWED`，message「文件类型不允许：仅支持 pdf/doc/docx/xls/xlsx/csv/png/jpg/jpeg/gif/md/txt」（`uploads.service.ts` 校验 `!ext` 直接拦截，无扩展名等同非法类型，与 TC-UPL-057 同分支；单测已锁定该行为）<br>2. 不落盘 |

### 4.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-UPL-056 | 上传：未携带 file 字段 | 反向 | P0 | admin accessToken | 1. `POST /api/v1/uploads`，Header：`Authorization: Bearer <accessToken>`，不带任何文件字段 | 1. 返回 `400 Bad Request`，`code=UPLOAD_FILE_REQUIRED`，message「缺少 file 文件（multipart 字段名 file）」（实测）<br>2. 不落盘任何文件 |
| TC-UPL-057 | 上传：扩展名不在白名单 | 反向 | P0 | admin accessToken；准备 `evil.exe` | 1. `POST /api/v1/uploads`，file=`evil.exe`<br>2.（变体）file=`script.js` | 1. 返回 `400 Bad Request`，`code=UPLOAD_FILE_TYPE_NOT_ALLOWED`，message「文件类型不允许：仅支持 pdf/doc/docx/xls/xlsx/csv/png/jpg/jpeg/gif/md/txt」（实测）<br>2. 不落盘（fileFilter 拦截） |
| TC-UPL-058 | 上传：超过 10MB 大小上限 | 反向 | P1 | admin accessToken；准备 >10MB 的 `big.bin`（用 dd 生成 11MB 临时文件） | 1. `POST /api/v1/uploads`，file=`big.bin` | 1. 返回 `413 Payload Too Large`（multer `limits.fileSize=10MB` 触发，与 skills 上传同款机制）<br>2. 不产生完整落盘文件 |
| TC-UPL-059 | 上传：未认证访问 | 反向 | P0 | 无 token | 1. `POST /api/v1/uploads`，file=`a.txt`（不带 Authorization 头） | 1. 返回 `401 Unauthorized`，`code=AUTH_UNAUTHORIZED`（全局 JwtAuthGuard 拦截） |
| TC-UPL-060 | 上传：multipart 字段名错误 | 反向 | P1 | admin accessToken；准备 `a.txt` | 1. `POST /api/v1/uploads`，Header：`Authorization: Bearer <accessToken>`，form-data 字段名用 `filename`（而非 `file`） | 1. 返回 `400 Bad Request`，`code=UPLOAD_FILE_REQUIRED`（`@UploadedFile()` 取不到 file 字段，等价于缺文件）<br>2. 不落盘任何文件 |

---

## 5. 用例汇总

| 模块 | 前缀 | 正向 | 反向 | 合计 |
|------|------|------|------|------|
| Worker 节点管理 | TC-WKR | 12 | 16 | 28 |
| 产出物与文档库 | TC-ART | 14 | 9 | 23 |
| 文件上传 | TC-UPL | 3 | 6 | 9 |
| **合计** | — | **29** | **31** | **60** |
**覆盖端点清单**（均为 `/api/v1` 前缀，含 API 与 Web 页面）：

- Workers（8 端点）：`POST /workers/register`、`POST /workers/:id/heartbeat`、`GET /workers`、`GET /workers/:id`、`PATCH /workers/:id`、`POST /workers/:id/restart`、`POST /workers/:id/shutdown`、`POST /worker/events`
- Artifacts（4 端点）：`GET /tasks/:id/artifacts`、`GET /artifacts/:id`、`GET /artifacts/:id/versions/:version`、`POST /tasks/:id/artifacts`
- Uploads（2 端点）：`POST /uploads`、`GET /uploads/:file`（静态服务，经 API 或 web 入口访问）
- Web 页面（2 页）：Worker 节点页（§2.11）、任务详情与文档库页（§2.7）

**反向覆盖维度**：worker 注册/心跳/事件 token 缺失、错误、tokenHash 不匹配（401）、注册/心跳参数非法（400）、worker 不存在（404）、未认证访问（401）、非管理员管理操作越权（403）、事件未注册 worker（404）、事件非法 type（400）、事件幂等重放（202 去重）、产出物声明非法（type/title/content/fileRef 交叉校验，400）、归档到不存在任务（外键约束）、产出物/版本不存在（404）、版本号非整数（400）、已验收版本不可覆盖（409）、上传缺文件/非法类型（400）、上传超限（413）、未认证上传（401）等，均已覆盖。
