#!/usr/bin/env bash
# ============================================================
# stop.sh —— 停止 vteam 离线部署的服务
#
# 用法：
#   ./stop.sh            # 停止并移除容器（**保留数据卷**）
#   ./stop.sh --purge    # 同时删除数据卷（MySQL 数据 / 会话库 / 产出物**一并删除**）
#   ./stop.sh --status   # 只看状态
# ============================================================
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PKG_ROOT"

if [[ -t 1 ]]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[34m'; N=$'\033[0m'
else
  R=""; G=""; Y=""; B=""; N=""
fi
log() { echo "${B}[$(date +%H:%M:%S)]${N} $*"; }
ok()  { echo "${G}[  OK  ]${N} $*"; }
die() { echo "${R}[ FAIL ]${N} $*" >&2; exit 1; }

PURGE=0
STATUS_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge)  PURGE=1; shift;;
    --status) STATUS_ONLY=1; shift;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "unknown arg: $1 (try --help)";;
  esac
done

command -v docker >/dev/null 2>&1 || die "missing required command: docker"
docker info >/dev/null 2>&1 || die "docker daemon not reachable"

if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  die "missing required command: docker compose（或 docker-compose）"
fi

if [[ "$STATUS_ONLY" -eq 1 ]]; then
  "${DC[@]}" ps
  exit 0
fi

if [[ "$PURGE" -eq 1 ]]; then
  log "stopping containers and **removing volumes**（数据将被删除）"
  "${DC[@]}" down -v --remove-orphans
  ok "已停止并删除数据卷"
else
  log "stopping containers (keeping volumes)"
  "${DC[@]}" down --remove-orphans
  ok "已停止（数据卷保留）"
fi

echo
echo "重新启动: ./start.sh"
