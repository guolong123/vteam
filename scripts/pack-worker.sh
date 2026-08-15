#!/bin/sh
#
# pack-worker.sh —— 打包 worker 发布包，供 install-worker.sh 一键安装下载。
#
# 背景：install-worker.sh 不再 git clone 源码仓库（目标机器无仓库 SSH 凭证时
# clone 必失败，违背「复制命令即装好」）。改为从控制面 web 静态服务下载
# worker 发布包（本脚本产物）。
#
# 发布流程：改动 worker/ 代码后运行本脚本 → 生成 web/public/worker-src.tar.gz
#   → 部署 web（tarball 随静态服务发布）。tarball 已 .gitignore，不入库。
#   web 镜像构建（web/Dockerfile）亦在构建期调用本脚本，镜像自带发布包。
#
# 发布包内容（运行所需最小集，不含 node_modules / src）：
#   dist/            tsc 编译产物（含 resources 自定义工具）
#   package.json     npm 依赖声明（生产依赖 @opencode-ai/sdk）
#   package-lock.json
#   scripts/start.sh worker 启动脚本（.env 加载 + 启动校验）
#   .env.example     配置模板（install-worker.sh 复制生成 .env）
#
# POSIX sh 兼容（Alpine 基础镜像无 bash，web/Dockerfile 构建期调用）。
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/worker"

echo "[pack-worker] 构建 dist ..."
npm run build

OUT="$ROOT/web/public/worker-src.tar.gz"
echo "[pack-worker] 打包发布包 → ${OUT}"
tar -czf "$OUT" dist package.json package-lock.json scripts .env.example

echo "[pack-worker] 完成：$(du -h "$OUT" | cut -f1)（记得部署 web 使其随静态服务发布）"
