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
#   dist/            tsc 编译产物（含 resources 自定义工具 + 本脚本生成的 version.js）
#   package.json     npm 依赖声明（生产依赖 @opencode-ai/sdk）
#   package-lock.json
#   scripts/start.sh worker 启动脚本（.env 加载 + 启动校验）
#   .env.example     配置模板（install-worker.sh 复制生成 .env）
#
# 版本戳（worker 自更新机制的版本身份来源，worker/src/code-version.ts 解析）：
#   1. dist/version.js —— 本脚本在 `npm run build` 之后、tar 之前生成，内容为
#      `export const WORKER_CODE_VERSION = '<git short SHA>';`；非 git 环境
#      （如 web 镜像构建期的源码 COPY）回退 manual-<YYYYMMDD>。
#   2. web/public/worker-src.version.json —— tar 打包完成后写出
#      {version, sha256, builtAt}：sha256 为 tarball 本体摘要（自更新执行器
#      下载后校验，不匹配即放弃覆盖），供 UI/运维核对发布物版本。
#   3. 容器/集群路径不经过本脚本（worker/Dockerfile 直接 tsc），版本由 env
#      WORKER_CODE_VERSION 注入（Dockerfile ARG CODE_VERSION → ENV），优先级
#      高于文件戳（见 code-version.ts 的三级优先级）。
#
# 用法：
#   sh scripts/pack-worker.sh                # 构建 + 打包 + 写版本文件（默认）
#   sh scripts/pack-worker.sh --print-version # 仅打印解析出的版本号（自检用，
#     不构建不打包；在非 git 目录执行可验证 manual-<date> 回退分支）
#
# POSIX sh 兼容（Alpine 基础镜像无 bash，web/Dockerfile 构建期调用）。
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 版本解析（可单独执行，供自检验证非 git 回退分支）。
# 非 git 目录（git 不存在/命令失败/不在工作树内）→ manual-<YYYYMMDD>。
resolve_code_version() {
  # 构建期注入优先：web 镜像构建上下文无 .git（.dockerignore 排除），
  # deploy 以 --build-arg CODE_VERSION=$TAG 传入，否则回退 git，再否则日期戳。
  if [ -z "${CODE_VERSION:-}" ]; then
    CODE_VERSION="$(git rev-parse --short HEAD 2>/dev/null || true)"
  fi
  if [ -z "${CODE_VERSION}" ]; then
    CODE_VERSION="manual-$(date +%Y%m%d)"
  fi
}

if [ "${1:-}" = "--print-version" ]; then
  resolve_code_version
  echo "${CODE_VERSION}"
  exit 0
fi

cd "$ROOT/worker"

echo "[pack-worker] 构建 dist ..."
npm run build

# ---- 版本戳：npm run build 之后、tar 之前（dist 是 tsc 产物，每次构建重建）----
resolve_code_version
VERSION_FILE="dist/version.js"
# 只读环境无法写 dist 时（理论不发生：build 已写过 dist）显式报错，不静默产出无版本包。
cat > "$VERSION_FILE" <<EOF
// 本文件由 scripts/pack-worker.sh 自动生成，请勿手工编辑。
// dist 是 tsc 产物目录，每次 npm run build 后由打包脚本重写本文件。
// 运行时版本解析（worker/src/code-version.ts）：
//   env WORKER_CODE_VERSION（容器/集群注入，优先）> 本文件 > 'dev'
export const WORKER_CODE_VERSION = '${CODE_VERSION}';
EOF
echo "[pack-worker] 版本戳 = ${CODE_VERSION} → ${VERSION_FILE}"

OUT="$ROOT/web/public/worker-src.tar.gz"
echo "[pack-worker] 打包发布包 → ${OUT}"
# 清单维持不变：dist 目录整体入包（自然带上 version.js）。
tar -czf "$OUT" dist package.json package-lock.json scripts .env.example

# ---- 发布包版本元数据：tarball 摘要 + 版本 + 构建时间（ISO 8601 UTC）----
# sha256 优先系统 sha256sum（Linux/Alpine），回退 shasum -a 256（macOS），
# 最后回退 node 内置 crypto（打包链路已要求 node，不引入新 npm 依赖）。
sha256_of() {
  target="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$target" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target" | cut -d' ' -f1
  else
    node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$target"
  fi
}

META_OUT="$ROOT/web/public/worker-src.version.json"
SHA256="$(sha256_of "$OUT")"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{\n  "version": "%s",\n  "sha256": "%s",\n  "builtAt": "%s"\n}\n' \
  "$CODE_VERSION" "$SHA256" "$BUILT_AT" > "$META_OUT"
echo "[pack-worker] 版本文件 = ${META_OUT}（sha256 ${SHA256}，builtAt ${BUILT_AT}）"

echo "[pack-worker] 完成：$(du -h "$OUT" | cut -f1)（记得部署 web 使其随静态服务发布）"