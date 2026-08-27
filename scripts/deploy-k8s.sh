#!/usr/bin/env bash
#
# scripts/deploy-k8s.sh — vteam 一键构建 + push + helm 部署到 K8s
#
# 背景：chart 在 helm upgrade 时，vteam.dbPassword helper 多文件渲染不一致
# （configmap.yaml 调 helper 重新 randAlphaNum，secret.yaml 用 lookup 复用旧值），
# 导致 DATABASE_URL 与 DB_PASSWORD / MySQL root 密码三者漂移，server 启动时
# P1000 认证失败。本脚本强制显式传 4 个 secret，绕过 bug；持久化到
# .deploy-secrets.env（gitignored），后续 upgrade 复用同一组不轮换。
#
# 用法：
#   scripts/deploy-k8s.sh                            # git SHA tag + 默认参数
#   scripts/deploy-k8s.sh --tag v1.2.3              # 指定 tag
#   scripts/deploy-k8s.sh --registry REGISTRY       # 自定义 registry
#   scripts/deploy-k8s.sh --namespace staging       # 自定义 ns
#   scripts/deploy-k8s.sh --release vteam-prod      # 自定义 release 名
#   scripts/deploy-k8s.sh --no-build                # 跳过 docker build（镜像已存在）
#   scripts/deploy-k8s.sh --no-push                 # 跳过 docker push（已 push）
#   scripts/deploy-k8s.sh --dry-run                 # 仅渲染 helm，不执行 build/push/upgrade
#   scripts/deploy-k8s.sh --reset-secrets           # 重新生成 4 个 secret（旧 release 会失配）
#   scripts/deploy-k8s.sh --skip-health             # 不等待 rollout / health（CI 阶段用）
#
# 环境变量（覆盖默认值）：
#   DOCKER_REGISTRY     默认 docker-hosted.ketaops.cc/ketaops
#   VTNAMESPACE         默认 vteam
#   VTEAM_RELEASE       默认 vteam
#   INGRESS_ENABLED     默认 true（false 关闭 ingress）
#   INGRESS_HOST        默认 vteam.ketaops.cc
#   INGRESS_CLASS       默认 nginx
#   VTNAM_BUILD_DIR     默认 /tmp/vteam-build
#
# 前置：
#   - kubectl（context 已指向目标集群）、helm >= 3.12、docker、git、openssl
#   - 已登录目标 registry（docker login），未登录时镜像 push 会失败
#   - 可 pull 基础镜像 docker.ketaops.cc/library/node:{22-alpine,22-bookworm-slim}
#     （anonymous pull 可达）
#
# 文件：
#   .deploy-secrets.env    持久化 4 个 secret（gitignored），升级时复用
#
# 影响范围（每次运行只动这些）：
#   ✓ 改动：server/web/worker 三个业务镜像 tag
#   ✗ 不动：MySQL StatefulSet + 数据 PVC、Secret、ConfigMap、Ingress、Service、
#           uploads PVC、worker-home/worker-work PVC（StatefulSet volumeClaimTemplates）
#
# 升级机制：
#   - helm upgrade --install（无 release 时 install）
#   - Deployment 滚动更新：server / web
#   - StatefulSet 滚动更新：worker（默认 partition 全量滚动）
#   - MySQL StatefulSet 不动（仅镜像未变）
#   - init Job 重新创建（chart 非 helm-hook，平凡 Job；seed 幂等 upsert 不重复）

set -euo pipefail

# ============================================================
# 颜色与输出
# ============================================================
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_BOLD=''; C_RESET=''
fi
log()  { printf '%s[deploy-k8s]%s %s\n' "$C_BLUE"   "$C_RESET" "$*"; }
ok()   { printf '%s[deploy-k8s]%s %s ✓\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s[deploy-k8s]%s %s !\n' "$C_YELLOW" "$C_RESET" "$*"; }
err()  { printf '%s[deploy-k8s]%s %s ✗\n' "$C_RED"   "$C_RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }
hdr()  { printf '\n%s[deploy-k8s] %s%s%s\n' "$C_BOLD" "$C_RESET" "$C_BOLD" "$*"; }

# ============================================================
# 默认参数
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

REGISTRY="${DOCKER_REGISTRY:-docker-hosted.ketaops.cc/ketaops}"
NAMESPACE="${VTNAMESPACE:-vteam}"
RELEASE="${VTEAM_RELEASE:-vteam}"
INGRESS_ENABLED="${INGRESS_ENABLED:-true}"
INGRESS_HOST="${INGRESS_HOST:-vteam.ketaops.cc}"
INGRESS_CLASS="${INGRESS_CLASS:-nginx}"

SECRETS_FILE="$REPO_ROOT/.deploy-secrets.env"
LOG_DIR="${VTNAM_BUILD_DIR:-/tmp/vteam-build}"
LOG_FILE="$LOG_DIR/deploy-$(date +%Y%m%d-%H%M%S).log"

TAG=""
NO_BUILD=0
NO_PUSH=0
DRY_RUN=0
RESET_SECRETS=0
SKIP_HEALTH=0

EFFECTIVE_SECRETS_FILE="$SECRETS_FILE"
DRY_TMP_SECRETS=""

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)            TAG="$2"; shift 2;;
    --registry)       REGISTRY="$2"; shift 2;;
    --namespace)      NAMESPACE="$2"; shift 2;;
    --release)        RELEASE="$2"; shift 2;;
    --no-build)       NO_BUILD=1; shift;;
    --no-push)        NO_PUSH=1; shift;;
    --dry-run)        DRY_RUN=1; shift;;
    --reset-secrets)  RESET_SECRETS=1; shift;;
    --skip-health)    SKIP_HEALTH=1; shift;;
    -h|--help)        usage;;
    *) die "unknown arg: $1 (try --help)";;
  esac
done

mkdir -p "$LOG_DIR"

if [[ $DRY_RUN -eq 1 ]]; then
  NO_BUILD=1
  NO_PUSH=1
  log "--dry-run: 自动跳过 build/push（仅渲染 helm + health 检查）"
fi

# ============================================================
# 1. 前置检查
# ============================================================
hdr "1/6 检查前置条件"

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }
need_cmd kubectl
need_cmd helm
need_cmd docker
need_cmd git
need_cmd openssl

CONTEXT=$(kubectl config current-context 2>/dev/null) || die "kubectl has no current context"
log "kubectl context: $CONTEXT"

HELM_VER=$(helm version --short 2>/dev/null | sed 's/^v//' | cut -d. -f1,2)
if [[ -n "$HELM_VER" ]] && ! awk -v v="$HELM_VER" 'BEGIN{exit !(v>="3.12")}'; then
  warn "helm $HELM_VER < 3.12 (chart requires >= 3.12)"
fi

# tag 默认值（git 短 SHA，非 git 仓库则 last commit 文件 mtime 或 'manual'）
if [[ -z "$TAG" ]]; then
  if git -C "$REPO_ROOT" rev-parse --short HEAD >/dev/null 2>&1; then
    TAG=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
    log "tag: git short SHA = $TAG"
  else
    TAG="manual-$(date +%Y%m%d-%H%M%S)"
    warn "not a git repo, fallback tag = $TAG"
  fi
fi
[[ "$TAG" =~ ^[a-zA-Z0-9._-]+$ ]] || die "invalid tag: $TAG (must match [a-zA-Z0-9._-]+)"

# namespace 不存在则创建
if ! kubectl get ns "$NAMESPACE" >/dev/null 2>&1; then
  if [[ $DRY_RUN -eq 1 ]]; then
    warn "namespace '$NAMESPACE' not exists (dry-run, not creating)"
  else
    log "namespace '$NAMESPACE' not exists, creating..."
    kubectl create ns "$NAMESPACE"
    ok "namespace created"
  fi
else
  log "namespace '$NAMESPACE' exists"
fi

# release 存在性检查（仅 log，不影响）
if [[ $DRY_RUN -eq 0 ]]; then
  if helm list -n "$NAMESPACE" 2>/dev/null | grep -q "^${RELEASE}\b"; then
    REVISION=$(helm history "$RELEASE" -n "$NAMESPACE" --max 1 -o json 2>/dev/null \
      | grep -oE '"revision":[0-9]+' | head -1 | cut -d: -f2 || echo "?")
    log "release '$RELEASE' exists (revision=$REVISION) → will upgrade"
  else
    log "release '$RELEASE' not exists → will install"
  fi
fi

# ============================================================
# 2. 持久化 secret（绕过 chart dbPassword bug）
# ============================================================
hdr "2/6 准备 secret（持久化在 .deploy-secrets.env）"

if [[ $RESET_SECRETS -eq 1 ]]; then
  warn "--reset-secrets: 重新生成 4 个 secret（旧 release 会失配 → MySQL root / JWT / Worker 全部失效，慎用）"
  rm -f "$SECRETS_FILE"
fi

if [[ ! -f "$EFFECTIVE_SECRETS_FILE" ]]; then
  # 优先：release 已存在 → 从集群 secret 提取（避免破坏 MySQL root / JWT / Worker 注册）
  EXISTING_SECRET=""
  if helm list -n "$NAMESPACE" 2>/dev/null | grep -q "^${RELEASE}\b"; then
    EXISTING_SECRET=$(kubectl get secret -n "$NAMESPACE" \
      -l "app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/component=secret" \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    if [[ -z "$EXISTING_SECRET" ]]; then
      for candidate in "${RELEASE}-secret" "${RELEASE}-vteam-secret"; do
        if kubectl get secret "$candidate" -n "$NAMESPACE" >/dev/null 2>&1; then
          EXISTING_SECRET="$candidate"
          break
        fi
      done
    fi
  fi

  # DRY_RUN 且无 SECRETS_FILE → 写到 /tmp 避免污染 repo
  if [[ $DRY_RUN -eq 1 ]]; then
    DRY_TMP_SECRETS="$(mktemp /tmp/vteam-secrets-XXXX.env)"
    EFFECTIVE_SECRETS_FILE="$DRY_TMP_SECRETS"
  fi

  if [[ -n "$EXISTING_SECRET" ]]; then
    log "release '$RELEASE' 已存在，从集群 secret '$EXISTING_SECRET' 提取 4 个 secret..."
    DB_PASSWORD=$(kubectl get secret "$EXISTING_SECRET" -n "$NAMESPACE" -o jsonpath='{.data.DB_PASSWORD}'             | base64 -d)
    JWT_SECRET=$(kubectl get secret "$EXISTING_SECRET" -n "$NAMESPACE" -o jsonpath='{.data.JWT_SECRET}'              | base64 -d)
    WORKER_TOKEN=$(kubectl get secret "$EXISTING_SECRET" -n "$NAMESPACE" -o jsonpath='{.data.WORKER_TOKEN}'           | base64 -d)
    MODEL_CREDENTIAL_KEY=$(kubectl get secret "$EXISTING_SECRET" -n "$NAMESPACE" -o jsonpath='{.data.MODEL_CREDENTIAL_KEY}' | base64 -d)
    umask 077
    cat > "$EFFECTIVE_SECRETS_FILE" <<EOF
# extracted from existing release $RELEASE (secret=$EXISTING_SECRET) on $(date -Iseconds)
# 保持与现有 MySQL root / JWT / Worker token 一致；不要手动修改这些值
DB_PASSWORD=$DB_PASSWORD
JWT_SECRET=$JWT_SECRET
WORKER_TOKEN=$WORKER_TOKEN
MODEL_CREDENTIAL_KEY=$MODEL_CREDENTIAL_KEY
EOF
    chmod 600 "$EFFECTIVE_SECRETS_FILE"
    ok "secrets extracted → $EFFECTIVE_SECRETS_FILE (cluster secret preserved, no rotation)"
  else
    if [[ $DRY_RUN -eq 1 ]]; then
      die "secret file not found and no existing release to extract from; run without --dry-run first"
    fi
    log "generating new secrets (no existing release)..."
    umask 077
    cat > "$EFFECTIVE_SECRETS_FILE" <<EOF
# generated by scripts/deploy-k8s.sh on $(date -Iseconds)
# 持久化 4 个 secret，绕过 chart vteam.dbPassword 多文件渲染不一致 bug。
# 任何升级都用同一组 secret，不触发轮换 → MySQL root / JWT / Worker token 稳定。
# ⚠️ 删除此文件后下次运行会重新生成（破坏现有登录态、worker 注册、MySQL 访问）
DB_PASSWORD=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)
WORKER_TOKEN=$(openssl rand -hex 32)
MODEL_CREDENTIAL_KEY=$(openssl rand -hex 32)
EOF
    chmod 600 "$EFFECTIVE_SECRETS_FILE"
    ok "secrets generated → $EFFECTIVE_SECRETS_FILE"
  fi
fi

# shellcheck source=/dev/null
source "$EFFECTIVE_SECRETS_FILE"
: "${DB_PASSWORD:?DB_PASSWORD missing in $EFFECTIVE_SECRETS_FILE}"
: "${JWT_SECRET:?JWT_SECRET missing}"
: "${WORKER_TOKEN:?WORKER_TOKEN missing}"
: "${MODEL_CREDENTIAL_KEY:?MODEL_CREDENTIAL_KEY missing}"
log "DB_PASSWORD=${DB_PASSWORD:0:8}...  JWT_SECRET=${JWT_SECRET:0:8}...  WORKER_TOKEN=${WORKER_TOKEN:0:8}..."

if [[ -n "$DRY_TMP_SECRETS" && $DRY_RUN -eq 1 ]]; then
  trap 'rm -f "$DRY_TMP_SECRETS" 2>/dev/null || true' EXIT
fi

# ============================================================
# 3. 构建镜像
# ============================================================
hdr "3/6 构建镜像 (tag=$TAG)"

IMAGE_SERVER="$REGISTRY/vteam-server:$TAG"
IMAGE_WEB="$REGISTRY/vteam-web:$TAG"
IMAGE_WORKER="$REGISTRY/vteam-worker:$TAG"

build_one() {
  local dockerfile="$1" context="$2" image="$3" name="$4"
  log "building $name → $image"
  if DOCKER_BUILDKIT=1 docker build -f "$dockerfile" -t "$image" "$context" \
       >"$LOG_DIR/build-$name.log" 2>&1; then
    local size
    size=$(docker images --format '{{.Size}}' "$image" 2>/dev/null | head -1)
    ok "$name built ($size)"
  else
    err "$name build FAILED — tail $LOG_DIR/build-$name.log:"
    tail -30 "$LOG_DIR/build-$name.log" >&2
    return 1
  fi
}

if [[ $NO_BUILD -eq 1 ]]; then
  log "--no-build set, verifying images exist locally..."
  for img in "$IMAGE_SERVER" "$IMAGE_WEB" "$IMAGE_WORKER"; do
    docker image inspect "$img" >/dev/null 2>&1 || die "image missing locally: $img"
  done
  ok "all 3 images present locally"
else
  build_one "$REPO_ROOT/server/Dockerfile" "$REPO_ROOT/server" "$IMAGE_SERVER" server
  build_one "$REPO_ROOT/worker/Dockerfile" "$REPO_ROOT/worker" "$IMAGE_WORKER" worker
  build_one "$REPO_ROOT/web/Dockerfile"    "$REPO_ROOT"          "$IMAGE_WEB"    web
fi

# ============================================================
# 4. push 镜像
# ============================================================
hdr "4/6 推送镜像到 $REGISTRY"

push_one() {
  local image="$1" name="$2"
  log "pushing $name → $image"
  if docker push "$image" >"$LOG_DIR/push-$name.log" 2>&1; then
    ok "$name pushed"
  else
    err "$name push FAILED — tail $LOG_DIR/push-$name.log:"
    tail -30 "$LOG_DIR/push-$name.log" >&2
    return 1
  fi
}

if [[ $NO_PUSH -eq 1 ]]; then
  log "--no-push set, skipping"
else
  push_one "$IMAGE_SERVER" server
  push_one "$IMAGE_WEB"    web
  push_one "$IMAGE_WORKER" worker
fi

# ============================================================
# 5. helm upgrade（强制显式 4 个 secret，绕过 chart bug）
# ============================================================
hdr "5/6 helm upgrade ($RELEASE in $NAMESPACE)"

# 拆分 image = repository / tag
repo_of() { echo "${1%:*}"; }

HELM_ARGS=(
  upgrade "$RELEASE" "$REPO_ROOT/chart/vteam"
  --install
  --namespace "$NAMESPACE"
  --timeout 10m
  --history-max 5
  --set "secret.dbPassword=$DB_PASSWORD"
  --set "secret.jwtSecret=$JWT_SECRET"
  --set "secret.workerToken=$WORKER_TOKEN"
  --set "secret.modelCredentialKey=$MODEL_CREDENTIAL_KEY"
  --set "server.image.repository=$(repo_of "$IMAGE_SERVER")"
  --set "server.image.tag=$TAG"
  --set "web.image.repository=$(repo_of "$IMAGE_WEB")"
  --set "web.image.tag=$TAG"
  --set "worker.image.repository=$(repo_of "$IMAGE_WORKER")"
  --set "worker.image.tag=$TAG"
  --set "ingress.enabled=$INGRESS_ENABLED"
  --set "ingress.host=$INGRESS_HOST"
  --set "ingress.className=$INGRESS_CLASS"
)

if [[ $DRY_RUN -eq 1 ]]; then
  HELM_ARGS+=(--dry-run)
  warn "--dry-run: rendering only, no cluster changes"
fi

log "helm ${HELM_ARGS[*]}" | tee -a "$LOG_FILE"
if helm "${HELM_ARGS[@]}" >"$LOG_DIR/helm-upgrade.log" 2>&1; then
  ok "helm upgrade succeeded"
  [[ $DRY_RUN -eq 0 ]] && tail -10 "$LOG_DIR/helm-upgrade.log" || tail -30 "$LOG_DIR/helm-upgrade.log"
else
  err "helm upgrade FAILED — $LOG_DIR/helm-upgrade.log:"
  tail -40 "$LOG_DIR/helm-upgrade.log" >&2
  exit 1
fi

# ============================================================
# 6. rollout + health check
# ============================================================
hdr "6/6 等待 rollout + health check"

finish() {
  ok "🎉 deploy complete!"
  printf '\n  release    : %s  (ns=%s)\n' "$RELEASE" "$NAMESPACE"
  printf '  images     :\n    %s\n    %s\n    %s\n' \
    "$IMAGE_SERVER" "$IMAGE_WEB" "$IMAGE_WORKER"
  printf '  secrets    : %s\n' "$SECRETS_FILE"
  printf '  helm log   : %s\n' "$LOG_DIR/helm-upgrade.log"
  printf '  deploy log : %s\n\n' "$LOG_FILE"
}

if [[ $SKIP_HEALTH -eq 1 || $DRY_RUN -eq 1 ]]; then
  if [[ $SKIP_HEALTH -eq 1 ]]; then warn "--skip-health: skipping rollout / health"; fi
  if [[ $DRY_RUN -eq 1 ]]; then warn "--dry-run: skipping rollout / health"; fi
  finish
  exit 0
fi

log "等待 init job (prisma migrate + seed)..."
if kubectl wait --for=condition=complete "job/${RELEASE}-init" \
     -n "$NAMESPACE" --timeout=300s 2>&1 | tee -a "$LOG_FILE"; then
  ok "init job 完成"
else
  warn "init job 未在 300s 内 complete（可能在跑或失败）：kubectl logs -n $NAMESPACE -l job-name=${RELEASE}-init --tail=50"
fi

log "等待 deployments / statefulset..."
kubectl rollout status "deploy/${RELEASE}-server" -n "$NAMESPACE" --timeout=300s 2>&1 | tee -a "$LOG_FILE" || warn "server rollout not Ready"
kubectl rollout status "deploy/${RELEASE}-web"    -n "$NAMESPACE" --timeout=300s 2>&1 | tee -a "$LOG_FILE" || warn "web rollout not Ready"
kubectl rollout status "sts/${RELEASE}-worker"    -n "$NAMESPACE" --timeout=300s 2>&1 | tee -a "$LOG_FILE" || warn "worker rollout not Ready"

log "health check (port-forward svc/${RELEASE}-server 13000:3000)..."
nohup kubectl port-forward "svc/${RELEASE}-server" 13000:3000 -n "$NAMESPACE" \
  >"$LOG_DIR/pf-health.log" 2>&1 &
PF_PID=$!
# 注册 trap，脚本退出时清理 port-forward
cleanup_pf() { kill "$PF_PID" 2>/dev/null || true; }
trap cleanup_pf EXIT INT TERM

sleep 4
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:13000/api/v1/health 2>/dev/null || echo 000)
cleanup_pf
trap - EXIT INT TERM

if [[ "$HEALTH" == "200" ]]; then
  ok "health check 通过 (HTTP 200)"
else
  die "health check 失败 (HTTP $HEALTH). 查看: kubectl logs -n $NAMESPACE -l app.kubernetes.io/component=server --tail=50"
fi

finish
