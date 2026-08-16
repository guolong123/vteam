# vteam 部署指南

本文档整理自 vteam 项目实际部署过程中的全部经验（Docker Compose 与 Kubernetes Helm 两套部署方式），涵盖安装步骤、关键配置、常见坑与排障命令，可直接用于生产部署与问题排查。内容均来自真实部署验证（见文末证据索引），不包含未经验证的假设。

## 一、部署方式总览

vteam 提供两套部署方式，按环境选择：

| 方式 | 适用场景 | 说明 |
|------|----------|------|
| Docker Compose（`docker-compose.yml`） | 本地开发 / 单机演示 | 五服务一键编排，`db` 不映射端口，宿主机 13000/13001/14000 |
| Kubernetes Helm（`chart/vteam`） | 生产推荐 | Deployment/StatefulSet/Job 形态，支持持久化、Ingress、多副本，内置 MySQL 可切换外部库 |

两种方式的 env 语义完全对齐（DATABASE_URL / JWT / WORKER_TOKEN / MODEL_CREDENTIAL_KEY / FIRST_TOKEN_TIMEOUT_MS / PLATFORM_MCP_URL 等），同一套镜像均可部署。

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
| `MYSQL_ROOT_PASSWORD` | db | `aiagents-root` | DB root 密码（init/server 共用） |
| `DATABASE_URL` | init/server | `mysql://root:...@db:3306/aiagents` | compose 网络内服务名 `db` |
| `JWT_SECRET` | server | compose 默认值 | 登录 JWT 签名密钥，生产用 `openssl rand -hex 32` |
| `JWT_ACCESS_EXPIRES_IN` | server | `2h` | access token 时效 |
| `JWT_REFRESH_EXPIRES_IN` | server | `7d` | refresh token 时效 |
| `WORKER_TOKEN` | server/worker | compose 默认值 | worker 注册/事件鉴权 token，两端必须一致 |
| `MODEL_CREDENTIAL_KEY` | server | **必填**（未设置启动报错） | 模型凭据 AES-256-GCM 主密钥，32 字节，`openssl rand -hex 32` 生成 |
| `FIRST_TOKEN_TIMEOUT_MS` | server | `180000` | dispatch 后首字超时 watchdog（180s ≥ worker 120s + 余量） |
| `API_PROXY_TARGET` | web | `http://server:3000` | 运行时代理目标（middleware.ts 读取），compose 下为服务名 `server` |
| `X_WORKER_TOKEN` | worker | 同 `WORKER_TOKEN` | worker 侧鉴权 |
| `SERVER_URL` | worker | `http://server:3000` | 注册/心跳的 server 地址 |
| `WORKER_ID` | worker | `w_compose_worker` | compose 单副本固定 |
| `OPENCODE_SERVE_HOSTNAME` | worker | `0.0.0.0` | serve 监听地址 |
| `OPENCODE_SERVE_PORT` | worker | `4000` | serve 固定端口 |
| `WORKER_ADVERTISE_HOST` | worker | `http://worker` | 上报给 server 的 baseUrl（compose 服务名） |
| `WORKER_DEFAULT_MODEL` | worker | 空 | Agent 未配模型时的默认模型兜底 |
| `WORKER_FIRST_TOKEN_TIMEOUT_MS` | worker | `180000` | worker 侧首字超时，与 server 对齐防竞态误杀 |
| `WORK_DIR` | worker | `/data/keta-worker` | 持久化工作目录（serve cwd、.opencode 注入、git clone 仓库） |

### 2.3 卷

| 卷 | 挂载点 | 用途 |
|----|--------|------|
| `mysql_data` | db `/var/lib/mysql` | MySQL 数据 |
| `uploads_data` | server `/app/uploads` | Agent 产出物落盘（server 静态服务挂载点） |
| `worker_work` | worker `/data/keta-worker` | serve cwd、.opencode 注入、git clone 仓库、任务文件 |
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

- 账号：`admin/admin123`（初始管理员）、`seed-admin/Admin@123456`（种子管理员/项目 owner）、`seed-member/Admin@123456`（普通成员）
- 种子数据：5 个模板 Agent（产品经理/项目经理/架构师/开发者/测试）、2 个种子项目（`p_seed_1`、`p_seed_2`）、内置工具 + `vteam` MCP 工具注册、模型目录

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
- 注意 worker 容器默认 cwd 是镜像 WORKDIR，探测 MCP 必须 `cd /data/keta-worker && opencode mcp list --pure` 才能读到注入的 opencode.json。

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
| 3 | 内置 MCP `mcpStatus` 非 connected | seed 注册的 URL 是 compose 的 `server:3000` | 按 4.4 UPDATE mcp_servers + `kubectl rollout restart sts/vteam-worker`；容器内 `cd /data/keta-worker && opencode mcp list --pure` 确认 |
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
kubectl exec sts/vteam-worker -n vteam -- sh -c "cd /data/keta-worker && opencode mcp list --pure"

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
