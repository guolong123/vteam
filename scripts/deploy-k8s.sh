#!/usr/bin/env bash
# scripts/deploy-k8s.sh
# vteam k8s 一键部署脚本：build 镜像 + push + helm upgrade
# 单 tag 参数 → 自动 build+push server/web/worker 镜像 + helm upgrade 整个 vteam
# 注：mysql 用 chart 默认镜像（docker.ketaops.cc/library/mysql:8），无需 build
#
# 用法:
#   ./scripts/deploy-k8s.sh                       # 缺省 tag=vteam-k8s-pr31，build+push server+web+worker
#   ./scripts/deploy-k8s.sh vteam-k8s-pr33      # ← 最常用：只传 tag，全部 build+push+deploy
#   ./scripts/deploy-k8s.sh vteam-k8s-pr33 --components server,web  # 只升 server+web
#   ./scripts/deploy-k8s.sh --tag vteam-k8s-pr33 --skip-build    # 跳过 build（用已存在的镜像）
#   ./scripts/deploy-k8s.sh vteam-k8s-pr33 --dry-run              # build+push，**不** helm upgrade
#   ./scripts/deploy-k8s.sh vteam-k8s-pr33 --namespace vteam-dev # 自定义 namespace
#
# 前置: docker / helm / kubectl 已装且可访问 cluster；
#   registry 推送凭据（docker login docker-hosted.ketaops.cc）
set -euo pipefail

# 默认值
REG="${REG:-docker-hosted.ketaops.cc/xishuhq}"
TAG="vteam-k8s-pr31"
COMPONENTS="server,web,worker"
NAMESPACE="vteam"
CHART="chart/vteam"
SKIP_BUILD=0
DRY_RUN=0

# 第一个位置参数作为 tag（无 --tag 时）
if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
  TAG="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --components) COMPONENTS="${2:-}"; shift 2 ;;
    --namespace|-n) NAMESPACE="${2:-}"; shift 2 ;;
    --chart) CHART="${2:-}"; shift 2 ;;
    --registry) REG="${2:-}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,17p' "$0" | sed 's/^# *//'
      exit 0
      ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

cd "$(dirname "$0")/.."

echo "================================================"
echo "vteam k8s deploy"
echo "  TAG:        $TAG"
echo "  COMPONENTS: $COMPONENTS"
echo "  NAMESPACE:  $NAMESPACE"
echo "  CHART:      $CHART"
echo "  REGISTRY:   $REG"
echo "  SKIP_BUILD: $SKIP_BUILD"
echo "  DRY_RUN:    $DRY_RUN"
echo "================================================"

# 1. 验证前置
for cmd in docker helm kubectl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd 未装"; exit 1; }
done
kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || { echo "ERROR: namespace $NAMESPACE 不存在"; exit 1; }

# 2. 解析 components
IFS=',' read -ra PARTS <<< "$COMPONENTS"
declare -A REPO=(
  [server]="vteam-server"
  [web]="vteam-web"
  [worker]="vteam-worker"
)
declare -A BUILD_TARGET=(
  [server]="server"
  [web]="web"
  [worker]="worker"
)
# web 镜像需要 API_PROXY_TARGET（构建期注入到 routes-manifest）
API_PROXY_TARGET="${API_PROXY_TARGET:-http://vteam-server:3000}"

# 3. Build + push（按 components 顺序）
if [[ $SKIP_BUILD -eq 0 ]]; then
  for c in "${PARTS[@]}"; do
    c="$(echo "$c" | xargs)"  # trim
    [[ -z "$c" ]] && continue
    if [[ -z "${REPO[$c]:-}" ]]; then
      echo "ERROR: 未知 component '$c'（支持: server web worker；mysql 用 chart 默认镜像）"
      exit 1
    fi
    img="$REG/${REPO[$c]}:$TAG"

    if [[ "$c" == "web" ]]; then
      echo ""
      echo "=== build web ==="
      docker build -f "$c/Dockerfile" \
        --build-arg "API_PROXY_TARGET=$API_PROXY_TARGET" \
        -t "$img" .
    else
      echo ""
      echo "=== build $c ==="
      docker build -t "$img" "./$c"
    fi
    echo "=== push $c ==="
    docker push "$img"
  done
fi

# 4. export baseline + 改 tag（仅改传入的 components 对应段，避免误改未构建组件）
baseline="/tmp/vteam-baseline-$(date +%Y%m%d-%H%M%S).yaml"
echo ""
echo "=== export baseline → $baseline ==="
helm get values vteam -n "$NAMESPACE" -o yaml > "$baseline"

cp "$baseline" "$baseline.new"
for c in "${PARTS[@]}"; do
  c="$(echo "$c" | xargs)"
  [[ -z "$c" ]] && continue
  # 用 awk 找对应 component 段，把该段内的 tag 行替换为新 tag
  awk -v comp="$c" -v newtag="$TAG" '
    $0 ~ "^"comp":" { in_comp=1; print; next }
    /^[a-z]/ && $0 !~ "^"comp":" && in_comp { in_comp=0 }
    in_comp && /^  tag:/ { sub(/tag:.*/, "tag: " newtag) }
    { print }
  ' "$baseline.new" > "$baseline.tmp" && mv "$baseline.tmp" "$baseline.new"
done
mv "$baseline.new" "$baseline"
echo "=== baseline diff (vs current) ==="
diff <(helm get values vteam -n "$NAMESPACE" -o yaml) "$baseline" | head -30 || true

if [[ $DRY_RUN -eq 1 ]]; then
  echo ""
  echo "DRY_RUN: 跳过 helm upgrade + init 清理。baseline 保留: $baseline"
  exit 0
fi

# 5. 删 init Job（防 Job.spec.template 不可变 error，docs/deployment.md L188）
echo ""
echo "=== delete init Job ==="
kubectl delete job vteam-init -n "$NAMESPACE" 2>&1 | tail -1 || true

# 6. helm upgrade
echo ""
echo "=== helm upgrade ==="
helm upgrade vteam "$CHART" -n "$NAMESPACE" -f "$baseline" --wait --timeout 600s

# 7. 等就绪
echo ""
echo "=== pods status ==="
kubectl get pods -n "$NAMESPACE"

echo ""
echo "=== ingress check (host: vteam.ketaops.cc) ==="
node_ip=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || echo "")
np=$(kubectl get svc -A -l app.kubernetes.io/name=ingress-nginx -o jsonpath='{.items[0].spec.ports[?(@.name=="http")].nodePort}' 2>/dev/null || echo "")
if [[ -n "$node_ip" && -n "$np" ]]; then
  for path in "/" "/api/v1/health"; do
    code=$(/usr/bin/curl -s --max-time 5 -o /dev/null -w "%{http_code}" -H "Host: vteam.ketaops.cc" "http://${node_ip}:${np}${path}" 2>/dev/null || echo "ERR")
    echo "  ${path} → HTTP ${code}"
  done
else
  echo "  (跳过：未取到 node IP / ingress-nginx NodePort)"
fi

echo ""
echo "✅ deploy done. TAG=$TAG  baseline: $baseline"
