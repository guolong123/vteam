#!/usr/bin/env bash
#
# install-worker.sh —— worker 独立部署一键安装脚本（由控制面 web 静态服务提供）。
#
# 用法（控制面安装向导页生成的命令）：
#   curl -fsSL <控制面地址>/install-worker.sh | bash -s -- \
#     --server http://<控制面地址> --worker-id my-worker-1 --concurrency 8 --opencode v1.18.15
#
# 流程：前置校验（git / node >= 18 / opencode CLI）→ 拉取 worker 源码 → npm install
#   → 生成 .env（SERVER_URL / WORKER_ID）→ 校验 X_WORKER_TOKEN → 构建 → 启动
#   （复用仓库内 worker/scripts/start.sh 语义：启动即注册，随后每 10s 心跳）。
#
# 参数：
#   --server <url>      控制面地址（缺省 http://localhost:3000）
#   --worker-id <id>    worker 唯一 id（缺省 w_<hostname>）
#   --concurrency <n>   并发上限（预留：worker 侧当前硬编码 maxInstances=1，见 worker/src/index.ts）
#   --opencode <ver>    opencode CLI 版本要求（仅提示校验，CLI 需自行安装并入 PATH）
#   --token <token>     X_WORKER_TOKEN（注册鉴权，需与 server 侧约定一致；缺省引导手动填写）
#   --repo <url>        源码仓库（缺省 git@gitee.com:xishuhq/aiagents.git）
#   --dir <path>        安装目录（缺省 $HOME/aiagents-worker）
set -euo pipefail

# ------------------------------ 参数解析 ------------------------------
SERVER_URL=""
WORKER_ID=""
CONCURRENCY=""
OPENCODE_VERSION=""
WORKER_TOKEN=""
REPO_URL="git@gitee.com:xishuhq/aiagents.git"
INSTALL_DIR="${HOME}/aiagents-worker"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER_URL="${2:-}"; shift 2 ;;
    --worker-id) WORKER_ID="${2:-}"; shift 2 ;;
    --concurrency) CONCURRENCY="${2:-}"; shift 2 ;;
    --opencode) OPENCODE_VERSION="${2:-}"; shift 2 ;;
    --token) WORKER_TOKEN="${2:-}"; shift 2 ;;
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    *)
      echo "[install-worker] ERROR: 未知参数 $1（支持 --server/--worker-id/--concurrency/--opencode/--token/--repo/--dir）" >&2
      exit 1
      ;;
  esac
done

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
WORKER_ID="${WORKER_ID:-w_$(hostname)}"
CONCURRENCY="${CONCURRENCY:-8}"

# ------------------------------ 前置校验 ------------------------------
for cmd in git node npm opencode; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[install-worker] ERROR: 未找到 $cmd，请先安装并加入 PATH（opencode CLI 为 worker 运行依赖）" >&2
    exit 1
  fi
done

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 18 ? 1 : 0)'; then
  echo "[install-worker] ERROR: Node.js >= 18 必需，当前 $(node --version)" >&2
  exit 1
fi

if [ -n "${OPENCODE_VERSION}" ]; then
  echo "[install-worker] opencode 版本要求：${OPENCODE_VERSION}（请确认 PATH 中 opencode CLI 版本满足，当前 $(opencode --version 2>/dev/null || echo 未知)）"
fi

# ------------------------------ 拉取源码 ------------------------------
if [ -d "${INSTALL_DIR}/worker" ]; then
  echo "[install-worker] 复用已有源码目录 ${INSTALL_DIR}/worker（跳过 clone）"
else
  echo "[install-worker] 拉取 worker 源码：${REPO_URL} → ${INSTALL_DIR}"
  mkdir -p "$INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "${INSTALL_DIR}/worker"

# ------------------------------ 安装依赖 ------------------------------
echo "[install-worker] npm install ..."
npm install

# ------------------------------ 生成 .env（不覆盖已有配置） ------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|^SERVER_URL=.*|SERVER_URL=${SERVER_URL}|" .env
  sed -i "s|^X_WORKER_TOKEN=.*|X_WORKER_TOKEN=${WORKER_TOKEN}|" .env
  echo "# worker-id 由安装参数注入（缺省 w_<hostname>）" >> .env
  echo "WORKER_ID=${WORKER_ID}" >> .env
  echo "[install-worker] 已生成 .env（SERVER_URL=${SERVER_URL}，WORKER_ID=${WORKER_ID}）"
fi

# ------------------------------ token 校验 ------------------------------
if [ -z "${X_WORKER_TOKEN:-}" ]; then
  X_WORKER_TOKEN="$(sed -n 's/^X_WORKER_TOKEN=//p' .env | tail -n 1)"
fi
if [ -z "${X_WORKER_TOKEN}" ] || [ "${X_WORKER_TOKEN}" = "change-me-worker-token" ]; then
  echo "[install-worker] ERROR: 缺少 X_WORKER_TOKEN（注册鉴权 token，需与 server 侧约定一致）" >&2
  echo "  请编辑 ${INSTALL_DIR}/worker/.env 填写 X_WORKER_TOKEN 后重新执行：./scripts/start.sh" >&2
  exit 1
fi

# ------------------------------ 构建 + 启动 ------------------------------
if [ ! -d dist ]; then
  echo "[install-worker] dist 不存在，执行 npm run build ..."
  npm run build
fi

echo "[install-worker] 启动 worker（workerId=${WORKER_ID}，server=${SERVER_URL}）..."
echo "[install-worker] 并发上限参数 --concurrency ${CONCURRENCY} 为预留项（worker 侧当前硬编码 maxInstances=1）"
exec ./scripts/start.sh
