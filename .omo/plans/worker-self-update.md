# worker-self-update - Work Plan

## TL;DR (For humans)

**What you'll get:** 外部 worker 的完整更新机制：① **版本可见**——pack-worker 打包时戳 git SHA 版本，worker 心跳上报 `code_version`，UI Worker 节点页显示"当前 vs 期望"徽章；② **按钮触发更新**——Worker 节点页点【更新】→ server 经**心跳响应**下发指令 → worker 空闲时下载 tarball（sha256 校验）→ 备份 `dist.prev` → 覆盖 → systemd 重启拉新码；③ **自动回滚**——更新后 register 连续失败/超时未注册 → 自动切回 `dist.prev` 重启并上报回滚状态；④ 无 systemd 的 worker 只下载并标记"待手动重启"，绝不自杀。

**Why this approach:** 三个地基已存在——install-worker 默认注册 systemd（重启即拉新码）、pack-worker 在 web 镜像构建期自动发布 tarball（发布链已通）、心跳 10s 现成通道（指令经心跳响应下发，零新增长连接）。检测（版本比对、徽章）全自动，**执行由人点按钮**（部署节奏人控，坏包不自动传播）；回滚覆盖"起了但注册不上"这一最可能的失败形态，硬崩溃保留 `dist.prev` + 手动一行命令兜底（计划 Must-NOT 明确边界）。

**What it will NOT do:** 不做全自动自更新（env 开关也先不做，按钮即全部）；不做多 worker 批量更新（逐个点）；不回滚"进程根本起不来"的硬崩溃（自动回滚仅覆盖 register 失败路径，硬崩溃 = UI 离线可见 + dist.prev 手动恢复）；不改 opencode CLI / start.sh 前置校验逻辑；不做增量下载/差分包；不动 install-worker.sh 安装流程。

**Effort:** Medium（6 个实现任务，跨 worker + server + web + 部署脚本）
**Risk:** Medium — 更新执行器涉下载/覆盖/重启（失败窗口内 worker 短暂离线属预期）；心跳协议两端改动需向后兼容（旧 worker 不带 codeVersion 必须不炸）
**Decisions to sanity-check:** ① 执行策略 = UI 按钮触发（心跳响应下发）② 坏包回滚 = register 失败自动切 dist.prev ③ 期望版本 = server env `CODE_VERSION`（deploy TAG 注入，与 tarball 构建 SHA 同源）④ 重启仅在 idle（无运行中会话）执行 ⑤ 无 systemd 只标记待重启、不 process.exit

Your next move: approve 后执行 `$start-work worker-self-update`，或先运行高精度评审（momus）。完整执行细节如下。

---

> TL;DR (machine): Medium effort, Medium risk — worker 自更新机制（6 todos：version-stamp/heartbeat-proto/command-api/executor/web-ui/e2e + F1-F4 终验），版本可见 + UI 按钮触发 + 自动回滚。

## Scope

### Must have
- **uw-version-stamp**：`scripts/pack-worker.sh` 构建期写 `dist/version.js`（`WORKER_CODE_VERSION = git short SHA`，非 git 环境回退 `manual-<date>`）+ 生成 `web/public/worker-src.version.json`（`{version, sha256, builtAt}`，sha256 对 tarball 本体）；worker 运行时版本解析模块：env `WORKER_CODE_VERSION`（容器/集群注入）> dist/version.js > `'dev'`；worker Dockerfile / docker-compose / chart 的 env 注入路径确认与接线（与 pack 文件戳并存，env 优先）
- **uw-heartbeat-proto**：register/heartbeat DTO（两端）+= `codeVersion?: string`（**可选，旧 worker 缺席不炸**）；**指令通道复用既有 heartbeat `commands` 机制**（server `workers.service.ts` pendingCommands :196/:412-420 → worker `registry-client.extractCommands` :157 → `index.dispatchCommands` :1079，均有 T4a spec——不新增 `pendingUpdate` 字段，更新指令以 `{kind:'update-worker', version}` 命令入队下发）；heartbeat **响应另加轻量 `expectedVersion?: string`**（纯信息字段，来自 server env `CODE_VERSION`，空缺省不下发 → 无更新语义）；server workers 表 += `code_version varchar(191)?`（迁移 + 守卫测试，照 memory-refcount 模板）；register/heartbeat 持久化 codeVersion；env 经 **deploy-k8s.sh helm --set + chart configmap/values** 注入（dev 缺省 = 不下发期望）
- **uw-command-api**：`POST /workers/:id/update`（守卫对齐 workers.controller 现有管理端点；未注册/离线 worker 409 拒绝）→ **入队既有 pendingCommands 通道**（kind `update-worker`，沿用该通道的下发/清除语义，不另建内存 map）；重复点击幂等（已存在同 kind 待发命令直接 ok）；`GET /workers` 出参 += `codeVersion/expectedVersion/updateState/rolledBack`（updateState/rolledBack 为 worker 心跳上报字段透传，字段名与 Todo 4 约定）；单测覆盖：admin 门、404/409、幂等、命令入队与心跳透出
- **uw-worker-executor**：worker 收到 `pendingUpdate` 后的执行器——a) **idle 判定**（有运行中会话 → 本轮跳过继续心跳，指令保持 pending 直到空闲）；b) 下载 tarball + version.json，**sha256 校验不过即放弃并告警**；c) 备份 `dist → dist.prev`；d) 解压覆盖（tarball 内容 = dist/package.json/package-lock.json/scripts/.env.example，**不含 .env 天然安全**）；e) lock 变化时 `npm ci --omit=dev`（记录 lock hash 判定）；f) `systemctl --user restart aiagents-worker`（检测 systemd：`systemctl` 存在 + `/run/systemd/system` + user unit 存在；系统级 unit 同理探测）；g) **无 systemd → 只下载 + 心跳上报 `updateReady: true` 标记，绝不 process.exit**；h) 下载/校验失败 → 保留旧码、退避下轮重试（指令仍 pending）
- **uw-worker-rollback**：**自动回滚**——更新后 `registeredSinceUpdate=false`，register 连续失败达到阈值（次数 + 时间双条件，常量可调）→ 恢复 `dist.prev → dist` → 重启一次 → 心跳/日志上报 `rolledBack: true`（UI 可见"已回滚"提示）；回滚后再失败 → 停止自动动作、只告警（避免震荡）；`dist.prev` 不存在（首装）不回滚
- **uw-web-ui**：Worker 节点页卡片 += codeVersion 徽章（vs `expectedVersion` 不一致 → 高亮"待更新"）、pending/待手动重启/已回滚状态显示；【更新】按钮（admin 门对齐该页既有守卫）→ POST update → 按钮转"已下发，空闲后执行"；数据随现有 `GET /workers` 字段扩展
- **uw-e2e**：本地栈/真实路径验证——① 新旧版本徽章与不一致高亮 ② 点按钮 → worker 下载换码重启 → codeVersion 对齐期望 ③ 人为构造 register 失败 → 自动回滚生效、UI 显示已回滚 ④ 旧 worker（不带 codeVersion）心跳不炸、UI 显示未知版本 ⑤ 无 systemd 场景只标记不退出

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 全自动自更新（无 env 开关，按钮是唯一执行入口）；多 worker 批量更新
- "进程起不来"硬崩溃的自动回滚（自动回滚只覆盖 register 失败路径；硬崩溃 = UI 离线 + `dist.prev` 手动恢复，文档写明一行命令）
- 改 install-worker.sh 首装流程 / start.sh 的 opencode 前置校验 / register 鉴权逻辑
- 心跳协议破坏性变更（旧 worker 缺 codeVersion 必须全程兼容，server 不得对其报错）
- pending 指令落库（复用既有 pendingCommands 通道语义）；**另建与既有 heartbeat commands 并行的专用指令字段/通道**；增量/差分下载；对集群 sts worker 的差异化逻辑（同一套协议，scale>0 时自然生效）
- `as any`/`@ts-ignore`/空 catch；更新路径吞错误

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + jest（server DTO/服务/控制器 spec、worker 更新器/回滚/版本模块 spec；web `npm run build` + `npm run lint`，条件允许时浏览器断言徽章与按钮）
- Evidence: .omo/evidence/task-<N>-worker-self-update.<ext>（outside ulw-loop use .omo/evidence/）

## Execution strategy
### Parallel execution waves
- **Wave 1**（2 todos 并行，文件零交集）：Todo 1（uw-version-stamp，worker+pack 脚本）、Todo 2（uw-heartbeat-proto，server DTO+迁移+env 接线）
- **Wave 2**（2 todos 并行）：Todo 3（uw-command-api，依赖 2）、Todo 4（uw-worker-executor，依赖 1+2）
- **Wave 3**（1 todo）：Todo 5（uw-web-ui，依赖 2+3）
- **Wave 4**（1 todo）：Todo 6（uw-e2e，依赖 1-5）
- **Final verification wave**：F1-F4 并行

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. uw-version-stamp | - | 4, 6 | 2 |
| 2. uw-heartbeat-proto | - | 3, 4, 5, 6 | 1 |
| 3. uw-command-api | 2 | 5, 6 | 4 |
| 4. uw-worker-executor | 1, 2 | 6 | 3 |
| 5. uw-web-ui | 2, 3 | 6 | - |
| 6. uw-e2e | 1-5 | F 波 | - |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [ ] 1. uw-version-stamp：版本戳与发布包版本文件
  What to do / Must NOT do:
  - `scripts/pack-worker.sh`：打包前生成 `worker/dist/version.js`（`export const WORKER_CODE_VERSION='...'`，值 = `git rev-parse --short HEAD`，非 git/失败回退 `manual-<YYYYMMDD>`；注意 dist 是 tsc 产物目录，version 文件生成时机放在 npm run build 之后、tar 打包之前，或以 build 脚本钩子注入——读脚本现状选实现，确保 `tar` 清单包含它）；打包后对 tarball 计 sha256 并生成 `web/public/worker-src.version.json` = `{"version","sha256","builtAt"}`；`tar` 清单维持不变（dist 会自然带上 version.js）
  - worker 运行时版本模块（新文件，如 `worker/src/version.ts`）：`resolveCodeVersion(env)` = env `WORKER_CODE_VERSION`（容器/集群注入，优先）> 读 dist/version.js（try/catch，模块缺失/'dev' 回退）> `'dev'`；单测三优先级
  - 注入路径核实与接线：`worker/Dockerfile`（构建期 `ARG CODE_VERSION` 写入或 ENV）、`docker-compose.yml` worker env、`chart/vteam/templates/*` worker env——与文件戳并存，**env 优先**；deploy-k8s.sh 是否给 worker 传 TAG 属 Todo 2 的 server env 同批（此处只做 worker 侧与 compose/chart 的 worker 段）
  - 单测：版本解析优先级三态、非 git 回退、version.js 缺失回退；pack-worker.sh 用 shell 冒烟（跑一次打包后 tar -tzf 含 version.js 且 version.json 存在且 sha256 与文件一致）
  - Must NOT：不改 tarball 内容清单的其余成员；不动 start.sh/install-worker.sh；不动心跳协议（Todo 2）；不引入新 npm 依赖（sha256 用系统 sha256sum/shasum 或 node crypto）
  Parallelization: Wave 1 | Blocked by: - | Blocks: 4, 6
  References: scripts/pack-worker.sh 全文（构建/打包/发布注释）；worker/Dockerfile；worker/src/config.ts（env 读取惯例）；worker/package.json scripts；docker-compose.yml worker 段；chart/vteam/templates/deployment? statefulset-worker.yaml + values.yaml
  Acceptance: `sh scripts/pack-worker.sh` 成功且 tar 内含 version.js、version.json 字段齐全 sha256 吻合；worker `npm run typecheck` + scoped jest 绿；compose/chart 渲染含注入
  QA: happy——打包冒烟断言；failure——version.js 缺失时 resolve 回退 'dev'。Evidence .omo/evidence/task-1-worker-self-update.txt
  Commit: Y | feat(worker): 构建版本戳与发布包版本文件
- [ ] 2. uw-heartbeat-proto：心跳协议版本通道（两端 + 迁移 + env）
  What to do / Must NOT do:
  - 迁移：workers 表 += `code_version varchar(191) NULL`（+ 索引可选，行数极小可不加）；守卫测试照抄 memory-refcount 模板（schema 声明/基线不含/无回填）
  - server DTO：`RegisterWorkerDto`/`HeartbeatWorkerDto` += `codeVersion?: string`（可选，IsOptional/IsString）；register upsert + heartbeat 刷新写 `codeVersion`（缺席不覆盖已有值或写 null——语义自定并注释）
  - heartbeat **响应**体扩展：`{expectedVersion?, pendingUpdate?}`——expectedVersion 来自 server env `CODE_VERSION`（空/缺省则不下发字段）；pendingUpdate 从内存 map 读（Todo 3 写入，此处只定义透传结构与存储位置注释）；旧 worker 不读响应体新字段亦无害
  - worker 侧 `registry-client.ts`：register/heartbeat payload += `codeVersion`（调用 Todo 1 的 resolveCodeVersion）；响应类型 += 新字段（worker 本轮**只接收不执行**，执行器属 Todo 4）
  - env 注入：`deploy-k8s.sh` helm `--set server.env.codeVersion=$TAG`（TAG 已是 git SHA，天然与 tarball 同源）+ `chart/vteam/values.yaml`/`configmap.yaml`（server.env 段，沿用 memoryMaintenanceIntervalMs 等既有键风格；dev values 同步或显式注释缺省行为）；server 读取常量（`Number.isFinite` 不适用，空串回退 undefined）
  - 单测：register/heartbeat 持久化 codeVersion、缺席兼容（旧 payload 不炸、响应结构合法）、env 空时不下发 expectedVersion、迁移守卫
  - Must NOT：不加 pending 落库列（内存 map 归 Todo 3）；不改心跳鉴权/负载/status 逻辑；不破坏旧 worker 兼容；不动 web UI（Todo 5）
  Parallelization: Wave 1 | Blocked by: - | Blocks: 3, 4, 5, 6
  References: server/src/workers/dto/{register,heartbeat}-worker.dto.ts；workers.service.ts:245-340（register/heartbeat）、:185-190（注释契约）；workers.controller.ts:26-60；prisma schema workers 模型；deploy-k8s.sh helm 段（--set 列表）；chart configmap/values server.env 段；worker/src/client/registry-client.ts:1-160；worker/src/index.ts:650-760（register/心跳响应处理）
  Acceptance: `cd server && npx tsc --noEmit` + `npm run test` 绿（报数）；`cd worker && npm run typecheck` + test 绿；helm template 渲染含 CODE_VERSION
  QA: happy——旧 payload 注册成功且响应含结构；failure——env 缺省无 expectedVersion 且不报错。Evidence .omo/evidence/task-2-worker-self-update.txt
  Commit: Y | feat(worker): 心跳协议版本通道与迁移
- [ ] 3. uw-command-api：更新指令端点（server）
  What to do / Must NOT do:
  - `POST /workers/:id/update`（workers.controller，守卫对齐该控制器既有管理端点——查现状用 JWT 还是 admin，沿用并注释）：worker 不存在 → 404；当前 offline → 409（离线无法接收指令）；幂等——已 pending 同版本直接返回 ok（结构 `{status:'pending', version}`）；写内存 map（workerId → {version, requestedAt}，服务重启丢失可接受，注释说明）
  - 心跳响应透出 pendingUpdate（与 Todo 2 的响应结构汇合；若 Todo 2 先落则此处填值）；worker 执行完成后（Todo 4 上报 ack 或下轮心跳无 pending——**ack 语义在此定义**：建议 worker 执行成功后心跳请求带 `updateAck:true` 或 server 在检测到 codeVersion 已对齐时自动清除 pending——选后者更简单：**心跳里 codeVersion == expectedVersion 且存在 pending → 清除**，注释该收敛规则）
  - UI 数据：`GET /workers` 响应 += `codeVersion`（表字段直读）与 `expectedVersion`/`pendingUpdate`（server 侧计算，含"已回滚"状态——回滚状态先由 worker 心跳上报字段承载，Todo 4 定义字段名，此处只留 TODO 汇合位或先实现对 `updateState` 字段的读取：与 Todo 4 约定字段 `lastUpdateState?: 'pending'|'downloading'|'restarting'|'rolledback'|'ready-manual'`，本 todo 只做透传占位 + 注释）
  - 单测：404/409/幂等/响应透出/清除规则（codeVersion 对齐自动清 pending）/非 admin 门（按实际守卫）
  - Must NOT：pending 不落库；不动 register/心跳鉴权；不做批量端点；不实现 worker 侧执行（Todo 4）
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 5, 6
  References: workers.controller.ts 全文（守卫/路由风格）；workers.service.ts :196 pendingCommands 与 :412-420 心跳下发（**指令入队目标**）、heartbeat(:324-340)；worker-item 响应组装处（GET /workers 出参投影 :800-830 附近，:832+ 窄行投影）；plan 决策①（按钮触发）
  Acceptance: server tsc + `npm run test` 绿（报数）；端点矩阵四态（200/200 幂等/404/409）覆盖
  QA: happy——两次点击幂等且响应一致；failure——offline worker 409。Evidence .omo/evidence/task-3-worker-self-update.txt
  Commit: Y | feat(worker): 更新指令下发端点
- [ ] 4. uw-worker-executor：更新执行器 + 自动回滚（worker）
  What to do / Must NOT do:
  - 指令接入 = **既有 `dispatchCommands` 路由新增 kind `update-worker`**（index.ts :1079 已有分发骨架与 spec——新增 case 调执行器，**先读既有 dispatchCommands 避免与 T4a 命令重入/状态冲突**，Momus 非阻断提示点名要求）；同一时刻仅一个执行流（防重入锁）
  - 执行器步骤（严格顺序 + 每步失败策略）：a) idle 判定——`load.instances > 0` 或已知 running 会话数 > 0 → 跳过本轮（保持 pending，下轮心跳再试，debug 日志）；b) 下载 tarball（URL = 从 install 时 src-url 推导或心跳未带则用 `${serverUrl origin}/worker-src.tar.gz`——**读 install-worker.sh 的缺省推导 `SERVER_URL%/worker-src.tar.gz` 保持同源**）到临时文件 + 下载 version.json 取期望 sha256（version.json 缺失/不匹配 → 放弃并 warn，退避重试）；c) `sha256sum/shasum` 校验（失败即弃，绝不覆盖）；d) lock 是否变化比对（下载的 package-lock vs 本地）→ 变化则覆盖后 `npm ci --omit=dev`（失败 → 立即回滚 dist 并告警）；e) 备份 `rm -rf dist.prev && mv dist dist.prev` → 解压 tarball 的 dist/（及 package*.json、scripts——.env 不在包内天然安全）；f) systemd 检测：`systemctl` + `/run/systemd/system` +（用户级 unit 存在或系统级存在）→ `systemctl [--user] restart aiagents-worker`；g) 无 systemd → **不重启不退出**，置状态 `ready-manual`（心跳上报，UI 显示"已下载待手动重启"）
  - **自动回滚**：进程内状态 `registeredSinceUpdate`——执行更新后置 false，register 成功置 true；连续失败达阈值（常量：次数 ≥ 5 **或** 更新后 ≥ 5 分钟从未注册成功，先到者）且 `dist.prev` 存在 → `rm -rf dist.failed && mv dist dist.failed && mv dist.prev dist` → restart → 状态 `rolledback`（保留 failed 留证）→ 之后不再自动动作（只 warn）；若 register 成功过（registeredSinceUpdate=true）永不回滚
  - 心跳上报：payload += `codeVersion`（Todo 2）+ `updateState?`（上表状态机，与 Todo 3 约定字段）+ `rolledBack?: boolean`（一次性标志，上报后可保持——UI 用于展示最近一次结果）
  - 单测（mock fs/http/systemd 调用）：idle 跳过、校验失败不覆盖、备份-覆盖顺序、无 systemd 不退出、回滚触发阈值（次数/时间）、register 成功不回滚、防重入、下载退避
  - Must NOT：校验不过绝不覆盖；不在无 systemd 时 process.exit；不改 register 鉴权/backoff 主逻辑（在其外层加计数）；不动模型执行链
  Parallelization: Wave 2 | Blocked by: 1, 2 | Blocks: 6
  References: worker/src/index.ts（注册/心跳/重试结构 :650-1110、**dispatchCommands :1079（指令接入点+既有 spec，防重入先读）**）；registry-client.ts（extractCommands :157）；install-worker.sh（src-url 缺省推导、systemd 检测段 :292-330、unit 名 aiagents-worker）；scripts/pack-worker.sh（tarball 清单）；plan 决策②④⑤
  Acceptance: worker typecheck + `npm run test` 全绿（报数）
  QA: happy——mock 全链成功且 systemd 被调；failure——sha256 不符不覆盖 + 阈值回滚。Evidence .omo/evidence/task-4-worker-self-update.txt
  Commit: Y | feat(worker): 更新执行器与自动回滚
- [ ] 5. uw-web-ui：Worker 节点页版本徽章与更新按钮
  What to do / Must NOT do:
  - `web/app/(main)/workers/page.tsx`（+shared.tsx 若卡片在此）：卡片 += codeVersion 徽章（mono 字体，短 SHA 展示）；`codeVersion !== expectedVersion` → "待更新"高亮；`updateState` 状态行（pending/downloading/restarting → 执行中、ready-manual → "已下载待手动重启"、rolledback → "已回滚（新版本异常）"警示）；【更新】按钮——仅 `codeVersion !== expectedVersion` 时可见（一致则无意义），点击 → `POST /workers/:id/update` → 成功转"已下发，空闲后执行"（pending 态）；按钮防双击（请求中 disabled）；admin/守卫门对齐该页既有约定（读页面现状：Worker 页对普通用户可见性如何处理就如何）
  - 错误面：`isApiError` 展示 404/409；`GET /workers` 出参类型扩展（WorkerItem += codeVersion/expectedVersion/pendingUpdate/updateState/rolledBack，字段与 Todo 3 实际实现**逐字对齐——先读服务端出参再写类型**）
  - 空/未知版本（'dev' 或 undefined）：徽章显示 `dev`/`未知`，与期望比对不同则仍可点更新（本地开发语义自定，注释说明）
  - Must NOT：不做批量更新按钮；不引入新依赖；不动 server/worker；不做自动更新（无 env 开关 UI）
  Parallelization: Wave 3 | Blocked by: 2, 3 | Blocks: 6
  References: web/app/(main)/workers/page.tsx 全文（卡片/徽章/守卫/data-testid 惯例 :88-210, :559）；shared.tsx；web/src/api/ 惯例（该页若裸调 api 沿用其风格）；plan 决策①
  Acceptance: web tsc + lint(0 err/729 基线) + build 绿；徽章三态渲染（一致/待更新/回滚）+ 按钮四态（可见/禁用中/已下发/不可用）
  QA: happy——build+lint 绿且（有条件时）浏览器断言徽章与点击流；failure——409 展示正确。Evidence .omo/evidence/task-5-worker-self-update.txt
  Commit: Y | feat(web): worker 版本徽章与更新按钮
- [ ] 6. uw-e2e：端到端验证（更新链 + 回滚链 + 兼容性）
  What to do / Must NOT do:
  - 场景矩阵（可用栈或降级口径，诚实声明）：① 旧 worker 心跳（无 codeVersion）→ server 不炸、UI 显示未知/待更新 ② 点更新 → 指令下发 → worker 空闲执行下载换码重启 → codeVersion 对齐、pending 自动清除、UI 转一致 ③ 人为破坏（改期望版本或喂坏 sha256）→ 不覆盖旧码/回滚生效、UI 显示已回滚 ④ 有 running 会话时点更新 → 指令保持 pending 不打断 ⑤ 无 systemd 模拟 → ready-manual 不退出 ⑥ pack-worker 产物冒烟（version.json sha256 吻合）
  - 无 docker/无真实 worker 机时允许降级：server 集成测试（supertest 指令矩阵）+ worker 单测引用 + web build 冒烟，声明口径
  - Must NOT：为冒烟改业务代码；留脏数据（updateState/进程状态复原）
  Parallelization: Wave 4 | Blocked by: 1-5 | Blocks: F 波
  References: Todo 1-5 证据；docker-compose.yml；install-worker.sh/systemd 检测可用性
  Acceptance: 证据文件逐场景实测输出；降级声明
  QA: happy——更新对齐全链；failure——坏包回滚。Evidence .omo/evidence/task-6-worker-self-update.txt
  Commit: N（证据并入 F 波）

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit：Must have / Must NOT 逐条（重点：无全自动、无批量、硬崩溃不自动回滚、旧 worker 兼容、pending 不落库、校验不过不覆盖、无 systemd 不退出）
- [ ] F2. Code quality review：server+worker+web 三端门禁重跑；无 `as any`/空 catch/吞错；更新路径每步失败策略可追溯
- [ ] F3. Real manual QA：本地/生产链路实测（版本徽章、按钮流、回滚）
- [ ] F4. Scope fidelity：git diff 范围（未动 install-worker 首装/start.sh 校验/register 鉴权、package.json 零 diff）

## Commit strategy
- 每 todo 单独 commit（scope=worker/web）：`feat(worker): <subject>` / `feat(web): <subject>`；小改 amend 合并；迁移文件随其 todo 提交
- 提交前 server tsc+test、worker typecheck+test、web build+lint
- 分支：基于 xishuhq 远端默认分支开发布分支 → 推送 ketabot → PR

## Success criteria
- UI 可见各 worker 当前版本与期望版本，不一致高亮待更新
- 点【更新】→ 空闲 worker 自动换码重启 → 版本对齐、pending 自清、UI 一致
- 坏包/register 失败 → 自动回滚 dist.prev 并 UI 显示已回滚；校验失败绝不覆盖；无 systemd 只标记不退出
- 旧 worker（无 codeVersion）全程兼容不炸
- 三端门禁全绿；F1-F4 全部 APPROVE
