#!/usr/bin/env bash
# ============================================================
# start.sh —— vteam 离线部署**一键启动**脚本
#
# 干的事（离线机器上全程不需要外网）：
#   1. 检查 docker / docker compose
#   2. 首次运行：生成 .env（随机密钥），从 .env.example 复制可选项
#   3. 从 images/*.tar 导入镜像（docker load），并按 manifest 打回原始 tag
#   4. docker compose up -d 启动 db → init → server → web → worker
#   5. 等待健康检查通过，输出访问地址
#
# 用法：
#   ./start.sh              # 启动（幂等：已导入的镜像会跳过 load）
#   ./start.sh --recreate   # 重建容器（改过 .env 后用）
#   ./start.sh --reload     # 强制重新 load 镜像（镜像 tar 更新后用）
#   ./start.sh --status     # 只看状态
# ============================================================
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PKG_ROOT"

# ---------- 日志 ----------
if [[ -t 1 ]]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[34m'; C=$'\033[36m'; N=$'\033[0m'
else
  R=""; G=""; Y=""; B=""; C=""; N=""
fi
log()  { echo "${B}[$(date +%H:%M:%S)]${N} $*"; }
ok()   { echo "${G}[  OK  ]${N} $*"; }
warn() { echo "${Y}[ WARN ]${N} $*"; }
die()  { echo "${R}[ FAIL ]${N} $*" >&2; exit 1; }
hdr()  { echo; echo "${G}==== $* ====${N}"; }

# ---------- 参数 ----------
RECREATE=0
FORCE_LOAD=0
STATUS_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --recreate) RECREATE=1; shift;;
    --reload)   FORCE_LOAD=1; shift;;
    --status)   STATUS_ONLY=1; shift;;
    -h|--help)  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "unknown arg: $1 (try --help)";;
  esac
done

# ---------- 前置检查 ----------
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }
need_cmd docker

# ---- Docker 守护进程连通性检查（区分具体失败原因，别只报"连不上"）----
# `docker info` 在**多种**非"守护进程没起"的情况下也会失败：
#   · 当前用户无权访问 docker.sock（权限不足，需加入 docker 组或 sudo）
#   · DOCKER_HOST 指向了错误地址 / 配了失效的 context
#   · 客户端与守护进程版本不兼容
# 统一报"daemon not reachable"会让人以为是没装 Docker，方向完全错了。
# 这里捕获真实 stderr，按特征分类给出**可执行的**处理建议。
#
# 用 `docker version --format {{.Server.Version}}` 而非 `docker info`：
#   · 只探测**服务端**连通性（info 会拉一大堆本地信息，慢且噪声多）
#   · 失败时客户端信息走 stdout、错误走 stderr，便于把错误原文摘出来
# 加 timeout：若 DOCKER_HOST 指向不可达地址，不加会一直挂着。
PROBE_ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/vteam-docker-probe.XXXXXX" 2>/dev/null || echo "/tmp/vteam-docker-probe.$$")"
if command -v timeout >/dev/null 2>&1; then
  DOCKER_PROBE=(timeout 20 docker version --format '{{.Server.Version}}')
else
  DOCKER_PROBE=(docker version --format '{{.Server.Version}}')
fi
if ! "${DOCKER_PROBE[@]}" >/dev/null 2>"$PROBE_ERR_FILE"; then
  PROBE_ERR="$(tr '\n' ' ' < "$PROBE_ERR_FILE" 2>/dev/null | sed 's/[[:space:]]\+/ /g')"
  rm -f "$PROBE_ERR_FILE"
  warn "无法连接 Docker 守护进程（docker 命令存在，但连不上 daemon）"
  [[ -n "$PROBE_ERR" ]] && warn "docker 输出: ${PROBE_ERR}"
  echo
  warn "按下面顺序排查："
  if [[ "$PROBE_ERR" == *"permission denied"* ]]; then
    warn "  1) **权限不足**：当前用户无权访问 Docker socket。"
    warn "     解决：sudo usermod -aG docker \$USER && newgrp docker   （或直接用 sudo 运行本脚本）"
  elif [[ "$PROBE_ERR" == *"context"* ]]; then
    warn "  1) **context 配置无效**：docker context 指向了不存在的 endpoint。"
    warn "     解决：docker context list 查看；用默认 context：unset DOCKER_CONTEXT"
  elif [[ "$PROBE_ERR" == *"Cannot connect to the Docker daemon"* || "$PROBE_ERR" == *"daemon is running"* ]]; then
    warn "  1) **守护进程未运行 / 地址不对**："
    warn "     解决：systemctl start docker && systemctl status docker"
    warn "     若经 SSH 远程使用：unset DOCKER_HOST 后重试（本脚本不需要远程守护进程）"
  elif [[ "$PROBE_ERR" == *"client version"* || "$PROBE_ERR" == *"API version"* ]]; then
    warn "  1) **客户端与守护进程版本不兼容**：更新 docker-ce 客户端或守护进程到同一版本。"
  else
    warn "  1) 确认守护进程已启动：systemctl status docker"
  fi
  warn "  2) 确认当前用户可用：docker ps 能正常输出（不能则加 docker 组或用 sudo）"
  warn "  3) 若设过 DOCKER_HOST / DOCKER_CONTEXT，先 unset 再运行本脚本"
  echo
  die "docker daemon 不可用（详见上方排查步骤）"
fi
rm -f "$PROBE_ERR_FILE"

# compose 形态探测：优先 docker compose（v2+），回退 docker-compose（v1）
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  die "missing required command: docker compose（或 docker-compose）"
fi
ok "compose: $("${DC[@]}" version --short 2>/dev/null || echo unknown)"

# ---------- 状态模式 ----------
if [[ "$STATUS_ONLY" -eq 1 ]]; then
  hdr "服务状态"
  "${DC[@]}" ps
  echo
  hdr "镜像"
  docker images | grep -E "vteam/|ketaops/vteam|mysql:8" || true
  exit 0
fi

# ---------- 1. 准备 .env ----------
hdr "1/4 准备配置"

ENV_FILE="$PKG_ROOT/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  log "首次运行：生成 .env（含随机密钥）"
  gen_hex() {
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex 32
    else
      # 无 openssl 时的回退：读 /dev/urandom
      LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom 2>/dev/null | head -c 64
    fi
  }
  {
    echo "# vteam 离线部署配置（由 start.sh 自动生成于 $(date '+%Y-%m-%d %H:%M:%S')）"
    echo "# 密钥为随机生成，请勿泄露；轮换请改后 ./stop.sh && ./start.sh --recreate"
    echo ""
    echo "SERVER_PORT=13000"
    echo "WEB_PORT=13001"
    echo "WORKER_SERVE_PORT=14000"
    echo "AGENT_BROWSER_DASHBOARD_PORT=14848"
    echo ""
    echo "MYSQL_ROOT_PASSWORD=$(gen_hex | head -c 32)"
    echo "MYSQL_DATABASE=vteam"
    echo ""
    echo "JWT_SECRET=$(gen_hex)"
    echo "WORKER_TOKEN=$(gen_hex)"
    echo "MODEL_CREDENTIAL_KEY=$(gen_hex)"
    echo "OPENCODE_SERVER_PASSWORD=$(gen_hex)"
    echo ""
    echo "WORKER_ID=w_compose_worker"
    echo "WORKER_DEFAULT_MODEL="
    echo "WORKER_MAX_INSTANCES=10"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok ".env 已生成（随机密钥，权限 600）"
else
  ok ".env 已存在（复用；改配置后执行 ./start.sh --recreate 生效）"
fi

# ---------- 2. 导入镜像 ----------
hdr "2/4 导入离线镜像"

MANIFEST="$PKG_ROOT/images/manifest.txt"
[[ -f "$MANIFEST" ]] || die "missing images/manifest.txt（离线包不完整，请重新获取）"

# manifest 行格式：<本地离线tag>|<原始registry引用>|<digest>
load_image() {
  local local_tag="$1" ref="$2"
  # 判重看**本地离线 tag**（compose 实际引用的就是它），
  # 而非 registry ref——ref 在离线机器上多半不存在，用它判重会导致每次都重新 load。
  if [[ "$FORCE_LOAD" -eq 0 ]] && docker image inspect "$local_tag" >/dev/null 2>&1; then
    ok "已存在，跳过: ${local_tag}"
    return 0
  fi
  # tar 文件名：<组件>-<版本>.tar
  local comp="${local_tag#vteam/}"
  comp="${comp%%:*}"
  local tar_path
  tar_path="$(find "$PKG_ROOT/images" -maxdepth 1 -name "${comp}-*.tar" | head -1)"
  [[ -n "$tar_path" ]] || die "image tar not found for ${local_tag} (expected ${comp}-*.tar in images/)"

  log "loading $(basename "$tar_path") ..."
  docker load -i "$tar_path" >/dev/null
  # docker save 同时存了本地 tag 和原始 ref；load 后两者都应存在
  docker image inspect "$local_tag" >/dev/null 2>&1 || die "loaded tar missing tag: ${local_tag}"
  if [[ "$ref" != "$local_tag" ]]; then
    if [[ "$ref" == *@sha256:* ]]; then
      # digest 形式的引用：docker tag 不接受 @sha256: 目标。
      # 用 RepoDigests 匹配出该 digest 对应的镜像 ID，再按该 ID 打 tag；
      # 匹配不到说明本地没有这个 digest（离线包不完整），直接报错。
      local repo="${ref%@*}"
      local want_digest="${ref#*@}"
      local img_id
      img_id="$(docker image inspect "$local_tag" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null \
        | grep -F "${want_digest}" | head -1 | cut -d@ -f1)"
      if [[ -n "$img_id" ]]; then
        docker tag "$img_id" "$repo:${want_digest:0:12}" 2>/dev/null || true
      else
        warn "本地未匹配到 digest ${want_digest}（${repo}），compose 默认引用本地 tag ${local_tag}，不影响启动"
      fi
    else
      docker tag "$local_tag" "$ref" 2>/dev/null || warn "tag ${ref} 未能恢复（不影响启动）"
    fi
  fi
  ok "已导入: ${local_tag}"
}

while IFS='|' read -r local_tag ref digest; do
  [[ -z "$local_tag" || "$local_tag" == \#* ]] && continue
  load_image "$local_tag" "$ref"
done < "$MANIFEST"

# ---------- 3. 启动 ----------
hdr "3/4 启动服务"

# ---- 存量卷 / 密码一致性预检 ----
# MySQL 数据卷一旦初始化，root 密码就**固化在卷里**，改 .env 的 MYSQL_ROOT_PASSWORD
# 不会生效 ⇒ init 服务会以 P1000（Authentication failed）退出。
# 典型场景：机器上已有同项目名的旧栈（仓库 dev compose 用的也是 name: vteam），
# 卷被复用但密码不同。本包项目名为 vteam-offline，与 dev 栈天然隔离；
# 这里再兜一层：检测到卷已存在且密码对不上时明确报错，而不是让 init 神秘失败。
#
# ⚠️ 判定必须用「真实认证」而非 mysqladmin ping：
#    mysqladmin ping 只探测 mysqld 存活，**密码错误也返回 exit 0**（实测确认），
#    用它判密码会永远"匹配"。这里用 `mysql -e "SELECT 1"` 实连认证。
MYSQL_VOL="vteam-offline_mysql_data"
MYSQL_PW="$(grep -E '^MYSQL_ROOT_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')"
if docker volume inspect "$MYSQL_VOL" >/dev/null 2>&1; then
  log "检测到已有 MySQL 数据卷 ${MYSQL_VOL}，校验 root 密码 ..."
  # 用一次性容器挂载该卷起 mysqld（跳过 entrypoint 的初始化逻辑，
  # 直接跑 mysqld 用既有数据目录），再实连认证。
  CHECK_C="vteam-offline-pwcheck-$$"
  cleanup_check() { docker rm -f "$CHECK_C" >/dev/null 2>&1 || true; }
  trap cleanup_check EXIT
  if docker run -d --name "$CHECK_C" --platform linux/amd64 \
        -v "${MYSQL_VOL}:/var/lib/mysql" \
        "${MYSQL_IMAGE:-vteam/mysql:v1.3.3}" \
        --skip-networking --skip-grant-tables=0 >/dev/null 2>&1; then
    # 等 mysqld 就绪（最多 60s）
    for _ in $(seq 1 30); do
      docker exec "$CHECK_C" mysqladmin ping --socket=/var/run/mysqld/mysqld.sock --silent >/dev/null 2>&1 && break
      sleep 2
    done
    # 真实认证：密码错 → exit 1；对 → exit 0。
    # 必须走 **socket**：临时容器带 --skip-networking（避免端口冲突），
    # 此时没有 TCP 监听，用 -h 127.0.0.1 必然连不上 → 永远误判为"密码不符"。
    if docker exec -e MYSQL_PWD="$MYSQL_PW" "$CHECK_C" \
          mysql --socket=/var/run/mysqld/mysqld.sock -uroot -e "SELECT 1" >/dev/null 2>&1; then
      ok "已有数据卷密码匹配，复用现有数据"
    else
      warn "已有数据卷 ${MYSQL_VOL} 的 root 密码与当前 .env 不一致。"
      warn "MySQL 密码在卷初始化后固化，改 .env 无效 ⇒ init 会以 P1000 失败。"
      warn "两种处理方式："
      warn "  A. 保留旧数据：把 .env 的 MYSQL_ROOT_PASSWORD 改回旧密码"
      warn "  B. 放弃旧数据：执行 ./stop.sh --purge 后重新 ./start.sh（**数据会删除**）"
      exit 1
    fi
  else
    warn "无法启动临时容器校验密码（跳过预检）；若 init 报 P1000 请看 README 第 10 节"
  fi
  cleanup_check
  trap - EXIT
fi

if [[ "$RECREATE" -eq 1 ]]; then
  log "recreating containers"
  "${DC[@]}" up -d --force-recreate --remove-orphans
else
  "${DC[@]}" up -d --remove-orphans
fi
ok "compose up 完成"

# ---------- 4. 等待健康 ----------
hdr "4/4 等待服务就绪"

# 等待 server healthy（最长 300s）
log "等待 server 健康检查通过 ..."
server_ready=0
for i in $(seq 1 60); do
  state="$(docker inspect --format '{{.State.Health.Status}}' vteam-offline-server 2>/dev/null || echo starting)"
  case "$state" in
    healthy) server_ready=1; break;;
    unhealthy) warn "server unhealthy，检查日志：docker logs vteam-offline-server"; break;;
  esac
  sleep 5
done

if [[ "$server_ready" -eq 1 ]]; then
  ok "server healthy"
else
  warn "server 未在预期时间内 healthy，继续输出当前状态"
fi

echo
hdr "容器状态"
"${DC[@]}" ps

# ---------- 访问地址 ----------
SERVER_PORT="$(grep -E '^SERVER_PORT=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')"
WEB_PORT="$(grep -E '^WEB_PORT=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')"
WORKER_SERVE_PORT="$(grep -E '^WORKER_SERVE_PORT=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')"
AGENT_BROWSER_DASHBOARD_PORT="$(grep -E '^AGENT_BROWSER_DASHBOARD_PORT=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')"
SERVER_PORT="${SERVER_PORT:-13000}"; WEB_PORT="${WEB_PORT:-13001}"
WORKER_SERVE_PORT="${WORKER_SERVE_PORT:-14000}"; AGENT_BROWSER_DASHBOARD_PORT="${AGENT_BROWSER_DASHBOARD_PORT:-14848}"

hdr "访问地址"
echo "  Web 前端      http://<本机IP>:${WEB_PORT}"
echo "  Server API    http://<本机IP>:${SERVER_PORT}/api/v1/health"
echo "  worker serve  http://<本机IP>:${WORKER_SERVE_PORT}"
echo "  agent-browser http://<本机IP>:${AGENT_BROWSER_DASHBOARD_PORT}"
echo
echo "  查看日志: ${DC[*]} logs -f server"
echo "  停止服务: ./stop.sh"
echo "  查看状态: ./start.sh --status"
