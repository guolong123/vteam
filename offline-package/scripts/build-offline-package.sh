#!/usr/bin/env bash
# ============================================================
# build-offline-package.sh —— 在**有网络**的机器上制作 vteam 离线安装包
#
# 做法：
#   1. 从线上 k8s 使用的 registry 拉取 linux/amd64 镜像（不在本地重新构建）
#   2. docker save 导出为 images/*.tar
#   3. 把每个镜像同时打上**本地离线 tag**（vteam/<name>:<version>），
#      离线端 load 后无需再访问任何 registry
#   4. 生成 images/manifest.txt（tag → 原始镜像名 → digest 映射表），start.sh 据此导入
#   5. 打包整个目录为 vteam-offline-<version>-amd64.tar.gz
#
# 用法：
#   ./build-offline-package.sh                 # 用默认镜像清单（v1.3.3）
#   ./build-offline-package.sh --version v1.3.3
#   ./build-offline-package.sh --skip-tarball   # 只生成 images/ 不打包
#
# 依赖：docker（含 buildx 不需要）、tar、gzip
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------- 参数 ----------
VERSION="v1.3.3"
SKIP_TARBALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)      VERSION="$2"; shift 2;;
    --skip-tarball) SKIP_TARBALL=1; shift;;
    -h|--help)      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done

# ---------- 日志 ----------
if [[ -t 1 ]]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[34m'; N=$'\033[0m'
else
  R=""; G=""; Y=""; B=""; N=""
fi
log()  { echo "${B}[$(date +%H:%M:%S)]${N} $*"; }
ok()   { echo "${G}[  OK  ]${N} $*"; }
warn() { echo "${Y}[ WARN ]${N} $*"; }
die()  { echo "${R}[ FAIL ]${N} $*" >&2; exit 1; }
hdr()  { echo; echo "${G}==== $* ====${N}"; }

command -v docker >/dev/null 2>&1 || die "missing required command: docker"
docker info >/dev/null 2>&1 || die "docker daemon not reachable"

IMAGES_DIR="$PKG_ROOT/images"
mkdir -p "$IMAGES_DIR"

# ---------- 镜像清单 ----------
# 格式：<本地离线名>|<registry 原始引用>
# 本地 tag 统一为 vteam/<component>:<version>，离线端 load 后直接用它，
# 同时把原始 registry 名也打进 tar（compose 默认引用本地离线 tag，start.sh 会打 tag）
#
# ⚠️ mysql **按 digest 钉死**（不是 `:8` 浮动 tag）：
#    k8s 集群里跑的 mysql 是 37 天前拉的那份（digest 0744ee5e…），
#    而 `:8` tag 期间已被上游重新推过（当前指向 a0225d1e…）。
#    离线包要对齐**线上实际运行的版本**，故用 digest 钉死，
#    避免离线端拿到的是另一个 digest 的 mysql。
#    digest 来源：kubectl get pod vteam-mysql-0 -n vteam -o jsonpath='{.status.containerStatuses[0].imageID}'
read -r -d '' IMAGE_LIST <<'EOF' || true
mysql|docker.ketaops.cc/library/mysql@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d
server|docker-hosted.ketaops.cc/ketaops/vteam-server:v1.3.3
web|docker-hosted.ketaops.cc/ketaops/vteam-web:v1.3.3
worker|docker-hosted.ketaops.cc/ketaops/vteam-worker:v1.3.3
EOF

# ---------- 平台 ----------
PLATFORM="linux/amd64"

hdr "1/5 拉取镜像（platform=${PLATFORM}）"

# 先删掉可能存在的同 tag 旧镜像，避免 pull 到错误架构的层缓存
MANIFEST="$IMAGES_DIR/manifest.txt"
: > "$MANIFEST"

OFFLINE_TAG_PREFIX="vteam"

while IFS='|' read -r comp ref; do
  [[ -z "$comp" ]] && continue
  local_tag="${OFFLINE_TAG_PREFIX}/${comp}:${VERSION}"

  log "pulling ${ref} (${PLATFORM})"
  if ! docker pull --platform "$PLATFORM" "$ref"; then
    die "failed to pull ${ref}"
  fi

  # 校验架构：必须是 amd64（离线目标平台）
  arch="$(docker image inspect "$ref" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null || echo unknown)"
  if [[ "$arch" != "linux/amd64" ]]; then
    die "image ${ref} arch is ${arch}, expected linux/amd64 (离线包只含 amd64)"
  fi
  ok "${ref} -> ${arch}"

  # 打本地离线 tag（离线端 compose 用这个 tag，不访问 registry）
  docker tag "$ref" "$local_tag"

  echo "${local_tag}|${ref}" >> "$MANIFEST"
done <<< "$IMAGE_LIST"

ok "manifest written: $MANIFEST"

hdr "2/5 导出镜像（docker save）"

# 每个镜像单独一个 tar：离线端可只 load 需要的镜像，也可整体 load
# 文件名用组件名，避免原始 registry 名里的斜杠/点号带来路径歧义
while IFS='|' read -r local_tag ref; do
  [[ -z "$local_tag" ]] && continue
  comp="${local_tag#${OFFLINE_TAG_PREFIX}/}"
  comp="${comp%%:*}"
  tar_path="$IMAGES_DIR/${comp}-${VERSION}.tar"

  log "saving ${local_tag} -> $(basename "$tar_path")"
  docker save -o "$tar_path" "$local_tag" "$ref"

  size="$(du -h "$tar_path" | cut -f1)"
  ok "$(basename "$tar_path")  ${size}"
done < "$MANIFEST"

hdr "3/5 生成校验信息"

# 记录每个镜像的 digest（离线端可核对导入是否完整）
# 注意：输出到临时文件再 mv——若直接重定向到 $MANIFEST，shell 会先截断该文件，
# 而内层 while 仍在从它读取 ⇒ 读到空内容（自反馈死循环，manifest 被写坏）。
MANIFEST_TMP="$(mktemp "${TMPDIR:-/tmp}/vteam-manifest.XXXXXX")"
{
  echo "# vteam 离线镜像清单"
  echo "# version=${VERSION} platform=${PLATFORM}"
  echo "# 格式：<本地离线tag>|<原始registry引用>|<digest>"
  while IFS='|' read -r local_tag ref; do
    [[ -z "$local_tag" || "$local_tag" == \#* ]] && continue
    digest="$(docker image inspect "$local_tag" --format '{{index .RepoDigests 0}}' 2>/dev/null || echo '-')"
    echo "${local_tag}|${ref}|${digest}"
  done < "$MANIFEST"
} > "$MANIFEST_TMP"
mv -f "$MANIFEST_TMP" "$MANIFEST"

cat "$IMAGES_DIR/manifest.txt"

hdr "4/5 生成 .env.example"

# 生成 env 模板（真实 .env 由离线端 start.sh 首启时生成随机值）
cat > "$PKG_ROOT/.env.example" <<EOF
# ============================================================
# vteam 离线部署配置（复制为 .env 后按需修改）
#
# ⚠️ 首次运行 ./start.sh 时，若 .env 不存在，会**自动生成**本文件并填入随机密钥
#    （JWT_SECRET / WORKER_TOKEN / MODEL_CREDENTIAL_KEY / OPENCODE_SERVER_PASSWORD /
#     MYSQL_ROOT_PASSWORD 全部随机），无需手工准备。
#
# 需要覆盖时改这里（改完重启 ./stop.sh && ./start.sh 生效）：
# ============================================================

# ---------- 镜像引用（一般不用改） ----------
# compose 默认已指向离线包内置的本地 tag（vteam/<组件>:<版本>），
# 这里显式列出，便于换版本或改用自有 registry。
MYSQL_IMAGE=vteam/mysql:${VERSION}
SERVER_IMAGE=vteam/server:${VERSION}
WEB_IMAGE=vteam/web:${VERSION}
WORKER_IMAGE=vteam/worker:${VERSION}

# ---------- 服务端口（宿主机侧） ----------
# server (NestJS API)
SERVER_PORT=13000
# web (Next.js 前端)
WEB_PORT=13001
# worker opencode serve
WORKER_SERVE_PORT=14000
# agent-browser dashboard
AGENT_BROWSER_DASHBOARD_PORT=14848

# ---------- 数据库 ----------
MYSQL_ROOT_PASSWORD=vteam-root
MYSQL_DATABASE=vteam

# ---------- 鉴权密钥（生产必须改为随机值） ----------
# 生成方式：openssl rand -hex 32
JWT_SECRET=CHANGE_ME_$(date +%s)
WORKER_TOKEN=CHANGE_ME_$(date +%s)
# 模型 provider token 加密密钥（AES-256-GCM，必须 32 字节 / 64 hex）
MODEL_CREDENTIAL_KEY=CHANGE_ME_$(date +%s)
# opencode serve 认证密码（Basic Auth，用户名固定 opencode）
OPENCODE_SERVER_PASSWORD=CHANGE_ME_$(date +%s)

# ---------- worker ----------
# worker 唯一 id（多副本部署时每实例需不同）
WORKER_ID=w_compose_worker
# worker 默认模型兜底（Agent 未配模型时用）；留空 = 用 serve 默认
WORKER_DEFAULT_MODEL=
# worker 并发上限（server 按此算剩余容量派单）
WORKER_MAX_INSTANCES=10
EOF

ok ".env.example generated"

hdr "5/5 打包"

# 包内不含 .env（含密钥），只含 .env.example
rm -f "$PKG_ROOT/.env" "$PKG_ROOT/.env.test"

if [[ "$SKIP_TARBALL" -eq 1 ]]; then
  warn "--skip-tarball: 跳过 tar.gz 打包（images/ 与脚本已就绪）"
else
  OUT_TAR="$PKG_ROOT/../vteam-offline-${VERSION}-amd64.tar.gz"
  log "packing -> $(basename "$OUT_TAR")"
  tar -czf "$OUT_TAR" \
    --exclude='.env' \
    --exclude='.env.test' \
    --exclude='*.tar.gz' \
    -C "$PKG_ROOT" .
  size="$(du -h "$OUT_TAR" | cut -f1)"
  ok "$(basename "$OUT_TAR")  ${size}"
fi

hdr "完成"
echo "离线包目录: $PKG_ROOT"
echo "镜像 tar:   $IMAGES_DIR"
echo
echo "交付到离线机器后执行："
echo "  tar -xzf vteam-offline-${VERSION}-amd64.tar.gz -C /opt"
echo "  cd /opt/vteam-offline && ./start.sh"
