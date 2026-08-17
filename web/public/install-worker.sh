#!/usr/bin/env bash
#
# install-worker.sh —— worker 独立部署一键安装脚本（由控制面 web 静态服务提供）。
#
# 用法（控制面安装向导页生成的命令）：
#   curl -fsSL <控制面地址>/install-worker.sh | bash -s -- \
#     --server http://<控制面地址> --worker-id my-worker-1 --concurrency 8 --opencode v1.18.15
#
# 流程：自动安装前置（git / node >= 18 / opencode CLI，缺失即自动装）→ 下载 worker 发布包
#   → npm install → 生成 .env（SERVER_URL / WORKER_ID）→ 校验 X_WORKER_TOKEN → 启动
#   （复用仓库内 worker/scripts/start.sh 语义：启动即注册，随后每 10s 心跳）。
#   worker 源码以发布包（pack-worker.sh 产物）从控制面下载，不做 git clone——
#   目标机器无需任何仓库 SSH 凭证，复制命令即可完整安装。
#
# 参数：
#   --server <url>      控制面地址（缺省 http://localhost:3000）
#   --worker-id <id>    worker 唯一 id（缺省 w_<hostname>）
#   --concurrency <n>   并发上限（预留：worker 侧当前硬编码 maxInstances=1，见 worker/src/index.ts）
#   --opencode <ver>    opencode CLI 版本（如 v1.18.15）；CLI 缺失时按此版本 npm 安装（缺省 latest），已安装则仅提示校验
#   --token <token>     X_WORKER_TOKEN（注册鉴权，需与 server 侧约定一致；缺省引导手动填写）
#   --src-url <url>     worker 发布包下载地址（缺省 ${SERVER_URL%/}/worker-src.tar.gz）
#   --dir <path>        安装目录（缺省 $HOME/aiagents-worker）
#   --mcp-url <url>     内置 vteam MCP 地址覆盖（WORKER_MCP_URL，可选）：集群外 worker 必须设置
#                       为外部可达地址（如 http://<控制面外部地址>/api/v1/platform-mcp），否则内置
#                       MCP 不可达（server 下发的默认地址为集群内服务名）；集群内 worker 可省略。
#                       未提供时仅提示，不强制写入（保证集群内 worker 无感知）。
#   --advertise-host <url>   worker 对 server 公布的 serve 基址（WORKER_ADVERTISE_HOST，可选）：
#                       外部/跨机 worker 建议显式设置 server 可达的 worker 地址（只填 IP 即可，
#                       脚本自动补 http:// 前缀，如 192.168.1.10 → http://192.168.1.10）；
#                       未提供时 worker 会自动探测本机非回环 IPv4 上报（探测失败回退
#                       http://127.0.0.1 仅本机可访问）；集群内/本机 worker 可省略。
#   --serve-hostname <host>  opencode serve 监听地址（OPENCODE_SERVE_HOSTNAME，可选）：外部
#                       worker 须设 0.0.0.0（serve 监听非回环，server 才能连上）；缺省 127.0.0.1
#                       只监听本机。未提供时仅提示，不强制写入（本机/集群内 worker 无感知）。
#   --work-dir <path>   worker 工作目录（WORK_DIR，可选；缺省 /tmp/keta-worker）：opencode serve
#                       工作目录 + 资源注入落点（opencode.json / 技能 / 工具）。外部 worker 若
#                       需固定工作目录/挂载持久化盘可设置；缺省不写入（worker 用内置默认）。
#   --no-service        不注册 systemd 服务（默认注册：守护进程 + 开机自启 + 崩溃自动重启，
#                       服务名 aiagents-worker，日志 journalctl -u aiagents-worker -f）。
#                       无 systemd 环境（容器等）自动回退前台启动。
set -euo pipefail

# ------------------------------ 参数解析 ------------------------------
SERVER_URL=""
WORKER_ID=""
CONCURRENCY=""
OPENCODE_VERSION=""
WORKER_TOKEN=""
WORKER_SRC_URL=""
INSTALL_DIR="${HOME}/aiagents-worker"
WORKER_MCP_URL=""
WORKER_ADVERTISE_HOST=""
WORKER_SERVE_HOSTNAME=""
WORK_DIR=""
NO_SERVICE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER_URL="${2:-}"; shift 2 ;;
    --worker-id) WORKER_ID="${2:-}"; shift 2 ;;
    --concurrency) CONCURRENCY="${2:-}"; shift 2 ;;
    --opencode) OPENCODE_VERSION="${2:-}"; shift 2 ;;
    --token) WORKER_TOKEN="${2:-}"; shift 2 ;;
    --src-url) WORKER_SRC_URL="${2:-}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --mcp-url) WORKER_MCP_URL="${2:-}"; shift 2 ;;
    --advertise-host) WORKER_ADVERTISE_HOST="${2:-}"; shift 2 ;;
    --serve-hostname) WORKER_SERVE_HOSTNAME="${2:-}"; shift 2 ;;
    --work-dir) WORK_DIR="${2:-}"; shift 2 ;;
    --no-service) NO_SERVICE="1"; shift ;;
    *)
      echo "[install-worker] ERROR: 未知参数 $1（支持 --server/--worker-id/--concurrency/--opencode/--token/--src-url/--dir/--mcp-url/--advertise-host/--serve-hostname/--work-dir/--no-service）" >&2
      exit 1
      ;;
  esac
done

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
WORKER_ID="${WORKER_ID:-w_$(hostname)}"
CONCURRENCY="${CONCURRENCY:-8}"
WORKER_SRC_URL="${WORKER_SRC_URL:-${SERVER_URL%/}/worker-src.tar.gz}"

# ------------------------------ 前置环境自动安装（缺失即装，保证一键成功） ------------------------------
# 目标：git/curl/node/opencode 无需用户预装。node 缺失时下载官方二进制到 $HOME/.local/node；
# opencode 缺失时按 --opencode 指定版本（缺省 latest）经 npm 全局安装。

ensure_git_curl() {
  local missing=()
  for cmd in git curl tar; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "[install-worker] 缺少系统工具 ${missing[*]}，尝试 apt 安装..."
    if command -v apt-get >/dev/null 2>&1; then
      if ! apt-get install -y "${missing[@]}" >&2; then
        echo "[install-worker] ERROR: 自动安装 ${missing[*]} 失败，请手动安装后重试" >&2
        exit 1
      fi
    else
      echo "[install-worker] ERROR: 未找到 apt-get，请手动安装 ${missing[*]} 后重试" >&2
      exit 1
    fi
  fi
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 18 ? 1 : 0)' 2>/dev/null; then
    return 0
  fi
  echo "[install-worker] 未找到 Node.js >= 18，自动下载官方二进制到 \${HOME}/.local/node ..."
  local node_ver="v22.12.0"
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "[install-worker] ERROR: 不支持的架构 $(uname -m)" >&2; exit 1 ;;
  esac
  local base="${HOME}/.local/node"
  mkdir -p "$base"
  local tarball="${TMPDIR:-/tmp}/node-${node_ver}-linux-${arch}.tar.xz"
  curl -fsSL "https://nodejs.org/dist/${node_ver}/node-${node_ver}-linux-${arch}.tar.xz" -o "$tarball"
  tar -xJf "$tarball" -C "$base" --strip-components=1
  rm -f "$tarball"
  export PATH="$base/bin:$PATH"
  echo "[install-worker] Node.js 已安装：$(node --version)（npm $(npm --version)）"
}

ensure_opencode() {
  if ! command -v opencode >/dev/null 2>&1; then
    local pkg="opencode-ai"
    [ -n "${OPENCODE_VERSION}" ] && pkg="opencode-ai@${OPENCODE_VERSION#v}"
    echo "[install-worker] 未找到 opencode CLI，执行 npm install -g ${pkg} ..."
    if ! npm install -g "$pkg"; then
      echo "[install-worker] ERROR: opencode 自动安装失败；如为权限问题请加 sudo 重试" >&2
      exit 1
    fi
  fi
  if [ -n "${OPENCODE_VERSION}" ] && [ "$(opencode --version 2>/dev/null || true)" != "${OPENCODE_VERSION#v}" ]; then
    echo "[install-worker] 提示：opencode 当前 $(opencode --version 2>/dev/null || echo 未知)，与要求 ${OPENCODE_VERSION} 不一致（不自动切换，避免破坏已有环境）"
  fi
}

ensure_git_curl
ensure_node
ensure_opencode

# ------------------------------ 下载 worker 发布包 ------------------------------
if [ -d "${INSTALL_DIR}/worker/dist" ] && [ -f "${INSTALL_DIR}/worker/package.json" ]; then
  echo "[install-worker] 复用已有发布目录 ${INSTALL_DIR}/worker（跳过下载）"
else
  echo "[install-worker] 下载 worker 发布包：${WORKER_SRC_URL} → ${INSTALL_DIR}/worker"
  local_tarball="${TMPDIR:-/tmp}/worker-src.tar.gz"
  curl -fsSL "$WORKER_SRC_URL" -o "$local_tarball"
  mkdir -p "${INSTALL_DIR}/worker"
  tar -xzf "$local_tarball" -C "${INSTALL_DIR}/worker"
  rm -f "$local_tarball"
fi

cd "${INSTALL_DIR}/worker"

# ------------------------------ 安装依赖（仅生产依赖；dist 由发布包自带） ------------------------------
echo "[install-worker] npm install --omit=dev ..."
npm install --omit=dev

# ------------------------------ 生成/更新 .env（幂等：显式参数总是生效） ------------------------------
# 先删旧行再追加：.env 已存在（复用源码目录）时 --token 等参数仍覆盖写入，未显式传入的 X_WORKER_TOKEN 保留旧值。
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[install-worker] 已从 .env.example 生成 .env"
fi

update_env() {
  local key="$1" value="$2"
  sed -i "/^${key}=/d" .env
  echo "${key}=${value}" >> .env
}

update_env SERVER_URL "${SERVER_URL}"
if [ -n "${WORKER_TOKEN}" ]; then
  update_env X_WORKER_TOKEN "${WORKER_TOKEN}"
fi
update_env WORKER_ID "${WORKER_ID}"
if [ -n "${WORKER_MCP_URL}" ]; then
  update_env WORKER_MCP_URL "${WORKER_MCP_URL}"
fi
if [ -n "${WORKER_ADVERTISE_HOST}" ]; then
  # 只填 IP（如 192.168.1.10）时自动补协议前缀（WORKER_ADVERTISE_HOST 须为完整 URL，server 直连）
  case "${WORKER_ADVERTISE_HOST}" in
    *://*) ;;
    *) WORKER_ADVERTISE_HOST="http://${WORKER_ADVERTISE_HOST}" ;;
  esac
  update_env WORKER_ADVERTISE_HOST "${WORKER_ADVERTISE_HOST}"
fi
if [ -n "${WORKER_SERVE_HOSTNAME}" ]; then
  update_env OPENCODE_SERVE_HOSTNAME "${WORKER_SERVE_HOSTNAME}"
fi
if [ -n "${WORK_DIR}" ]; then
  update_env WORK_DIR "${WORK_DIR}"
fi
echo "[install-worker] .env 已更新（SERVER_URL=${SERVER_URL}，WORKER_ID=${WORKER_ID}${WORKER_TOKEN:+，X_WORKER_TOKEN 已注入}${WORKER_MCP_URL:+，WORKER_MCP_URL 已注入}${WORKER_ADVERTISE_HOST:+，WORKER_ADVERTISE_HOST 已注入}${WORKER_SERVE_HOSTNAME:+，OPENCODE_SERVE_HOSTNAME 已注入}${WORK_DIR:+，WORK_DIR 已注入}）"

# ------------------------------ token 校验 ------------------------------
if [ -z "${X_WORKER_TOKEN:-}" ]; then
  # set -euo pipefail 下 grep 无匹配返回非零，需 || true 兜底
  X_WORKER_TOKEN="$(grep '^X_WORKER_TOKEN=' .env | tail -n 1 | cut -d= -f2- || true)"
fi
if [ -z "${X_WORKER_TOKEN}" ] || [ "${X_WORKER_TOKEN}" = "change-me-worker-token" ]; then
  echo "[install-worker] ERROR: 缺少 X_WORKER_TOKEN（注册鉴权 token，需与 server 侧 WORKER_TOKEN 约定一致）" >&2
  echo "  重跑本命令并携带 --token <token>，或手动编辑 ${INSTALL_DIR}/worker/.env 后执行：./scripts/start.sh" >&2
  exit 1
fi
# 导出给 exec 的 start.sh，避免其重新 source .env 失败时 token 丢失
export X_WORKER_TOKEN

# ------------------------------ 内置 MCP 地址提示 ------------------------------
# 集群外 worker：server 下发的内置 vteam MCP 地址（seed PLATFORM_MCP_URL）为集群内服务名
# （http://server:3000/... 或 http://vteam-server:3000/...），集群外无法解析 → 内置 MCP 不可达。
# 未提供 --mcp-url 且 .env 亦无 WORKER_MCP_URL 时醒目提示；不强制（集群内 worker 无感知）。
if [ -z "${WORKER_MCP_URL}" ] && ! grep -q '^WORKER_MCP_URL=' .env; then
  echo "[install-worker] ⚠️  未配置 WORKER_MCP_URL（内置 vteam MCP 地址覆盖）"
  echo "  若本 worker 位于集群外：server 下发的内置 MCP 地址是集群内服务名"
  echo "  （http://server:3000 或 http://vteam-server:3000），集群外无法解析 → 内置 MCP 不可达。"
  echo "  请设置 WORKER_MCP_URL=<外部可达 server>/api/v1/platform-mcp（如 http://<控制面外部地址>/api/v1/platform-mcp）"
  echo "  —— 可重跑本命令携带 --mcp-url <url>，或手动编辑 ${INSTALL_DIR}/worker/.env 后执行：./scripts/start.sh"
fi

# ------------------------------ 可达地址提示 ------------------------------
# 外部/跨机 worker：未设置 WORKER_ADVERTISE_HOST 时 worker 会自动探测本机非回环 IPv4 上报
# （探测失败才回退 http://127.0.0.1）。未提供 --advertise-host 且 .env 亦无
# WORKER_ADVERTISE_HOST 时提醒：若 server 无法访问探测到的地址，可显式设置；不强制
# （本机/集群内 worker 无感知）。
if [ -z "${WORKER_ADVERTISE_HOST}" ] && ! grep -q '^WORKER_ADVERTISE_HOST=' .env; then
  echo "[install-worker] 提示：未配置 WORKER_ADVERTISE_HOST"
  echo "  worker 会自动探测本机内网 IP 上报（探测失败才回退 http://127.0.0.1 仅本机可访问）。"
  echo "  若 server 无法访问探测到的地址（多网卡/VPN 等），请显式设置 --advertise-host <只填 IP>"
  echo "  且 OPENCODE_SERVE_HOSTNAME=0.0.0.0（serve 须监听非回环，server 才能连上）。"
  echo "  —— 可重跑本命令携带 --advertise-host <IP> --serve-hostname 0.0.0.0，或手动编辑 ${INSTALL_DIR}/worker/.env 后执行：./scripts/start.sh"
fi

# ------------------------------ 启动：systemd 服务（默认）或前台 ------------------------------
if [ ! -d dist ]; then
  echo "[install-worker] ERROR: 发布包缺少 dist/，请确认控制面 worker-src.tar.gz 完整（pack-worker.sh 产物）" >&2
  exit 1
fi

# 检测 systemd 环境（有 systemctl 且运行于 systemd PID 1——容器内通常无）
SYSTEMD_AVAILABLE=""
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  SYSTEMD_AVAILABLE="1"
fi

if [ -n "${NO_SERVICE}" ]; then
  echo "[install-worker] --no-service：前台启动（Ctrl+C 停止，无守护）"
elif [ -z "${SYSTEMD_AVAILABLE}" ]; then
  echo "[install-worker] 未检测到 systemd（容器/精简环境），回退前台启动"
  echo "  手动注册 systemd 可参考：/etc/systemd/system/aiagents-worker.service（ExecStart=${INSTALL_DIR}/worker/scripts/start.sh）"
else
  # node 可能在非默认 PATH（ensure_node 装到 ${HOME}/.local/node/bin）——unit 里显式补 PATH
  NODE_BIN_DIR="$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/node)")"
  SERVICE_UNIT="/etc/systemd/system/aiagents-worker.service"
  echo "[install-worker] 注册 systemd 服务：aiagents-worker（unit=${SERVICE_UNIT}）"
  cat > "${SERVICE_UNIT}" <<EOF
[Unit]
Description=vteam AI worker (aiagents, workerId=${WORKER_ID})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/worker
EnvironmentFile=${INSTALL_DIR}/worker/.env
Environment=PATH=${NODE_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/env bash ${INSTALL_DIR}/worker/scripts/start.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now aiagents-worker >/dev/null 2>&1
  if systemctl is-active --quiet aiagents-worker; then
    echo "[install-worker] ✅ systemd 服务已启动：aiagents-worker"
    echo "  状态：systemctl status aiagents-worker；日志：journalctl -u aiagents-worker -f"
    echo "  停止：systemctl stop aiagents-worker；卸载：systemctl disable --now aiagents-worker && rm -f ${SERVICE_UNIT} && systemctl daemon-reload"
    exit 0
  fi
  echo "[install-worker] ⚠️  systemd 服务启动失败，请检查：journalctl -u aiagents-worker -n 50" >&2
  exit 1
fi

echo "[install-worker] 启动 worker（workerId=${WORKER_ID}，server=${SERVER_URL}）..."
echo "[install-worker] 并发上限参数 --concurrency ${CONCURRENCY} 为预留项（worker 侧当前硬编码 maxInstances=1）"
exec ./scripts/start.sh
