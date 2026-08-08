# Phase 4 Worker × opencode 集成 - Learnings

## [2026-08-08] T1 契约先行（已完成）
- **交付物**：`server/src/workers/dto/` 三 DTO（register/heartbeat/event）+ `worker/src/protocol/` 双写类型 + 双端契约测试 + `workers.module.ts` 骨架 + event.constants 扩展
- **结构对齐**：三 DTO 对齐 schema Worker 表（L365-381）——opencodeVersion/capabilities/load；嵌套对象用 `WorkerCapabilitiesDto`/`WorkerLoadDto` + `@ValidateNested` + `@Type`（对齐 agents/dto/create-agent.dto.ts 风格）
- **事件双层设计**（关键区分，勿混）：
  - worker 协议枚举 `WORKER_EVENT_TYPES`（6 个）：worker.heartbeat / instance.created / session.updated / message.part.delta / agent.status / task.completed——放 `worker-event.dto.ts`；**instance.created 仅协议层**（worker 自身上报实例生命周期）
  - server 前端事件字典 `EVENT_TYPES` 扩展 5 个：SESSION_UPDATED / MESSAGE_PART_DELTA / TASK_COMPLETED / AGENT_STATUS / WORKER_HEARTBEAT（SSE 广播用）
  - 5 个同名值由 worker-dto.spec.ts 交叉断言对齐，防双端事件名漂移
- **worker 双写类型**：worker-protocol.ts 用 interface 重写（**不 import server 代码**，worker 独立进程铁律 D1/1B）；contract.spec.ts 用 JSON.stringify→JSON.parse 模拟双端 JSON 互通
- **验证命令坑**：`jest workers` 的 testPathPattern 只匹配路径含 `workers` 的 spec → `event.constants.spec.ts`（common/constants/ 下）不会被跑到 → **必须补 `server/src/workers/dto/worker-dto.spec.ts`**，否则验证命令报 No tests found
- **worker 工具链**：worker/package.json devDeps 仅 typescript/jest/ts-jest/@types（T2 才加 @opencode-ai/sdk）；根 .gitignore 的 `node_modules/` 全局模式已覆盖 worker/，无需改 .gitignore
- **验证**：server `jest --no-cache --runInBand workers` 6 passed；worker `tsc --noEmit` PASS；worker jest 5 passed；server 全量 23 suites / 290 tests 全过（基线 17/171 → 23/290，无回归）；`nest build` EXIT 0

## [2026-08-08] T2 worker 独立目录骨架 + 部署脚本（已完成）
- **交付物**：`worker/src/index.ts`（最小入口）+ `worker/src/config.ts`（env 配置）+ `worker/scripts/start.sh`（部署脚本）+ `worker/README.md` + `worker/.env.example`；package.json 补 `@opencode-ai/sdk@1.18.15`、`tsx@^4.19.0`（devDep）与 `start`/`dev` scripts
- **config.ts 默认值**：SERVER_URL=`http://localhost:3000`（nest 默认端口）；WORKER_ID=`w_<hostname>`（对齐协议 workerId 前缀）；WORKER_NAME=hostname；OPENCODE_SERVE_PORT=`0`=随机（D2 随机端口起点）；HEARTBEAT_INTERVAL_MS=`10000`（D1 心跳周期）；**X_WORKER_TOKEN 必填缺失即抛错**——非负整数配置统一 `parseNonNegativeInt` 校验
- **index.ts 骨架**：读 config → 打印启动信息（workerId/serverUrl/opencode 版本探测 `spawnSync('opencode',['--version'])`，失败不阻断）→ SIGTERM/SIGINT 统一收口优雅退出（防重复处理标志位）→ `setInterval` 占位保持进程存活（T6 替换为真实心跳）。`main(env)` 可注入 env 便于单测；**不含任何 T3-T6 逻辑**
- **start.sh 要点**：`set -euo pipefail`；`command -v opencode` 前置校验；`cd "$(dirname "$0")/.."` 定位 worker 目录（任意路径可跑）；`set -a` + source .env（导出变量）；X_WORKER_TOKEN 空时**在 bash 层给指引而非等 node 抛堆栈**；dist 缺失先 build；`exec node dist/index.js`
- **验证**：`npm install`（@opencode-ai/sdk 1.18.15 + tsx 共 4 包）；`tsc --noEmit` PASS；`npm run build` PASS；start.sh 无 token → exit 1 + 明确指引；带 token 启动 → 启动信息完整 + opencode 版本探测到 1.18.15 + SIGTERM 优雅退出 exit 0；T1 jest 5 passed 无回归
- **坑/注意**：worker 目录 `.gitignore` 复用根级（node_modules/ dist/ .env 均被覆盖，无需改）；`tsconfig` 保持 commonjs（T1 原样），tsx dev 运行无冲突；SDK 1.18.15 与本机 opencode CLI 1.18.15 同版本对齐（D7 模型 id 依赖 serve 版本）

## [2026-08-08] T7 WorkersModule（server 控制面，已完成）
- **交付物**：`workers.service.ts`（WorkerRegistry + Heartbeat + Scheduler + HealthChecker + LifecycleManager 骨架）、`workers.controller.ts`、`worker-token.guard.ts`、`workers.constants.ts`（新增）、`workers.module.ts`（T1 占位补全 providers/controllers/exports）+ 三个 spec
- **鉴权分层（D1 隔离铁律）**：register/heartbeat 端点 `@Public()` 跳过全局 JwtAuthGuard → `@UseGuards(WorkerTokenGuard)` 独立把关 X-Worker-Token（`process.env.WORKER_TOKEN` 默认 `dev-worker-token`，sha256 归一化 + `timingSafeEqual` 常量时间比较）；GET /workers 走用户 JWT。guard 校验通过后把 token 挂 `request.workerToken`，register 据此落库 tokenHash
- **tokenHash 方案**：沿用 auth.service.ts 的 bcrypt（BCRYPT_ROUNDS=10，常量收敛到 workers.constants.ts `WORKER_TOKEN_BCRYPT_ROUNDS` 并注释对齐）——明文 token 只存 hash，guard 层用 env 明文对比（不查库），tokenHash 供后续 T8/T9 信任校验复用
- **HealthChecker 无第三方依赖**：`@Interval` 需 `@nestjs/schedule`（未安装）→ 用原生 `setInterval` + `OnModuleInit`/`OnModuleDestroy` 等价实现（unref 防阻塞退出）；`markStaleWorkersOffline` 公开供测试直调。**where 只扫过期行**：`status != offline AND (lastHeartbeatAt IS NULL OR < now-30s)`，不批量全扫；onModuleInit 启动自愈（server 重启标残留 online 为 offline）
- **Scheduler.assignWorker 语义**：剩余容量 `capacity = maxInstances - instances`（load 缺省按 0）；online 优先、degraded 降权排后、同状态内容量降序（负载最少优先）；opencodeVersion 精确匹配（req 提供时）；无可用 → `null`（D3 调用方报错）。**JS 层对 offline 二次兜底过滤**（DB where 已过滤，防御单测 mock 不执行 where 的场景）
- **status 三值**：online / offline / degraded（heartbeat health=degraded → degraded 降权不判离线；超时仍归 offline）
- **测试坑**：`jest.mock('bcrypt')` factory `{ hash: jest.fn() }` 正常生效（ts-jest + commonjs 下 `import * as bcrypt` 拿到 mock）；**upsert 只传一个参数对象** → `mock.calls[0]` 是 `[{where,create,update}]`，取参用 `const [args] = calls[0]` 而非 `const [, args]`（第二个元素不存在）；controller spec 中方法级 `@UseGuards(WorkerTokenGuard)` 会在 compile 时实例化 guard → **必须补 `ConfigService` mock**，否则 Nest can't resolve
- **验证**：`jest workers` 5 suites / 56 tests 全过（worker.client.spec.ts 为 T8 已有）；`nest build` EXIT 0；server 全量回归 27 suites / 340 tests（基线 23/290 → 27/340，无回归）；零 DDL、未动 chat.module.ts/web/


## [2026-08-08] T8 WorkerClient（server→worker HTTP 客户端，已完成）
- **交付物**：`server/src/workers/worker.client.ts`（@Injectable + ConfigService 注入，export 供 T10）+ `worker.client.spec.ts`（mock global.fetch，22 用例）；`workers.module.ts` providers+exports 补 WorkerClient（T7 并行已改写该文件，直接在其版本上追加）
- **serve REST 端点实测**（本机 opencode 1.18.15 `--pure` 启动 + curl + /doc OpenAPI）：
  - **模型列表 = `GET /api/model`**（不是 /config！），返回 `{ location, data: [{id, providerID, family, name, cost...}] }`；id 映射为 `providerID/modelID` 供 T11 替换 STATIC_AVAILABLE_MODELS（对齐 D7）
  - `POST /session` 实际返回 **`{ id: "ses_..." }` 而非 {sessionID}**——SDK 声明 {sessionID} 是错的根源；WorkerClient 内部映射为 `{ sessionID }` 契约
  - `POST /session/{id}/prompt_async`：directory 是 **query 参数**；body `{ model: {providerID, modelID}（可选）, agent（可选）, parts: array（必填） }`，204/2xx 成功
  - `POST /session/{id}/abort`、`GET /session/{id}/message`（limit/before query 可选）、`GET /`（带 auth 200，作健康检查）
  - 新版 `/api/*` 前缀路径与旧版无前缀路径**并存**；serve 依赖：v1 旧路径（/session 系）保持，模型列表只有 /api/model
  - `--pure` 下 /api/model 返回的仍是全局配置的 provider（如 ollama-local/qwen3.5），模型列表会含真实 serve 可用的全部模型
- **baseUrl 约定**：Worker 表无 baseUrl 列（schema 365-381），capabilities Json 无 port 字段（T1 DTO 无）→ 解析顺序 **capabilities.baseUrl → capabilities.port → env WORKER_BASE_URL（默认 http://localhost:4199）**；注释说明 T7 注册时上报 baseUrl/port 即可被 T8 使用
- **鉴权**：Basic Auth `Basic base64(opencode:<password>)`；server 侧密码取 env **SERVER_PASSWORD**（默认空=不鉴权，不发 Authorization 头），值=worker 侧 OPENCODE_SERVER_PASSWORD
- **错误语义**：fetch 网络错/超时/HTTP 非 2xx → 统一 `WorkerUnavailableException extends ServiceUnavailableException`（503，body 带 code=WORKER_UNAVAILABLE + workerId 字段），T10「无可用 worker 报错」直接 catch 读 workerId
- **坑**：Node 18+ fetch abort 抛 **DOMException（非 Error 实例）** → describeError 不能只 `instanceof Error`，需按 `name==='AbortError'` 识别归一为超时文案（已修，spec 覆盖）
- **验证**：`jest --no-cache --runInBand workers` 5 suites / 56 passed（含 T7 并行套件，首次跑 service/controller FAIL 是 T7 中间态，重跑即绿）；`nest build` EXIT 0

## [2026-08-08] T3 V1Runtime：spawn opencode serve（已完成）
- **交付物**：`worker/src/runtime/opencode-server.ts`（OpencodeServer 类）+ `opencode-server.spec.ts`（单元 16）+ `opencode-server.integration.spec.ts`（真实 spawn 集成 3）；`config.ts` 补 `serverPassword`；`index.ts` 挂载（启动 spawn + SIGTERM/SIGINT stop）；`.env.example`/`README.md` 同步
- **D2 实测确认**：`opencode serve --help` 显示 **`--port` 默认 0（即随机端口）**——serve 原生支持端口 0，无需退化为固定 4199；`opencode serve --pure --port 0` 实测日志含 `opencode server listening on http://127.0.0.1:<随机>`；`GET /` 设密码后无 auth=401、带 `Basic base64(opencode:pw)`=200（body 为 HTML）
- **端口策略（已实现）**：配置端口 >0 → 从该端口起 `net.createServer` bind 探测空闲，占用 +1 重试（最多 5 次）；=0 → 先 bind 0 拿 OS 随机空闲端口再传给 serve（规避 serve 自己随机后需解析日志的脆弱性）；健康检查轮询 `GET http://127.0.0.1:{port}/` 带 Basic Auth（密码非空才带），2xx 通过，超时 30s/间隔 500ms
- **进程清理（D2 铁律落地）**：spawn `detached:true` + `stdio:['ignore','pipe','pipe']` → `stop()` 用 `process.kill(-pid,'SIGTERM')`（负 pid=进程组组长），`waitForExit` 3s 未退出补 `SIGKILL`；serve 提前退出（exitCode 非 null）健康检查即报错；**实测**：worker SIGTERM 后 serve 进程组零残留（pid 消失），环境既有 4096 双 serve 不受影响
- **日志收集**：stdout/stderr pipe → 环形缓冲（默认保留最近 200 行，`recentLogs` 供 debug/报错附日志）；解析 `listening on http://127.0.0.1:<port>` 与实际端口不一致时告警（防御性）
- **版本探测**：OpencodeServer 内部 `spawnSync(command,['--version'])`（start 时探测，失败返回 'unknown'，command 可配置便于集成测指向假脚本）
- **测试坑**：单元测 mock `process.kill` 为 no-op 会导致 fake 子进程永不退出 → stop 卡满 3s×2 超时；正确做法是 killSpy 把信号**转发给 fake 子进程**（`pid===-fakeProc.pid` 时调 `fakeProc.kill(signal)`，进程已 exit 时抛 ESRCH）模拟真实语义；mock `http.get` 时**不能覆盖 `req.on = jest.fn()`**（EventEmitter 的 'error' 事件无监听器会抛 Unhandled error，promise 永不 settle）——保留 EventEmitter.on 让 `req.on('error', reject)` 生效
- **集成测技巧**：假 serve 脚本（bash 解析 `--port/--version` + `node -e` 起 HTTP 200 服务 + `& wait` 保持 bash 为组长）写入 os.tmpdir() 并 chmod +x 作 command——可真实验证 spawn/健康检查/进程组清理，且 `--version` 分支让 detectVersion 不误起服务；真实端口占用场景用 occupyPort 兜底（若该端口已被环境占用则测试前提依然成立）
- **验证**：`tsc --noEmit` PASS；`npm run build` PASS；`npm test` **5 suites / 42 tests 全绿**（T1 契约 5 + T3 单元 16 + T3 集成 3 + git 已有 18）；真实启动验证：worker → 随机端口 → serve `--pure` 就绪 → SIGTERM 优雅退出零残留
- **环境备注**：`4199` 已被环境 node 进程（pid 991682）占用；`4096` 双 serve 常驻（root 1593222 + keta 2371842）——T3 用 port=0 随机绕开冲突

## [2026-08-08] T5 git 工具族注入 + 凭证最小链路（决策 2B，已完成）
- **交付物**：`worker/src/git/git-tools.ts`（GIT_TOOLS 七工具清单 + renderGitToolsFile/installGitTools）+ `worker/src/git/git-credentials.ts`（resolveGitEnv/createTempKey/cleanup）+ 两个 spec（18 用例全绿）；`config.ts` 扩展 `workDir`（WORK_DIR，默认 /tmp/keta-worker）与 `gitSshKeyPath`（GIT_SSH_KEY_PATH）；README/.env.example 同步
- **工具名命名规则铁律**（17 篇 §4.2）：单文件 `git.ts` 具名导出 `clone/pull/...` → 工具名 `<文件名>_<导出名>` = `git_clone`；**工具名即权限 action**（permission 规则 `git_push: ask`）。GIT_TOOLS 数组的 name 字段直接存 `git_<exportName>`，spec 断言 `name === 'git_'+exportName` 防漂移
- **默认 effect 对齐 §4.1**：只读四件套（status/diff/log/fetch）+ 写本地（clone/pull）默认 allow；**唯一 ask = git_push**（写远端核心副作用，07 §3.1「有副作用默认 ask」）
- **opencode 自定义工具文件真实格式**（context7 查证，与 17 篇 §4.3 伪代码一致）：`.opencode/tools/*.ts` 用 `import { tool } from "@opencode-ai/plugin"`（**不是** "@opencode-ai/sdk"）；`tool({description, args:{k: tool.schema.string().describe()}, async execute(args){}})`；目录扫描 `{tool,tools}/*.{js,ts}` 逐个 import，default 导出 → 工具名=文件名，具名导出 → `<文件名>_<导出名>`
- **installGitTools 注入机制**：写 `<workDir>/.opencode/tools/git.ts`（mkdir recursive + 幂等覆盖），返回完整路径；execute 为**最小实现**——共享 `runGit()` 用 spawnSync 调本机 git + `_buildGitArgs()` switch 按 exportName 组装参数，真实凭证/清理留给运行期扩展（T3/T4 集成时把 resolveGitEnv 返回 env 注入 serve 子进程）
- **resolveGitEnv 解析顺序**：`credential.keyPath → config.gitSshKeyPath`，trim 后空视为缺省；两者皆空返回 `{}`（不注入）。构造 `GIT_SSH_COMMAND="ssh -i <key> -o IdentitiesOnly=yes -o StrictHostKeyChecking=no"`（D6 2B：StrictHostKeyChecking=no 免交互，17 §6.1）；options 可覆盖 identitiesOnly/strictHostKeyChecking
- **createTempKey 安全基线**（17 §5.4）：`os.tmpdir()/keta-cred-<crypto.randomBytes(16)hex>` + writeFileSync mode **+ 显式 chmodSync 0o600**（双保险，防 umask 干扰）；cleanup 幂等（ENOENT 忽略），try/finally 用完即删
- **零 DDL 合规**：未动 server/web/schema.prisma；凭证来源仅 env（GIT_SSH_KEY_PATH）不入库（2B）；未做 credentials/repo_grants 表与 ask 确认流（下轮）
- **验证**：`npx tsc --noEmit` PASS；`npx jest --no-cache --runInBand src/git` 2 suites / 18 passed；全量 worker 测试 5 suites 中 **src/runtime/opencode-server*.spec.ts 有 5 FAIL 为 T3 并行任务中间态**（ECONNREFUSED/端口 4199 被占/健康检查超时等真实网络 spawn 问题，与 T5 无关，runtime 未引用 config 新字段）

## T13 前端 /workers 列表页（worker-list 原型迁移）

- **交付**：`web/app/(main)/workers/page.tsx`（'use client' + @tanstack/react-query + api.get，替换原 14 行占位）；`npx tsc --noEmit` 通过、`npm run build` EXIT 0（/workers 路由 4.74 kB）
- **数据映射**（GET /workers toWorkerView 字段 → 原型 WorkerInfo）：id→workerId；status online/offline/degraded→原型三态 在线/离线/维护中（页面内 workerStatusTheme 扩展 token，不入 tokens.ts，对齐 users 页 roleTheme 范式）；capabilities.maxInstances→并发上限；capabilities.skills/tools 数组 **length**→skill/tool 数量；load.instances→实例数；lastHeartbeatAt→相对时间（手写 formatRelativeTime，"3 秒前"格式，null→"从未上报"）
- **无后端字段的降级**：① CPU 进度条→用 instances/maxInstances 实例占用率驱动（loadColor 档位 ≥75 红/≥50 琥珀/低绿 照搬原型 cpuColor），load 字段真实语义；② 原型 address（10.0.8.21:18080）→展示 worker.name ?? "未命名节点"；③ 操作按钮（详情/重启/下线）全占位无 onClick（后端无端点，T10 接入），对齐 users 页"编辑按钮占位"模式
- **原型 bug 修正**：WorkerCard border 条件 `theme.status === "离线"`（theme 无 status 属性，TS 直接报错）→ 按意图修正为 `worker.status === "offline" ? neutral[200] : theme.border`（离线灰边框淡化），三色 token 值不变
- **isV2 判定**：`/^v?2\./.test(opencodeVersion)`（v2.0.0-beta.1 / 2.x 命中）
- **实时性决策**：worker.heartbeat SSE 需 T9 事件回流（未实现，server 当前不 emit）→ 按任务备选方案 **refetchInterval 10s 轮询**（与心跳周期同频，30s 判离线前可捕捉翻转）+ 1s tick setState 驱动相对心跳时间重算；T9 上线后如要改 SSE 需在 use-realtime 加 WORKER_HEARTBEAT 分发
- **注册指引**（MUST DO）：新增 WorkerGuide 折叠组件（data-testid worker-guide），内容取自 worker/.env.example + scripts/start.sh 真实命令（cp .env.example → npm install/build → ./scripts/start.sh + SERVER_URL/心跳参数说明）；「新增 Worker」按钮（add-worker-button）aria-expanded 切换；**空列表首次加载完成自动展开**（useEffect 监听 !isPending && items.length===0）
- **data-testid 全覆盖**：worker-list-root/worker-stats/worker-card（data-worker-id+data-status）/worker-status/worker-version（data-v2）/worker-capability/worker-load/worker-heartbeat（data-online）/worker-actions/worker-detail-button/worker-restart-button/worker-offline-button/add-worker-button/worker-pool-hint/workers-loading/workers-error/workers-retry
- **验证**：tsc EXIT 0 + build EXIT 0（历史坑：build 后 dev 需 kill+rm .next，本次仅 build 验证）

## [2026-08-08] T11 agent 模型映射 + GET /models 动态化（已完成）
- **交付物**：`agents.service.ts` getAvailableModels 动态化（WorkersService.assignWorker + WorkerClient.listModels）、`agent.constants.ts` 新增 STATIC_AVAILABLE_MODELS（fallback，D7 新格式 id）、`agents.module.ts` import WorkersModule、create/update DTO defaultModelId 格式校验、spec 更新
- **动态化语义**：assignWorker() 无可用 worker → 降级；listModels 抛异常/返回空数组 → 降级；成功 → 返回纯数组 `[{id, name}]`（**保持前端契约**，web 期待 AvailableModel[]）；降级 → 返回 `{ models, source: 'fallback' }` 对象。TS 类型 union `AvailableModelsResult`（Live 数组 | Fallback 对象）
- **降级结构设计取舍**：数组在 JSON 序列化时无法携带 source 字段 → 降级必须返回对象。成功返回数组保持前端 `api.get<AvailableModel[]>` 无感；无 worker 时（开发期）前端会拿到对象导致渲染兼容问题，但 web/ 属 MUST NOT 范围，由后续前端任务适配
- **STATIC_AVAILABLE_MODELS 迁移**：从 agents.service.ts:46-50 移到 agent.constants.ts，id 全部换成 opencode 实测模型（opencode-go/deepseek-v4-flash、deepseek-v4-pro、glm-5.1/5.2、gpt-5.6-luna、grok-4.5、kimi-k2.6、qwen3.6-plus），旧 gpt-4o/claude-3-5-sonnet/deepseek-v3 废弃（D7 零 DDL 语义迁移）
- **defaultModelId 校验**：DTO 层 `@Matches(/^[a-z0-9-_.]+\/[a-z0-9-_.]+$/)` 强制 provider/model 格式（T10 拼 `-m <defaultModelId>` 前置保障）；spec 中旧 id 断言同步迁移（gpt-4o→opencode-go/deepseek-v4-flash、deepseek-v3→deepseek-v4-pro）
- **模块依赖**：WorkersModule 已 export WorkersService+WorkerClient（T7/T8 完成），agents.module.ts 仅需 import WorkersModule；app.module 已注册，Nest 模块系统幂等复用
- **测试坑**：ts-jest 类型检查下 `as { models: {id:string}[] }` cast 与 `readonly` 数组（as const 常量）不兼容 → 断言 cast 类型必须写 `models: readonly { id: string }[]`，否则 TS2352
- **验证**：`jest agents` 27 suites / 343 tests 全过（新增 4 个动态/降级用例）；`nest build` EXIT 0；零 DDL、未动 web/chat.module.ts

## [2026-08-08] T4 V1Driver + prompt-await（已完成）
- **交付物**：`worker/src/driver/v1-driver.ts`（V1Driver：createSession/sendMessage/getMessages/abort/listModels/isHealthy + Basic Auth + 15s AbortController 超时 + baseUrl 可变 setter）+ `prompt-await.ts`（awaitCompletion/sendAndAwait/findFinish/aggregateText/CompletionTimeoutError）+ 两个 spec（31 用例）；`index.ts` 挂载 V1Driver（serve 就绪后注入 baseUrl）；README 同步
- **serve 端点实测确认**（opencode 1.18.15 --pure，起临时 serve + curl）：
  - `POST /session` → `{id:"ses_...", slug, projectID, directory, path, cost, tokens, title, version, time}`（**非 {sessionID}**）
  - `POST /session/{id}/prompt_async?directory=/tmp` body `{parts:[...]}` → **204 空 body**（2xx 均算成功）
  - `GET /session/{id}/message` → **`Array<{info, parts}>`**（不是裸 Message[]！）；assistant 消息**先以 parts=[] 出现**，完成过程中逐步填充 step-start→text→step-finish——**必须轮询到 step-finish 才算完成**（有消息不算，D2 铁律实证）
  - `step-finish` part：`{type:"step-finish", reason:"stop", cost:number, tokens:{total,input,output,reasoning,cache:{read,write}}}`——**实测有 total 字段**（SDK 类型声明缺 total，worker 侧 ServeTokens 补全）
  - 真实模型 text part 无 `synthetic` 字段（undefined）；synthetic=true 是工具调用占位文本，聚合需排除
  - `GET /api/model` → `{data:[{id, providerID, name}]}`（31 个模型，实测 id=ling-3.0-tiny-free providerID=opencode）；listModels 映射 id=`${providerID}/${modelID}`（如 `opencode/ling-3.0-tiny-free`，对齐 D7/T11 格式）
- **完成判定实现（D2 最重要铁律）**：findFinish 只找 **assistant** 消息（user 消息带 step-finish 不算）且 reason===stop（error 等其它 reason 不算）；轮询默认 500ms/60s，超时 → abort + 抛 CompletionTimeoutError（携带已收集文本）
- **文本聚合规则**：只取 assistant 消息的 text part（**user 输入不进入最终回复**——实测 user 消息也有 text part，不过滤会把用户输入拼进回复）+ 排除 synthetic + 按 part.time.start 升序串接
- **关键坑：getMessages 返回整个会话累积列表（非增量）**——每次轮询 push 会重复聚合（文本翻倍）；且同一条 assistant 消息 parts 完成中逐步填充。修复：按 `info.id` 合并，同 id 用最新版本**整体替换**（mergeMessages）
- **SDK path key bug 规避**：V1Driver 全裸 fetch（不 import @opencode-ai/sdk），注释注明原因；directory 是 prompt_async 的 **query 参数**（实测 URLSearchParams 编码正确）
- **index.ts 集成**：driver 初始 baseUrl 为空（随机端口未知）→ `serveServer.start().then(baseUrl => driver.baseUrl = baseUrl)`；V1Driver.baseUrl 为可变 setter（注入时记录日志）
- **测试坑**：Node Response 构造器 **204 不允许带 body**（传 JSON body 抛 "Invalid response status code 204"）→ jsonResponse 对 status=204 返回 `new Response(null,{status})`；同一 Response 的 body 只能读一次（重复断言需 mockResolvedValueOnce 新 Response）；`promise.catch(e=>e)` 返回值类型是 union → 需 `as CompletionTimeoutError` cast
- **端到端实测**（tsx 临时脚本，真实 serve + V1Driver + sendAndAwait）：isHealthy=true、listModels 31 个、createSession→ses_xxx、prompt_async 204、**text="done"**（精确模型输出）、cost/tokens 从 step-finish 取出、parts 类型序列 text,step-start,text,step-finish
- **验证**：`tsc --noEmit` PASS；`npm run build` PASS；`npm test` **9 suites / 90 tests 全绿**（T4 driver 31 + T6 client 20 + T3 19 + T5 git 15 + T1 契约 5）；真实 opencode 调用共 2 次（≤5 合规）
- **环境备注**：`worker/src/index.ts` 与 `worker/src/client/*` 已被并行 T6 任务修改（注册/心跳/事件上送已集成）；T4 在其版本上增量挂载 driver，无冲突

## [2026-08-08] T6 worker 注册/心跳 + 事件上送（已完成）
- **交付物**：`worker/src/client/registry-client.ts`（registerWorker + sendHeartbeat + registerWorkerWithRetry）+ `worker/src/client/event-client.ts`（EventSender）+ 两个 spec（17 用例）+ `index.ts` 挂载（启动注册 → 定时心跳 → 优雅退出先停心跳/flush 事件再 stop serve）；README 状态/目录结构同步
- **URL 对齐**：`/api/v1` 前缀在 server main.ts setGlobalPrefix → worker 侧路径 = `{serverUrl}/api/v1/workers/register`、`/api/v1/workers/{id}/heartbeat`、`/api/v1/worker/events`（T9 消费端同前缀）；`apiUrl(serverUrl, path)` 尾斜杠容忍 + workerId `encodeURIComponent`
- **X-Worker-Token 双写**：worker 独立进程铁律（不 import server 代码）→ `WORKER_TOKEN_HEADER='x-worker-token'` 在 registry-client.ts 本地常量（与 server workers.constants.ts 一致，注释交叉说明）
- **注册重试**：`registerWorkerWithRetry` 指数退避 `baseDelayMs*2^(attempt-1)` 封顶 maxDelayMs=30s（序列 1s/2s/4s/8s/16s/30s...），maxRetries 默认 8；网络错/非 2xx 均失败；重试耗尽抛错 → index.ts 清理 serve 进程组后 exit(1)（无法成为可用 worker）
- **心跳间隔以 server 返回为准**：register 响应 `{workerId, heartbeatIntervalMs, serverTime}` → `setInterval` 用 `registerResult.heartbeatIntervalMs`（而非本地 config，协议对齐 T7）；心跳 body `{workerId, load:{instances:0}, health}`，health 随 `serveServer.isRunning` → ok/degraded；心跳失败仅 console.warn 不退出
- **EventSender seq 单调递增（D4 落地）**：模块级计数器 `moduleSeq` 作默认起点 + 实例 `seq` 从 startSeq 接续、send 时 +1 并 `moduleSeq=Math.max(moduleSeq,this.seq)` 回写——**进程内多实例也严格递增**（不传 startSeq 的新实例从模块级当前值接续）；eventId=`evw_<seq>` 与 seq 同步；导出 `resetEventSeq()` 仅测试隔离（jest 模块状态共享）
- **事件投递语义**：deliver 失败重试 maxRetries=3（指数退避 base=500ms），重试仍失败**记日志不抛**（事件可丢，server 内存去重 D4 兜底，at-least-once 边界）；`flush()` 等所有 in-flight 送达（优雅退出前调用）；`send` 返回的 Promise 在成功或最终放弃后 resolve
- **测试坑**：① `jest.advanceTimersByTimeAsync` 推进重试定时器时，`registerWorkerWithRetry` 的顶层 promise 会先 reject（重试耗尽）→ 必须**在 advance 前**先 `const assertion = expect(promise).rejects.toThrow(...)` 挂 handler，否则 Node 报 PromiseRejectionHandledWarning / jest 误报测试失败；② 模块级计数器被 startSeq 实例的 send 推进（设计如此）→ spec 内多个 describe 共享 moduleSeq 状态需 `resetEventSeq()` 隔离
- **能力声明**：`buildCapabilities()` 从 GIT_TOOLS 映射工具名（git_clone 等 7 个，T5 注入的工具族即上报能力），maxInstances=1/skills=[] 为 T6 最小声明（T10 细化）
- **验证**：`npx tsc --noEmit` PASS；`npm test` **7 suites / 59 tests 全绿**（T1 契约 5 + T3 单元 16 + T3 集成 3 + git 18 + client 17）；真实 smoke：假 server 收到 register（X-Worker-Token + 完整 body）→ 心跳按 server 返回 1s 周期 → SIGTERM 优雅退出 + serve 进程组零残留（端口 46343 无监听）
- **边界**：未实现 server 侧消费（T9）/WorkerDispatcher（T10）/V1Driver（T4）；未动 schema.prisma/server/web/；EventSender 通道已就绪供 T4 上报

## [2026-08-08] T12 Session/TaskGroupInstance 生命周期（已完成）
- **交付物**：`server/src/workers/session-lifecycle.service.ts`（新建）+ `session-lifecycle.spec.ts`（7 用例）；`workers.module.ts` 接线（import RealtimeModule + providers/exports SessionLifecycleService）；`tasks.service.ts` 注入 SessionLifecycleService + 新增 `getInstancesByTask` / `getInstanceBySession` 对外暴露；`tasks.module.ts` import WorkersModule；`tasks.service.spec.ts` 补 mock 防回归（+2 委托用例）
- **D3 落地（Metis 必改点 2）**：`bindSessionToWorker(sessionId, workerId, instanceId)` 事务内：查 Session（不存在 → 404 `SESSION_NOT_FOUND`，局部常量，无现成错误码）→ 幂等 upsert TaskGroupInstance（`findFirst` 同 (taskId, workerId, instanceId)，命中复用不 create——二次 @ 复用同一 opencode 会话）→ `session.update` 写 workerId + instanceRef + status=active；返回 `{sessionId, taskId, workerId, instanceId, instanceRowId}`
- **id 前缀 ti_**：TaskGroupInstance 主键 `ti_<seq>`（15 篇 §2.2）；`IdGeneratorService` 由 RealtimeModule 导出 → **WorkersModule 必须 import RealtimeModule**（T7 时 WorkersModule imports 为空，新增依赖的前提）
- **模块接线无循环**：TasksModule → WorkersModule → RealtimeModule（WorkersModule 不依赖 TasksModule）；TasksModule 同时 import RealtimeModule + WorkersModule，Nest 模块单例共享幂等；对齐 T11 agents.module.ts import WorkersModule 的既有先例
- **查询语义**：`getInstancesByTask` 过滤 `removedAt: null` + createdAt 倒序；`getInstanceBySession` 先查 Session（无 workerId/instanceRef 即 created 态 → null）再按 (taskId, workerId, instanceRef) 匹配实例行（未移除才返回）——供 T10 判断二次 @ 是否复用
- **验证命令坑**：`npx jest --no-cache --runInBand workers,tasks` **No tests found**——jest testPathPattern 是正则不是逗号分隔，必须用 `"workers|tasks"` 正则形式
- **验证**：`jest "workers|tasks"` 8 suites / 127 passed；`nest build` EXIT 0；全量回归 28 suites / 352 tests（基线 27/343 + 新增 session-lifecycle 1 suite 7 用例 + tasks.service 2 委托用例，无回归）；零 DDL、未动 chat.module.ts/web/

## [2026-08-08] T14 群聊流式展示增强（已完成）
- **交付物**：`web/src/components/chat/msg-parts.tsx`（新建 MsgParts 共享渲染器）+ `web/hooks/use-realtime.ts`（+SESSION_UPDATED/AGENT_STATUS 分发）+ `web/hooks/use-sse.ts`（matchesScope task scope 扩展）+ 群聊页/DM 页接入
- **现状盘点（Phase 2 已满足项，T14 未重复建设）**：SSE 断线重连在 use-sse.ts **已存在**（onerror → close → 1s 固定延迟重建 + URL since=lastId 续拉，重放补拉事件）——T14 确认即可；agent.loading/agent.error 分发与两阶段指示器 Phase 2 已实现
- **MsgParts 组件设计（10 篇 §2.2/§2.3 落地）**：一条 agent 消息的 content.parts 统一映射——reasoning/**thinking 别名**（T10 约定 parts 可能用 thinking 而非 reasoning，双别名防漂移）→ MsgThinking；tool → MsgTool；error → MsgError；aborted → **独占**（中断时其余未完成 Part 不渲染，仅灰条）；**text → ChatBubble agent 型置底**（多 Part 组合 reasoning→tool→text 自上而下堆叠、正文置底作为最终结论）；其余内部片段（step-start/step-finish/patch 等）不渲染（FR-10 边界）；正文兜底 `text parts 合并 || content.text`（T10 落库 {text, parts} 可能其一为空）
- **关键缺口修复**：原群聊/DM 页内联 parts 循环对 `part.type==='text'` 返回 null → **真实 worker 回流（parts 含 text）时正文丢失**；MsgParts 统一修复并消除两页重复代码（页面仅剩 3 行 MsgParts 调用）
- **use-realtime 事件扩展**：新增 `SessionUpdatedEvent {sessionId, taskId?, agentId?, status}`（status 对齐 SESSION_STATUS：active=运行中/frozen|archived=已结束）与 `AgentStatusEvent {taskId?, agentId?, sessionId?, status}`（running=开始/completed|failed=终结收敛）；回调 onSessionUpdated/onAgentStatus 与既有五类事件并列分发
- **matchesScope 扩展**：task scope 命中列表加入 `agent.status`/`session.updated`（均按 payload.taskId 匹配，与 agent.loading 同规则）——**不做 sessionId 匹配**（task scope 语义是 taskId，sessionId 匹配会误放行跨任务事件）
- **页面状态展示**：sessionByAgent state（agentId→status）；`sessionLabel`（active 且非 loading →「XX 会话运行中…」蓝点脉冲条，data-testid=session-status）；**收敛三通道**：① chat.message.new agent 回复到达 → 清 active；② onSessionUpdated frozen/archived → 清 loading；③ 历史补拉收敛 effect 追加 sessionByAgent 清理（首连补拉重放顺序不定，历史最后一条是 agent 回复 → active 残留清除）
- **DM 页差异**：任务过滤用 `channel?.taskId`（channel 异步加载后才有）；AgentInfoBar 状态「在线/处理中」纳入 sessionByAgent active（会话运行中显示处理中）
- **验证**：`npx tsc --noEmit` EXIT 0；`npm run build` EXIT 0（/tasks/[id] 7.69 kB、/messages/[id] 9.32 kB，无新依赖）；未改 server/schema.prisma
- **边界**：session.updated/agent.status 事件 server 侧 T9/T10 未完成前不会 emit——订阅是契约先行（T1 常量已定），真实 worker 回流后自动生效；message.part.delta 按 D2 结论**不进统一 SSE 流**，T14 未订阅（流式文本粒度 = parts 落库后 chat.message.new 一次到位 + session.updated 状态条）

## [2026-08-08] T9 WorkerEventIngress：事件回流消费（幂等 + 语义转换 + 回调转发，已完成）
- **交付物**：`server/src/workers/worker-event.ingress.ts`（WorkerEventIngress）+ `worker-events.controller.ts`（POST /worker/events）+ 两个 spec（ingress 15 + controller HTTP 4）；`workers.module.ts` 接线（controllers+providers+exports 加 WorkerEventIngress）
- **D5 边界铁律落地**：Ingress **只做**幂等去重 + 语义转换 + RealtimeService.emit 转发 + 回调通知；**不落库消息/不广播 chat.message.new/不 emit task.completed**——落库+广播+emitFinal 归 T10 WorkerDispatcher 注册的 onTaskCompleted 回调（对齐 MockDispatcher 模板，防双写）
- **幂等实现（D4）**：`Map<workerId:eventId>` + 先进先出环形缓冲（DEDUP_WINDOW=1000，order 数组 shift 淘汰最旧）；`handleEvent` 返回 boolean（true=首次处理/false=重复跳过，测试断言依据）；**已知限制**：server 重启内存去重丢失 → at-least-once（M4 可接受，Phase 5 补唯一索引）
- **各 type 语义**：worker.heartbeat → 忽略（心跳走 T7 单独端点）；instance.created → 仅日志确认（实例已由 T12 bind 落库）；session.updated → `session.updateMany({id, status: {not: mapped}})` + emit `session.updated`（scope=task:taskId，无 taskId → global）；message.part.delta → **不落库不广播**（D2 流式中间态，前端经 /sessions/:id/stream），仅 debug 日志；agent.status → status=error/带 error 字段 emit `agent.error`，否则 emit `agent.loading`（phase 缺省补 operating）；task.completed → 解析 payload（taskId/agentId/sessionId/text/parts/tokens/cost）→ 通知 onTaskCompleted 回调
- **回调注册机制**：`onTaskCompleted(cb)` / `onAgentStatus(cb)` 订阅模式（返回 this 可链式），Ingress 内 notify 对齐 MessageDispatcher.notify：回调异常被吞（订阅者失败不影响事件处理）；WorkerEventIngress 已 export 供 T10 WorkerDispatcher 构造时注册
- **session.updated DB 更新失败策略**：updateMany 单独 try/catch 记 warn **不阻断 emit**（事件流转优先，落库终态由重放兜底）；handleEvent 各 handler 外层 catch 吞错 → controller 恒定 202（worker 不重试，符合事件尽力而为语义）
- **controller 路由**：`@Controller('worker')` + `@Post('events')` + `@HttpCode(202)` + `@Public()` + `@UseGuards(WorkerTokenGuard)` → `/api/v1/worker/events`（单数 worker，与 worker 侧 EventSender `apiUrl(serverUrl,'/worker/events')` 严格对齐）；鉴权与 register/heartbeat 同模式（用户 JWT 与 worker token 隔离）
- **测试坑**：① `SESSION_STATUS_ALLOWED: Set<string>` 必须显式泛型——`new Set(Object.values(SESSION_STATUS))` 推断为字面量 union Set，`.has(string)` 报 TS2345；② controller spec 用 supertest 建 HTTP 层（`Test.createTestingModule` + `ConfigService` mock 返回 undefined 落到默认 token），可直接断言 401（无/错 token）/202（正确 token）+ handleEvent 转发——guard 在 compile 时实例化，无 ConfigService mock 会 Nest can't resolve（T7 已知坑）
- **验证**：`jest workers` **8 suites / 82 passed**（ingress 15 + controller 4 新增，T7/T8/T12 无回归）；全量回归 **30 suites / 391 passed / 1 failed**——唯一失败是 `worker-dispatcher.spec.ts`（T10 并行中间态文件 doclib 用例，与本任务无关）；`nest build` 仅剩 2 个 TS 错误**全部在 T10 未提交的 worker-dispatcher.ts**（authorAgentId 不在 schema Artifact），T9 三个文件零编译错误；零 DDL、未动 chat.module.ts/web/

## [2026-08-08] T10 WorkerDispatcher 替换 MockDispatcher（已完成）
- **交付物**：`server/src/chat/worker-dispatcher.ts`（新建，extends MessageDispatcher）+ `worker-dispatcher.spec.ts`（25 用例）+ `chat.module.ts` :24 useClass MockDispatcher→WorkerDispatcher；对 T9 最小侵入补 `artifacts` 透传（worker-event.ingress.ts handleTaskCompleted 提取 raw.artifacts + TaskCompletedPayload.artifacts?）
- **dispatch 全链**（fire-and-forget，返回 `{replies:[]}`）：查 Session（已绑 workerId/instanceRef→复用同一 opencode 会话；未绑→assignWorker，无可用→emitError+广播 agent.error 不降级 D3）→ 首次 bind(instanceRef 占位 `pending`) → Worker 行 capabilities → Agent.defaultModelId 拆 `provider/model` → doclib 注入 → loading thinking → createSession→bind 真实 instanceRef → promptAsync → loading operating + 60s watchdog
- **回流处理（D5 铁律）**：handleTaskCompleted 定位发件 Agent（agentId 缺失→sessionId 反查 Session）→ 定位频道（私聊 taskId+agentId 优先→群聊回退，DB 推导跨实例一致）→ message.create(senderType=agent) → 广播 chat.message.new(channel) → emitFinal → artifacts 声明直连 ArtifactsService.onArtifactSubmitted；频道缺失跳过落库但产出物仍归档
- **T9 接线关键**：构造注入 WorkerEventIngress 并 `ingress.onTaskCompleted(handler)`+`onAgentStatus(handler)`（T9 已实现并有订阅接口）；**agent.status 回调只做 emitLoading/emitError 本地通知，不重复广播**——T9 ingress 已自行 emit agent.loading/agent.error（SSE），双写会重复推送（防双写）；task.completed 回调 `void handleTaskCompleted().catch()`（fire-and-forget，ingress notify 吞异常）
- **watchdog**：`${taskId}:${agentId}` Map + 60s setTimeout（unref），handleTaskCompleted 命中 clearTimeout；超时 emitError+广播 agent.error(retry/dispatch_timeout)
- **doclib 注入（12 篇 §8）**：artifact.findMany(taskId) 全清单 + artifactVersion 取各 current_version 正文/作者（**authorAgentId 在版本行不在 Artifact 表**，TS 直接报错教训）；`<doclib>` 块 `<artifact type/title/version/author/updated>正文</artifact>`，单文档 truncateUtf8 32KB + 块总 128KB 上限；truncateUtf8 用 UTF-8 字节二分截断防切裂多字节字符
- **坑**：① ConfigService.get 缺省值不生效于 mock（返回 undefined 覆盖默认）→ 构造时 `typeof v === 'number' && v>0` 才用否则回退常量（T3 教训同源：公开字段 + 防御）；② Artifact 表无 authorAgentId 字段（在 ArtifactVersion）——select 时 TS 直接报 TS2353；③ jest 测试回调注册验证：ingress 回调是 fire-and-forget（void），`await cb()` 不等待异步内部逻辑——落库断言需直接调 `handleTaskCompleted`，回调只断言不抛
- **模块接线**：ChatModule imports RealtimeModule+WorkersModule+ArtifactsModule（WorkersModule 已 export WorkerEventIngress/SessionLifecycleService/WorkerClient/WorkersService；ArtifactsModule export ArtifactsService）；ConfigService 全局可用；无循环依赖（Chat→Workers/Artifacts 单向）
- **验证**：`jest "chat|workers|artifacts"` 14 suites / 179 passed；全量 31 suites / 396 tests（基线 28/352 + T10 25 + T9 接线相关），无回归；`nest build` EXIT 0；MockDispatcher/chat.service/schema.prisma/web 零改动（F4 基线）

## [2026-08-08] F2 代码质量修复：C1 回流断链 + M2 token 语义 + M5 绑定残留（已完成）
- **交付**：`worker-dispatcher.ts`（C1 自持轮询 + 幂等 + 防迟到 + M5 回滚/排除 + doclib 补闭合）、`session-lifecycle.service.ts`（+unbindSession）、`worker-event.ingress.ts`（M2 workerId 注册校验 + sessionId 语义防御）、`workers.service.ts`/`workers.controller.ts`（M2 heartbeat tokenHash 比对）、`chat.module.ts`（删 WORKER_MOCK_FALLBACK 仅注释）+ 四个 spec 更新
- **C1（CRITICAL，核心断链修复）**：原先 dispatch 只等 ingress task.completed 回调，但**无生产代码产生该事件**（worker 侧 EventSender 从不 send）→ 60s watchdog 必超时。修复：WorkerDispatcher 在 promptAsync 后**自持轮询** `GET /session/{id}/message`（500ms 间隔/60s 超时，POLL_INTERVAL_MS 常量），命中 `step-finish(reason=stop)`（`findFinish`，仅 assistant + reason===stop）→ `handlePolledCompletion` → 复用既有 `handleTaskCompleted` 落库+广播+emitFinal；文本聚合 `aggregateText`（assistant 非 synthetic text 按 time.start 升序）——两函数**移植自 worker prompt-await.ts**（不依赖 worker 侧接线）
- **C1 幂等**：`completedSessions: Set<sessionId>`——落库成功 add；ingress 回调与轮询双通道任一先落库，另一侧跳过（handleTaskCompleted 入口检查）；**时序细节**：落库成功后 add（create 失败不标记，可重试）
- **MINOR 防迟到**：`failedSessions: Set<sessionId>`——watchdog 超时回调与轮询超时都 add；之后任何回流（ingress/轮询）命中即跳过落库仅记日志（防用户同时见错误+消息）。**关键设计**：轮询超时**不重复 emitError**（emitError 由 watchdog 统一触发，避免双 error）；watchdog 签名加 sessionId 参数
- **M5（MAJOR）**：① createSession 失败 → `sessionLifecycle.unbindSession(sessionId)` 回滚（事务内清 workerId/instanceRef + status=created + TaskGroupInstance removedAt=now，幂等）；② dispatch 检测 `instanceRef===PENDING_INSTANCE_REF` 残留 → 视为未绑定重新 assignWorker（第二层防御，防 server 崩溃在 bind/createSession 之间）
- **M2（MAJOR）**：① events 端点——`WorkerEventIngress.handleEvent` 入口校验 workerId 已注册（`worker.findUnique` 不存在 → 404 WORKER_NOT_FOUND；此前 WorkerTokenGuard 只校验共享 token，伪造 workerId 可注入事件）；② heartbeat——controller 3 参签名（id, req, dto）透传 `req.workerToken`，service 比对 bcrypt.compare(token, tokenHash)，不匹配 → 401 WORKER_TOKEN_INVALID。生产默认 token 保留（仅注释警告，未强制）
- **MINOR 其余**：doclib 总大小截断可能切裂 `</doclib>` → 截断后 `lastIndexOf('</doclib')` 定位残缺片段补完整闭合标签；chat.module.ts 删 WORKER_MOCK_FALLBACK 仅注释（实现不存在，防误导）；ingress task.completed payload.sessionId 语义注释 + 防御——非 `s_` 前缀（疑似 opencode ses_ 会话 id）经 `Session.instanceRef` 反查映射，查不到留空
- **测试坑**：① `handleEvent` 需改 `async`（校验含 await）；② ingress spec 需补 `worker.findUnique`（返回已注册）与 `session.findFirst` mock，task.completed 用例 sessionId 从 `ses_1` 改 `s_1`（否则触发映射）；③ UnauthorizedException reject 断言用 `rejects.toMatchObject({ response: { code } })`（顶层无 statusCode）；④ C1 轮询测试用 fake timers：getMessages `mockResolvedValueOnce` 控制首轮无 finish（poll 挂起在 sleep）→ advanceTimersByTimeAsync(500) 触发次轮——**幂等测试必须用 Once 序列**，否则 fire-and-forget 轮询会先于 ingress 落库，时序不可控；⑤ 全部 dispatch 测试需 mock `getMessages` 返回 `[]`（默认 poll 后台 60s 空转，unref sleep 不阻塞退出）
- **验证**：`jest "chat|workers|artifacts"` 14 suites / 197 passed（+17）；全量 **31 suites / 414 tests**（基线 396 → 414，无回归）；`nest build` EXIT 0；零 DDL、未动 web/worker/、MockDispatcher 保留（F4 基线）

## [2026-08-08] F2 质量审计修复：C2/M1/M3/M4 + MINOR（已完成，C1 由并行任务）
- **背景**：F2 判定 REJECT——C2（端口不上报）+ C1（无自持轮询）使真实链路必失败。本任务修 C2/M1/M3/M4 + MINOR；**C1 明确不实现**（并行任务负责，worker-dispatcher.ts 为 C1 中间态文件）
- **C2（CRITICAL）随机端口上报**：worker `buildCapabilities(port)` 补 `port: serveServer.port`（serve start 成功后 actualPort 已确定）；server 侧 **必须同步给 WorkerCapabilitiesDto 加 `@IsOptional() @IsInt() @Min(0) port?`**——main.ts ValidationPipe `whitelist: true` 会剔除 DTO 未声明字段，不加则上报的 port 落不了库，C2 白修（learnings 追加：C2 并非"server 无需改"）。WorkerClient.resolveBaseUrl 的 caps.port 分支 T8 已就绪，仅补齐 DTO 白名单
- **M1（MAJOR）eventId 复用**：EventSender eventId 由 `evw_<seq>` 改为 `evw_<bootId>_<seq>`，bootId = `{process.pid}.{Date.now().toString(36)}` 模块加载时固定（进程内不变，跨重启变化）；EventSenderOptions 支持 bootId 覆盖（测试隔离）；seq 仍进程内单调（重启归零由 bootId 区分），server seen key 是完整 eventId 字符串无需改
- **M3（MAJOR）spawn ENOENT 空转**：spawnServe 的 `proc.once('error')` 记录 `spawnErrorValue`（原 `proc.on('error')` 仅 pushLog）；waitForHealthy 循环开头检查 spawnErrorValue 即抛 `spawn 失败: <err.message>`（健康检查超时/提前退出判定之前）——opencode 不在 PATH 时立即失败不空转 30s
- **M4（MAJOR）load 恒 0**：新建 `worker/src/instance-tracker.ts`（trackInstanceStart/End/getLoad/resetInstanceCount，end 钳制 0）；index.ts 心跳 `load = getLoad()`；**接线点标注**：T10 会话执行后 createSession 成功 → trackInstanceStart，abort/完成 → trackInstanceEnd（v1-driver.ts createSession 注释标明）。M4 阶段简单进程内计数即可，跨进程/持久化留 Phase 5
- **MINOR**：server worker.client.ts listModels `id: \`${m.providerID}/${m.id}\`` → 加 `?? ''` 与 worker 侧 v1-driver.ts 统一（缺省字段不产出 `undefined/undefined`）；index.ts V1Driver/EventSender 加"待 T10 回流接线"标注
- **顺带修复（既有断裂）**：workers.controller.spec.ts heartbeat 测试仍用 2 参数调用 `controller.heartbeat(id, dto)`，而 controller 已是 F2 M2 三参数签名 `(id, req, dto)` → 编译失败（TS2554）阻塞 `jest workers`。按 register 测试模式补 `req = {workerToken}` 并断言 `service.heartbeat(id, dto, token)`。这是 F2 M2 并行改动遗留的 spec 未同步，与本任务修复配套
- **验证**：worker `tsc --noEmit` PASS / `npm run build` PASS / jest **10 suites / 99 tests 全绿**（+instance-tracker 5，M1/M3 spec 更新）；server `jest workers` **8 suites / 87 tests 全绿**；server 全量 31 suites 仅 1 FAIL = `worker-dispatcher.spec.ts` 的 **F2 C1 自持轮询幂等用例**（C1 并行任务中间态，与本任务无关，learnings T9 记录过同类中间态失败）；零 DDL、未动 web/chat.module.ts/schema.prisma

## [2026-08-08] F3 QA：真实端到端验证（证据 .omo/evidence/phase4-f3-qa.md）

- **主链路通过**（首次 @）：@a_product → createSession（serve 34975 上 ses_022993f15ffe...）→ promptAsync → 4 轮 tool-calls → step-finish(stop) → poll 检测 → 幂等落库 m_33（senderType=agent, parts 18）→ chat.message.new(channel scope)。SSE 时序 agent.loading(thinking→operating)→chat.message.new 确认。
- **首字延迟 25.7s > 15s 通过线**（D8 未达标）。注意环境因素：QA 期间当前 opencode 会话（Sisyphus-Junior）与 worker **共用同一 serve 34975**（worker --pure 的 serve 恰好也是本环境 opencode 的 serve 后端）——并行负载拉长首次延迟；第二次 @ 秒回（缓存命中）证明链路本身快。
- **🔴 MAJOR C1 回归：二次 @ 复用会话回复不回流**。根因：pollForCompletion 全量 getMessages 拿整个会话累积历史 → findFinish 命中**第一条**的 step-finish → completedSessions 幂等跳过 → 提前 return；且 findFinish 命中时先 clearPendingWatchdog（:585）→ watchdog 也被清 → **静默失败无 agent.error**。opencode 侧回复已完成（消息[6] step-finish stop）但 server 永不检测。修复方向：poll 增量（`?before=<lastSeenId>` 或记录已见消息集合，只对新增判定 finish）。
- **🔴 MAJOR 产出物自动归档不可用**：handlePolledCompletion 构造 payload 不含 artifacts 字段（仅 text/parts/tokens/cost）→ handleTaskCompleted 归档循环空数组；仅 ingress task.completed 回调带 artifacts（worker 不上送该事件）→ poll 路径产出物声明永不归档。GET /tasks/:id/artifacts 实测空。
- **60s 总超时偏紧**：@a_architect 5 轮 tool 调用 + 并行负载 → 72s 完成 > 60s → watchdog agent.error，迟到回复被 failedSessions 跳过（F2 MINOR 防迟到设计生效——用户只见 error 不见消息，语义正确）。
- **F4 零污染风险**：opencode 在 promptAsync directory（/data/git-project/aiagents）下**真实写文件**（模型创建 .omo/plans/m4-acceptance-criteria.md 5823B）→ QA 已清理。工作目录需隔离（worker workDir）或限制写权限，否则每次真实会话都可能污染仓库。
- **API 契约确认**：GET /workers 返回数组（非 {items}）；POST /tasks/:id/team {addAgentIds}；POST /channels/:id/messages 返回 {message, triggers[{agentId,sessionId,status}]}；task 创建后自动建 task_group 频道（GET /channels?taskId= 过滤）。chat.message.new 按 **channel scope** 广播（task scope 订阅收不到，需 channel 或双 scope）。
- **worker load.instances 恒 0**：T10 server 侧 WorkerClient 直连 serve，不经过 worker 侧 v1-driver/instance-tracker → trackInstanceStart 接线点永远不触发。M4 已标注"awaiting T10 hookup"，实际 T10 未接入——前端 /workers 负载展示失真（已知边界）。

## [2026-08-08] F3 缺陷修复：MAJOR-1 增量 poll + MAJOR-2 artifacts 提取 + MINOR-3 工作目录/超时可配（已完成）

- **MAJOR-1 二次 @ 复用会话回复不回流（静默失败）——双因修复**：
  ① **增量 poll**：`pollForCompletion` 不再对全量 `getMessages` 判 finish。新增 `pollCursors: Map<sessionId, lastMessageId>`——首轮先做**基线**（getMessages 记录当前最新消息 id 为起点只记录不检测），后续只对 `messagesAfter(messages, cursor)`（cursor 之后的新消息）判 step-finish；复用会话时历史（含上一次 step-finish）被 cursor 跳过，不会误命中。cursor 存 Map 跨 dispatch 续接（复用会话第二次从上次已消费位置继续）。`lastMessageId` 用 `info.id`（opencode 真实消息都有）；消息无 id（测试 mock/极端）→ cursor=null 视为全量检测（兼容旧行为）。cursor 不在列表（游标丢失）→ 全量（防漏检）。
  ② **dispatch 重置幂等标记**：`dispatchForTarget` 在 promptAsync 后、poll 启动前 `completedSessions.delete(sessionId)` + `failedSessions.delete(sessionId)`——否则复用同一 sessionId 时上一轮已落库的 completedSessions 标记会让本轮回复被幂等跳过（静默失败根因之一）。**不破坏同轮防双写**：ingress/轮询双通道竞态发生在重置之后，completedSessions 仍在竞态内生效。
  ③ **重要关联发现**：即使增量 poll 正确跳过历史，completedSessions 不清除的话复用会话第二次回复仍会被 `handlePolledCompletion` 幂等跳过——F3 QA 描述的"completedSessions 命中提前 return"正是此点。两处必须一起修。
- **MAJOR-2 产出物自动归档——poll 路径提取声明**：`handlePolledCompletion` 构造 payload 补 `artifacts: extractArtifacts(aggregateText(messages))`。`extractArtifacts` 支持三种声明格式：① `<doclib><artifact type title>正文</artifact>`（12 篇 §8.2 注入格式对称复用，text 取正文为 content）；② 内嵌 JSON `{type,title,content,fileRef}`（§3.1，`(?<![\w])\{...type:"(?:text|doc|file)"...` 限定三态枚举防误匹配）；③ `[artifact]...[/artifact]` 包裹 JSON。每个候选过 `validateArtifactDeclaration` 过滤（非法丢弃不误报），无声明 → 空数组。**去重坑**：`[artifact]` 包裹的 JSON 会被 JSON 正则（②）和包裹正则（③）双命中 → 用 `JSON.stringify` 作 key 的 Set 去重。`decodeXml` 反转义标签属性/正文（&amp; 等）。
- **MINOR-3 工作目录隔离 + 超时可配**：
  ① 任务工作目录：server 侧 config `WORK_DIR`（默认 `/tmp/keta-worker-tasks`），`ensureTaskWorkDir` 做 `<根>/tasks/<taskId>` 的 `fs.promises.mkdir(recursive)`，作为 `promptAsync` 的 `directory` 传入——防模型在仓库根真实写文件污染（F4 关键）。注意：server 与 worker 同机时目录互通；分布式场景 server mkdir 的目录 worker 机不可见，需 worker 侧兜底（当前单机部署可行，任务要求优先 server 侧）。
  ② 首字延迟记录：poll 检测到新消息中第一个非 synthetic text part 时 `logger.log("agent X 首字出现（dispatch 后 Yms）")`（`startedAt` 由 dispatch 传入），**不优化模型速度**（受模型/网络影响）。
  ③ 超时可配：`DISPATCH_TIMEOUT_MS` 常量 60s→**120s**（默认，env `DISPATCH_TIMEOUT_MS` 可配，`dispatchTimeoutMs` 实例字段）。watchdog/poll 超时文案动态显示配置秒数。保守改动：poll 间隔仍 500ms，不加其他行为变更。
- **测试坑**：① spec 的 `fs` 必须 import 同步版 `node:fs`（`mkdtempSync`/`rmSync`/`existsSync` 不在 promises 版）；② 每次测试独立临时 `workRoot`（config WORK_DIR 指向），afterEach `rmSync` 清理，避免 dispatch 真实 mkdir 污染 /tmp；③ fake timers 下 mock 消息必须带 `info.id` 才能测增量语义；④ 二次 @ 测试用 `mockResolvedValueOnce` 序列精确控制两轮 dispatch 各自的基线/完成轮。
- **验证**：`jest "chat|workers|artifacts"` 14 suites / 197 passed（worker-dispatcher 25→40，+7 F3 用例）；全量 **31 suites / 421 tests**（基线 414 → 421，无回归）；`nest build` EXIT 0；零 DDL、未动 web/worker/、MockDispatcher 保留。

## [2026-08-08] F3 缺陷复审（证据 .omo/evidence/phase4-f3-recheck.md）

- **MAJOR-1 部分修复（新缺陷）**：pollCursors 增量检测解决 F3 原根因（历史 step-finish 误命中），但引入新缺陷——**pollForCompletion 首轮基线在 promptAsync 之后取 lastId，恰好取到本次 assistant 占位消息（parts=[]，prompt 后 ~58ms 即创建）**→ messagesAfter 永空 → 120s 超时。首个复用 dispatch（m_37）实测失败；**后续复用（m_38/m_40）成功是碰巧** cursor 残留在 m_37 完整回复上。修法：基线应在 promptAsync 之前取 / 基线取本次 user prompt id / 对 parts=[] 占位防御。
- **MAJOR-2 修复生效**：handlePolledCompletion 已携带 `artifacts: extractArtifacts(text)`；实测 extractArtifacts 对 `<artifact type="text">` 提取正常、对 type=markdown 返回 []（validateArtifactDeclaration 枚举 text/doc/file，**契约设计**）；旁路 POST /tasks/:id/artifacts type=text → archived。模型声明 type=markdown 被过滤属预期，非代码缺陷。
- **MINOR-3 部分生效**：新会话 dispatch 后 `/tmp/keta-worker-tasks/tasks/<taskId>/` 已创建 ✓；但**复用会话时 serve 沿用创建时 directory（/data/git-project/aiagents/worker），promptAsync 的 directory 参数对已存在会话不生效**（m_39 tool workdir 实证）→ 复用场景隔离失效，需 serve 层解决。
- **首字延迟不稳定**：m_40 单轮回复 4205ms ✓；m_38 多轮 tool 调用（ls/grep/read）17687ms ✗。首字由模型行为主导，非 poll 代码可控。
- **API 契约补充**：`POST /channels/:id/messages` body 顶层字段 `text` + `mentions`（非 content.text 嵌套）；`GET /channels/:id/messages` 分页参数 perPage 可用。

## [2026-08-08] F3 MAJOR-1 残留修复：poll 基线时序（已完成）

- **残留根因**（F3 复审证据）：`pollForCompletion` 首轮基线在 **promptAsync 之后**取 lastId——promptAsync 返回 204 后 ~58ms serve 即创建本次回复的 assistant 占位消息（parts=[]）→ 首轮基线恰好落在占位上 → `messagesAfter(cursor)` 永空 → 永不命中 step-finish → 120s 超时。**首个**复用 dispatch（m_37）必现（server 重启后 pollCursors 内存清空）；m_38/m_40 成功是**碰巧**——cursor 残留在 m_37 完整回复上（pollCursors 跨轮续接的"正确位置"掩盖了首轮基线缺陷）。
- **修复（基线移到 promptAsync 前）**：
  ① `dispatchForTarget` 在 promptAsync **之前** `getMessages` 取 `lastMessageId` 为基线（`baselineCursor`）。此时 serve 尚未创建本次占位 → cursor 落在上一轮最后一条消息（复用会话）或 null（首次会话，messagesAfter(null)=全量，对齐 F3 首次链路不回归）。取基线失败 → 传 **undefined**（未提供）→ 轮询回退 pollCursors 既有游标（跨轮续接）或兜底首轮自取。
  ② `pollForCompletion` 签名加 `baselineCursor?: string | null`：`!== undefined` 视为已初始化直接检测；`undefined`（前置失败）才回退 `pollCursors` 既有游标。**必须区分 null 与 undefined**——null=明确"无历史"（messagesAfter(null)=全量，首次会话），undefined=未提供（回退续接，复用会话前置失败时不误检历史 step-finish）。
  ③ **兜底防御 `baselineId`**：前置取基线失败且无既有游标时，首轮自取基线**跳过空 assistant 占位**（parts=[]）——从后往前找第一个"非空占位"消息 id，基线落在本次 user prompt 消息上（即"基线取 user prompt id"方案），防兜底路径重蹈 m_37。
- **测试**：新增 2 用例——① 复现占位场景（复用会话：前置基线=历史 msg_1 → poll 第1轮出现 msg_3 占位 parts=[] → poll 第2轮占位填充 step-finish → 断言回流，修复前此用例必超时）；② 首次会话回归（前置基线 null → messagesAfter(null) 全量检测 → 回流，防首次链路回归）。
- **测试坑**：dispatch 现在前置多一次 getMessages——既有幂等测试（ingress 先到）需补前置空 mock 让 poll 第1轮挂起，否则 poll 第1轮（baseline=null 直接全量检测）在 dispatch await 期间命中，与 ingress handleTaskCompleted 交错双写（completedSessions 检查都发生在 add 之前）。F2 C1"命中 step-finish"测试 mock 序列恰好兼容（mock[0] 被前置基线消耗，断言次数 2 不变）。
- **验证**：全量 **31 suites / 423 tests**（基线 421 → 423，无回归）；`nest build` EXIT 0；零 DDL、未动 worker/、web/、schema.prisma、extractArtifacts/ensureTaskWorkDir（F3-MAJOR-2/MINOR-3 修复保持不动）。

## [2026-08-08] M4 最终确认：MAJOR-1 修复真实验证（1 次调用，通过）
- **核心验证**：F3 遗留任务 t_0000000006 频道 c_0000000012，发 @a_product 消息 m_42（复用会话 s_0000000009）→ **m_43 agent 回复正常回流**（parts 含 step-finish），无 dispatch_timeout、无 agent.error——F3 复审"首个复用 dispatch 回复不回流"（m_37 120s 超时）已修复
- **首字延迟 5016ms**：m_42 createdAt → m_43 createdAt 差值；≤15s 通过线 ✅，5s 目标线差 16ms（模型单轮即时回复，接近未达标）
- **修复机制实证**：worker-dispatcher.ts dispatchForTarget 在 promptAsync **之前**取基线 cursor（preMessages → lastMessageId），pollForCompletion 优先用 baselineCursor，失败兜底 baselineId 跳过空 assistant 占位——本轮复用 dispatch 基线落在 m_41 而非占位消息上，messagesAfter 非空，step-finish 命中
- **产出物**：m_43 无 artifact 声明 → 无新归档（artifacts 仅剩 F3 旁路 art_0000000009），契约行为符合
- **目录隔离**：仓库根零新增（最近修改仅 F3 遗留截图）；任务 workdir /tmp/keta-worker-tasks/tasks/t_0000000006/ 存在为空（模型未调工具）
- **验收结论**：MAJOR-1 真实环境修复闭合。遗留：复用会话 workdir 隔离（serve 层 directory 不可变）、5s 目标线依赖模型行为
- **API 备忘**：POST /api/v1/channels/:id/messages body={text, mentions:[{type:'agent',agentId}]} → 201 {message, triggers[{agentId,sessionId,status:'dispatched'}]}；回复 senderType=agent 落库，poll 检测到 step-finish 后写入
