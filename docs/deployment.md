# vteam 部署指南

本文档整理自 vteam 项目实际部署过程中的全部经验（Docker Compose 与 Kubernetes Helm 两套部署方式），涵盖安装步骤、关键配置、常见坑与排障命令，可直接用于生产部署与问题排查。内容均来自真实部署验证（见文末证据索引），不包含未经验证的假设。

## 一、部署方式总览

vteam 提供两套部署方式，按环境选择：

| 方式 | 适用场景 | 说明 |
|------|----------|------|
| Docker Compose（`docker-compose.yml`） | 本地开发 / 单机演示 | 五服务一键编排，`db` 不映射端口，宿主机 13000/13001/14000 |
| Kubernetes Helm（`chart/vteam`） | 生产推荐 | Deployment/StatefulSet/Job 形态，支持持久化、Ingress、多副本，内置 MySQL 可切换外部库 |

两种方式的 env 语义完全对齐（DATABASE_URL / JWT / WORKER_TOKEN / MODEL_CREDENTIAL_KEY / SILENT_SESSION_WAKE_MS / PLATFORM_MCP_URL 等），同一套镜像均可部署。

> **从 OpenCode v1 线切到 v2 线**（改协议、改 CLI 版本、改数据存储形态的那次上线），
> 请直接看 **§八「OpenCode v2 灰度与回滚」**：交付顺序、灰度闸门、观察项清单、回滚步骤
> 与数据影响都在那里，**不需要**读 `.omo/plans/` 里的计划。

## 二、Docker Compose 部署

### 2.1 服务清单与端口

| 服务 | 镜像 | 容器内 | 宿主机 | 说明 |
|------|------|--------|--------|------|
| db | mysql:8 | 3306 | 不映射 | compose 网络内互通，healthcheck 后 init 才执行 |
| init | ./server 构建 | - | - | 一次性：`prisma migrate deploy && node dist/prisma/seed.js`，完成后 server 才拉起 |
| server | ./server 构建 | 3000 | 13000 | NestJS API（`/api/v1`，Swagger `/api/v1/docs`），healthcheck `/api/v1/health` |
| web | ./web 构建（context 为仓库根） | 3000 | 13001 | Next.js standalone，`API_PROXY_TARGET` 代理到 server |
| worker | ./worker 构建 | 4000 | 14000 | opencode 执行节点，serve 0.0.0.0:4000，向 server 注册/心跳 |

> 端口避开原则：本机 dev server 占 3000、web dev 占 3001，故 db 不映射、server 用 13000、web 用 13001。

### 2.2 env 清单

| 变量 | 服务 | 默认/建议 | 说明 |
|------|------|-----------|------|
| `MYSQL_ROOT_PASSWORD` | db | `vteam-root` | DB root 密码（init/server 共用） |
| `DATABASE_URL` | init/server | `mysql://root:...@db:3306/aiagents` | compose 网络内服务名 `db` |
| `JWT_SECRET` | server | compose 默认值 | 登录 JWT 签名密钥，生产用 `openssl rand -hex 32` |
| `JWT_ACCESS_EXPIRES_IN` | server | `2h` | access token 时效 |
| `JWT_REFRESH_EXPIRES_IN` | server | `7d` | refresh token 时效 |
| `WORKER_TOKEN` | server/worker | compose 默认值 | worker 注册/事件鉴权 token，两端必须一致 |
| `MODEL_CREDENTIAL_KEY` | server | **必填**（未设置启动报错） | 模型凭据 AES-256-GCM 主密钥，32 字节，`openssl rand -hex 32` 生成 |
| `SILENT_SESSION_WAKE_MS` | server | `600000` | 事件静默自愈窗口（滑动）：距最近一次回流事件 600s 无事件判一次「静默」→ worker 心跳在线则经 `tryAutoRestart` 自动唤醒重试，最多 `MAX_SILENT_WAKE_ATTEMPTS = 3` 次（每次重武装完整 600s 窗口），心跳已离线则立即失败不唤醒；唤醒耗尽仍无响应才 emitError + agent.error（`silent_session_timeout`）。worker 首字超时缺省禁用（`WORKER_FIRST_TOKEN_TIMEOUT_MS=0`），server 永不抢跑 worker 的诊断路径 |
| `API_PROXY_TARGET` | web | `http://server:3000` | 运行时代理目标（middleware.ts 读取），compose 下为服务名 `server` |
| `X_WORKER_TOKEN` | worker | 同 `WORKER_TOKEN` | worker 侧鉴权 |
| `SERVER_URL` | worker | `http://server:3000` | 注册/心跳的 server 地址 |
| `WORKER_ID` | worker | `w_compose_worker` | compose 单副本固定 |
| `OPENCODE_SERVE_HOSTNAME` | worker | `0.0.0.0` | serve 监听地址（**v2 下控制面不直连 serve**——控制面调 worker 的执行端点 `:4198`，鉴权 `X-Worker-Token`；此处只决定 serve 自身对外可达性） |
| `OPENCODE_SERVE_PORT` | worker | `4000` | serve 固定端口 |
| `WORKER_ADVERTISE_HOST` | worker | `http://worker` | 上报给 server 的 baseUrl（compose 服务名） |
| `WORKER_DEFAULT_MODEL` | worker | 空 | Agent 未配模型时的默认模型兜底 |
| `WORKER_FIRST_TOKEN_TIMEOUT_MS` | worker | `0`（禁用，可 opt-in） | worker 侧首字超时——时限内无首字即 abort 并上报；缺省 0=禁用（线上误杀长脚本/等权限，无真实 hang 证据），env 设正值打开；server 侧不再有 token 探测，对应机制为 `SILENT_SESSION_WAKE_MS`（600000 滑动事件静默自愈） |
| `AGENT_IDLE_TIMEOUT_MS` | server | `0`（禁用，可 opt-in） | server 空闲判死扫描——running 会话超时无任何输出活动 → 判死；缺省 0=关闭扫描（同上，避免误杀长任务），env 设正值打开（如 `1800000`=30min） |
| `WORK_DIR` | worker | `/data/vteam-worker` | 持久化工作目录（serve cwd、.opencode 注入、git clone 仓库） |

> **三条探活路径（worker / server / 心跳，各司其职）**：
> - **worker 首字探测（`WORKER_FIRST_TOKEN_TIMEOUT_MS`，缺省 0=禁用）**：首字/模型诊断唯一归 worker——worker 直接观察 awaitCompletion 轮询，时限内无首字即 abort 并上报 `等待首字超时`，是知情方（可中止会话、附带 serve 诊断）。缺省禁用（长脚本/等权限不被误杀；线上 kill 均为误报），需要时 env 设正值打开。首字出现后无完成超时，长任务由 worker 自行推进（`worker/src/driver/prompt-await.ts`、`worker/src/exec/exec-server.ts`）。
> - **server 事件静默自愈 600s 滑动 ×3**（`SILENT_SESSION_WAKE_MS`，默认 600000）：窗口按「距最近一次回流事件」滑动重武装（每个事件都重置计时），覆盖首字之后的中途静默（首字超时与空闲判死均缺省禁用，此为当前唯一判定路径）。到期先查 worker 心跳——在线则 `tryAutoRestart` 自动唤醒（最多 `MAX_SILENT_WAKE_ATTEMPTS = 3` 次，每次重武装完整 600s 窗口），已离线则立即失败不空转；唤醒耗尽才 emitError + agent.error（`silent_session_timeout`）。
> - **心跳探活 10s/30s**（`WORKER_HEARTBEAT_INTERVAL_MS = 10_000`，`server/src/workers/workers.constants.ts`）：worker 每 10s 上报心跳，`HealthChecker` 将 `lastHeartbeatAt < now - 30s` 的 worker 标为 `offline`（`server/src/workers/workers.service.ts`）——进程死亡走这条路；server 的静默唤醒在 worker 已离线时直接失败（不发起无意义的唤醒）。

### 2.3 卷

| 卷 | 挂载点 | 用途 |
|----|--------|------|
| `mysql_data` | db `/var/lib/mysql` | MySQL 数据 |
| `uploads_data` | server `/app/uploads` | Agent 产出物落盘（server 静态服务挂载点） |
| `worker_work` | worker `/data/vteam-worker` | serve cwd、.opencode 注入、git clone 仓库、任务文件 |
| `worker_home` | worker `/root` | opencode.db 会话库、auth.json 模型凭据、.keta-git-creds.json |

### 2.4 启动与清理

```bash
# 启动（首次自动执行迁移 + seed）
docker compose up -d --build

# 查看状态
docker compose ps

# 清理（保留数据卷）
docker compose down

# 清理（连数据一起删）
docker compose down -v
```

### 2.5 预置账号与种子数据

- 账号：`admin/admin123`（初始管理员）、`seed-admin/Admin@123456`（种子管理员）、`seed-member/Admin@123456`（普通成员）
- 种子数据：5 个模板 Agent（产品经理/项目经理/架构师/开发者/测试）、示例团队 `tm_0000000001`（5 角色各 1 实例）、内置工具 + `vteam` MCP 工具注册、模型目录

## 三、Kubernetes Helm 部署（推荐生产）

### 3.1 chart/vteam 结构

```
chart/vteam/
├── Chart.yaml                 # name: vteam, version: 1.0.0, type: application
├── values.yaml                # 默认值（镜像/replicas/资源/secret/持久化/ingress）
├── values-dev.yaml            # 开发/测试覆盖示例（小资源 + 显式 dev 密码）
├── README.md                  # chart 使用说明
└── templates/
    ├── _helpers.tpl           # 名称/labels/secretName/随机值缓存（secret↔configmap 同源）
    ├── configmap.yaml         # DATABASE_URL 拼装 + 非敏感 env
    ├── secret.yaml            # JWT_SECRET / WORKER_TOKEN / MODEL_CREDENTIAL_KEY / DB_PASSWORD
    ├── deployment-server.yaml # server（env + /app/uploads 挂载 + 探针）
    ├── deployment-web.yaml    # web（探针用 $HOSTNAME，standalone 监听 pod IP）
    ├── statefulset-worker.yaml# worker（StatefulSet + volumeClaimTemplates 每副本独立 PVC）
    ├── statefulset-mysql.yaml # 内置 MySQL（mysql:8 + VCT + healthcheck，db.enabled 时）
    ├── job-init.yaml          # 一次性迁移/种子（initContainer 等待 DB 就绪）
    ├── service-server.yaml / service-web.yaml
    ├── service-worker-headless.yaml  # worker Headless Service（StatefulSet serviceName 必填）
    ├── service-mysql.yaml     # MySQL Headless :3306
    ├── pvc.yaml               # uploads（worker 卷由 StatefulSet VCT 按副本创建）
    ├── ingress.yaml           # /api/v1→server、/→web（默认关闭）
    └── NOTES.txt
```

### 3.2 镜像构建与推送

镜像 registry 使用集群已验证可达的 `docker-hosted.ketaops.cc/xishuhq/`（本机 docker 已有推送凭据），统一 tag 便于标识（如 `vteam-k8s`、`vteam-k8s-pr2nd`）：

```bash
# server（NestJS）
docker build -t docker-hosted.ketaops.cc/xishuhq/vteam-server:vteam-k8s ./server && docker push docker-hosted.ketaops.cc/xishuhq/vteam-server:vteam-k8s

# web（Next.js standalone）—— ⚠️ 必须构建期注入 API_PROXY_TARGET（见 4.2）
# Dockerfile 引用 web/package.json、worker/、scripts/，必须以项目根目录为构建 context
docker build \
  -f web/Dockerfile \
  --build-arg API_PROXY_TARGET=http://vteam-server:3000 \
  -t docker-hosted.ketaops.cc/xishuhq/vteam-web:vteam-k8s . \
&& docker push docker-hosted.ketaops.cc/xishuhq/vteam-web:vteam-k8s

# worker（opencode 执行节点）
docker build -t docker-hosted.ketaops.cc/xishuhq/vteam-worker:vteam-k8s ./worker && docker push docker-hosted.ketaops.cc/xishuhq/vteam-worker:vteam-k8s

# MySQL（如集群无法访问 docker.ketaops.cc/library，重推到已验证 registry）
docker pull mysql:8 && docker tag mysql:8 docker-hosted.ketaops.cc/xishuhq/vteam-mysql:vteam-k8s && docker push docker-hosted.ketaops.cc/xishuhq/vteam-mysql:vteam-k8s
```

### 3.3 安装步骤

```bash
# 1) 创建 namespace
kubectl create ns vteam

# 2) 生成并记录 secret（显式注入，避免 chart 随机化漂移）
#    openssl rand -hex 32 / openssl rand -hex 16（DB 密码）生成，妥善保存

# 3) 首次安装（db.enabled=true 默认内置 MySQL）
helm install vteam chart/vteam -n vteam \
  -f chart/vteam/values-dev.yaml \
  --set secret.jwtSecret=<openssl rand -hex 32> \
  --set secret.workerToken=<openssl rand -hex 32> \
  --set secret.modelCredentialKey=<openssl rand -hex 32> \
  --set secret.dbPassword=<openssl rand -hex 16> \
  --set server.image.repository=docker-hosted.ketaops.cc/xishuhq/vteam-server --set server.image.tag=vteam-k8s \
  --set web.image.repository=docker-hosted.ketaops.cc/xishuhq/vteam-web    --set web.image.tag=vteam-k8s \
  --set worker.image.repository=docker-hosted.ketaops.cc/xishuhq/vteam-worker --set worker.image.tag=vteam-k8s \
  --set db.image.repository=docker-hosted.ketaops.cc/xishuhq/vteam-mysql --set db.image.tag=vteam-k8s

# 4) 验证部署
kubectl rollout status deploy/vteam-server && kubectl rollout status deploy/vteam-web && kubectl rollout status sts/vteam-worker
kubectl wait --for=condition=complete job/vteam-init --timeout=300s
kubectl get pods,svc,pvc -n vteam
```

### 3.4 关键 values

| 路径 | 默认 | 说明 |
|------|------|------|
| `db.enabled` | `true` | 内置 MySQL StatefulSet；`false` 时须 `db.external.enabled=true` + `db.external.url` |
| `replicaCount.{server,web,worker}` | 1 | 各服务副本数；**生产 worker 保持 1**（见 4.3） |
| `worker.resources.limits.memory` | `8Gi` | opencode 执行引擎内存占用高，8Gi 为推荐值（原 4Gi 偏小） |
| `worker.resources.requests.memory` | `1Gi` | 实际常驻约 2Gi，节点紧张可提到 2Gi |
| `worker.persistence.{workerHome,workerWork}.{enabled,size,storageClass}` | 全启用 | 每副本独立 PVC（见 4.3） |
| `worker.updateStrategy.partition` | 空 | 空 = 全量滚动；数字 = 仅更新 ordinal ≥ partition 的副本 |
| `initJob.platformMcpUrl` | 空（自动） | 内置 vteam MCP URL；空 = 按 server Service 名拼 `http://<fullname>-server:3000/api/v1/platform-mcp`（见 4.4） |
| `persistence.{uploads,mysql}.{enabled,size,storageClass}` | 全启用 | uploads 10Gi / mysql 20Gi（默认） |
| `secret.*` / `secret.existingSecret` | 自动生成 | 显式注入优先（见 4.5） |
| `ingress.enabled` / `ingress.host` | `false` / `vteam.example.com` | `/api/v1`→server、`/`→web；SSE 需关缓冲+放宽读超时（values 已内置注解） |

外部数据库模式：

```bash
helm install vteam chart/vteam \
  --set db.enabled=false \
  --set db.external.enabled=true \
  --set db.external.url='mysql://user:pass@external-mysql:3306/aiagents'
```

### 3.5 迁移与 seed（init Job）

- init Job 执行 `npx prisma migrate deploy && node dist/prisma/seed.js`，initContainer 先等待 MySQL 就绪（对齐 compose `depends_on: service_healthy`）。
- seed 全部 upsert，重跑幂等安全。
- ⚠️ Job `spec.template` 不可变：改 values 后 upgrade 前需先删除旧 Job，否则 helm upgrade 报错。

```bash
kubectl delete job vteam-init -n vteam   # upgrade 前执行
helm upgrade vteam chart/vteam -n vteam -f <完整 values 基线>
```

### 3.6 服务访问

```bash
# 端口转发（对齐 compose 宿主端口）
kubectl port-forward svc/vteam-web 13001:3000      # 控制台 http://localhost:13001
kubectl port-forward svc/vteam-server 13000:3000   # API / Swagger
kubectl port-forward sts/vteam-worker 14000:4000   # 调试 opencode serve（转发到 ordinal 0；指定副本用 pod/vteam-worker-N）

# 或启用 Ingress（生产推荐）
helm upgrade vteam chart/vteam -n vteam -f <基线> \
  --set ingress.enabled=true \
  --set ingress.host=vteam.ketaops.cc \
  --set ingress.className=nginx
```

生产实测链路（裸金属集群经 ingress-nginx NodePort 32054，host 为 `vteam.ketaops.cc`）：

```bash
curl -H "Host: vteam.ketaops.cc" http://<node>:32054/          # web 200
curl -H "Host: vteam.ketaops.cc" http://<node>:32054/api/v1/health  # {"status":"ok"} 200
```

## 四、关键配置与坑（重点）

### 4.1 ⚠️ helm upgrade 必须携带完整 values 基线

**教训（REV14 事故）**：`helm upgrade` 只传部分 `--set` 时，其余值会回退 chart 默认值，导致：
- `secret.*` 为空 → `_helpers.tpl` 执行 `randAlphaNum` 重新随机密码 → ConfigMap 的 `DATABASE_URL` 与实际 MySQL root 密码失配 → server 启动报 `Authentication failed against database server` → CrashLoopBackOff；
- 镜像 repository 回退 `docker.ketaops.cc/ketaops/...:latest`（该镜像不存在）→ ImagePullBackOff；
- PVC resize / StatefulSet spec 变更被拒 → helm upgrade 整体 failed。

**正确做法**：

```bash
# 导出当前部署完整 user values 作为基线
helm get values vteam -n vteam -o yaml > /tmp/opencode/vteam-baseline.yaml

# 基线文件里仅修改需要变更的字段（如镜像 tag / 副本数），再 -f 升级
helm upgrade vteam chart/vteam -n vteam -f /tmp/opencode/vteam-baseline.yaml --wait --timeout 300s
```

> 禁用 `--reuse-values`：chart 新增嵌套 values 键时它不会复用新 chart 默认值，会触发 nil。始终用 `helm get values` 导出 + `-f` 的方式。

### 4.2 web 镜像：API_PROXY_TARGET 编译进 routes-manifest

- web 的 rewrites 代理目标**编译进** `routes-manifest.json`，运行时注入 env **无效**。
- compose 镜像默认指向 `http://server:3000`（compose 服务名）；K8s 下 server Service 名为 `vteam-server`，必须**构建期**用 `--build-arg API_PROXY_TARGET=http://vteam-server:3000` 重建。
- 验证：构建后检查镜像内 `/app/.next/routes-manifest.json` 的 `rewrites.afterFiles`，应看到 `/api/v1/:path*` → `http://vteam-server:3000/api/v1/:path*`。

### 4.3 worker：StatefulSet + 每副本独立 PVC + headless DNS

- **每副本独立 PVC（StatefulSet volumeClaimTemplates）**：多副本共享同一 home PVC 并发写 SQLite `opencode.db` 必然损坏（`Tree 23 page 23 Extends off end of page`）。worker 已从 Deployment 迁移为 StatefulSet，PVC 命名 `worker-home-vteam-worker-<ordinal>`，扩容自动建独立卷。
- **WORKER_ID 唯一**：不在 ConfigMap 下发，由 StatefulSet 经 downward API 注入 `w_$(POD_NAME)`（pod 名全局唯一）；多副本时共享同一 ID 会互相覆盖注册（server 以 workerId 为主键 upsert）。
- **WORKER_ADVERTISE_HOST 用 pod 专属 headless DNS**：`http://$(POD_NAME).vteam-worker-headless.<ns>.svc.cluster.local`。若上报共享 ClusterIP 名（`http://vteam-worker`），exec 端口 4198 未在该 Service 暴露，server dispatch 全部 `WorkerUnavailableException(fetch failed)`，表现为**消息只有 ACK 没有实际回复**。
- **无共享 ClusterIP Service**：worker 仅有 headless Service（StatefulSet serviceName 必填）；调试 serve 用 `kubectl port-forward sts/vteam-worker 14000:4000`。
- **副本数**：生产 `replicaCount.worker=1`（多副本需各自独立卷 + 内存充足，非必要不扩）。

### 4.4 内置 MCP（keta-platform）：URL 由 PLATFORM_MCP_URL 控制

- seed 默认把 keta-platform 注册为 `http://server:3000/api/v1/platform-mcp`（compose 服务名）——K8s 下不通。
- 修复：seed 读 `process.env.PLATFORM_MCP_URL ?? 'http://server:3000/...'`；init Job 注入该 env，默认按 server Service 名拼 `http://vteam-server:3000/api/v1/platform-mcp`（`initJob.platformMcpUrl` 可显式覆盖）。
- 存量部署修复（不重装）：`UPDATE mcp_servers SET url='http://vteam-server:3000/api/v1/platform-mcp' WHERE name='keta-platform';` 然后 `kubectl rollout restart sts/vteam-worker`（injectMcp 启动时执行）。
- 注意 worker 容器默认 cwd 是镜像 WORKDIR，探测 MCP 必须 `cd /data/vteam-worker && opencode mcp list` 才能读到注入的 opencode.json。⚠️ **opencode v2 已移除 `--pure`**（传了会 `Unrecognized flag` 并 exit 1）——v2 下**不带 `--pure` 探测**；宿主的全局配置/插件隔离由 worker 的**隔离配置域**（`OPENCODE_ISOLATION_ROOT`）保证（见 07 篇 §12.1）。

### 4.5 内置插件 OmO（oh-my-openagent）

worker 镜像**内置** OmO 插件，用**官方安装器**在构建期完成安装，无需目标环境联网。

| 项 | 值 |
|----|----|
| 上游 | https://github.com/code-yeongyu/oh-my-openagent（npm 包 `oh-my-opencode`，别名 `oh-my-openagent`） |
| 安装方式 | `bunx oh-my-openagent@latest install --no-tui --platform=opencode --skip-auth`（Dockerfile 构建期） |
| 插件声明 | `<WORK_DIR>/opencode.json` 的 **`plugins`** 节（v2 段名；v1 是 `plugin`）（worker 启动注入时写入，幂等） |
| agent 模型配置 | `<WORK_DIR>/.omo/omo.jsonc`（**实际生效**；旧位置 `.opencode/oh-my-openagent.jsonc` 仅在其不存在时接管） |
| 生效前提 | ⚠️ **opencode v2 已移除 `--pure`**（v1 里 `--pure` = 不加载外部插件）。v2 下的等价手段是**隔离配置域**（`OPENCODE_ISOLATION_ROOT`，见 07 篇 §12.1）；另注意 **v1 形态的插件实现不会在 v2 运行**（官方迁移指南明写）⇒ **v2 线按"OmO 关闭"上线**（详见 **§8.5**：镜像能力标记 `/opt/omo-bundled.json` 的 `v2` 字段 = `false` ⇒ 注入器不注册 OmO，并清掉历史遗留条目） |

> ⚠️ **不要与 `oh-my-opencode-slim` 混淆**。后者（`alvinunreal/oh-my-opencode-slim`）是第三方
> 精简 fork，agent 集（orchestrator/explorer/…）与 OmO 完全不同。早期 vteam 误装过 slim；
> worker 的注入器现在会**自动清除**配置里的 slim 条目并写入 OmO，避免两者并存冲突。

**`--pure` 与环境变量 `OPENCODE_PURE`（⚠️ opencode v2 已失效）**

> ⚠️ **订正（2026-10-20，opencode v2 适配）**：**v2 没有 `--pure`**——`opencode serve --pure` 会打印 `Unrecognized flag` 并 **exit 1**，`opencode mcp list --pure` 同理。因此：
> - **worker 不再拼 `--pure`**：`OPENCODE_PURE` / OmO 开关在 v2 上**降级为"只做告警"**（worker 启动日志里明确写出"该开关在 v2 已失效"），**不再有任何抑制效果**；
> - v1 时代"用 `--pure` 抑制第三方插件 / `AGENTS.md` 注入"的语义，改由**隔离配置域**承接：serve 子进程的 `HOME` / `XDG_*` 全部指向 `OPENCODE_ISOLATION_ROOT`（缺省 `<HOME>/.opencode-iso`）⇒ 宿主的全局配置 / 全局插件 / 全局 `AGENTS.md` 不在作用域内。**这是唯一可靠手段**（`plugins: []` / `instructions: []` / `experimental` / `OPENCODE_CONFIG*` 全是 no-op；`plugins:["-*"]` 不可用；`plugins:["-<id>"]` 可精确禁用单个插件）——逐条实测见 07 篇 §12.1；
> - 残留：受管目录（`/etc/opencode` 等）**不受 XDG 控制**（v2 仍会 watch 它），只有 `policies` 能压 ⇒ **不是 100% 等价于 `--pure`**。

serve 默认**不带** `--pure`（v2 下也不可能带），以便加载 OmO。需要纯净基线（对照 token 开销）时：

| 取值 | v1 行为 | **v2 行为（当前）** |
|------|----------|--------------------|
| 未设置（默认） | 非 pure，加载插件（OmO 生效） | 同左（但**隔离配置域**已保证宿主全局插件不进作用域） |
| `true`/`1`/`yes`/`on`/`y` | `--pure`，不加载插件（input tokens 约 1900，非 pure 约 7601） | ⚠️ **开关失效**——worker 只打一条告警，**不拼 `--pure`**；要抑制全局插件请用 `OPENCODE_ISOLATION_ROOT` 隔离配置域 |

> ⚠️ **`OPENCODE_PURE` 不能设为空串**：它同时是 opencode 自身解析的布尔环境变量，空串会让 serve
> 直接启动失败（`SchemaError: Expected "true"|...|"false"..., got ""`）。因此 compose 里**不要**
> 写成 `OPENCODE_PURE: ${OPENCODE_PURE:-}`（未设时会生成空串）；默认整条注释掉即可。
> worker 侧对空串/纯空白会主动删除该变量兜底（见 `opencode-server.ts` 的 `isPureMode()`）。

**验证 OmO 是否真的加载**（serve 静默加载插件，stdout 无提示）：

```bash
# 1) serve 命令行不含 --pure
docker compose exec worker sh -c 'tr "\0" " " < /proc/$(pgrep -f "opencode serve" | head -1)/cmdline'

# 2) 看 GET /api/agent 是否出现 OmO 的 agent（出现 Sisyphus/Prometheus 即已加载）
#    ⚠️ v2 端点是 /api/agent（v1 是 /agent）；v2 恒开鉴权，需带 Basic 头
curl -s -H "Authorization: Bearer $TOKEN" http://<server>/api/v1/agents/opencode | jq '.agents[].name'
#   期望可见：Sisyphus - ultraworker / Hephaestus - Deep Agent / Prometheus - Plan Builder 等
#   ⚠️ 该判据只是"控制面代理的观测面"；插件是否真的被 v2 加载，权威判据是 serve 日志的
#      `msg="loading plugin"` 行 + 工具是否出现在模型请求的 tools[]（GET /api/plugin 不可靠）
```

**OmO agent 与 vteam 职责映射**

OmO 注册的 primary agent（**v2 端点是 `GET /api/agent`**（v1 是 `GET /agent`）返回的**展示名**）：

| agent | 展示名 | vteam 职责 |
|-------|--------|-----------|
| sisyphus | `Sisyphus - ultraworker` | 执行（主编排/派发） |
| prometheus | `Prometheus - Plan Builder` | **计划** |
| hephaestus | `Hephaestus - Deep Agent` | 执行 |
| atlas | `Atlas`（执行落地） | 执行 |

> ⚠️ OmO 的 agent 名是**展示名**（`<Name> - <描述>`），而配置文件里用小写键（`prometheus`）。
> `opencode-agent-duty.ts` 为此取 ` - ` 前的基底名再判定——若按整串精确匹配，OmO 的 agent
> 永远命中不了职责表，表现为"选了计划 agent 却不进计划模式"（实测踩坑，已加回归测试）。

**开关与配置入口：worker 详情页**

OmO 是**与 worker 绑定**的能力（插件在镜像里、配置在 worker workDir、开关只影响该 worker
的 serve 启动），因此入口在 **Worker 详情页**内的「OmO 编排插件」卡片，不是全局页面。

| 操作 | 效果 |
|------|------|
| 开关**关闭** | ⚠️ **v2 下 `--pure` 已失效**——worker 只打告警，**不再以 `--pure` 启动**（v2 无此 flag，传入会 exit 1）。要抑制全局插件请用 `OPENCODE_ISOLATION_ROOT` 隔离配置域；模型配置**保留**。<br>✅ **开关现在直接决定配置**：注入器在写 `plugins` 节时读这个开关，关闭时**不注册** OmO 条目并清掉历史条目（此前它只影响一个早已失效的 flag，"看得见、不生效"） |
| 开关**开启** | v1 线：正常加载插件，可配置各 agent 模型。**v2 线：无效**——镜像内置的是 **v1 形态**入口，v2 不会加载它（见 **§8.5**）；平台核心功能不受影响 |
| 保存配置 | 写盘后**自动重启 serve** 生效（有会话进行中则排队，见下） |

> ⚠️ **镜像未内置 OmO 时不显示该卡片，也无法开启**：worker 启动时读镜像内能力标记
> `/opt/omo-bundled.json`（Dockerfile 构建期写入），`GET /agents/omo-config` 返回
> `bundled` 字段供前端判断；对未内置的 worker 调用 `enabled:true` 返回 **400**
> （明确告知镜像不含 OmO），而不是静默接受一个永远不生效的 true。
>
> 开关状态存 `<WORK_DIR>/.omo/omo-enabled.json`，**不写进 OmO 自己的配置文件**——
> 那个文件由 OmO 管理（会迁移/重写），混进去迟早被覆盖。读取缺省为 true，
> 坏文件也不会把功能悄悄关掉。

**`capabilities.models` 不下发给前端（重要）**

`GET /workers/:id` 返回的 `capabilities` 已**剔除 `models` 字段**：那是 serve 探测到的
**全量模型目录**（实测 7701 项），只用于注册时入库同步（`syncFromWorkerCapabilities`），
对展示无用。原样透传会让单次响应达 **253KB**；剔除后 **0.8KB**（缩小约 330 倍）。

> 需要"可用模型"请看 `capabilities.executableModels`（真正可执行的那几个）。
> `models` 仍照常入库到模型目录，删除的只是 API 响应里的冗余。

**「可用模型」的口径（重要）**

worker 详情页的「可用模型」取 `capabilities.executableModels`——worker 侧用 CLI
（`opencode models`，带鉴权过滤）探测的**真正可执行**清单，与 OmO 配置页的模型下拉同源。

> ⚠️ **不要用 `capabilities.models`**：那是 serve 探测到的**全部模型目录**（实测 7699 条），
> 绝大多数没有可用凭据；直接渲染会把页面撑到几万像素且严重误导（实测踩坑）。
> 兜底顺序：`executableModels` → 目录中 `enabled=true` 的模型 → 空（显示"未上报"）。

**API**（供脚本/自动化；页面走同一组接口）

- `GET /api/v1/agents/omo-config?workerId=` → `{agents, available, enabled, bundled, configPath, configKind, workerId, degraded}`
  （`available` 是 OmO 的可配 agent 清单，来自其包内 schema，不硬编码在 vteam；
  `bundled`=镜像是否内置 OmO，`enabled`=用户开关）
- `GET /api/v1/agents/omo-agent-prompt?workerId=&name=` → 单个 agent 的系统提示词
  （`{name, description, mode, prompt, empty}`）。**按需拉取**：全部 agent 的 prompt 合计
  约 106KB（Sisyphus 单个 33KB），故不随列表下发；动作页「提示词」按钮点开才请求。
  `name` 支持配置键（`prometheus`）或 serve 展示名（`Prometheus - Plan Builder`）；
  该 agent 当前未注册（如 `hephaestus` 需 GPT 系模型）→ **400** 并说明原因。
- `PATCH /api/v1/agents/omo-config?workerId=` body：
  - `{agents:{"<name>":"<providerID>/<modelID>"}}` —— **增量合并**（只改提交项）；
    值传空串 = 清除该 agent 的覆盖，回落 OmO 默认
  - `{enabled: true|false}` —— 切换插件开关（与 agents 可同时提交，也可只提交其一）
  - 响应含 `restart`（`executed`/`pending`/`skipped`），表示 serve 是否已重启

> 模型值必须是 `providerID/modelID`（如 `opencode/big-pickle`）。
> ⚠️ 不要用 `/models` 接口返回的 `id`——那是模型目录主键（`md_` 前缀），写进 OmO 配置无法解析。

**配置落点与优先级（实测确认，勿凭直觉改）**

OmO 按以下顺序找配置，**先命中者胜**：

| 顺序 | 路径 | 说明 |
|------|------|------|
| 1 | `<WORK_DIR>/.omo/omo.jsonc` | **当前生效**（OmO 迁移后的新位置；带 `"[opencode]"` 平台分段与 `_migrations`） |
| 2 | `<WORK_DIR>/.opencode/oh-my-openagent.jsonc` | 旧位置；**仅当上面不存在时**才被读取（扁平 `agents`） |

> ⚠️ 两份同时存在时 `.omo/omo.jsonc` 胜出，旧文件变成**死配置**——改它完全不生效。
> 实证：分别把两份设成不同模型、重启、看会话实际使用的模型，只有 `.omo` 那份生效。
> worker 的读写逻辑（`resources/omo-config.ts`）会自动选择生效的那份，并在接口
> `configPath` / `configKind` 字段回传实际路径，配置页顶部也会显示"生效配置：…"。

**OmO 会自动迁移**：它检测到旧位置的配置后，会把文件搬到 `.omo/omo.jsonc`
（旧文件备份进 `.omo/migration-backup-<时间戳>/` 并删除原文件）。这是 OmO 自身行为，
不是 vteam 写的——所以**不要**手工在 `.opencode/` 下维护这份配置。

配置**在 serve 启动时读取**：改完配置需要重启 serve 才生效。

**保存后自动重启**：配置页（`PATCH /api/v1/agents/omo-config`）保存后，worker 会复用
`RestartCoordinator` 触发 serve 重启，响应 `restart` 字段给出结果：

| restart | 含义 |
|---------|------|
| `executed` | 无活跃会话，已立即重启 —— 下个会话即用新模型 |
| `pending` | 有活跃会话，重启**已排队**，会话归零后自动执行（不会打断进行中的 agent） |
| `skipped` | 未注入重启回调，或重启失败（配置已落盘，下次自然重启生效） |

> 重启失败**不会**让保存失败：配置已写盘，只是本次未即时生效，日志会告警。

**格式**：新位置带平台分段 `{ "[opencode]": { "agents": {…} }, "_migrations": […] }`，
旧位置是扁平 `{ "agents": {…} }`。worker 读写时**保持该文件原有形状**，不动其他键。
### 4.6 opencode CLI 版本策略（已改为**锁版本**）

> ⚠️ **订正（2026-10-20，opencode v2 适配）**：本节原文写的是"**不锁版本**，每次构建取 registry 最新版（`npm i -g opencode-ai`）"。**该策略已废止**——v2 的契约已冻结到可锁版本的程度，平台改为**锁版**：`worker/Dockerfile` 的 `ARG OPENCODE_CLI_SPEC=@opencode/cli@2.0.32`（**不是** `opencode-ai`，那是冻结在 1.19.3 的 v1 线）。配套地：worker **启动期做版本闸门**（`opencode --version` 解析出主版本，**major < 2 → fail-fast**），上报值规范化为 semver 串，与控制面的版本过滤对齐。依据：07 篇 §6 / §12.3、`.omo/plans/opencode-v2-adaptation.md` 的 D2 / T1。

worker 镜像**锁** opencode CLI 版本：`npm i -g @opencode/cli@2.0.32`（Dockerfile ARG `OPENCODE_CLI_SPEC`）。

**为什么锁版本**：v2 是正式发版且契约已冻结（不再是 beta），"浮动"只会引入不可控的契约漂移；锁版**即锁契约基线**——用锁定版二进制重跑一次契约基线快照（`docs/agent-platform/opencode-v2-contract-baseline/`），实现一律以快照为准。

**版本闸门**：worker 启动时解析 `opencode --version`（v2 形如 `opencode v2.0.28`；兼容 v1 形 `opencode 1.19.0`），**主版本 < 2 直接 fail-fast** 并给出可操作错误（"需要 opencode ≥ 2，当前 1.x，镜像未换 OPENCODE_CLI_SPEC"）；版本字符串**认不出**时**不判死**，只告警并上报 `unknown`（解析器不对未来格式过拟合）。

**构建产物如何追溯版本**：构建日志打印 `opencode CLI installed: <版本>`；运行期 `docker compose logs worker`
的启动横幅也打印 `opencodeVersion = <规范 semver>`，worker 详情页可见。

**如需复现某次构建 / 换 CLI 版本**：

```bash
# 换 CLI 版本（只影响"镜像里装哪版 opencode"，不改变 worker 代码）
docker compose build --build-arg OPENCODE_CLI_SPEC=@opencode/cli@2.0.32 worker
```

> ⚠️ **换 CLI 版本 ≠ 回滚到 v1**：worker 代码已单轨 v2，版本闸门要求 opencode **主版本 ≥ 2**
> ⇒ 把 `OPENCODE_CLI_SPEC` 改成 `opencode-ai@1.19.3` 只会让 worker **启动即 fail-fast**
> （"需要 opencode ≥ 2，当前 1.x"）。真正的回滚必须**连代码一起回**（`v1.0.4` tag），
> 步骤见 **§8.6**。

> 注意：`AssignmentRequirement.opencodeVersion` 的比较**两侧都先归一成 semver** 再比
> （`server/src/workers/worker-version.ts` 的 `isSameOpencodeVersion`）⇒ 需求写成
> `opencode v2.0.28` 或 `2.0.28` **都能匹配** worker 上报的 `2.0.32`。
> ⚠️ **但当前没有任何生产调用方设置该字段**（也没有 env/values 开关可以设置）⇒ 这个版本
> 过滤**今天是失效的**，混跑期不会自动挡住跨版本派发 ⇒ 切换时必须先下线 v1 worker。
> 详见 **§8.4**。
> 另注：**回滚不是"换个开关"**——v1 驱动已删除，`OPENCODE_V2_ENABLED=false` 会让 worker
> 启动即抛错；回滚 = **回滚镜像/代码到 `v1.0.4` + 恢复数据卷**，完整步骤见 **§8.6**，
> 数据影响见 **§8.7**。

#### 4.4.1 集群外 worker 配置（WORKER_MCP_URL + 可达地址三件套）

集群外独立部署的 worker（install-worker.sh 一键安装场景）与 server 不在同一集群网络，需同时解决
**内置 MCP 不可达** 与 **server 连不上 worker** 两个问题：

1. **内置 MCP 不可达**：`PLATFORM_MCP_URL` 默认值（`http://server:3000/...` /
   `http://vteam-server:3000/...`，均为集群内服务名）无法解析 → 内置 vteam MCP 探测 failed。
   worker 侧用 `WORKER_MCP_URL` 覆盖：注册时经 `capabilities.mcpUrl` 上报，server 在 worker 拉取
   mcp-servers 时按 worker 覆盖内置地址下发（不修改全局 seed 地址，集群内 worker 无感知）。
2. **server 连不上 worker**：`WORKER_ADVERTISE_HOST` 默认 `http://127.0.0.1`（仅本机可访问），
   server 在远端用回环地址连 worker 执行端点 → 消息只有 ACK 无实际回复、worker 显示不可用。
   须设置为 server 可达的 worker 地址 ⇒ **控制面实际要能到达的是该主机的 `:4198`**
   （执行端点 `WORKER_EXEC_PORT`；执行端点 node:http 已监听 `0.0.0.0`，无需改动）。
   ⚠️ v2 控制面**不直连 opencode serve** ⇒ `OPENCODE_SERVE_HOSTNAME=0.0.0.0` **不是**为了让
   控制面连上 serve，它只决定 serve 自身对外可达（回滚 v1 时 v1 server 直连 serve 才需要）。

```bash
# worker/.env —— 集群外 worker 三件套
WORKER_MCP_URL=http://<控制面外部地址>/api/v1/platform-mcp   # 内置 vteam MCP 外部可达地址
WORKER_ADVERTISE_HOST=http://<worker 局域网 IP>              # server 可达的 worker 地址（baseUrl）
OPENCODE_SERVE_HOSTNAME=0.0.0.0                             # serve 自身对外监听；v2 控制面走 :4198 执行端点，不直连 serve
```

- `<控制面外部地址>`：worker 所在网络可达的 server 地址（如 `https://vteam.example.com`）；
  `<worker 局域网 IP>`：worker 所在网络内 server 可达的 worker 地址。
- 一键安装：`bash install-worker.sh ... --mcp-url http://<控制面外部地址>/api/v1/platform-mcp
  --advertise-host http://<worker 局域网 IP> --serve-hostname 0.0.0.0`；未提供时脚本会醒目提示
  （不强制，本机/集群内 worker 忽略即可）。
- 一键安装的 **opencode 版本缺省 = npm `latest`**（`@opencode/cli@latest` = 最新已发布的 v2）；
  要可复现就加 `--opencode 2.0.32` 钉版。⚠️ 脚本**拒绝 v3+ 的 opencode**（主版本 ≥ 3 硬失败退出），
  且**镜像路径仍单独锁版 2.0.32**（`worker/Dockerfile` 的 `ARG OPENCODE_CLI_SPEC`）——详见 **§8.1.1**。
- worker 探测到内置 MCP 失败且地址为集群内服务名时，`mcp-status-probe` 会在日志输出 WORKER_MCP_URL
  引导提示；启动时未显式设置 `WORKER_ADVERTISE_HOST`（上报 baseUrl 为 `http://127.0.0.1`）时，
  worker 启动日志输出一次可达地址引导提示。

### 4.5 secret：显式注入，避免随机化

| key | 用途 | 生成 |
|-----|------|------|
| `secret.jwtSecret` | JWT 签名 | `openssl rand -hex 32` |
| `secret.workerToken` | worker 注册/事件鉴权 | `openssl rand -hex 32` |
| `secret.modelCredentialKey` | 模型凭据 AES-256-GCM 主密钥（32 字节） | `openssl rand -hex 32` |
| `secret.dbPassword` | MySQL root 密码 | `openssl rand -hex 16` |

- 首次安装留空会自动生成并持久化到集群 Secret（升级复用不轮换）；但生产务必显式提供并备份（Secret 被删则升级重新随机，与 MySQL 数据卷失配）。
- `secret.existingSecret` 支持外部 Secret，但内置 MySQL 时仍须提供 `secret.dbPassword`（ConfigMap 拼 DATABASE_URL 需要明文）。

### 4.6 资源

- worker：`limits.memory=8Gi`（原 4Gi 偏小导致长任务 OOM 风险），`requests.memory=1Gi`（实际常驻约 2Gi）。
- mysql：`limits.memory=2Gi`（512Mi 曾触发 OOMKilled，exitCode 137）。
- server：`limits.memory=1Gi`（默认）。

## 五、运维与排障速查

### 5.1 常见问题与解决

| # | 现象 | 根因 | 解决 |
|---|------|------|------|
| 1 | server CrashLoopBackOff，日志 `Authentication failed against database server` | helm upgrade 未带完整 values，ConfigMap `DATABASE_URL` 密码被随机化，与 MySQL 实际密码失配 | 比对 `kubectl get configmap vteam-config -o yaml` 的 DATABASE_URL 与 `kubectl get secret vteam-secret -o jsonpath='{.data.DB_PASSWORD}'`（base64 解码）；`helm rollback` 或按 4.1 完整基线 upgrade，最后 `kubectl rollout restart deploy/vteam-server` |
| 1b | server/web/init pod `ImagePullBackOff` | 镜像 tag 回退 `latest` 或 tag 写错（如 sed 误改多个 tag） | 检查 `helm get values` 中 image tag，用正确基线重推镜像并 upgrade |
| 2 | 发消息只有 ACK（"收到，正在处理…"）无实际回复；server 日志 `WorkerDispatcher ... 不可用：fetch failed` | worker `baseUrl` 上报共享 ClusterIP 名，exec 端口 4198 未暴露 | 确认 `GET /api/v1/workers` 的 baseUrl 为 `http://vteam-worker-N.vteam-worker-headless...:4000`（headless DNS）；非则按 4.3 修正 WORKER_ADVERTISE_HOST 并 upgrade |
| 3 | 内置 MCP `mcpStatus` 非 connected | seed 注册的 URL 是 compose 的 `server:3000` | 按 4.4 UPDATE mcp_servers + `kubectl rollout restart sts/vteam-worker`；容器内 `cd /data/vteam-worker && opencode mcp list` 确认（⚠️ v2 已移除 `--pure`，带上会 exit 1） |
| 4 | worker 多副本后 `database disk image is malformed` | 共享 home PVC 并发写 SQLite opencode.db | 迁移 StatefulSet 每副本独立 PVC；损坏时降副本、删除损坏 db 重建（运行时会话/缓存，丢失影响有限） |
| 5 | 任务创建 500，`value too long for column description` | description 列 VARCHAR(191) 容量不足 | 已改 TEXT 列（迁移 `20260814150000_text_columns`）；新部署随 init Job 自动应用，存量需重跑迁移 |
| 6 | worker opencode 进程无响应/被杀 | 内存不足（OOMKilled）或模型偶发卡死 | `kubectl top pod` 查看资源，worker limits 提到 8Gi；模型无响应为偶发，重发消息恢复 |
| 7 | helm upgrade 报 Job 不可变（`forbidden`/patch 失败） | Job spec.template 不可变 | `kubectl delete job vteam-init -n vteam` 后重新 upgrade（seed upsert 幂等，重跑安全） |
| 8 | 修改 ConfigMap/Secret 后服务不生效 | K8s 不会热更 env | 修改后必须 `kubectl rollout restart deploy/<svc>` / `kubectl rollout restart sts/vteam-worker` |
| 9 | port-forward 后 curl 仍打到旧服务 / connection refused | 本机 13000/13001 被 compose 部署占用；web standalone 只监听 `$HOSTNAME`（pod IP）非 loopback | 换端口或用 Ingress 验证（`curl -H "Host: vteam.ketaops.cc" http://<node>:32054/...`）；web 探针/访问必须走 pod 内 `$HOSTNAME:3000` |
| 10 | server 启动期短暂 CrashLoop 数次后自愈 | server 与 init Job 无硬依赖，init 建表完成前 Prisma 初始化报错 | 属已知竞态，init 完成后自愈；长期可在 server 加 initContainer 等 init Job |

### 5.2 常用命令

```bash
# 日志
kubectl logs deploy/vteam-server -n vteam --since=24h | grep -i dispatch
kubectl logs -l component=worker -n vteam --tail=100
kubectl logs job/vteam-init -n vteam

# 配置核对
helm get values vteam -n vteam -o yaml          # 当前生效 user values
helm history vteam -n vteam                      # 版本与失败记录
kubectl get configmap vteam-config -n vteam -o yaml
kubectl get secret vteam-secret -n vteam -o jsonpath='{.data.DB_PASSWORD}' | base64 -d; echo

# 访问
kubectl port-forward svc/vteam-server 13000:3000
kubectl port-forward svc/vteam-web 13001:3000
kubectl port-forward sts/vteam-worker 14000:4000

# DB 查询（exec 进 mysql pod）
kubectl exec vteam-mysql-0 -n vteam -- mysql -uroot -p'<dbPassword>' aiagents -e "SELECT id,name,status,last_heartbeat_at FROM workers;"
kubectl exec vteam-mysql-0 -n vteam -- mysql -uroot -p'<dbPassword>' aiagents -e "SHOW COLUMNS FROM tasks LIKE 'description';"

# worker 内核对（注意先 cd 到工作目录）
kubectl exec sts/vteam-worker -n vteam -- sh -c "cd /data/vteam-worker && opencode mcp list"   # ⚠️ v2 无 --pure

# 健康检查
curl -H "Host: vteam.ketaops.cc" http://<node>:32054/api/v1/health
```

### 5.3 健康检查基线（部署完成后应满足）

- pod：server/web/worker 1/1 Running，mysql 1/1 Running，init Completed
- `GET /api/v1/health` → 200 `{"status":"ok",...}`
- `POST /api/v1/auth/login`（admin/admin123 或 seed-admin/Admin@123456）→ 200
- `GET /api/v1/agents` → 5 个模板 Agent
- `GET /api/v1/workers` → 至少 1 个 online，`mcpStatus` 含 `keta-platform: connected`
- 消息链路：群聊发消息 → ACK → dispatch → worker 实际回复落库

## 六、部署历史（REV 演进与经验沉淀）

### 6.1 REV 演进表（ns=vteam）

| 阶段 | REV | 变更 | 证据 |
|------|-----|------|------|
| 首次部署 | install | Helm install，4 镜像推 docker-hosted，显式 secret，Ingress 验证链路 | k8s-deploy |
| WORKER_ID 唯一化 | 5 | ConfigMap 移除共享 WORKER_ID，StatefulSet 经 downward API 注入 `w_$(POD_NAME)`，副本 2 独立注册 | k8s-worker-replicas |
| MCP 修复 | 6 | seed URL 可配置化（PLATFORM_MCP_URL），镜像 vteam-k8s-mcpfix；发现共享 PVC 损坏 SQLite，临时降 1 副本 | k8s-mcp-fix |
| StatefulSet 迁移 | 8 | worker Deployment→StatefulSet + volumeClaimTemplates，每副本独立 PVC（根治共享卷并发写）；`--reuse-values` 弃用 | k8s-worker-statefulset |
| headless DNS | 12 | WORKER_ADVERTISE_HOST 改 pod 专属 headless DNS（修复 dispatch fetch failed 只 ACK 无回复） | k8s-msg-no-response |
| 移除共享 Service | 13 | 删除 worker ClusterIP Service，仅保留 headless（serve 调试走 port-forward sts） | k8s-remove-worker-svc |
| REV14 事故 | 14 FAILED | 只传部分 --set：secret 随机化 + 镜像回退 latest + PVC/STS 变更被拒 → 完整 values 纪律确立 | k8s-server-crash |
| 恢复 | 17 | rollback 13 + 删旧 Job + 完整基线 upgrade + rollout restart | k8s-server-crash |
| 合并前调优 | 21 | worker 副本 1 + memory 8Gi（chart 基线修正）；GitHub main 推送 13 commits | main-fix-and-worker-tune |
| 合并后重建 | 25 | GitHub main 合并（PR#2-4）+ 本地修复，重建 merged/merged2 镜像，完整基线升级，18 个迁移全应用 | k8s-deploy-merged |
| PR 二轮部署 | 27 | PR#5-8 合并，重建 vteam-k8s-pr2nd 镜像，完整基线升级 | github-pr-round2-review-deploy |

### 6.2 教训清单

1. **完整 values 纪律**：helm upgrade 必须带完整基线（`helm get values` 导出 + `-f`），禁止只传单个 `--set` 覆盖；否则 secret 随机化、镜像回退、PVC/STS 变更被拒，产生 CrashLoop + ImagePullBackOff（REV14）。
2. **web 代理目标构建期注入**：`API_PROXY_TARGET` 编译进 routes-manifest.json，运行时 env 无效，换环境必须重建镜像。
3. **worker 多副本 = 独立存储**：SQLite opencode.db 不可共享卷并发写，必须 StatefulSet 每副本独立 PVC。
4. **唯一身份**：WORKER_ID 用 pod 名（`w_$(POD_NAME)` downward API），避免多副本注册互相覆盖。
5. **可寻址性**：WORKER_ADVERTISE_HOST 必须用 pod 专属 headless DNS，且 exec 端口 4198 随 baseUrl origin 可达；共享 ClusterIP 名会因端口未暴露导致 dispatch 全挂。
6. **seed 默认值要按部署形态**：内置 MCP URL 默认 compose 服务名 `server:3000`，K8s 下必须由 `PLATFORM_MCP_URL` 覆盖为 server Service 名。
7. **secret 显式注入并备份**：随机密码依赖 Secret 持久化，Secret 被删则升级失配；MODEL_CREDENTIAL_KEY 必须 32 字节。
8. **Job 不可变**：upgrade 前先 `kubectl delete job vteam-init`；seed upsert 幂等可安全重跑。
9. **ConfigMap 修改后 rollout restart**：env 不热更。
10. **资源容量**：worker limits 8Gi（原 4Gi 偏小）、mysql 2Gi（512Mi OOMKilled）、server 1Gi。
11. **验证链路差异**：本机 13000/13001 可能被 compose 占用、web standalone 只监听 `$HOSTNAME`——外部验证以 Ingress（Host header）为唯一可信入口；server 启动与 init 存在竞态 CrashLoop 属已知自愈行为。

## 七、相关证据文件索引

部署相关的会话证据位于 `.omo/evidence/role-instance-separation/`：

| 文件 | 主题 |
|------|------|
| `k8s-deploy.txt` | Helm 首次部署：镜像策略、ns、install 参数、Ingress 验证链路、风险 |
| `k8s-server-crash.txt` | CrashLoopBackOff：REV14 失败升级教训（secret 随机化/镜像回退）、修复与恢复 |
| `k8s-worker-replicas.txt` | WORKER_ID pod 名唯一化（downward API）、多副本独立注册实证 |
| `k8s-worker-statefulset.txt` | Deployment→StatefulSet 迁移、每副本独立 PVC、`--reuse-values` 陷阱 |
| `k8s-mcp-fix.txt` | 内置 MCP 连接失败：PLATFORM_MCP_URL 可配置化、mcpStatus connected 双证 |
| `k8s-remove-worker-svc.txt` | 移除共享 worker Service，headless 直连 + serve 调试方式 |
| `k8s-msg-no-response.txt` | 消息无反应：WORKER_ADVERTISE_HOST headless DNS 修复全链路复验 |
| `k8s-deploy-merged.txt` | GitHub main 合并 + 本地修复重建部署（REV25）与 PR 冒烟 |
| `github-pr-round2-review-deploy.txt` | PR#5-8 二轮合并 + 部署（REV27）与验证 |
| `main-fix-and-worker-tune.txt` | GitHub main 推送、worker 副本 1 + 内存 8Gi 调优 |
| `fix-text-columns.txt` | TEXT 列迁移（任务创建 500 修复）与 K8s 部署验证 |
| `helm-chart.txt` | chart 结构、模板渲染抽查、设计要点与风险 |

## 八、OpenCode v2 灰度与回滚（v2 切换专用）

> **适用范围**：从 OpenCode **v1 线（`v1.0.4` tag）**切到 **v2 线**的那一次上线。
> 本节是**可执行的操作手册**：照着做即可，不需要读 `.omo/plans/` 里的计划。

### 8.0 先读这五条硬事实

1. **没有代码级开关能退回 v1**。`OPENCODE_V2_ENABLED=false` 在 worker 的 `loadConfig`
   阶段**直接抛错**（v1 驱动已随 v2 切换删除，`worker/src/config.ts` 的
   `parseDriverModeSwitch`）。⇒ **回退 = 回滚镜像/代码到 `v1.0.4`**，不是"改个 env"。
   该 env 保留下来只为**响亮失败**并指向真正的回退手段。
2. **server 与 worker 必须一起换**。v2 把控制面↔opencode 的通道从"控制面直连 serve"
   换成了"控制面调 worker 的执行端点"：`POST /sessions`、`POST /sessions/:id/prompt`、
   `GET /sessions/:id/messages`、`POST /sessions/:id/abort`、`GET /models`（鉴权
   `X-Worker-Token`）。**v1 worker 没有这些端点**（v1 的执行端点只有 `/execute`、
   `/file`、`/agents`、`/todos` …），**v1 server 则直连 serve 的 v1 路由**（`/session`、
   `/session/:id/prompt_async` …，v2 上已移除）。⇒
   **v1 server + v2 worker 与 v2 server + v1 worker 都不能互通**（不是"能跑但降级"，
   是会话链路直接断）。
3. **数据卷快照：要，但"硬前置"只在一种部署形态下成立**（详见 §8.6/§8.7）。v2 把会话存储
   换成了 SQLite `opencode.db`，而 worker 的 serve 跑在**隔离配置域**里
   （`XDG_DATA_HOME=<HOME>/.opencode-iso/data`；隔离根 `OPENCODE_ISOLATION_ROOT` 缺省
   `<HOME>/.opencode-iso`，见 `worker/src/config.ts` 的 `resolveIsolationScope`）
   ⇒ **v2 的库落在与 v1 不同的目录**（v1 的库在 `<HOME>/.local/share/opencode/`）
   ⇒ **v2 不会就地迁移 v1 的库**。
   ⇒ **缺省形态下，回滚不需要恢复数据卷**：v1 自己的数据原封未动，**v1 期间产生的会话
   全部还在**；损失是**有界的**——只丢 v2 窗口期内新建的会话（以及平台侧引用这些 v2 会话
   id 的行，v1 解析不了）。
   ⇒ **例外（这一种形态下快照才是硬前置）**：若把 `OPENCODE_ISOLATION_ROOT` /
   `XDG_DATA_HOME` **指回了 v1 的数据目录**，v2 的迁移就是**就地**发生的
   ⇒ **v1 的二进制读不到 v2 形态的会话库**（v1 连卷都读不了）⇒ **必须**恢复卷。
   ⇒ **动手前先确认** `OPENCODE_ISOLATION_ROOT` **没有**指向 v1 的数据目录
   （缺省值即安全形态）——否则"回滚不用恢复卷"这句话**不成立**。
   ⇒ **两种形态的回滚步骤完全一样**，都按 §8.6 做即可（快照是**便宜的保险**：建 G0 闸门
   时顺手做掉），但它**不是**缺省形态下的**无条件硬前置**。
4. **没有"混跑保护网"**。调度器确实有 opencode 版本过滤，但**当前没有任何生产调用方**
   设置 `AssignmentRequirement.opencodeVersion` ⇒ 该过滤**今天是失效的**
   （详见 §8.4）。⇒ **切换前必须把 v1 worker 全部下线**，不能指望调度器帮你挡住。
5. ⚠️ **MCP 状态是五态 ⇒ server 必须先于 worker 上线**（**线契约顺序是硬约束**）。
   v2 的 `GET /api/mcp` 有五个状态：`connected` / `pending`（还在连）/ `disabled`
   （配了但关着）/ `failed` / `needs_auth`。worker 心跳把状态**原样**上报，server 侧
   `McpStatusEntryDto.status` 用 `@IsIn` **逐字校验**。⇒ **server 必须先接受这五个值**，
   否则新 worker 一旦上报 `pending` 或 `disabled`，**整条心跳被 400 拒绝**
   （`mcpStatus` 是 `@ValidateNested({each:true})` ⇒ **数组里混进一个非法值 ⇒ 整包校验失败**）
   ⇒ worker 心跳全部丢失 ⇒ **30s 内被判离线**（3 个心跳周期）。
   ⇒ **滚动更新 worker 只有在 server 已经是新版之后才安全**：先起新 worker 正是这个故障模式。

### 8.1 交付顺序（制品）与每一步的理由

| 序 | 制品 | 内容 | 为什么必须在这个位置 |
|----|------|------|---------------------|
| 0 | **数据卷快照** | worker 的 **home 卷**（opencode 会话库/凭据）与 **work 卷**（注入配置/任务文件）各一份 | 必须在**第一个 v2 worker 启动之前**完成（启动即写新形态数据，事后无法还原） |
| 1 | **v2 线的 server 镜像** | 控制面改调 worker 执行端点 | 与 worker 同批换（事实 2）；**并且必须先于 worker 就位**——server 侧的 MCP 状态校验必须**先**接受 v2 的五态（事实 5）：否则新 worker 上报 `pending`/`disabled` ⇒ 整条心跳 400 ⇒ worker 判离线 |
| 2 | **v2 线的 worker 镜像** | 内含 opencode CLI，**钉死** `@opencode/cli@2.0.32`（Dockerfile `ARG OPENCODE_CLI_SPEC`）；同一镜像还带平台自己的工具插件（`.opencode/plugins/*.ts`，v1/v2 双形态） | 与 server 同批换（事实 2）；**必须在 server 之后**（事实 5）；**回滚镜像也会把 CLI 一起回滚**（v1 线钉的是 `opencode-ai` = 1.19.3） |
| 3 | **注入配置**（`<WORK_DIR>/opencode.json`） | 由 worker 的注入器在启动时重写：v1 段名 → v2 段名（`agent:`→`agents:`、`prompt`→`system`、`permission{}`→`permissions[]`、`mcp:`→`mcp.servers:`、`plugin:`→`plugins:`） | 配置在**持久卷**上（镜像不是）⇒ 旧段名会一直留在文件里。v2 遇到 v1 段会**静默归一化**（角色提示可能整段丢失且**零告警**）⇒ 注入器每次写盘前都做幂等迁移 |
| 4 | **OmO 插件条目** | v2 线的 worker **不注册** OmO（镜像内置的是 v1 形态入口，v2 不加载） | 见 §8.5 |

> **注入配置是"静默降级"的头号来源**：`<WORK_DIR>/opencode.json` 的形态不对时，平台**不
> 报错**，只是角色提示/权限规则悄悄不生效。所以 §8.3 把"归一化诊断计数 = 0"列为**硬闸门**。

> ⚠️ **顺序 1 → 2 是线契约约束，不只是"顺手先上 server"**（对应事实 5）：
> v2 的 MCP 状态是**五态**，server 的 `McpStatusEntryDto.status` 用 `@IsIn` **逐字校验**，
> 而心跳里的 `mcpStatus` 是 `@ValidateNested({each:true})` ⇒ **数组里混进一个 server 不认识的
> 状态值 ⇒ 整条心跳 400** ⇒ worker 的心跳全丢 ⇒ **30s 内被判离线**。
> ⇒ **server 必须先接受五态，worker 才能开始上报五态**；**滚动更新 worker 只有在 server
> 已是新版之后才安全**——"先起新 worker、后升 server" 正是这个故障模式（worker 刚起来就
> 报 `pending`/`disabled`，server 不认 ⇒ 400 ⇒ 判离线 ⇒ 看起来像"worker 起不来"）。

### 8.1.1 物理机 / 集群外 worker（不在 chart 编排内）

本章的交付顺序默认 worker 是 **Helm 管理的 StatefulSet**。**物理机 / VM 上的 worker**
（systemd，`EnvironmentFile=<dir>/worker/.env`）**不在 chart 的 rollout 编排内**——它的升级
由运维手工控制 ⇒ "**先升 server、再升 worker**"这条硬约束**天然可执行**（先把 server 升完，
再重启 worker）。四条要点：

- **opencode CLI 必须是 v2**：物理机一键安装脚本（`install-worker.sh`）**缺省按 npm 的 `latest` 标签装**
  （`@opencode/cli@latest` = 最新已发布的 v2）——裸机安装跟随上游发布；需要可复现时用
  `--opencode 2.0.32` **钉版**（v2 **改了包名**；v1 的 npm 包 `opencode-ai` 永远停在 1.19.3，
  **到不了 v2**）。
  ⚠️ **脚本拒绝 v3+ 的 opencode**：装出来的 opencode 主版本 ≥ 3 时**硬失败退出**——worker 驱动只对着
  v2 验证过，而 worker 自身的版本闸门只拦 `< 2` ⇒ v3 会被放行、到运行期才以难排查的方式失败
  （契约漂移）⇒ 请钉一个 v2 版本，如 `--opencode 2.0.32`。
  ⚠️ **镜像路径仍单独锁版 2.0.32**（`worker/Dockerfile` 的 `ARG OPENCODE_CLI_SPEC`）——与脚本的
  `latest` 缺省互不影响 ⇒ 物理机与镜像两条路径可能落在不同 opencode 版本上（但都满足 worker 的
  「主版本 ≥ 2」闸门）。
- **`OPENCODE_SERVER_PASSWORD` 必须写进那份 `.env`**：v2 **恒开鉴权**，缺它 worker
  **启动即 fail-fast**（不是"先跑起来再报错"）。
- **控制面只连 worker 的执行端点**（`WORKER_EXEC_PORT`，缺省 4198）：该端口必须对控制面
  **可达**；**serve 端口不必对外暴露**（serve 可以留在回环，见 §8.0 事实 2）。
- **升级前先快照 `<WORK_DIR>/opencode.json`**：注入器会把它**改写成 v2 形态**
  （`mcp:` → `mcp.servers:`）⇒ 残留的 v2 形态嵌套键被 **v1 的注入器**读到会**误解析 MCP 段**
  （这一份文件就是本形态下"数据卷快照"的对应物）。

### 8.2 灰度步骤与闸门

**阶段 0 —— 前置（不可跳过）**

```bash
# 0.1 导出 values 基线（灰度前！）——§4.1 的纪律，缺了它回滚也回滚不干净
helm get values vteam -n vteam -o yaml > /tmp/opencode/vteam-baseline-v1.yaml

# 0.2 记录灰度前基线（会话成功率 / 首字延迟），作为后续对比的对照组
kubectl exec vteam-mysql-0 -n vteam -- mysql -uroot -p'<dbPassword>' aiagents -e \
  "SELECT status, COUNT(*) FROM sessions WHERE created_at >= NOW() - INTERVAL 7 DAY GROUP BY status;"

# 0.3 快照数据卷（见 §8.6.3 的具体命令），并**验证快照可恢复**
# 0.4 构建并推送 v2 线的三个镜像（server / web / worker）
# 0.5 升级前数据检查：成员是否仍绑着「v2 上不存在」的外部 agent（详见 §8.2.1）
#     期望：**0 行**；有输出 ⇒ 先按 §8.2.1 的两条修复 SQL 处理完，再动第一个 v2 worker
kubectl exec vteam-mysql-0 -n vteam -- mysql -uroot -p'<dbPassword>' aiagents -e \
  "SELECT tm.id, t.name, tm.alias, ar.key, tm.opencode_agent_name FROM team_members tm JOIN teams t ON t.id=tm.team_id LEFT JOIN agent_roles ar ON ar.id=tm.role_id WHERE tm.opencode_agent_name IS NOT NULL AND TRIM(tm.opencode_agent_name)<>'' AND tm.opencode_agent_name NOT IN ('build','plan','general','explore','compaction','title','summary') AND NOT EXISTS (SELECT 1 FROM agents a2 WHERE a2.agent_key IS NOT NULL AND CONCAT('vteam-',a2.agent_key)=tm.opencode_agent_name);"
```

#### 8.2.1 升级前数据检查：成员绑定的外部 agent 在 v2 上是否存在

> **为什么必须"切换前"做**（不是切换后再说）：v2 线**不加载 OmO** ⇒ 三个 OmO 的 agent 名
> （`Sisyphus - ultraworker` / `Prometheus - Plan Builder` / `Atlas - Plan Executor`）在 v2 上
> **不存在**（实测见 §8.5 与 `docs/agent-platform/opencode-v2-agent-fallback-evidence/`）；
> 而存量团队里绑定这三个外部岗位的成员，**`TeamMember.opencodeAgentName` 里已经写着这些名字**
> （`server/src/teams/teams.service.ts` 的 `resolveMemberBinding` 规则 5 预填）
> ⇒ 派发时它**无条件胜出**（`server/src/chat/worker-dispatcher.ts`）
> ⇒ opencode **静默接受**（`POST /api/session/{id}/agent` 返回 **204**，无任何错误信号）
> ⇒ **每一轮**真正执行时抛 `Agent not found` ⇒ **该成员在 v2 上每一轮都失败、没有回复**。
> ⇒ **必须在第一个 v2 worker 起来之前**清掉这类绑定（否则灰度第一档就踩）。

**列名口径（先对，别照抄 prisma 字段名）**：prisma 用 `@map` 把 camelCase 字段映射成
snake_case 列 ⇒ SQL 里必须写**列名**：`team_members.opencode_agent_name`（字段
`opencodeAgentName`）、`team_members.role_id`、`team_members.team_id`、
`agent_roles.default_opencode_agent_name`（字段 `defaultOpencodeAgentName`）、
`agent_roles.key`、`agents.agent_key`、`teams.name`。

**① 检查（只读 SELECT）**：列出所有**绑着 v2 上不存在的 agent 名**的成员
（"存在"的判据 = 控制面注入的 `vteam-<agent_key>`（v2 上存在）或 opencode 内置 agent）：

```sql
SELECT
  tm.id                          AS member_id,
  t.name                         AS team_name,
  tm.team_id                     AS team_id,
  tm.alias                       AS member_alias,
  tm.seq                         AS seq,
  tm.role_id                     AS role_id,
  ar.key                         AS role_key,
  ar.name                        AS role_name,
  tm.opencode_agent_name         AS bound_agent_name,
  ar.default_opencode_agent_name AS role_default_agent_name,
  CASE
    WHEN tm.opencode_agent_name IN ('Sisyphus - ultraworker','Prometheus - Plan Builder','Atlas - Plan Executor')
      THEN 'OmO agent（v2 不加载 ⇒ 必然不存在）'
    ELSE '其它未知名字'
  END AS verdict
FROM team_members tm
JOIN teams t             ON t.id  = tm.team_id
LEFT JOIN agent_roles ar ON ar.id = tm.role_id
LEFT JOIN agents a       ON a.id  = tm.agent_id
WHERE tm.opencode_agent_name IS NOT NULL
  AND TRIM(tm.opencode_agent_name) <> ''
  AND tm.opencode_agent_name NOT IN
      ('build','plan','general','explore','compaction','title','summary')
  AND NOT EXISTS (
        SELECT 1 FROM agents a2
        WHERE a2.agent_key IS NOT NULL
          AND CONCAT('vteam-', a2.agent_key) = tm.opencode_agent_name
      )
ORDER BY t.name, tm.seq, tm.id;
```

**② 修复（两条 UPDATE，按顺序做；先在测试库演练）**：

```sql
-- 修复 ①：清掉**成员行**里的外部名 ⇒ 派发回落到平台的 vteam-<role> agent（v2 上存在）
UPDATE team_members tm
SET tm.opencode_agent_name = NULL
WHERE tm.opencode_agent_name IS NOT NULL
  AND TRIM(tm.opencode_agent_name) <> ''
  AND tm.opencode_agent_name NOT IN
      ('build','plan','general','explore','compaction','title','summary')
  AND NOT EXISTS (
        SELECT 1 FROM agents a2
        WHERE a2.agent_key IS NOT NULL
          AND CONCAT('vteam-', a2.agent_key) = tm.opencode_agent_name
      );

-- 修复 ②：把**岗位**的外部槽位指向平台自己的 agent 名（v2 上存在）
UPDATE agent_roles
SET default_opencode_agent_name = CASE `key`
      WHEN 'sisyphus'   THEN 'vteam-developer'
      WHEN 'prometheus' THEN 'vteam-plan'
      WHEN 'atlas'      THEN 'vteam-developer'
    END,
    updated_at = NOW(3)
WHERE `key` IN ('sisyphus','prometheus','atlas')
  AND default_agent_id IS NULL;
```

**两条修复各自为什么必须存在**：

- **修复 ①（成员行）**：派发时 `opencodeAgentName` **无条件**优先（`?? policyCandidate ?? omit`）
  ⇒ 只要成员行里还留着那个名字，opencode 就会收到它 ⇒ 清成 `NULL` 后派发才回落到平台的
  `vteam-<role>` agent（控制面注入 ⇒ v2 上**存在**）。
- **修复 ②（岗位行）**：**只清成员行不持久**——`resolveMemberBinding`（**规则 5 预填**）在
  **成员被重新绑定岗位**时会把岗位的 `defaultOpencodeAgentName` **再填回**成员行
  （`prefill ≠ override`：仅当成员当前值为空时写入）⇒ 岗位不改，成员下次被重绑就**又变回**
  那个不存在的名字。岗位改指 `vteam-developer` / `vteam-plan`（**平台自己的 agent 名**）后，
  之后发生的预填也落在**存在**的名字上。
- ⚠️ **不要把岗位的外部槽位清空**：两个槽位**互斥**
  （`default_agent_id` 与 `default_opencode_agent_name` 同时非空 ⇒ 400 `AGENT_ROLE_DEFAULT_SLOT_CONFLICT`），
  而这三个外部岗位**本来就没有** `default_agent_id` ⇒ 两个都空 ⇒ 派发直接失败
  （400 `ROLE_DEFAULT_AGENT_MISSING`）⇒ **岗位必须保持可派发**。
  修复 ② 的条件里限定了 `default_agent_id IS NULL` ⇒ **只改外部槽位 ⇒ 不产生互斥冲突**。

**③ 复检**：把 ① 再跑一遍 ⇒ **必须 0 行**；再抽查岗位行：

```sql
SELECT id, `key`, default_agent_id, default_opencode_agent_name
FROM agent_roles
WHERE `key` IN ('sisyphus','prometheus','atlas');
```

⇒ 期望：外部槽位 = `vteam-developer` / `vteam-plan` / `vteam-developer`，且 `default_agent_id` 仍为 `NULL`。

**闸门 G0**（全部满足才允许动 worker）：

- [ ] home 卷 + work 卷快照**已创建**，且**做过一次恢复演练**（"创建了快照" ≠ "能恢复"）
- [ ] v1 线的三个镜像仍在 registry 里（回滚要用；`v1.0.4` 树构建）
- [ ] `vteam-baseline-v1.yaml` 已导出并**确认含 v1 的 image tag**
- [ ] 灰度前基线（会话成功率、首字延迟）已记录
- [ ] `OPENCODE_SERVER_PASSWORD` 已就位（v2 恒开鉴权，缺失 → worker 起不来）
- [ ] `WORKER_TOKEN`（server 侧）== `X_WORKER_TOKEN`（worker 侧）——**同一个 Secret key**
- [ ] **（§8.2.1）没有成员绑着「v2 上不存在」的 agent 名**——升级前数据检查 0.5 **无输出**
      （存量团队若有成员绑在 OmO 的 agent 名上 ⇒ v2 上**每一轮都失败**且没有回复，
      故障点在 opencode 的**执行期**、不在切换期 ⇒ 灰度第一档就会踩，见 §8.5）
- [ ] **（事实 5）server 侧 MCP 状态校验已接受 v2 五态**（`connected` / `pending` /
      `disabled` / `failed` / `needs_auth`）——**必须在任何新 worker 起来之前**；
      校验未放宽就放 worker ⇒ 心跳 400 ⇒ worker 判离线

**阶段 1 —— 硬切（server 先、worker 后；worker 只留 1 个）**

> ⚠️ **不要用 `worker.updateStrategy.partition` 做这次切换**。partition 会让 ordinal 0
> 保留 v1 镜像、其余升 v2 ⇒ **v2 server 会把任务派给 v1 worker**（版本过滤是失效的，
> 见 §8.4）⇒ 必炸。正确做法是**先把 v1 worker 全部下线，再按新镜像起 1 个**。

> ⚠️ **server 必须先就位、worker 才能起来**（事实 5 的直接后果）：新 worker 一上报
> `pending`/`disabled`，**旧 server 的 `@IsIn` 拒收 ⇒ 整条心跳 400 ⇒ worker 判离线**。
> ⇒ 顺序固定为「**先升 server（并确认它已接受五态）→ 再起新 worker**」；
> **滚动更新 worker 只有在 server 已是新版之后才安全**。

```bash
# 1.1 v1 worker 全部下线（事实 4：没有混跑保护网）
kubectl scale sts/vteam-worker -n vteam --replicas=0

# 1.2a 先把 server（+ web）升到 v2 线并等它就绪——它必须先接受 MCP 五态（事实 5）
helm upgrade vteam chart/vteam -n vteam -f /tmp/opencode/vteam-baseline-v1.yaml \
  --set server.image.tag=<v2-tag> \
  --set web.image.tag=<v2-tag> \
  --wait --timeout 300s
kubectl rollout status deploy/vteam-server -n vteam --timeout=300s

# 1.2b server 就绪后再升 worker 镜像（此时 worker 只起 1 个）
helm upgrade vteam chart/vteam -n vteam -f /tmp/opencode/vteam-baseline-v1.yaml \
  --set server.image.tag=<v2-tag> \
  --set web.image.tag=<v2-tag> \
  --set worker.image.tag=<v2-tag> \
  --set replicaCount.worker=1 \
  --wait --timeout 300s

# 1.3 验证 worker 注册与版本上报
kubectl get pod -n vteam -l app.kubernetes.io/component=worker
curl -s -H "Authorization: Bearer $JWT" http://<server>/api/v1/workers | jq '.[] | {id,status,opencodeVersion}'
#    期望：status=online，opencodeVersion="2.0.32"（规范 semver）
#    若 status 变 offline 且日志有 400 ⇒ server 还没接受五态（事实 5）⇒ 立刻停手、升 server
```

**闸门 G1**（≥30 分钟 **且** ≥20 个真实会话后逐条核对，判据见 §8.3）：

- [ ] **401 计数 = 0**
- [ ] **配置归一化诊断计数 = 0**
- [ ] **重复终态计数 = 0**
- [ ] 会话成功率 ≥ 灰度前基线（不下降）
- [ ] 首字延迟 P95 ≤ 15s（目标 ≤5s）
- [ ] MCP 探针：`vteam` + `keta-platform` 均 `connected`（不是"全部未连接"）；
      **若看到 `pending`/`disabled` 属正常**（v2 五态：还在连 / 配了但关着，
      **都不是 failed**）——web 徽章已按五态渲染（`连接中` / `已停用`）
- [ ] **心跳无 400**（server 侧 `POST /workers/:id/heartbeat` 无 400 计数）——
      有 400 ⇒ server 还没接受五态（事实 5）
- [ ] 一条真实 @ 触发走完：ACK → 首字 → 终态 → 产出物落库（`uploads` 有文件、DB 有 artifact 行）
- [ ] worker 日志无插件加载失败（OmO 在 v2 **不加载**，这是预期，见 §8.5）

**阶段 2 —— 10%**：目标 worker 规模 N ⇒ `replicas = max(1, round(0.1N))`，
观察 ≥1 个工作日 ⇒ **闸门 G2 = G1 的全部条目**。
**阶段 3 —— 50%**：`replicas = max(1, round(0.5N))` ⇒ **闸门 G3 = G1**。
**阶段 4 —— 100%**：`replicas = N` ⇒ **闸门 G4 = G1**；**数据卷快照至少保留 7 天**再清理。

> **升档规则**：G1..G4 任一条不达标 ⇒ **停在当前档位**，不要升档。
> 若不达标项属于 §8.3 的"必须为 0"类（401 / 归一化诊断 / 重复终态）且**当场修不掉**
> ⇒ 直接走 §8.6 的**回滚**。

### 8.3 灰度观察项（每一项都给取数方式与越界处置）

> ⚠️ **两类"静默失败"不会触发任何告警**：它们只会**悄悄变坏**，必须主动 grep：
> **401 计数**（密码/Token 下发问题）与**配置归一化诊断计数**（配置形态问题）。

| 观察项 | 判据 | 取数（K8s） | 越界怎么办 |
|--------|------|-------------|-----------|
| **401 计数** | **必须为 0** | worker→serve：`kubectl logs sts/vteam-worker -n vteam --since=30m \| grep -cE "HTTP 401"`（v2 驱动报 `[v2-driver] <path> HTTP 401`）<br>server→worker：`... \| grep -c "X-Worker-Token 无效"` | serve 侧 401 ⇒ `OPENCODE_SERVER_PASSWORD` 与 serve 实际口令不一致（v2 会自动生成随机密码 → worker 不解析就全线 401）；exec 侧 401 ⇒ `WORKER_TOKEN`（server）与 `X_WORKER_TOKEN`（worker）不是同一个 Secret key |
| **配置归一化诊断计数** | **必须为 0** | serve 日志（两处等价）：<br>① 容器内文件：`kubectl exec sts/vteam-worker -n vteam -- sh -c "grep -c 'configuration normalization diagnostic' /root/.opencode-iso/data/opencode/log/opencode.log"`<br>② worker stdout（serve 以 `--print-logs` 同时写 stderr）：`kubectl logs sts/vteam-worker -n vteam --since=30m \| grep -c "configuration normalization diagnostic"` | >0 ⇒ 注入的配置**还是 v1 形态**。诊断行里的 `path=` 点名被丢的键（如 `$.provider.x.models.y.reasoning`）；对照 §8.1 第 3 行的段名/键名改名表修正注入器（不是改 opencode.json——它每次启动都会被覆盖） |
| **重复终态计数** | **必须为 0** | `kubectl logs sts/vteam-worker -n vteam --since=30m \| grep -c "补发 task.completed"`（同一轮既失败又按终态证据补发 = 事件路与轮询路打架） | >0 ⇒ 终态证据来源不一致；查 worker 日志的 `terminalEvidence=event\|polling`，事件路与轮询路给出的结论必须一致（`prompt-await` 的"先问后记"不变式） |
| **会话成功率** | ≥ 灰度前基线（**不下降**） | `kubectl exec vteam-mysql-0 -n vteam -- mysql -uroot -p'<dbPassword>' aiagents -e "SELECT status, COUNT(*) FROM sessions WHERE created_at >= NOW() - INTERVAL 1 DAY GROUP BY status;"`（`idle`=成功终态、`failed`=判死终态） | 下降 ⇒ 停在当前档位；先比对是"卡在 running"（无终态）还是"直接 failed"（首字超时/模型错误） |
| **首字延迟** | **≤15s 通过线、5s 目标线**（P95 口径） | 平台**没有**现成的首字延迟指标（worker 不打首字耗时日志）⇒ 用 DB 近似：<br>`SELECT TIMESTAMPDIFF(SECOND, t.created_at, MIN(m.created_at)) FROM tasks t JOIN messages m ON m.task_id=t.id AND m.sender_type='agent' WHERE t.created_at >= NOW() - INTERVAL 1 HOUR GROUP BY t.id;` | 超线 ⇒ 先查模型侧（凭据/限流/首字超时 `WORKER_FIRST_TOKEN_TIMEOUT_MS`），再看 serve 日志有无 provider 错误 |
| **完成判定准确率** | "有文本无终态"不再被误判完成 | worker 日志 `[exec] 执行完成` 的条数 vs server 侧 `sessions` 转 `idle` 的条数（同一时间窗） | 两者对不上 ⇒ 查终态判定（`step-finish` part 是否存在；v2 由驱动合成） |
| **MCP 状态上报** | 不再出现"全部未连接" | `GET /api/v1/workers` 的 `mcpStatus`（每服务器**五态** `connected`/`pending`/`disabled`/`failed`/`needs_auth`） | 全 failed ⇒ 查 `WORKER_MCP_URL` / seed 的 MCP URL（集群内是服务名 `vteam-server`）；探针失败会以 `probe_failed` 显式上报，不会静默。**`pending`（还在连）与 `disabled`（配了但关着）都不是 failed，属正常态**；**心跳 400** ⇒ server 还没接受五态（见 §8.0 事实 5） |
| **`durable.seq` 幂等** | 重放下重复落库 = 0 | server 日志 `[dedup] 跳过重复事件`（debug 级，需开 debug 日志才可见） | 重复落库 ⇒ 幂等键口径漂移（worker 重启后 `evw_<bootId>_<seq>` 会变，靠上游 `durable.aggregateID+seq` 兜底） |
| **插件加载** | 无 `plugin load failed` | worker 的 serve 日志：`msg="loading plugin"`（`GET /api/plugin` 不可靠，历史上返回过 total=0） | v2 下**不应**有 OmO 加载失败——若出现，说明注入器仍注册了 v1 形态的 OmO（见 §8.5） |

### 8.4 版本闸门与"混跑窗口"（当前是失效的，必须知道）

- worker 向 server 上报的 `opencodeVersion` 是**规范化 semver**（如 `2.0.32`）；
  调度器 `assignWorker` 的过滤把**两侧都归一**后再比
  （`server/src/workers/worker-version.ts` 的 `isSameOpencodeVersion`）⇒
  需求写成原始 CLI 串 `opencode v2.0.28` 或裸 semver `2.0.28` **都能匹配**。
- ⚠️ **但这个过滤今天是失效的**：`AssignmentRequirement.opencodeVersion` **没有任何生产
  调用方设置**（全仓只有类型定义与过滤本身），也没有 env / values 开关可以设置它。
  ⇒ **混跑期没有自动保护**：v2 server 会把任务派给任何在线 worker，包括 v1 worker。
- ⇒ **操作要求**：切换时**必须**先把 v1 worker 下线（§8.2 阶段 1 第 1 步），
  不要指望版本过滤挡住。
- ⇒ 如果将来有调用方要"在灰度期钉住某个版本"：把需求写成**镜像里钉的那个精确 semver**
  （当前 = `2.0.32`）。**写错的后果是静默的总停摆**——不匹配 ⇒ worker 不可调度 ⇒
  什么都不派发、**且不报错**。两侧都会归一，所以 `opencode v2.0.28` / `2.0.28` 等价，
  但 `2.0.28` ≠ `2.0.32`。
- ⚠️ **与"混跑窗口"无关、但同样会咬人的另一条顺序约束**：**滚动更新 worker 只有在
  server 已经是新版之后才安全**（§8.0 事实 5）——新 worker 会上报 v2 的 MCP 五态，
  而**旧 server 的 `@IsIn` 只认三态** ⇒ 整条心跳 400 ⇒ worker 判离线。⇒ **先升 server、
  再滚 worker**；反过来做会表现成"worker 刚起来就离线"，很容易被误判成镜像/配置问题。

### 8.5 OmO（oh-my-openagent）在 v2 的状态：**有界降级（不加载）**

**结论：OmO 不是 vteam 核心功能的依赖，v2 线按"OmO 关闭"上线。**

- **平台核心**（skills / tools / MCP 注入、角色 agent 与权限、会话与流式链路、平台 MCP、
  产出物归档）全部由**平台自己**写进项目 `opencode.json` 与 `.opencode/`，
  **不依赖 OmO**。OmO 提供的是**额外的** agent（Sisyphus / Prometheus / Atlas …）与它们
  的模型配置页。
- **为什么在 v2 加载不了**：v2 的三个破坏性变更之一就是**插件 API**——v1 插件导出
  `{server}`，v2 插件导出 `{id, setup}` ⇒ **v1 形态的插件实现在 v2 不会运行**。而镜像里
  内置的 OmO 由 `bunx oh-my-openagent@latest install --platform=opencode` 装出，**是 v1 形态**。
- **配置怎么表达"关闭"**：worker 镜像的能力标记 `/opt/omo-bundled.json` 带一个 `v2` 字段
  （`true` = 内置 OmO 有 v2 形态入口；`false` = 只有 v1 形态）。当前镜像写的是
  `"v2": false` ⇒ **注入器不把 OmO 写进 `plugins` 节**，并会**清掉**持久卷上历史遗留的
  OmO 条目（升级路径必须清，否则老条目会一直留在配置里）。
  另外，用户的 OmO 开关（`<WORK_DIR>/.omo/omo-enabled.json`）现在**直接决定配置**——
  此前它只影响一个早已失效的 `--pure` flag，"看得见、不生效"。
- **降级的后果（明说）**：
  - OmO 的 14 个 agent（Sisyphus / Prometheus / Hephaestus / Atlas …）在 v2 下**不存在**；
  - worker 详情页的「OmO 编排插件」卡片里的 **agent→模型映射不再生效**
    （配置文件仍可写，但没人加载它）；
  - **平台的角色不受影响**：计划/执行职责判定用的是 `plan`（原生）/ `prometheus`（OmO 约定）/
    `vteam-plan`（平台）三选一，缺 OmO 时 `plan` 与 `vteam-plan` 仍在；
    ⚠️ **但"外部引擎岗位"的成员除外**——它们绑的**就是** OmO 的 agent 名，见下面那条；
  - 平台的**角色 agent 与权限**来自控制面注入的 `agents` 节，**与 OmO 无关**。
- ⚠️ **三个"外部引擎岗位"的成员会**逐轮失败**（实测 opencode **v2.0.32**，原始证据见
  `docs/agent-platform/opencode-v2-agent-fallback-evidence/`）：
  - **谁会中招**：`server/src/common/constants/agent-role.constants.ts` 的 `EXTERNAL_AGENT_ROLES`
    三个岗位（key `sisyphus` / `prometheus` / `atlas`）的外部槽位存的是 **OmO 的 agent 名**
    ——`Sisyphus - ultraworker` / `Prometheus - Plan Builder` / `Atlas - Plan Executor`
    ⇒ **v2 上这三个 agent 不存在**（`GET /api/agent` 里查无此名；证据 `03-agent-list.txt`）。
    成员绑这些岗位时，该名字会被**预填**进 `TeamMember.opencodeAgentName`
    （`server/src/teams/teams.service.ts` 的 `resolveMemberBinding` 规则 5：显式值 > 岗位的
    `defaultOpencodeAgentName`）⇒ **存量库里已经写着这些名字**。
  - **派发时它无条件胜出**：`server/src/chat/worker-dispatcher.ts` 的
    `opencodeAgentName ?? policyCandidate ?? omit` ⇒ 平台**自己**不会发现这个名字不存在；
    `worker/src/driver/v2-driver.ts` 的 `switchAgent` 也**不校验**名字。
  - **实测的落点**（v2.0.32，逐条原始响应见证据目录）：
    ① `POST /api/session/{id}/agent` 对**不存在的**名字返回 **`204 No Content`**
      （**零错误信号**——不 4xx、不告警）；会话里还**存下了**这个名字
      （`GET /api/session/{id}` 的 `agent` 字段＝原样字符串）⇒ "切成功"是假象；
    ② **爆点在下一轮执行**：opencode 抛 `Session.AgentNotFoundError`
      ⇒ 那一轮**直接失败**、**没有任何回复**——消息流里只有一条
      `{"type":"idle","outcome":"failed","error":{"type":"unknown","message":"Agent not found: \"Prometheus - Plan Builder\""}}`，
      **assistant 消息数 = 0**；
    ③ 失败是**快失败 + 有据**：事件流里发 **durable** 的 `session.execution.failed`
      ⇒ 平台终态闸门**立刻**拿到失败（**不会**挂到首字超时）；serve 日志里是
      `Session.AgentNotFoundError: Agent not found: "…"`（**可 grep**）。
  - ⇒ **不是"悄悄换成别的 agent 干活"**（那才是最难查的形态），而是"**这一轮没人干活**"
    ——故障**可见、可归因**（错误文案直接点名那个不存在的 agent 名）。
  - ⇒ **切换前必须先做数据检查 + 修复**（否则这些成员在 v2 上**每一轮都失败**）：
    见 **§8.2.1 升级前数据检查**。
- **要恢复 OmO 需要什么**：一个 **v2 形态入口**（`export default { id, setup(ctx) }`）的 OmO
  包，且镜像能力标记的 `v2` 字段改成 `true`。**不要**依赖仓库外的路径。

### 8.6 回滚步骤（可执行）

> **前置条件（回滚前必须成立，否则"回滚"会变成"带伤上线"）**：
> 1. **迁移前的数据卷快照存在且可恢复**（home 卷 + work 卷；见 §8.6.3）——**隔离根
>    （`OPENCODE_ISOLATION_ROOT`）指回 v1 数据目录**（= §8.7 的"未启用隔离域"）时是**硬前置**；
>    **缺省隔离根**下是**强烈建议**（便宜的保险，见 §8.0 事实 3）。
> 2. **v1 线的镜像可用**（`v1.0.4` 树构建的 server / web / worker，已推 registry）。
> 3. `vteam-baseline-v1.yaml`（灰度前导出的 values 基线，含 v1 image tag）在手。

#### 8.6.1 冻结（先止血，避免回滚过程中继续写卷）

```bash
# 停 worker（不再写 opencode 会话库/注入配置）
kubectl scale sts/vteam-worker -n vteam --replicas=0

# 停 server（不再派发、不再落任务/消息）
kubectl scale deploy/vteam-server -n vteam --replicas=0
```

#### 8.6.2 回滚代码/镜像

```bash
# 方式 A（推荐）：helm 回滚到灰度前的那次 revision
helm history vteam -n vteam                 # 找到灰度前的最后一个 SUCCESS revision
helm rollback vteam <REV> -n vteam --wait --timeout 300s

# 方式 B：显式用 v1 的 image tag 升级（不依赖 helm 的 revision 历史）
helm upgrade vteam chart/vteam -n vteam -f /tmp/opencode/vteam-baseline-v1.yaml \
  --set server.image.tag=<v1-tag> \
  --set web.image.tag=<v1-tag> \
  --set worker.image.tag=<v1-tag> \
  --wait --timeout 300s
```

> ⚠️ `helm rollback` / `helm upgrade` 只回滚 **values**，**不回滚数据卷** ⇒ §8.6.3 的恢复卷
> **在"隔离根指回 v1 数据目录"时是必做项，不是可选项**；**缺省隔离根**下 v2 不就地迁移
> v1 的库 ⇒ 回滚不恢复卷也只丢 v2 窗口期的会话 ⇒ 恢复卷降为**强烈建议**（便宜的保险）。
> **两种形态的步骤相同**，都照 §8.6.3 走（见 §8.0 事实 3）。

#### 8.6.3 恢复迁移前的数据卷

```bash
# 3.0 确保 worker 仍是 0 副本（helm rollback / upgrade 可能把它调回去了）
#     —— 必须为 0，否则 StatefulSet 控制器会立刻重建一个空 PVC
kubectl scale sts/vteam-worker -n vteam --replicas=0
kubectl get sts/vteam-worker -n vteam   # 期望 REPLICAS 0

# 3.1 列出 worker 的 PVC（每副本独立 RWO；PVC 由 StatefulSet 的 volumeClaimTemplates
#     创建，**不带 app 标签**，按名字筛）
kubectl get pvc -n vteam | grep -E 'worker-(home|work)-'
#   期望：worker-home-vteam-worker-0、worker-work-vteam-worker-0（每副本一对）

# 3.2 从快照恢复（CSI 快照能力可用时）：删掉旧 PVC → 用快照新建**同名** PVC
#     ⚠️ 顺序很重要：STS 的 replicas 必须已经是 0（否则控制器会立刻重建一个空 PVC）
#     ⚠️ 新 PVC 的 accessModes / storageClass / size 必须与 volumeClaimTemplates 一致，
#        StatefulSet 才会**接管**它（否则 Pod 挂不上）
kubectl delete pvc worker-home-vteam-worker-0 -n vteam
cat <<'EOF' | kubectl apply -n vteam -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: worker-home-vteam-worker-0
  namespace: vteam
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: <与原 PVC 相同>
  resources:
    requests:
      storage: 5Gi
  dataSource:
    name: <快照名>
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
EOF
#   恢复完把副本数调回去（helm upgrade --set replicaCount.worker=N）

# 3.3 没有 CSI 快照时：用临时 Pod 把快照内容拷回原卷（通用做法）
kubectl apply -n vteam -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: restore-worker-home-0
spec:
  restartPolicy: Never
  containers:
    - name: restore
      image: busybox:1.36
      command: ["sh", "-c", "sleep 3600"]
      volumeMounts:
        - { name: target, mountPath: /target }
  volumes:
    - name: target
      persistentVolumeClaim:
        claimName: worker-home-vteam-worker-0
EOF
#   把快照内容拷进 /target（rsync / tar 管道），完成后删掉这个 Pod：
kubectl delete pod restore-worker-home-0 -n vteam
```

> **work 卷**（`<WORK_DIR>`：注入的 `opencode.json`、`.opencode/`、任务文件）同法恢复：
> 它在 v2 线被改写成了 v2 形态的段名/键名，恢复后 v1 注入器写回的才是干净的 v1 形态。
> **若不恢复**：v1 注入器会重写它自己管的三个段（`agent`/`mcp`/`plugin`），
> 但 **v2 形态的残留键（`agents`/`plugins`）会留在文件里**——v1 大概率忽略未知键，
> 属"能跑但脏"；要干净就恢复。

#### 8.6.4 验证（逐条）

```bash
# ⓪ 把副本数调回去，server 也恢复
helm upgrade vteam chart/vteam -n vteam -f /tmp/opencode/vteam-baseline-v1.yaml \
  --set replicaCount.worker=<N> --wait --timeout 300s
kubectl scale deploy/vteam-server -n vteam --replicas=1

# ① worker 起来了，且 opencode 是 v1
kubectl get pod -n vteam -l app.kubernetes.io/component=worker
kubectl logs sts/vteam-worker -n vteam | grep -i "opencodeVersion"     # 期望 1.19.3
kubectl exec sts/vteam-worker -n vteam -- opencode --version            # 期望 opencode 1.19.3

# ② worker 重新注册为 online
curl -s -H "Authorization: Bearer $JWT" http://<server>/api/v1/workers | jq '.[] | {id,status,opencodeVersion}'

# ③ 端到端跑一条真实消息（ACK → 回复 → 产出物落库）

# ④ 会话历史可见性（v1 侧）
#   v1 会话库在 <HOME>/.local/share/opencode/（home 卷内）；v2 期间产生的会话在
#   <HOME>/.opencode-iso/data/opencode/opencode.db（v2 形态，v1 读不到）
kubectl exec sts/vteam-worker -n vteam -- ls -la /root/.local/share/opencode/ 2>/dev/null
kubectl exec sts/vteam-worker -n vteam -- ls -la /root/.opencode-iso/data/opencode/ 2>/dev/null
```

#### 8.6.5 Docker Compose 部署的回滚

```bash
# ① 停服（保留卷）
docker compose down

# ② 恢复迁移前的 home 卷（compose 命名卷：worker_home → 实际名 vteam_worker_home；
#    工作目录卷：vteam_worker_data）
docker run --rm -v vteam_worker_home:/dst -v "$PWD/backup/worker_home":/src alpine \
  sh -c "rm -rf /dst/* && cp -a /src/. /dst/"

# ③ 回滚代码到 v1.0.4 并重建镜像（compose 的 build 上下文即工作区）
#    用独立 worktree，**不动**当前工作区（当前工作区往往有未提交改动）
git worktree add /tmp/vteam-v1-rollback v1.0.4
cd /tmp/vteam-v1-rollback && docker compose up -d --build
#    验证完清理：git worktree remove /tmp/vteam-v1-rollback

# ④ 验证（同 8.6.4）
```

### 8.7 回滚时的数据影响：**哪些会丢、哪些不会**

| 数据 | 落点 | 回滚（镜像 + 卷）后 | 只回滚镜像（不回滚卷） |
|------|------|---------------------|----------------------|
| **平台的任务 / 消息 / 产出物 / 成员 / 角色** | **MySQL**（`tasks` / `messages` / `artifacts` / …） | ✅ **完好**（零 DDL，回滚不碰库） | ✅ 完好 |
| **平台模型凭据**（MySQL `model_credentials`）+ `auth.json` | MySQL + worker home 卷 | ✅ 完好（卷已恢复） | ✅ 完好 |
| **注入配置**（角色 agent、权限、MCP、工具插件） | worker **work** 卷的 `<WORK_DIR>/opencode.json` | ✅ 回到 v1 形态（卷已恢复） | ⚠️ v1 注入器重写自己管的段，但 v2 形态残留键仍在文件里 |
| **v1 线产生的 opencode 会话历史** | worker home 卷的 `<HOME>/.local/share/opencode/` | ✅ 完整恢复 | ✅ **仍在**（v2 的隔离域不碰它） |
| **v2 线产生的 opencode 会话** | worker home 卷的 `<HOME>/.opencode-iso/data/opencode/opencode.db`（v2 形态 SQLite） | ❌ **丢失**（快照是迁移前的） | ❌ **v1 读不到**（数据还在卷上；切回 v2 仍可见） |
| **平台侧会话记录**（`sessions` 表的 `instanceRef` 等） | MySQL | ✅ 保留（但指向的 opencode 会话可能已不可见） | ✅ 保留 |

> **结论（必须让运维知道）**：
> - **平台数据不会因为回滚而丢**——任务、消息、产出物、成员、凭据全在 MySQL，零 DDL。
> - **丢的是 OpenCode 侧的会话历史**：v2 期间产生的会话在 v2 形态的 SQLite 库里，
>   **v1 二进制读不了**（会话内容 = 模型上下文与产出物文本；产出物**文件**本身在
>   `uploads` 卷 / MySQL 里，**不丢**）。
> - **没做卷快照 ⇒ 没有"回到 v1 形态"的材料**：v1 线的老会话仍在卷上（隔离域设计使然，
>   见 §8.0 事实 3），但 v2 期间的会话对 v1 不可见，且注入配置带 v2 形态残留。
> - ⇒ **结论：数据卷快照是"安全灰度"的前置条件**，不是回滚的"锦上添花"——**隔离根指回
>   v1 数据目录**时它是**硬前置**（不恢复卷 ⇒ v1 连卷都读不了）；**缺省隔离根**下 v2 不
>   就地迁移 v1 的库 ⇒ 不恢复卷最坏也只丢 v2 窗口期的会话 ⇒ 快照是**强烈建议**的**便宜
>   保险**（G0 闸门顺手做掉）。
> - ⚠️ **口径差异提醒**（别把两句矛盾的话混用）：本表"只回滚镜像"一列描述的是
>   **v2 worker 带隔离域上线**的现状（v1 的老库在 `<HOME>/.local/share/opencode/`，
>   与 v2 的隔离域 `<HOME>/.opencode-iso/data/` **不是同一个目录**）。若部署时**未启用
>   隔离域**，v2 的迁移就是**就地**的、v1 连卷都读不了 ⇒ 那一列全部按"丢失"计。
>   **两种情况的回滚步骤相同（§8.6 走同一套流程）**，区别只在于"不回滚卷"的后果有多严重
>   ——以及**快照是不是硬前置**（见 §8.0 事实 3）。

