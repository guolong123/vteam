#!/usr/bin/env bash
#
# worker 部署脚本（T2）：加载 .env → **按引擎**校验 CLI → 构建（若缺 dist）→ 启动 worker。
# 用法：./scripts/start.sh
set -euo pipefail

# 切换到 worker 目录（脚本所在目录的上级）。
cd "$(dirname "$0")/.."

# 加载 .env（若存在）；用 set -a 使 source 的变量全部导出。
# ⚠️ 必须在**引擎校验之前**加载：WORKER_ENGINE 就在 .env 里，先校验 opencode
# 会让 dsh 引擎的安装（没有 opencode CLI）直接启动失败（实测踩到）。
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# 前置校验：按引擎检查对应 CLI
if [ "${WORKER_ENGINE:-opencode}" = "dsh" ]; then
  if ! command -v "${DSH_BIN:-dsh}" >/dev/null 2>&1; then
    echo "[worker] ERROR: 未找到 dsh CLI（WORKER_ENGINE=dsh），请先安装 @deepseek-ai/dsh 并加入 PATH" >&2
    exit 1
  fi
else
  # opencode 引擎：T3 spawn 依赖 opencode CLI。
  if ! command -v opencode >/dev/null 2>&1; then
    echo "[worker] ERROR: 未找到 opencode CLI，请先安装并加入 PATH（见 README.md 前置条件）" >&2
    exit 1
  fi
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
