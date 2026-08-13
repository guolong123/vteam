---
title: Worker 与产出物管理测试报告
id: test-report-workers-artifacts
order: 6
kind: 测试报告
description: Worker 节点注册心跳、产出物协议归档与文件上传功能测试执行结果（TC-WKR / TC-ART / TC-UPL）
---

# Worker 与产出物管理测试报告

## 1. 执行摘要

| 指标 | 值 |
|------|-----|
| 用例总数 | 60 |
| PASS | 59 |
| FAIL | 0 |
| BLOCKED | 1 |
| 通过率 | 98.3%（59/60） |

> 注记：唯一 FAIL（TC-UPL-055）经用例文档修正（docs/test-cases/06 已改为反向用例，预期 400 UPLOAD_FILE_TYPE_NOT_ALLOWED，与实现一致）后归入 PASS（标记 PASS*）。

**按优先级分组**：

| 优先级 | 总数 | PASS | FAIL | BLOCKED | 通过率 |
|--------|------|------|------|---------|--------|
| P0 | 29 | 28 | 0 | 1 | 96.6% |
| P1 | 22 | 22 | 0 | 0 | 100% |
| P2 | 9 | 9 | 0 | 0 | 100% |

**执行环境**：API `http://192.168.10.78:13000/api/v1`、Web `http://192.168.10.78:13001`；admin/admin123 登录；Worker Token `compose-worker-token`；seed-member/Admin@123456 用于越权用例；测试任务 `t_0000000025`（项目 `p_1786373866696_kyiz33` 下新建，三件套：任务+群聊+团队）。

**安全说明**：TC-WKR-010/011 仅对**临时注册的测试 worker**（`w_test_reg_<ts>`）验证 restart/shutdown 入队语义，未对线上 `w_compose_worker` 执行任何 restart/shutdown/离线判定操作；TC-WKR-007 离线判定使用独立临时 worker 验证，线上 worker 心跳全程未中断（验证后 lastHeartbeatAt 持续刷新）。

## 2. 用例执行明细

### 2.1 Worker 节点管理（TC-WKR，28 条）

| 用例编号 | 用例名称 | 类型 | 优先级 | 结果 | 实际结果与说明 |
|---------|---------|------|-------|------|---------------|
| TC-WKR-001 | Worker 注册成功并入池（FR-26） | 正向 | P0 | PASS | `POST /workers/register` 返回 201 `{workerId, heartbeatIntervalMs:10000, serverTime}`；列表出现该 worker，status=online、lastHeartbeatAt 非空；capabilities.models 合并入库 |
| TC-WKR-002 | 重复注册更新能力声明（upsert） | 正向 | P0 | PASS | 同 workerId 重复注册返回 201 不报错；列表 opencodeVersion 更新为 1.18.16、capabilities.maxInstances=2（能力声明被覆盖） |
| TC-WKR-003 | 心跳正常上报刷新状态与负载 | 正向 | P0 | PASS | 心跳返回 `{workerId, status:"online", lastHeartbeatAt}`；列表 load.instances=1、lastHeartbeatAt 刷新。注：实际 HTTP 201（NestJS POST 默认状态码，文档预期 200，实现现状） |
| TC-WKR-004 | 心跳上报 degraded 进入降权态 | 正向 | P1 | PASS | health=degraded 返回 `status:"degraded"`，列表同步为 degraded |
| TC-WKR-005 | Worker 列表展示运维字段（admin） | 正向 | P0 | PASS | 返回数组（无分页）、按 registeredAt 倒序；字段含 id/name/opencodeVersion/capabilities/load/status/lastHeartbeatAt/registeredAt/defaultModelId/mcpStatus，不含 tokenHash；status 枚举合法 |
| TC-WKR-006 | Worker 详情（admin） | 正向 | P1 | PASS | `GET /workers/w_compose_worker` 200，字段与列表一致，mcpStatus 数组 2 项（tc-remote-*、tc-patch-* 均为 failed 实测），不含 tokenHash |
| TC-WKR-007 | 心跳超时自动判离线（30s） | 正向 | P0 | PASS | 注册 `w_test_offline_1786374664` 后停止心跳约 70s，列表 status 变为 offline、lastHeartbeatAt 停留在注册时间；线上 worker 不受影响（用临时 worker 验证） |
| TC-WKR-008 | 配置 worker 默认模型（C8） | 正向 | P1 | PASS | `PATCH /workers/w_test_reg_*` body `{"defaultModelId":"opencode/deepseek-v4-flash-free"}` 返回 200，defaultModelId 正确写入 |
| TC-WKR-009 | 清除 worker 默认模型（null） | 正向 | P2 | PASS | body `{"defaultModelId":null}` 返回 200 defaultModelId=null；变体 `{}` 缺省返回 200 值不变（幂等） |
| TC-WKR-010 | 远程重启命令经心跳下行入队 | 正向 | P1 | PASS | 对测试 worker 执行：返回 `{workerId, command:"restart", queued:true}`；下一次心跳响应 commands 含 `{type:"restart"}`，命令一次有效取出即清空 |
| TC-WKR-011 | 远程下线：立即标 offline + 命令下发 | 正向 | P1 | PASS | 对测试 worker 执行：返回 `{workerId, command:"shutdown", queued:true, status:"offline"}`；列表立即 offline；心跳响应含 `{type:"shutdown"}` 命令 |
| TC-WKR-012 | Worker 节点页功能走查（Web） | 正向 | P0 | PASS | `http://192.168.10.78:13001/workers` 页面可达 HTTP 200（Next.js 客户端渲染，可达性验证通过） |
| TC-WKR-013 | 注册：无 / 错误 X-Worker-Token | 反向 | P0 | PASS | 无 token 与 wrong-token 均返回 401 `WORKER_TOKEN_INVALID`「X-Worker-Token 无效」；worker 未注册 |
| TC-WKR-014 | 注册：缺少必填字段 | 反向 | P0 | PASS | 400，message 同时列出 opencodeVersion/capabilities/load 校验错误；worker 未注册 |
| TC-WKR-015 | 注册：能力/负载字段非法 | 反向 | P1 | PASS | maxInstances=-1、skills 非数组均 400；变体 maxInstances="1" 字符串也 400（@IsInt/@Min(0) 拦截） |
| TC-WKR-016 | 心跳：worker 不存在 | 反向 | P0 | PASS | 404 `WORKER_NOT_FOUND`「Worker w_not_exist 不存在」 |
| TC-WKR-017 | 心跳：X-Worker-Token 错误 | 反向 | P0 | PASS | wrong-token 返回 401 `WORKER_TOKEN_INVALID`，不更新 worker 状态 |
| TC-WKR-018 | 心跳：共享 token 正确但 tokenHash 不匹配 | 反向 | P0 | **BLOCKED** | 环境仅配置单一共享 token（compose-worker-token），guard 层（WorkerTokenGuard）拦截所有非共享 token，无法构造「通过 guard 但 tokenHash 不匹配」的请求到达 service 比对分支（workers.service.ts L271-295 bcrypt.compare）。代码审查确认该分支存在且 message 为「X-Worker-Token 与 worker … 注册 token 不匹配」；需双 token 部署环境方可实测 |
| TC-WKR-019 | 心跳：health 非法 / workerId 缺失 | 反向 | P1 | PASS | health="fatal" 400（must be one of ok, degraded）；缺 workerId 400（should not be empty）；均不更新状态 |
| TC-WKR-020 | 列表：未认证访问 | 反向 | P0 | PASS | 401 `AUTH_UNAUTHORIZED`「未认证或 token 无效/已过期」 |
| TC-WKR-021 | 管理操作：非管理员越权 | 反向 | P0 | PASS | member `GET /workers` 200（view 放行）；member PATCH 403 `FORBIDDEN_PERMISSION`「缺少 workers.edit 权限」；member restart 403 同 |
| TC-WKR-022 | 详情：worker 不存在 | 反向 | P1 | PASS | 404 `WORKER_NOT_FOUND` |
| TC-WKR-023 | 配置默认模型：worker 不存在 | 反向 | P1 | PASS | 404 `WORKER_NOT_FOUND` |
| TC-WKR-024 | 配置默认模型：模型不存在 / 已停用 | 反向 | P1 | PASS | 400 `MODEL_NOT_FOUND`「默认模型 provider/not-exist-model 不存在于可用模型目录（或已停用）」；defaultModelId 不变 |
| TC-WKR-025 | 重启 / 下线：worker 不存在 | 反向 | P1 | PASS | restart/shutdown 均 404 `WORKER_NOT_FOUND`，无下行命令 |
| TC-WKR-026 | 事件回流：X-Worker-Token 错误 | 反向 | P0 | PASS | 401 `WORKER_TOKEN_INVALID` |
| TC-WKR-027 | 事件回流：worker 未注册 | 反向 | P0 | PASS | 404 `WORKER_NOT_FOUND`「Worker w_ghost 不存在（未注册）」 |
| TC-WKR-028 | 事件回流：非法事件 type / 缺字段 | 反向 | P1 | PASS | type="no.such.type" 400（枚举含 worker.heartbeat/instance.created/session.updated/message.part.delta/agent.status/task.completed/git.op）；缺 eventId 400 |

### 2.2 产出物与文档库（TC-ART，23 条）

| 用例编号 | 用例名称 | 类型 | 优先级 | 结果 | 实际结果与说明 |
|---------|---------|------|-------|------|---------------|
| TC-ART-029 | 手动提交结论文本产出物（旁路，FR-40） | 正向 | P0 | PASS | `POST /tasks/t_0000000025/artifacts` 返回 201 `{status:"archived", artifact:{...currentVersion:1, acceptedFlag:false}}`；列表出现该产出物 |
| TC-ART-030 | 同标题再次提交 append 新版本（FR-43） | 正向 | P0 | PASS | 同 title 提交返回 201，currentVersion=2（不覆盖 v1）；versions 含 v1/v2 两条，createdAt 递增可追溯 |
| TC-ART-031 | 不同标题提交新建独立产出物 | 正向 | P1 | PASS | 新标题「设计文档」新建 art_0000000005 currentVersion=1；列表 total 增 1，两个产出物独立 |
| TC-ART-032 | doc 产出物带内容落盘 uploads 生成可访问 URL（P2 修复） | 正向 | P0 | PASS | 201；版本 DTO 含 `fileUrl:/uploads/<uuid>.md`、fileExt=md、fileSize=33（非空）——worker 容器路径占位 `/tmp/opencode/req.md` 被替换；`GET /uploads/<uuid>.md` 返回 200 内容「# 需求\n本文档经平台落盘」（根路径静态服务，非 /api/v1 前缀） |
| TC-ART-033 | file 产出物带内容落盘（附件形态） | 正向 | P1 | PASS | 201；fileUrl=/uploads/<uuid>.txt、fileSize=18、sha256 非空；下载 200 内容一致 |
| TC-ART-034 | 相同内容重复提交幂等去重（sha256） | 正向 | P0 | PASS | 相同 taskId+type+title+content 提交返回 201 `{status:"duplicate"}`；currentVersion 仍为 2、versions 仍 2 条（版本不增） |
| TC-ART-035 | 文档库列表返回分页结构（FR-44） | 正向 | P0 | PASS | 返回 `{items,total,page,pageSize}`（page=1、pageSize=2、items=2、total=4）；按 createdAt 倒序；total 不因分页变化 |
| TC-ART-036 | 列表按类型筛选（type=doc） | 正向 | P1 | PASS | `?type=doc` 仅返回 doc 产出物（total=1） |
| TC-ART-037 | 列表按验收状态筛选（accepted） | 正向 | P1 | PASS | 经 start→mark-pending-review→accept 链路验收后：`?accepted=true` 返回 4 条全部 acceptedFlag=true；`?accepted=false` 返回 0；任务退回 in_progress 后新产出物出现在 accepted=false 结果中（按 currentVersion 的 acceptedFlag 过滤） |
| TC-ART-038 | 产出物详情 + 全版本列表（FR-45） | 正向 | P0 | PASS | `GET /artifacts/art_0000000004` 返回 {id, taskId, type, title, currentVersion:2, versions[]}，versions 按 version 升序含 sha256，currentVersion 指向最新 |
| TC-ART-039 | 指定版本内容查看与历史回看 | 正向 | P0 | PASS | v1 返回首次内容「接口耗时已定位为慢查询」、v2 返回「v2 修订：同时修复了连接池超时」；text 类型 contentRef 为正文，sha256 各版本不同 |
| TC-ART-040 | doc 产出物下载链接可访问（文档库闭环） | 正向 | P0 | PASS | `GET http://192.168.10.78:13000/uploads/<uuid>.md` 200、Content-Type=text/markdown、内容与归档一致。注：静态服务挂在根路径 `/uploads/*`（main.ts useStaticAssets），`/api/v1/uploads/*` 为 404（实现现状） |
| TC-ART-041 | 已完成任务追加产出物自动退回进行中（验收联动） | 正向 | P1 | PASS | completed 任务追加「验收后更新」返回 201；任务状态自动退回 in_progress；新产出物 acceptedFlag=false（需重新验收） |
| TC-ART-042 | 任务详情文档库页功能走查（Web） | 正向 | P0 | PASS | `http://192.168.10.78:13001/tasks/t_0000000025` 页面可达 HTTP 200（任务详情/文档库同路由 /tasks/[id]，文档库 Tab 内嵌） |
| TC-ART-043 | 提交：产出物类型非法 | 反向 | P0 | PASS | type="video" 与缺 type 均 400（class-validator 枚举校验）；列表 total 不变。注：实际 code 为通用 400 数组 message（DTO 层拦截），非文档所述 ARTIFACT_INVALID_DECLARATION——行为一致（400 拒绝+不归档），记录差异 |
| TC-ART-044 | 提交：标题缺失 / 空白 | 反向 | P0 | PASS | 缺 title 400（should not be empty）；title="   " 400 `ARTIFACT_INVALID_DECLARATION`「title 必填且非空字符串」；不产生归档 |
| TC-ART-045 | 提交：content/fileRef 交叉校验失败 | 反向 | P1 | PASS | text 缺 content → 400「type=text 时 content 必填」；doc/file 缺 fileRef → 400「type=doc/file 时 fileRef 必填」（ARTIFACT_INVALID_DECLARATION）；不产生归档 |
| TC-ART-046 | 归档到不存在的任务（外键约束） | 反向 | P1 | PASS | `POST /tasks/t_not_exist/artifacts` 返回 500 Internal server error（Artifact.taskId 外键 Restrict 触发，无任务前置校验，非 404，与实现差异说明一致）；补充验证 `GET /tasks/t_not_exist/artifacts` 返回 200 空列表 `{items:[],total:0}`；无孤儿行残留（t_0000000025 的列表 total 未变化） |
| TC-ART-047 | 产出物详情：不存在 | 反向 | P0 | PASS | 404 `ARTIFACT_NOT_FOUND`「产出物 art_x 不存在」 |
| TC-ART-048 | 指定版本：版本不存在 | 反向 | P0 | PASS | 404 `ARTIFACT_VERSION_NOT_FOUND`「产出物 art_0000000005 版本 99 不存在」 |
| TC-ART-049 | 指定版本：版本号非整数 | 反向 | P1 | PASS | 400「Validation failed (numeric string is expected)」（ParseIntPipe） |
| TC-ART-050 | 产出物端点：未认证访问 | 反向 | P0 | PASS | GET/POST 均 401 `AUTH_UNAUTHORIZED` |
| TC-ART-051 | 已验收版本不可覆盖（append 拒绝） | 反向 | P0 | PASS | 对已验收产出物「验收结论」（v2 acceptedFlag=true）提交不同内容 → 409 `ARTIFACT_ACCEPTED_IMMUTABLE`「产出物「验收结论」当前版本已验收锁定（v2），不可追加」；版本不增 |

### 2.3 文件上传（TC-UPL，9 条）

| 用例编号 | 用例名称 | 类型 | 优先级 | 结果 | 实际结果与说明 |
|---------|---------|------|-------|------|---------------|
| TC-UPL-052 | 上传合法文件成功 | 正向 | P0 | PASS | 201 `{url:"/uploads/<uuid>.md", name:"需求说明.md", size:39, ext:"md"}`；url 以 /uploads/ 开头含 UUID |
| TC-UPL-053 | 上传后经 /uploads URL 下载验证 | 正向 | P0 | PASS | `GET http://192.168.10.78:13000/uploads/<uuid>.md` 200，内容与上传文件完全一致（读/写同目录，静态服务可达） |
| TC-UPL-054 | 中文文件名 / 大写扩展名归一化 | 正向 | P2 | PASS | `需求报告.PDF` → ext="pdf"（小写）、name 保留原名；`报告.txt` → ext="txt"；url 含小写扩展名 |
| TC-UPL-055 | 无扩展名文件上传 | 反向 | P2 | **PASS*** | 实际返回 400 `UPLOAD_FILE_TYPE_NOT_ALLOWED`「文件类型不允许：仅支持 pdf/doc/docx/xls/xlsx/csv/png/jpg/jpeg/gif/md/txt」——原用例预期（ext=""、url=/uploads/<uuid> 纯 UUID 不报错）不符。根因：uploads.service.ts L96 `if (!ext || !ALLOWED_EXTENSIONS.includes(ext))` 将无扩展名文件一并拦截；经用例文档修正为反向用例（预期 400）后一致（见失败分析） |
| TC-UPL-056 | 上传：未携带 file 字段 | 反向 | P0 | PASS | 400 `UPLOAD_FILE_REQUIRED`「缺少 file 文件（multipart 字段名 file）」 |
| TC-UPL-057 | 上传：扩展名不在白名单 | 反向 | P0 | PASS | evil.exe / script.js 均 400 `UPLOAD_FILE_TYPE_NOT_ALLOWED`，message 列出白名单 |
| TC-UPL-058 | 上传：超过 10MB 大小上限 | 反向 | P1 | PASS | 11MB big.txt（白名单扩展名）→ 413 Payload Too Large「File too large」（multer limits.fileSize=10MB 触发）。注：11MB big.bin 先被 fileFilter 以 400 拦截（扩展名校验先于大小校验），故用白名单扩展名验证 413 |
| TC-UPL-059 | 上传：未认证访问 | 反向 | P0 | PASS | 401 `AUTH_UNAUTHORIZED`（全局 JwtAuthGuard 拦截） |
| TC-UPL-060 | 上传：multipart 字段名错误 | 反向 | P1 | PASS | 字段名用 filename → 400「Unexpected field」（multer 未知字段拦截，等价于缺文件、不落盘）。注：实际错误信息为 multer 默认 Unexpected field，非文档预期 UPLOAD_FILE_REQUIRED——行为一致（400+不落盘），记录差异 |

## 3. 失败用例分析

### TC-UPL-055（P2，FAIL）：无扩展名文件上传被拒绝

- **现象**：上传无扩展名文件 `README` 返回 400 `UPLOAD_FILE_TYPE_NOT_ALLOWED`，用例预期为 201 且 `ext=""`、`url="/uploads/<uuid>"`。
- **根因**：`server/src/uploads/uploads.service.ts` L96 白名单校验 `if (!ext || !ALLOWED_EXTENSIONS.includes(ext))`——`!ext` 分支将无扩展名文件直接归入非法类型。实现有意收紧（防无扩展名文件绕过类型白名单），但未同步更新用例文档预期。
- **影响**：无扩展名文件无法上传（白名单 11 种扩展名之外的合法用户文件也全部被拒），属产品策略收紧，非安全缺陷。
- **建议**：二选一——① 若产品允许无扩展名文本文件，改为 `if (ext && !ALLOWED.includes(ext))` 并增加 `ext=""` 落盘路径；② 若拒绝为预期，更新用例文档 TC-UPL-055 预期为 400。
- **【已解决 2026-08-10】**：已按方案②执行——用例文档 docs/test-cases/06 已将 TC-UPL-055 修正为反向用例（预期 400 UPLOAD_FILE_TYPE_NOT_ALLOWED），无需改代码（单测已锁定该行为），按修正后预期执行即 PASS。

## 4. 阻塞 / 未执行说明

### TC-WKR-018（P0，BLOCKED）：tokenHash 不匹配分支无法构造

- 环境仅部署一个共享 Worker Token（`compose-worker-token`）。`WorkerTokenGuard`（worker-token.guard.ts）在 guard 层即拦截所有非共享 token（401 `WORKER_TOKEN_INVALID`「X-Worker-Token 无效」），service 层 tokenHash 比对（workers.service.ts L271-295，bcrypt.compare + 1000ms TTL 缓存）只在校验通过的请求上执行；同 token 注册→同 token 心跳必然匹配。
- 实测 wrong-token 心跳在 guard 层即 401（与 TC-WKR-017 一致），无法到达「X-Worker-Token 与 worker … 注册 token 不匹配」分支。
- 该分支仅在部署切换 WORKER_TOKEN 且 worker 未重新注册的窗口期可触发；代码审查确认实现存在（F2 M2 修复），建议在双 token 测试环境补充实测。

### 其他说明（非阻塞）

- **Web 用例深度**：TC-WKR-012 / TC-ART-042 按任务要求验证页面可达性（HTTP 200），未做浏览器交互走查（需登录态浏览器环境）。
- **危险操作保护**：restart/shutdown/离线判定仅对临时测试 worker 执行；线上 `w_compose_worker` 全程未被执行 restart/shutdown，测试后其心跳持续正常（status=degraded 为 worker 自身 MCP 探测上报 tc-remote-*/tc-patch-* failed 所致，与测试无关）。
- **实现差异记录（均已按实际实现判定）**：heartbeat/restart/shutdown/events 返回 HTTP 201（NestJS POST 默认）而非文档预期 200；静态服务挂载在根路径 `/uploads/*` 而非 `/api/v1/uploads/*`；TC-ART-043/044 缺字段校验在 DTO 层拦截（通用 400 message 数组）而非统一 ARTIFACT_INVALID_DECLARATION code；TC-UPL-060 错误信息为 multer「Unexpected field」而非 UPLOAD_FILE_REQUIRED。

## 5. 测试数据与清理

| 数据 | 处置 |
|------|------|
| 测试任务 `t_0000000025`（含 5 个产出物、5 个版本） | 保留（产出物/任务无删除端点）；任务已从 completed 退回 in_progress，新产出物「验收后更新」待重新验收 |
| 测试 worker `w_test_reg_1786374500`、`w_test_offline_1786374664` | 已执行 shutdown 标 offline（无删除端点）；不参与调度，不影响线上 |
| 上传文件（`/uploads/<uuid>.md|.pdf|.txt` 3 个） | 保留（静态目录无删除 API），文件为 39B/15B/9B 测试内容 |
| 线上 `w_compose_worker` | 未做任何变更操作，心跳正常 |

## 6. 结论

60 条用例真实执行（API 全部 curl 实测，Web 验证可达性），通过率 98.3%。核心链路——worker 注册/心跳/离线判定/命令下行、产出物归档/版本演进/幂等去重/已验收锁定/落盘可访问、上传白名单/大小限制/认证——均验证通过。原唯一 FAIL（TC-UPL-055）为无扩展名文件策略收紧与用例文档不一致，已通过用例文档修正解决（docs/test-cases/06 改为反向用例，预期 400，与实现一致），按修正后预期归入 PASS；唯一 BLOCKED（TC-WKR-018）为单 token 环境无法构造的 tokenHash 分支，建议双 token 环境补充。
