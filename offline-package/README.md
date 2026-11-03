# vteam 离线安装包（docker-compose / linux-amd64）

本包用于在**无外网 / 内网隔离**的 Linux x86_64 机器上，用 `docker compose` 一键部署 vteam
（Web 前端 + NestJS Server + opencode Worker + MySQL）。

镜像**不是本地重新构建**的，而是直接取自线上 k8s 环境正在运行的同一批镜像
（`docker-hosted.ketaops.cc/ketaops/vteam-*:v1.3.3`），因此离线部署的版本与线上完全一致。

---

## 1. 包内容

```
vteam-offline/
├── start.sh                     # 一键启动（导入镜像 + 起服务 + 等健康检查）
├── stop.sh                      # 停止服务（--purge 连数据卷一起删）
├── docker-compose.yml           # 离线 compose（全部 image: 引用，无 build）
├── .env.example                 # 配置模板（真实 .env 由 start.sh 首启时随机生成）
├── images/
│   ├── mysql-v1.3.3.tar         # mysql:8                (linux/amd64)
│   ├── server-v1.3.3.tar        # vteam-server:v1.3.3    (linux/amd64)
│   ├── web-v1.3.3.tar           # vteam-web:v1.3.3       (linux/amd64)
│   ├── worker-v1.3.3.tar        # vteam-worker:v1.3.3    (linux/amd64)
│   └── manifest.txt             # tag → 原始镜像名 → digest 对照表
├── scripts/
│   └── build-offline-package.sh # 在有外网的机器上重新制作离线包
└── README.md
```

---

## 2. 部署前要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Linux x86_64（amd64） |
| Docker Engine | ≥ 20.10（需支持 `docker compose`，v2 插件） |
| 磁盘空间 | ≥ 15 GB 可用（镜像约 4.7 GB + 数据卷 + 运行时） |
| 内存 | ≥ 4 GB（server 建议给 2 GB，worker 建议给 4 GB） |
| 网络 | **不需要外网**；镜像已随包提供 |

> **架构说明**：本包仅含 `linux/amd64`。在 arm64 机器（如 Apple Silicon）上可正常跑
> （Docker 会走模拟），但性能损失较大，不建议用于生产。

---

## 3. 安装步骤

```bash
# 1. 解压到部署目录
tar -xzf vteam-offline-v1.3.3-amd64.tar.gz -C /opt
cd /opt/vteam-offline

# 2. 一键启动（首次运行会自动生成含随机密钥的 .env）
./start.sh

# 3. 查看状态
./start.sh --status
```

`start.sh` 会依次完成：

1. 检查 `docker` / `docker compose` 可用；
2. 首次运行生成 `.env`（`JWT_SECRET`、`WORKER_TOKEN`、`MODEL_CREDENTIAL_KEY`、
   `OPENCODE_SERVER_PASSWORD`、`MYSQL_ROOT_PASSWORD` 全部为随机值，权限 `600`）；
3. `docker load` 导入 `images/*.tar`，并按 `manifest.txt` 把 tag 还原成 compose 引用的名字；
4. `docker compose up -d` 启动（`db` → `init` → `server` → `web` → `worker`，
   由 `depends_on` + healthcheck 门控）；
5. 等待 `server` 健康检查通过，打印访问地址。

**全程无需外网。**

---

## 4. 访问地址

| 服务 | 地址 |
|---|---|
| Web 前端 | `http://<本机IP>:13001` |
| Server API | `http://<本机IP>:13000/api/v1/health` |
| worker opencode serve | `http://<本机IP>:14000` |
| agent-browser 面板 | `http://<本机IP>:14848` |

端口可在 `.env` 中修改，改完执行 `./stop.sh && ./start.sh --recreate` 生效。

> MySQL（`db` 服务）**不映射宿主端口**，只在 compose 网络内部可达（3306），避免与宿主机
> 已有 MySQL 冲突。

---

## 5. 常用运维命令

```bash
./start.sh --status          # 查看容器状态
./start.sh --recreate        # 改过 .env 后重建容器
./start.sh --reload          # 换了镜像 tar 后强制重新导入

docker compose ps                        # 容器状态
docker compose logs -f server            # 跟踪 server 日志
docker compose logs -f worker            # 跟踪 worker 日志
docker compose restart worker            # 重启单个服务

./stop.sh                   # 停止（保留数据卷）
./stop.sh --purge           # 停止并删除数据卷（MySQL 数据 / 会话库 / 产出物全部删除）
```

---

## 6. 数据持久化

compose 声明了 4 个具名卷（项目名 `vteam-offline`，实际卷名带 `vteam-offline_` 前缀）：

| 卷 | 挂载点 | 内容 |
|---|---|---|
| `vteam-offline_mysql_data` | `db:/var/lib/mysql` | MySQL 数据 |
| `vteam-offline_uploads_data` | `server:/app/uploads` | Agent 产出的文档/文件 |
| `vteam-offline_vteam_worker_data` | `worker:/data/vteam-worker` | serve 工作目录、`.opencode` 注入、任务实例目录 |
| `vteam-offline_worker_home` | `worker:/root` | `opencode.db` 会话库、`auth.json` 模型凭据、git 凭据、日志 |

`./stop.sh`（不带 `--purge`）**保留**这些卷；`./stop.sh --purge` 会一并删除。

---

## 7. 注意事项

1. **首次启动较慢**：`init` 服务要执行 `prisma migrate deploy` + `seed`，之后 `server`
   才通过健康检查。整体通常 1～3 分钟。

2. **模型凭据**：Worker 的模型 API Key 在 **vteam 管理界面**里配置（不是在本包里填）。
   数据库中的凭据用 `MODEL_CREDENTIAL_KEY` 加密，**该密钥一旦修改，已保存的凭据将无法解密**，
   需要重新录入。

3. **不要改动 `WORKER_TOKEN`**：`server` 与 `worker` 通过它互认（`X-Worker-Token`），
   两侧必须同值（`.env` 里只配一份，compose 自动下发给两侧）。

4. **opencode serve 密码**（`OPENCODE_SERVER_PASSWORD`）**只存在于 worker 一侧**：
   控制面不直连 serve，鉴权走 `X-Worker-Token`，所以不需要与 server 侧同值。

5. **防火墙**：默认放行 `13000`、`13001`、`14000`、`14848`。`14000`（opencode serve）
   与 `14848`（agent-browser）属调试面板，**生产环境建议不对外暴露**。

6. **磁盘**：worker 的 Chrome 缓存与 opencode 会话库都在卷里增长，注意监控
   `vteam-offline_worker_home` 与 `vteam-offline_vteam_worker_data`。

---

## 8. 在有外网的机器上重新制作离线包

```bash
cd offline-package
./scripts/build-offline-package.sh --version v1.3.3
```

该脚本会：拉取 `linux/amd64` 镜像 → 校验架构 → 打本地离线 tag → `docker save` 导出
`images/*.tar` → 生成 `manifest.txt` 与 `.env.example` → 打包成
`vteam-offline-v1.3.3-amd64.tar.gz`。

默认镜像清单（对应线上 k8s 当前运行的版本）：

| 组件 | 镜像 |
|---|---|
| mysql | `docker.ketaops.cc/library/mysql:8` |
| server | `docker-hosted.ketaops.cc/ketaops/vteam-server:v1.3.3` |
| web | `docker-hosted.ketaops.cc/ketaops/vteam-web:v1.3.3` |
| worker | `docker-hosted.ketaops.cc/ketaops/vteam-worker:v1.3.3` |

---

## 9. 镜像版本对照

`images/manifest.txt` 记录了每个离线 tag 对应的原始 registry 引用与 digest，
导入后如需核对，可执行：

```bash
docker images | grep -E "vteam/|mysql:8"
docker image inspect docker-hosted.ketaops.cc/ketaops/vteam-server:v1.3.3 --format '{{index .RepoDigests 0}}'
```

---

## 10. 常见问题排查

### `init` 报 `P1000: Authentication failed`

MySQL 的 root 密码在**数据卷初始化时就固化了**，改 `.env` 里的 `MYSQL_ROOT_PASSWORD`
不会生效。若机器上已有同项目名的旧数据卷（密码不同），`init` 会以 P1000 失败。

`start.sh` 会在启动前检测这种情况并直接给出提示。两种处理：

```bash
# A. 保留旧数据：把 .env 的 MYSQL_ROOT_PASSWORD 改回旧密码
# B. 放弃旧数据：删除数据卷后重来（**数据会删除**）
./stop.sh --purge && ./start.sh
```

### 容器起不来，日志报 `requested image's platform (linux/amd64) does not match the detected host platform`

本包只含 `linux/amd64` 镜像。compose 里已显式声明 `platform: linux/amd64`，
在 arm64 机器上 Docker 会通过模拟运行（可正常启动，但性能有损失）。
生产环境建议直接用 x86_64 机器。

### `start.sh` 报「无法连接 Docker 守护进程」

脚本会先探测**服务端**连通性（`docker version --format {{.Server.Version}}`），
捕获 docker 的真实报错并**分类给出处理步骤**，不是笼统说"连不上"。
常见三类：

| 报错特征 | 真实原因 | 处理 |
|---|---|---|
| `permission denied` | 当前用户无权访问 `docker.sock` | `sudo usermod -aG docker $USER && newgrp docker`，或直接 `sudo ./start.sh` |
| `context not found` | `DOCKER_CONTEXT` 指向了不存在的 endpoint | `docker context list` 查看；`unset DOCKER_CONTEXT` 后重试 |
| `Cannot connect to the Docker daemon` | 守护进程没起 / 地址不对 | `systemctl start docker && systemctl status docker`；SSH 场景先 `unset DOCKER_HOST` |

> 用 `docker version` 而不是 `docker info` 做探测：只关心服务端连通性，
> 不受客户端本地信息影响，且失败时错误信息走 stderr、便于原文摘取。

### `start.sh` 报 `missing images/manifest.txt`

离线包不完整（传输过程中缺文件）。重新拷贝完整的
`vteam-offline-v1.3.3-amd64.tar.gz` 即可。

### 想换镜像版本

重新在有外网的机器上执行：

```bash
cd offline-package
./scripts/build-offline-package.sh --version <新版本>
```

脚本里的镜像清单（`IMAGE_LIST`）需要同步更新为新版本对应的 registry 引用。

### 确认离线包内镜像与线上一致

```bash
cat images/manifest.txt
```

第三列是 digest，可与线上 k8s 对比：

```bash
kubectl get pod -n vteam -o jsonpath='{.items[*].status.containerStatuses[*].imageID}'
```
