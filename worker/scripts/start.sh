#!/usr/bin/env bash
#
# worker 部署脚本（T2）：校验 opencode CLI → 加载 .env → 构建（若缺 dist）→ 启动 worker。
# 用法：./scripts/start.sh
set -euo pipefail

# 前置校验：opencode CLI 必须存在（T3 spawn 依赖它）。
if ! command -v opencode >/dev/null 2>&1; then
  echo "[worker] ERROR: 未找到 opencode CLI，请先安装并加入 PATH（见 README.md 前置条件）" >&2
  exit 1
fi

# 切换到 worker 目录（脚本所在目录的上级）。
cd "$(dirname "$0")/.."

# 加载 .env（若存在）；用 set -a 使 source 的变量全部导出。
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# 必填项校验（X_WORKER_TOKEN），给出明确指引而非让 node 抛堆栈。
if [ -z "${X_WORKER_TOKEN:-}" ]; then
  echo "[worker] ERROR: 缺少环境变量 X_WORKER_TOKEN（注册鉴权 token），请复制 .env.example 为 .env 并填写" >&2
  exit 1
fi

# dist 不存在时先构建。
if [ ! -d dist ]; then
  echo "[worker] dist 不存在，执行 npm run build ..."
  npm run build
fi

echo "[worker] 启动 worker（pid=$$，workerId=${WORKER_ID:-w_$(hostname)}）..."
exec node dist/index.js
