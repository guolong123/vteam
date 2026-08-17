# vteam Helm Chart

vteam（虚拟团队 AI 协作平台）Kubernetes 部署 Chart。对齐 `docker-compose.yml` 的五服务编排：

- **server**（NestJS API）— Deployment + ClusterIP Service :3000
- **web**（Next.js 控制台）— Deployment + ClusterIP Service :3000
- **worker**（opencode 执行节点）— StatefulSet（每副本独立 PVC）+ Headless Service（serve :4000，无共享 ClusterIP 入口）
- **db**（MySQL 8，可选内置）— StatefulSet + PVC，默认启用，可切换外部数据库
- **init**（一次性 Job）— `prisma migrate deploy && node dist/prisma/seed.js`

## 前置条件

- Kubernetes >= 1.22，Helm >= 3.12
- server / web / worker 镜像已构建并推送到镜像仓库（见「构建并推送镜像」）

## Chart 结构

```
chart/vteam/
├── Chart.yaml              # name: vteam, version 1.0.0, type: application
├── values.yaml             # 默认值（镜像/replicas/资源/secret/持久化/ingress）
├── values-dev.yaml         # dev 覆盖示例（小资源/Dev 密码）
├── README.md
└── templates/
    ├── _helpers.tpl        # 名称/标签/selector/env/探针命令 辅助模板
    ├── configmap.yaml      # 共享配置（DATABASE_URL 拼装、非敏感 env）
    ├── secret.yaml         # 敏感项（JWT_SECRET/WORKER_TOKEN/MODEL_CREDENTIAL_KEY/DB_PASSWORD）
    ├── deployment-server.yaml
    ├── deployment-web.yaml
    ├── statefulset-worker.yaml     # StatefulSet + volumeClaimTemplates（每副本独立 PVC）
    ├── statefulset-mysql.yaml   # db.enabled=true 时（mysql:8 + volumeClaimTemplates + healthcheck）
    ├── job-init.yaml            # 一次性迁移/种子（initContainer 等待 DB 就绪）
    ├── service-server.yaml / service-web.yaml / service-mysql.yaml
    ├── service-worker-headless.yaml  # worker Headless Service（StatefulSet serviceName 必填；无共享 ClusterIP）
    ├── pvc.yaml                 # uploads（worker 卷由 StatefulSet VCT 按副本创建）
    ├── ingress.yaml             # 默认关闭
    └── NOTES.txt                # 部署后使用说明
```

## 构建并推送镜像

镜像与 compose 构建产物一致（各目录独立 Dockerfile）：

```bash
# server（NestJS）
docker build -t <registry>/vteam-server:latest ./server && docker push <registry>/vteam-server:latest

# web（Next.js standalone）——代理目标为**运行时** env（middleware.ts 读取），
# 无需构建参数；部署时由 chart 向容器注入 API_PROXY_TARGET（见
# deployment-web.yaml，值取 values.web.image.proxyTarget，默认指向本 release
# 的 server Service http://<release>-server:3000）。同一镜像可部署任意环境。
docker build -t <registry>/vteam-web:latest ./web && docker push <registry>/vteam-web:latest

# worker（opencode 执行节点）
docker build -t <registry>/vteam-worker:latest ./worker && docker push <registry>/vteam-worker:latest
```

若 release 名非 `vteam`，`values.web.image.proxyTarget` 自动按 `http://<release>-server:3000` 兜底（`deployment-web.yaml` 运行时注入 `API_PROXY_TARGET` env），无需改镜像。

## 安装

默认模式（内置 MySQL，开箱可部署）：

```bash
helm install vteam chart/vteam \
  --set server.image.repository=<registry>/vteam-server \
  --set web.image.repository=<registry>/vteam-web \
  --set worker.image.repository=<registry>/vteam-worker
```

首次安装若未显式提供 `secret.*`，chart 自动生成随机 Secret 并持久化到集群，升级时复用（不轮换）。

验证：

```bash
kubectl rollout status deploy/vteam-server && kubectl rollout status deploy/vteam-web && kubectl rollout status sts/vteam-worker
kubectl wait --for=condition=complete job/vteam-init --timeout=300s
```

### 外部数据库模式

不部署内置 MySQL，`DATABASE_URL` 直接使用外部连接串：

```bash
helm install vteam chart/vteam \
  --set db.enabled=false \
  --set db.external.enabled=true \
  --set db.external.url='mysql://user:pass@external-mysql:3306/aiagents'
```

此模式下不渲染 MySQL StatefulSet / Service / 数据卷，init Job 直接对目标库执行迁移/种子。

## Secret 管理

| key | 说明 | 生成建议 |
|-----|------|----------|
| `secret.jwtSecret` | 登录 JWT 签名密钥 | `openssl rand -hex 32` |
| `secret.workerToken` | worker 注册/事件鉴权 token | `openssl rand -hex 32` |
| `secret.modelCredentialKey` | 模型凭据 AES-256-GCM 主密钥（32 字节） | `openssl rand -hex 32` |
| `secret.dbPassword` | MySQL root 密码（内置 DB 时） | `openssl rand -hex 16` |

- 留空 → chart 自动生成随机值并写入 Secret（`<release>-vteam-secret`），NOTES 会提示生产环境显式设置。
- 外部 Secret 注入：`--set secret.existingSecret=<name>`，模板不再自建 Secret，各组件从该 Secret 读取同名 key（`JWT_SECRET` / `WORKER_TOKEN` / `MODEL_CREDENTIAL_KEY` / `DB_PASSWORD`）。
  ⚠️ 若同时启用内置 MySQL 且使用 existingSecret，须一并提供 `secret.dbPassword`（configmap 拼装 DATABASE_URL 需要明文密码）。

## 关键 values

| 路径 | 默认 | 说明 |
|------|------|------|
| `replicaCount.{server,web,worker}` | 1 | 各服务副本数 |
| `server.image` / `web.image` / `worker.image` | 见 values.yaml | 各服务镜像仓库/tag |
| `web.image.proxyTarget` | `http://vteam-server:3000` | 运行时 env `API_PROXY_TARGET`（middleware 同源代理目标，deployment-web 注入） |
| `db.enabled` | `true` | 内置 MySQL StatefulSet |
| `db.external.url` | 空 | 外部 DATABASE_URL（`db.enabled=false` 时必填） |
| `server.env.*` | 对齐 compose | NODE_ENV/PORT/JWT 时效/FIRST_TOKEN_TIMEOUT_MS |
| `worker.env.*` | 对齐 compose | serve 端口/advertise/默认模型/WORK_DIR |
| `worker.env.workerId` | 空（自动） | worker 唯一 id；空 = 自动按 pod 名生成（`w_<pod 名>`，downward API 注入，StatefulSet 多副本天然唯一）；显式设置时用该值（多副本下须自行保证唯一） |
| `worker.resources` | requests 500m/1Gi，limits cpu 4 / memory 8Gi | worker 资源配额。默认副本数 1（`replicaCount.worker`）；opencode 执行引擎内存占用高，limit 8Gi 为推荐值（开发环境可用 values-dev 的小配额覆盖） |
| `worker.persistence.{workerHome,workerWork}.{enabled,size,storageClass}` | 全部启用 | worker 每副本独立卷（StatefulSet volumeClaimTemplates，PVC 名 `worker-home-<sts>-<ordinal>`；`replicaCount.worker` 扩容自动建独立 PVC）。`enabled=false` 回退 emptyDir（临时，生产不建议关闭 workerHome） |
| `worker.updateStrategy.partition` | 空 | StatefulSet 滚动更新 partition：空 = 全量滚动（默认）；数字 = 仅更新 ordinal ≥ partition 的副本 |
| `initJob.platformMcpUrl` | 空（自动） | 内置 `vteam` MCP 的 URL（seed 写入 mcp_servers 表）。空 = 按 server Service 名拼 `http://<fullname>-server:3000/api/v1/platform-mcp`（K8s 下 server 服务名，seed 的 compose 默认 `http://server:3000` 不通）；显式设置时用该值 |
| `persistence.{uploads,mysql}.{enabled,size,storageClass}` | 全部启用 | uploads / mysql 卷（worker 卷见上） |
| `secret.*` / `secret.existingSecret` | 自动生成 | 敏感配置 |
| `ingress.enabled` | `false` | Ingress（`/api/v1`→server，`/`→web） |
| `extraEnv` | 空 | 透传额外 env 到 server/web/worker |

## 端口与访问

| 服务 | Service 类型 | 说明 |
|------|-----------|------|
| server | ClusterIP :3000 | 后端 API `/api/v1`、Swagger `/api/v1/docs` |
| web | ClusterIP :3000 | 控制台 |
| worker | Headless :4000 | opencode serve（无共享 ClusterIP；server 经每副本 headless DNS 直连，不对外） |
| mysql | Headless :3306 | 内置 MySQL |

访问方式：

```bash
# 端口转发（对齐 compose 宿主端口 13000/13001/14000）
kubectl port-forward svc/vteam-web 13001:3000      # 控制台 http://localhost:13001
kubectl port-forward svc/vteam-server 13000:3000   # API/Swagger
kubectl port-forward sts/vteam-worker 14000:4000     # 调试 opencode serve（worker 无共享 Service，sts 转发到 ordinal 0；指定副本用 pod/vteam-worker-N）
```

或启用 Ingress：

```bash
helm upgrade vteam chart/vteam \
  --set ingress.enabled=true \
  --set ingress.host=vteam.example.com \
  --set ingress.className=nginx
```

## 持久化

| PVC | 挂载点 | 用途 |
|-----|--------|------|
| `<release>-uploads` | server `/app/uploads` | Agent 产出物落盘 |
| `worker-home-<release>-worker-<n>` | worker `<n>` `/root` | opencode.db 会话库、auth.json 凭据（**每副本独立**，StatefulSet VCT） |
| `worker-work-<release>-worker-<n>` | worker `<n>` `/data/vteam-worker` | serve cwd、.opencode 注入、git clone 仓库（**每副本独立**，StatefulSet VCT） |
| MySQL 数据 | mysql `/var/lib/mysql` | StatefulSet volumeClaimTemplates |

worker 为 StatefulSet：`replicaCount.worker` 扩容时自动为每个 ordinal 创建独立 PVC
（`worker-home-vteam-worker-0/1/...`、`worker-work-vteam-worker-0/1/...`），home 卷相互隔离，
解决多副本共享同一 PVC 并发写 opencode.db（SQLite）导致的损坏问题。

`--set persistence.<name>.storageClass=<sc>` 指定 uploads/mysql 存储类；
worker 卷用 `--set worker.persistence.<name>.storageClass=<sc>`。
`enabled=false` 关闭对应卷（worker 卷回退 emptyDir，生产不建议关闭 worker-home）。

> 旧版共享 worker PVC（`<release>-worker-home` / `<release>-worker-work`）由本版本
> StatefulSet 独立卷替代，升级后不再被引用；如已无引用数据可按需删除，
> 无需要求则保留（不影响运行）。

## 卸载

```bash
helm uninstall vteam
# PVC 默认保留（helm uninstall 不删 PVC）；如需连数据一起删除：
kubectl delete pvc -l app.kubernetes.io/instance=vteam
```

## 与 docker-compose 的对齐点

- env：DATABASE_URL / NODE_ENV / PORT / JWT_* / WORKER_TOKEN / MODEL_CREDENTIAL_KEY / FIRST_TOKEN_TIMEOUT_MS / X_WORKER_TOKEN / SERVER_URL / OPENCODE_SERVE_* / WORKER_ADVERTISE_HOST / WORKER_DEFAULT_MODEL / WORK_DIR 全部对齐 compose。
- PLATFORM_MCP_URL：仅 init Job 注入（seed 用），指向本 release 的 server Service（`http://<fullname>-server:3000/api/v1/platform-mcp`），避免 vteam MCP 仍注册 compose 的 `server:3000` 导致 worker 连接失败。
- WORKER_ID：**不**在 ConfigMap 下发，由 worker StatefulSet 经 downward API 注入 pod 名（`w_<pod 名>`，pod 名 `<release>-worker-<ordinal>` 全局唯一）——多副本时每个 pod 唯一，避免共享同一 ID 相互覆盖注册；compose 单副本仍走 `w_<hostname>` 默认。
- 探针：server `/api/v1/health`、web `fetch($HOSTNAME:3000)`，均为容器 node 内置 fetch（node:22-alpine 无 curl/wget）。
- 挂载：`/app/uploads`、`/data/vteam-worker`、`/root` 对齐 compose volume 语义（worker 为每副本独立卷，非 compose 的命名卷共享）。
- 门控：init Job 经 initContainer 等待 MySQL 就绪（对齐 compose `depends_on: service_healthy`）；server 依赖 init 成功（Job 完成后 Deployment 探针即可就绪）。
- 端口：容器内 3000/3000/4000/3306 对齐；宿主 13000/13001/14000 对应 `kubectl port-forward` 语义。
