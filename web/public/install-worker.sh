#!/usr/bin/env bash
#
# install-worker.sh —— worker 独立部署一键安装脚本（由控制面 web 静态服务提供）。
#
# 用法（控制面安装向导页生成的命令）：
#   curl -fsSL <控制面地址>/install-worker.sh | bash -s -- \
#     --server http://<控制面地址> --worker-id my-worker-1 --concurrency 8 --opencode latest
#
# 流程：自动安装前置（git / node >= 18 / opencode CLI v2，缺失即自动装）→ 下载 worker 发布包
#   → npm install → 生成 .env（SERVER_URL / WORKER_ID / X_WORKER_TOKEN /
#   OPENCODE_SERVER_PASSWORD / WORKER_MAX_INSTANCES）→ 校验 X_WORKER_TOKEN → 启动
#   （复用仓库内 worker/scripts/start.sh 语义：启动即注册，随后每 10s 心跳）。
#   worker 源码以发布包（pack-worker.sh 产物）从控制面下载，不做 git clone——
#   目标机器无需任何仓库 SSH 凭证，复制命令即可完整安装。
#
# ⚠️ opencode v2 契约（本脚本只支持 v2；v1 时代的假设已全部作废）：
#   ① CLI 包名：v1 的 npm 包 `opencode-ai` 已冻结在 1.19.3（永远到不了 v2）→ v2 换包名
#      `@opencode/cli`。**本脚本缺省按 npm 的 `latest` 标签装（= 最新已发布的 v2）**，不钉死版本；
#      需要可复现时用 `--opencode <具体版本>` 显式钉版（如 2.0.32）。
#      ⚠️ **镜像路径是另一条路、单独锁版 2.0.32**（worker/Dockerfile 的 ARG OPENCODE_CLI_SPEC）——
#      那是「镜像里装哪版」的可复现性要求，与本脚本的 latest 缺省互不影响。
#   ② 恒开鉴权：v2 的 serve **总是**要求 Basic Auth（用户名固定 opencode），密码来自
#      `OPENCODE_SERVER_PASSWORD`——该变量在 v2 下**必填**；为空时 opencode 自动生成随机密码
#      并打到 stdout，worker 不解析它 → 启动即 fail-fast。故本脚本保证该变量一定写进 .env
#      （= systemd 的 EnvironmentFile）；逃生开关 `OPENCODE_ALLOW_GENERATED_PASSWORD=1`
#      **本脚本不会启用**（worker 侧默认关闭，属不推荐路径）。
#   ③ 拓扑：控制面**不再**直连 opencode serve，而是调用 worker 自己的执行端点
#      （POST /sessions、POST /sessions/:id/prompt、GET /sessions/:id/messages、
#       POST /sessions/:id/abort、GET /models，以及 /execute、/file、/agents、/todos），
#      端口取注册上报的 capabilities.execPort（缺省 4198 = WORKER_EXEC_PORT），
#      地址取 WORKER_ADVERTISE_HOST 的**主机部分**（serve 端口不再被使用）。
#      ⇒ 控制面要能访问的是 **<advertise-host>:4198**；serve 端口绑回环（127.0.0.1）完全没问题。
#
# 参数：
#   --server <url>      控制面地址（缺省 http://localhost:3000）
#   --worker-id <id>    worker 唯一 id（缺省 w_<hostname>）
#   --concurrency <n>   并发上限（写入 .env 的 WORKER_MAX_INSTANCES）：worker 侧读该变量
#                       （worker/src/config.ts，缺省 5），并随注册上报 capabilities.maxInstances，
#                       控制面按容量分派。传值必须是正整数（非法值本脚本直接报错退出，不静默兜底）。
#                       不传则不写该变量（保留 worker 自己的缺省 5）。
#   --opencode <ver>    opencode CLI 版本（缺省 latest = npm 包 @opencode/cli 的 latest 标签，即最新已发布的 v2）：
#                       可传 latest / 裸版本号（2.0.32 / v2.0.32）或完整 npm spec（@opencode/cli@2.0.32），
#                       后两者用于**钉版**（可复现安装）；CLI 缺失时按此规格 npm 全局安装，
#                       已安装则仅提示校验（不自动切换）。
#                       ⚠️ v2 worker 的启动期版本闸门要求 opencode 主版本 ≥ 2：传 1.x / v1 包
#                       （opencode-ai）会被自动改用缺省的 @opencode/cli@latest（v1 线已冻结，永不到 v2）。
#                       ⚠️ 装出来的 opencode 主版本 ≥ 3 时本脚本**硬失败**（worker 驱动只验证过 v2）——
#                       请钉一个 v2 版本，如 --opencode 2.0.32。
#                       ℹ️ 镜像路径单独锁版 2.0.32（worker/Dockerfile 的 ARG OPENCODE_CLI_SPEC），
#                       与本脚本的 latest 缺省互不影响。
#   --token <token>     X_WORKER_TOKEN（注册鉴权，需与 server 侧约定一致；缺省引导手动填写）
#   --src-url <url>     worker 发布包下载地址（缺省 ${SERVER_URL%/}/worker-src.tar.gz）
#   --dir <path>        安装目录（缺省 $HOME/vteam-worker）
#   --mcp-url <url>     内置 vteam MCP 地址覆盖（WORKER_MCP_URL，可选）：集群外 worker 必须设置
#                       为外部可达地址（如 http://<控制面外部地址>/api/v1/platform-mcp），否则内置
#                       MCP 不可达（server 下发的默认地址是集群内服务名 http://server:3000 /
#                       http://vteam-server:3000，集群外机器无法解析）；集群内 worker 可省略。
#                       未提供时仅提示，不强制写入（保证集群内 worker 无感知）。
#   --advertise-host <url>   worker 对 server 公布的基址（WORKER_ADVERTISE_HOST，可选）：
#                       外部/跨机 worker 建议显式设置 server 可达的 worker 地址（只填 IP 即可，
#                       脚本自动补 http:// 前缀，如 192.168.1.10 → http://192.168.1.10）；
#                       未提供时 worker 会自动探测本机非回环 IPv4 上报（探测失败回退
#                       http://127.0.0.1 仅本机可访问）；集群内/本机 worker 可省略。
#                       ⚠️ v2 拓扑：控制面只取该基址的**主机部分**，执行端点端口取注册上报的
#                       capabilities.execPort（缺省 4198）——真正的可达性要求是
#                       「控制面能访问 <advertise-host>:4198」，与 serve 端口无关。
#   --serve-hostname <host>  opencode serve 监听地址（OPENCODE_SERVE_HOSTNAME；缺省 0.0.0.0）。
#                       ⚠️ v2 拓扑：**控制面不再连 opencode serve**（它只调 worker 的执行端点
#                       <advertise-host>:4198），serve 只是 worker 自己的后端 ⇒ 绑回环
#                       （127.0.0.1）完全可以，且更安全（不必把 serve 暴露到本机所有网卡）。
#                       缺省仍写 0.0.0.0 仅为兼容既有安装（不改变已生成 .env 的暴露面）；
#                       想更收敛可显式传 --serve-hostname 127.0.0.1。
#                       serve 带 Basic Auth（OPENCODE_SERVER_PASSWORD），仍建议在防火墙/安全组
#                       限制来源 IP。
#   --serve-port <port>  opencode serve 端口（OPENCODE_SERVE_PORT，可选）：缺省安装时自动
#                       从 4199 起探测首个空闲端口并固定写入 .env（重启不变）；显式传入则
#                       以传入值为准；传 0 表示恢复随机端口（每次启动由 OS 分配）。
#                       （v2 下该端口只对 worker 自身有意义——控制面走执行端点 4198。）
#   --work-dir <path>   worker 工作目录（WORK_DIR，可选；缺省 /data/vteam-worker）：opencode serve
#                       工作目录 + 资源注入落点（opencode.json / 技能 / 工具）。外部 worker 若
#                       需固定工作目录/挂载持久化盘可设置；缺省不写入（worker 用内置默认）。
#   --system-service    以系统级 systemd 注册（unit 写 /etc/systemd/system，需 root）。
#                       缺省用**用户级** `systemctl --user`（unit 写 ~/.config/systemd/user），
#                       普通用户无需任何权限即可安装。差异见下方「启动」段。
#   --no-service        不注册 systemd 服务（默认注册：守护进程 + 崩溃自动重启，
#                       服务名 vteam-worker，日志 journalctl --user -u vteam-worker -f）。
#                       无 systemd 环境（容器等）自动回退前台启动。
set -euo pipefail

# ------------------------------ 参数解析 ------------------------------
SERVER_URL=""
WORKER_ID=""
CONCURRENCY=""
CONCURRENCY_SET=""
OPENCODE_VERSION=""
WORKER_TOKEN=""
WORKER_SRC_URL=""
INSTALL_DIR="${HOME}/vteam-worker"
WORKER_MCP_URL=""
WORKER_ADVERTISE_HOST=""
# 缺省 0.0.0.0（保持既有安装不变，不改动已生成 .env 的暴露面）：v2 拓扑下**控制面不再连
# serve**（它只调 worker 的执行端点 <advertise-host>:4198），serve 只是 worker 自己的后端
# ⇒ 绑回环 127.0.0.1 完全可行且更安全；保留 0.0.0.0 仅为不改变既有部署行为。
WORKER_SERVE_HOSTNAME="0.0.0.0"
WORK_DIR=""
NO_SERVICE=""
SYSTEM_SERVICE=""
SERVE_PORT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER_URL="${2:-}"; shift 2 ;;
    --worker-id) WORKER_ID="${2:-}"; shift 2 ;;
    --concurrency) CONCURRENCY="${2:-}"; CONCURRENCY_SET="1"; shift 2 ;;
    --opencode) OPENCODE_VERSION="${2:-}"; shift 2 ;;
    --token) WORKER_TOKEN="${2:-}"; shift 2 ;;
    --src-url) WORKER_SRC_URL="${2:-}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --mcp-url) WORKER_MCP_URL="${2:-}"; shift 2 ;;
    --advertise-host) WORKER_ADVERTISE_HOST="${2:-}"; shift 2 ;;
    --serve-hostname) WORKER_SERVE_HOSTNAME="${2:-}"; shift 2 ;;
    --serve-port) SERVE_PORT="${2:-}"; shift 2 ;;
    --work-dir) WORK_DIR="${2:-}"; shift 2 ;;
    --no-service) NO_SERVICE="1"; shift ;;
    --system-service) SYSTEM_SERVICE="1"; shift ;;
    *)
      echo "[install-worker] ERROR: 未知参数 $1（支持 --server/--worker-id/--concurrency/--opencode/--token/--src-url/--dir/--mcp-url/--advertise-host/--serve-hostname/--serve-port/--work-dir/--system-service/--no-service）" >&2
      exit 1
      ;;
  esac
done

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
WORKER_ID="${WORKER_ID:-w_$(hostname)}"
WORKER_SRC_URL="${WORKER_SRC_URL:-${SERVER_URL%/}/worker-src.tar.gz}"

# --concurrency 校验：写入 .env 的 WORKER_MAX_INSTANCES（worker 侧真实读取的变量，缺省 5）。
# 非法值直接拒绝——worker 自身遇到非法值只会告警并回落 5，静默兜底会让运维误以为并发上限已生效。
if [ -n "${CONCURRENCY_SET}" ]; then
  if ! printf '%s' "${CONCURRENCY}" | grep -qE '^[0-9]+$'; then
    echo "[install-worker] ERROR: --concurrency 必须为正整数（收到：${CONCURRENCY:-空值}）" >&2
    exit 1
  fi
  # 去掉前导零再比较：拦掉 "0"/"00" 等非正值；超长数字按非法处理（避免算术溢出）。
  concurrency_num="${CONCURRENCY#"${CONCURRENCY%%[!0]*}"}"
  concurrency_num="${concurrency_num:-0}"
  if [ "${#concurrency_num}" -gt 9 ] || [ "${concurrency_num}" -lt 1 ]; then
    echo "[install-worker] ERROR: --concurrency 必须为正整数（收到：${CONCURRENCY}）" >&2
    exit 1
  fi
fi

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

# ------------------------------ opencode CLI 规格解析（v2 包名 @opencode/cli） ------------------------------
# 缺省 = npm 的 `latest` 标签（@opencode/cli@latest = 最新已发布的 v2）：裸机安装默认跟随上游发布，
# 不把版本钉死在某个硬编码值上；需要可复现时用 `--opencode <具体版本>` 显式钉版（如 2.0.32）。
# ⚠️ **镜像路径单独锁版 2.0.32**（worker/Dockerfile 的 ARG OPENCODE_CLI_SPEC）——那是「镜像里装哪版」
# 的可复现性要求（控制面按 opencode 版本串精确过滤 worker），**不适用于本脚本**。
# v1 的 npm 包 `opencode-ai` 冻结在 1.19.3（永不到 v2），v2 换包名 `@opencode/cli`。
OPENCODE_CLI_DEFAULT_SPEC="@opencode/cli@latest"
OPENCODE_CLI_SPEC=""
OPENCODE_CLI_VERSION=""

# 把 --opencode 的取值规范化成 npm spec（结果写入 OPENCODE_CLI_SPEC / OPENCODE_CLI_VERSION）：
#   latest / vlatest        → @opencode/cli@latest（npm 标签 = 最新已发布的 v2，不是硬编码版本）
#   2.0.32 / v2.0.32        → @opencode/cli@2.0.32（裸版本号 → v2 包）
#   @opencode/cli@latest    → 原样
#   @opencode/cli@2.0.32    → 原样
#   @opencode/cli           → @opencode/cli@latest（补缺省版本）
#   opencode-ai@1.19.3     → v1 包（已冻结）→ 改用缺省 v2 规格
#   1.x / v1.18.15          → v1 版本 → 改用缺省 v2 规格（v2 worker 版本闸门要求 major ≥ 2）
resolve_opencode_spec() {
  local raw="${1:-}"
  local pkg="" ver="" major=""
  if [ -z "$raw" ]; then
    OPENCODE_CLI_SPEC="${OPENCODE_CLI_DEFAULT_SPEC}"
    OPENCODE_CLI_VERSION="${OPENCODE_CLI_DEFAULT_SPEC##*@}"
    return 0
  fi
  case "$raw" in
    *@*)
      if [ "${raw#@}" != "$raw" ]; then
        # 作用域包：@scope/name[@version]
        local rest="${raw#@}"
        case "$rest" in
          *@*) pkg="@${rest%@*}"; ver="${rest##*@}" ;;
          *) pkg="@${rest}"; ver="" ;;
        esac
      else
        pkg="${raw%@*}"; ver="${raw##*@}"
      fi
      ;;
    *) ver="$raw" ;;
  esac

  if [ -n "$pkg" ]; then
    if [ "$pkg" != "@opencode/cli" ]; then
      echo "[install-worker] ⚠️  请求的 opencode 包 ${pkg} 不是 v2 包（v1 的 opencode-ai 已冻结在 1.19.3，永不到 v2）" >&2
      echo "[install-worker] ⚠️  v2 worker 只支持 @opencode/cli → 改用缺省 ${OPENCODE_CLI_DEFAULT_SPEC}" >&2
      OPENCODE_CLI_SPEC="${OPENCODE_CLI_DEFAULT_SPEC}"
      OPENCODE_CLI_VERSION="${OPENCODE_CLI_DEFAULT_SPEC##*@}"
      return 0
    fi
    if [ -z "$ver" ]; then
      ver="${OPENCODE_CLI_DEFAULT_SPEC##*@}"
    fi
  else
    ver="${ver#v}"
    # `latest` 是 npm 标签（不是数字版本）→ 走缺省规格。**必须先于下面的「数字主版本」判定**，
    # 否则 latest 会被当成「无法识别的版本」直接报错。
    if [ "$ver" = "latest" ]; then
      ver="latest"
    else
      major="${ver%%.*}"
      if ! printf '%s' "$major" | grep -qE '^[0-9]+$'; then
        echo "[install-worker] ERROR: 无法识别的 opencode 版本：${raw}（应形如 latest / 2.0.32 或 @opencode/cli@2.0.32）" >&2
        exit 1
      fi
      if [ "$major" -lt 2 ]; then
        echo "[install-worker] ⚠️  请求的 opencode 版本 ${raw} 是 v1（npm 包 opencode-ai 已冻结在 1.19.3，永不到 v2）" >&2
        echo "[install-worker] ⚠️  v2 worker 的版本闸门要求 opencode 主版本 ≥ 2 → 改用 ${OPENCODE_CLI_DEFAULT_SPEC}" >&2
        ver="${OPENCODE_CLI_DEFAULT_SPEC##*@}"
      fi
    fi
  fi

  OPENCODE_CLI_SPEC="@opencode/cli@${ver}"
  OPENCODE_CLI_VERSION="${ver}"
}

ensure_opencode() {
  resolve_opencode_spec "${OPENCODE_VERSION}"
  if ! command -v opencode >/dev/null 2>&1; then
    echo "[install-worker] 未找到 opencode CLI，执行 npm install -g ${OPENCODE_CLI_SPEC} ..."
    if ! npm install -g "${OPENCODE_CLI_SPEC}"; then
      echo "[install-worker] ERROR: opencode 自动安装失败；如为权限问题请加 sudo 重试" >&2
      exit 1
    fi
  fi
  # 版本校验：v2 的 `opencode --version` 形如 "opencode v2.0.32" / "2.0.32" → 归一化成 semver 再比
  local raw_version actual_version actual_major
  raw_version="$(opencode --version 2>/dev/null || true)"
  actual_version="$(printf '%s' "$raw_version" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
  actual_major=""
  if [ -n "$actual_version" ]; then
    actual_major="${actual_version%%.*}"
  fi
  if [[ "$actual_major" =~ ^[0-9]+$ ]] && [ "$actual_major" -lt 2 ]; then
    echo "[install-worker] ERROR: 机器上已安装的 opencode 是 v1（${actual_version}），v2 worker 不支持 v1" >&2
    echo "  v1 的 npm 包 opencode-ai 已冻结在 1.19.3，永远到不了 v2——worker 启动即被版本闸门判死" >&2
    echo "  请先升级到 v2 再重跑本脚本：npm install -g ${OPENCODE_CLI_SPEC}" >&2
    echo "  （旧的 v1 可一并卸载：npm uninstall -g opencode-ai）" >&2
    exit 1
  fi
  # ≥3 硬闸：worker 自身的版本闸门只拦「主版本 < 2」，v3+ 会被**放行**；但当前 worker 的
  # opencode 驱动只对着 v2 验证过 ⇒ v3 会在运行期以难排查的方式失败（契约漂移），不能放过去。
  if [[ "$actual_major" =~ ^[0-9]+$ ]] && [ "$actual_major" -ge 3 ]; then
    echo "[install-worker] ERROR: 检测到已安装的 opencode 主版本为 ${actual_major}（${actual_version}）——当前 worker 只支持 v2" >&2
    echo "  npm 的 latest 标签现在可能已指向 v${actual_major}+ 发布版；worker 自身的版本闸门只拦「主版本 < 2」，" >&2
    echo "  v${actual_major} 会被放行、到运行期才以难排查的方式失败（契约漂移，不是启动即报错的清晰错误）。" >&2
    echo "  请钉一个 v2 版本重跑本脚本：--opencode 2.0.32（或手动 npm install -g @opencode/cli@2.0.32）。" >&2
    exit 1
  fi
  # 请求的是 `latest`（npm 标签，不是版本号）时**不做版本比对**——拿 "latest" 去比 semver 永远不相等，
  # 会每次安装都打印一条假的「与要求不一致」提示；改为直接报出实际装上的版本。
  if [ "${OPENCODE_CLI_VERSION}" = "latest" ]; then
    if [ -n "$actual_version" ]; then
      echo "[install-worker] opencode 已安装：${actual_version}（按 latest 安装）"
    else
      echo "[install-worker] opencode 已安装（版本号解析不出，按 latest 安装）"
    fi
  elif [ -n "$actual_version" ] && [ "$actual_version" != "${OPENCODE_CLI_VERSION}" ]; then
    echo "[install-worker] 提示：opencode 当前 ${actual_version}，与要求 ${OPENCODE_CLI_VERSION}（${OPENCODE_CLI_SPEC}）不一致（不自动切换，避免破坏已有环境）"
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

# 读取 .env 中某个键的值（去掉可能的首尾引号；键不存在返回空串）。
# set -euo pipefail 下 grep 无匹配返回非零，需 || true 兜底。
read_env_value() {
  local key="$1" raw
  raw="$(grep "^${key}=" .env | tail -n 1 | cut -d= -f2- || true)"
  case "$raw" in
    \"*\") raw="${raw#\"}"; raw="${raw%\"}" ;;
    \'*\') raw="${raw#\'}"; raw="${raw%\'}" ;;
  esac
  printf '%s' "$raw"
}

# 写密钥类变量：值含空格/引号/$ 等 shell 特殊字符时加双引号并转义
# （.env 会被 worker/scripts/start.sh 用 `source .env` 加载，不能是裸的非法 shell 片段）。
update_env_secret() {
  local key="$1" value="$2"
  sed -i "/^${key}=/d" .env
  if printf '%s' "$value" | grep -qE '^[A-Za-z0-9._~+/=@-]+$'; then
    echo "${key}=${value}" >> .env
  else
    local escaped
    escaped="$(printf '%s' "$value" | sed -e 's/[\\"$`]/\\&/g')"
    echo "${key}=\"${escaped}\"" >> .env
  fi
}

update_env SERVER_URL "${SERVER_URL}"
if [ -n "${WORKER_TOKEN}" ]; then
  update_env X_WORKER_TOKEN "${WORKER_TOKEN}"
fi
update_env WORKER_ID "${WORKER_ID}"
# 并发上限 → WORKER_MAX_INSTANCES（worker 读该变量并随注册上报 capabilities.maxInstances）；
# 未显式传 --concurrency 时不写，保留 worker 自己的缺省（5）。
if [ -n "${CONCURRENCY_SET}" ]; then
  update_env WORKER_MAX_INSTANCES "${CONCURRENCY}"
fi
if [ -n "${WORKER_MCP_URL}" ]; then
  update_env WORKER_MCP_URL "${WORKER_MCP_URL}"
fi
if [ -n "${WORKER_ADVERTISE_HOST}" ]; then
  # 只填 IP（如 192.168.1.10）时自动补协议前缀（WORKER_ADVERTISE_HOST 须为完整 URL；
  # v2 下控制面只取其中的主机部分，执行端点端口另由 capabilities.execPort 给出）
  case "${WORKER_ADVERTISE_HOST}" in
    *://*) ;;
    *) WORKER_ADVERTISE_HOST="http://${WORKER_ADVERTISE_HOST}" ;;
  esac
  update_env WORKER_ADVERTISE_HOST "${WORKER_ADVERTISE_HOST}"
fi
if [ -n "${WORKER_SERVE_HOSTNAME}" ]; then
  # 缺省即 0.0.0.0（保持既有安装不变）；显式传 127.0.0.1 可退回仅本机（v2 下同样可用）。
  update_env OPENCODE_SERVE_HOSTNAME "${WORKER_SERVE_HOSTNAME}"
  if [ "${WORKER_SERVE_HOSTNAME}" != "127.0.0.1" ]; then
    echo "[install-worker] serve 监听 ${WORKER_SERVE_HOSTNAME}（所有网卡；v2 下控制面不连 serve——它只调执行端点 <advertise-host>:4198；serve 带 Basic Auth，仍建议限制来源 IP）"
  fi
fi
if [ -n "${WORK_DIR}" ]; then
  update_env WORK_DIR "${WORK_DIR}"
fi
# 固定 opencode serve 端口（安装时选定一次，重启不再漂移）：
# - 显式 --serve-port 总是覆盖（--serve-port 0 = 明确改回随机，后续重装也保留 0）；
# - .env 已有 OPENCODE_SERVE_PORT（含 0）则保留（重复安装不换端口）；
# - 键缺失（.env.example 里该行默认注释掉）→ 从 4199 起探测首个空闲端口写入。
existing_serve_port="$(grep '^OPENCODE_SERVE_PORT=' .env | tail -n 1 | cut -d= -f2- || true)"
if [ -n "${SERVE_PORT}" ]; then
  update_env OPENCODE_SERVE_PORT "${SERVE_PORT}"
elif [ -z "${existing_serve_port}" ]; then
  pinned_port="$(node -e '
const net = require("net");
(async () => {
  for (let p = 4199; p < 4199 + 64; p++) {
    const free = await new Promise((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(p, "0.0.0.0", () => s.close(() => resolve(true)));
    });
    if (free) { process.stdout.write(String(p)); process.exit(0); }
  }
  process.exit(1);
})();' || true)"
  if [ -n "${pinned_port}" ]; then
    update_env OPENCODE_SERVE_PORT "${pinned_port}"
  else
    echo "[install-worker] ⚠️  4199-4262 端口段全被占用，保留 OPENCODE_SERVE_PORT=${existing_serve_port:-0}（随机）" >&2
  fi
fi
resolved_serve_port="$(grep '^OPENCODE_SERVE_PORT=' .env | tail -n 1 | cut -d= -f2- || true)"

# ------------------------------ 执行端点端口（v2 拓扑：控制面唯一要访问的端口） ------------------------------
# v2 下控制面只调 worker 的执行端点（/sessions、/execute、/file、/agents、/todos…），
# 端口随注册上报为 capabilities.execPort（worker 侧读 WORKER_EXEC_PORT，缺省 4198）。
# .env 里已有该键则保留（运维可能改过），否则显式写入缺省值——便于运维一眼看到该放行哪个端口。
if ! grep -q '^WORKER_EXEC_PORT=' .env; then
  update_env WORKER_EXEC_PORT "4198"
fi
resolved_exec_port="$(read_env_value WORKER_EXEC_PORT)"
resolved_exec_port="${resolved_exec_port:-4198}"
# 端口占用预检：被占时 worker 的执行端点绑不上（注册时不上报 capabilities.execPort），
# 控制面将无法派发任务 → 提前提醒换端口（改 .env 的 WORKER_EXEC_PORT 即可）。
exec_port_state="$(node -e '
const net = require("net");
const port = Number(process.argv[1]);
const s = net.createServer();
s.once("error", () => { process.stdout.write("busy"); });
s.listen(port, "0.0.0.0", () => s.close(() => process.stdout.write("free")));
' "${resolved_exec_port}" 2>/dev/null || true)"
if [ "${exec_port_state}" = "busy" ]; then
  echo "[install-worker] ⚠️  执行端点端口 ${resolved_exec_port} 已被占用：若占用者不是本 worker 自身的进程，则执行端点将绑不上（注册时不上报 capabilities.execPort，控制面无法派发任务）" >&2
  echo "  请确认 ${INSTALL_DIR}/worker/.env 里的 WORKER_EXEC_PORT 为空闲端口（控制面需能访问 <advertise-host>:<端口>）" >&2
fi

# ------------------------------ opencode serve 密码（v2 恒开鉴权，必填） ------------------------------
# v2 的 serve **恒开鉴权**（Basic Auth，用户名固定 opencode）：OPENCODE_SERVER_PASSWORD 为空时，
# opencode 自动生成随机密码并打到 stdout，worker 不解析它 → 启动即 fail-fast
# （"[opencode-server] v2 恒开鉴权：请设置环境变量 OPENCODE_SERVER_PASSWORD"），
# systemd 下表现为崩溃重启循环。故安装期必须保证该变量落在 .env（= systemd 的 EnvironmentFile）。
#
# 取值优先级（**明文不入 stdout/日志**：脚本由 web 静态服务分发，stdout 可能进 shell 历史 / CI 日志）：
#   ① .env 已有非空值 → 沿用（不覆盖；重复安装保持同一个密码）
#   ② 环境变量 OPENCODE_SERVER_PASSWORD 已设置 → 写入 .env（systemd 只认 EnvironmentFile）
#   ③ 都没有 → 现场随机生成（openssl rand -hex 32；无 openssl 时退回 node crypto.randomBytes）
serve_password="$(read_env_value OPENCODE_SERVER_PASSWORD)"
if [ -n "$serve_password" ]; then
  if [ -n "${OPENCODE_SERVER_PASSWORD:-}" ] && [ "${OPENCODE_SERVER_PASSWORD}" != "$serve_password" ]; then
    echo "[install-worker] 提示：环境中的 OPENCODE_SERVER_PASSWORD 与 .env 已有值不同，沿用 .env 已有值（不覆盖）"
  fi
  echo "[install-worker] OPENCODE_SERVER_PASSWORD 已存在于 .env（沿用；读取：grep OPENCODE_SERVER_PASSWORD ${INSTALL_DIR}/worker/.env）"
elif [ -n "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  serve_password="${OPENCODE_SERVER_PASSWORD}"
  update_env_secret OPENCODE_SERVER_PASSWORD "$serve_password"
  echo "[install-worker] 已将环境中的 OPENCODE_SERVER_PASSWORD 写入 ${INSTALL_DIR}/worker/.env（读取：grep OPENCODE_SERVER_PASSWORD ${INSTALL_DIR}/worker/.env）"
else
  serve_password="$(openssl rand -hex 32 2>/dev/null || true)"
  if [ -z "$serve_password" ]; then
    serve_password="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' 2>/dev/null || true)"
  fi
  if [ -z "$serve_password" ]; then
    echo "[install-worker] ERROR: 无法生成 OPENCODE_SERVER_PASSWORD（openssl 与 node 均不可用）" >&2
    exit 1
  fi
  update_env_secret OPENCODE_SERVER_PASSWORD "$serve_password"
  echo "[install-worker] 已生成随机 OPENCODE_SERVER_PASSWORD 并写入 ${INSTALL_DIR}/worker/.env（读取：grep OPENCODE_SERVER_PASSWORD ${INSTALL_DIR}/worker/.env）"
fi
unset serve_password

# .env 含注册 token 与 serve 密码 → 收紧权限（systemd 以同用户读取，不影响启动）
if ! chmod 600 .env; then
  echo "[install-worker] ⚠️  未能把 .env 权限收紧到 600，请手动执行：chmod 600 ${INSTALL_DIR}/worker/.env" >&2
fi

echo "[install-worker] .env 已更新（SERVER_URL=${SERVER_URL}，WORKER_ID=${WORKER_ID}${WORKER_TOKEN:+，X_WORKER_TOKEN 已注入}${WORKER_MCP_URL:+，WORKER_MCP_URL 已注入}${WORKER_ADVERTISE_HOST:+，WORKER_ADVERTISE_HOST 已注入}${WORKER_SERVE_HOSTNAME:+，OPENCODE_SERVE_HOSTNAME 已注入}${WORK_DIR:+，WORK_DIR 已注入}${CONCURRENCY_SET:+，WORKER_MAX_INSTANCES=${CONCURRENCY} 已注入}，OPENCODE_SERVE_PORT=${resolved_serve_port:-0}，OPENCODE_SERVER_PASSWORD 已注入）"
if [ "${resolved_serve_port:-0}" != "0" ]; then
  echo "[install-worker] opencode serve 端口已固定为 ${resolved_serve_port}（重启不变；改端口可重跑并加 --serve-port <port>）"
fi
echo "[install-worker] v2 拓扑提醒：控制面只调 worker 的执行端点（<advertise-host>:${resolved_exec_port}），不连 opencode serve——请确保控制面到该端口可达（防火墙/安全组放行）"

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
# WORKER_ADVERTISE_HOST 时提醒：若控制面无法访问探测到的地址，可显式设置；不强制
# （本机/集群内 worker 无感知）。
if [ -z "${WORKER_ADVERTISE_HOST}" ] && ! grep -q '^WORKER_ADVERTISE_HOST=' .env; then
  echo "[install-worker] 提示：未配置 WORKER_ADVERTISE_HOST"
  echo "  worker 会自动探测本机内网 IP 上报（探测失败才回退 http://127.0.0.1 仅本机可访问）。"
  echo "  若控制面无法访问探测到的地址（多网卡/VPN 等），请显式设置 --advertise-host <只填 IP>"
  echo "  —— 可重跑本命令携带 --advertise-host <IP>，或手动编辑 ${INSTALL_DIR}/worker/.env 后执行：./scripts/start.sh"
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

# 选 systemd 作用域：默认「用户级」（普通用户可写 unit，无需 root）；--system-service 走系统级。
# 用户级 unit 落在 ~/.config/systemd/user/，随该用户会话存活；配 linger 后登出仍存活。
if [ -n "${SYSTEM_SERVICE}" ]; then
  SYSTEMD_SCOPE="system"
else
  SYSTEMD_SCOPE="user"
fi

# 用户级 systemctl 依赖会话总线；非交互式 SSH 下 XDG_RUNTIME_DIR / DBUS 通常未就位，
# 需按 systemd 约定补齐，否则 systemctl --user 直接报 "Failed to connect to bus"。
if [ "${SYSTEMD_SCOPE}" = "user" ]; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
fi

# 用户级：探测 bus 可用性（不可用则回退前台，不硬失败——装完跑不起来更难排查）
if [ -n "${SYSTEMD_AVAILABLE}" ] && [ "${SYSTEMD_SCOPE}" = "user" ]; then
  if ! systemctl --user is-system-running >/dev/null 2>&1 \
     && ! systemctl --user list-unit-files >/dev/null 2>&1; then
    SYSTEMD_AVAILABLE=""
    echo "[install-worker] ⚠️  用户级 systemd 总线不可用（XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-未设}）"
    echo "  常见于无桌面的 SSH 会话；如需开机自启可改用：sudo ... bash -s -- --system-service ..."
  fi
fi

if [ -n "${NO_SERVICE}" ]; then
  echo "[install-worker] --no-service：前台启动（Ctrl+C 停止，无守护）"
elif [ -z "${SYSTEMD_AVAILABLE}" ]; then
  echo "[install-worker] 未检测到可用的 systemd（容器/精简环境/无用户总线），回退前台启动"
  if [ "${SYSTEMD_SCOPE}" = "user" ]; then
    echo "  手动注册用户级服务：mkdir -p ~/.config/systemd/user"
    echo "    unit 内容同 ${INSTALL_DIR}/worker/scripts/start.sh（ExecStart），随后 systemctl --user enable --now vteam-worker"
  else
    echo "  手动注册 systemd 可参考：/etc/systemd/system/vteam-worker.service（ExecStart=${INSTALL_DIR}/worker/scripts/start.sh）"
  fi
else
  # node 可能在非默认 PATH（ensure_node 装到 ${HOME}/.local/node/bin）——unit 里显式补 PATH
  NODE_BIN_DIR="$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/node)")"
  if [ "${SYSTEMD_SCOPE}" = "user" ]; then
    SERVICE_UNIT="${HOME}/.config/systemd/user/vteam-worker.service"
    SERVICE_LOG_HINT="journalctl --user -u vteam-worker -f"
    SERVICE_CTL="systemctl --user"
    # 用户级 unit 无 network-online.target 可用性保证，用 basic.target（用户会话就绪即启动）
    UNIT_AFTER="After=network.target"
    UNIT_WANTS="Wants=network.target"
    UNIT_WANTED_BY="WantedBy=default.target"
  else
    SERVICE_UNIT="/etc/systemd/system/vteam-worker.service"
    SERVICE_LOG_HINT="journalctl -u vteam-worker -f"
    SERVICE_CTL="systemctl"
    UNIT_AFTER="After=network-online.target"
    UNIT_WANTS="Wants=network-online.target"
    UNIT_WANTED_BY="WantedBy=multi-user.target"
  fi
  mkdir -p "$(dirname "${SERVICE_UNIT}")"
  echo "[install-worker] 注册 systemd 服务（${SYSTEMD_SCOPE} 级）：vteam-worker（unit=${SERVICE_UNIT}）"
  cat > "${SERVICE_UNIT}" <<EOF
[Unit]
Description=vteam AI worker (vteam, workerId=${WORKER_ID})
${UNIT_AFTER}
${UNIT_WANTS}

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/worker
EnvironmentFile=${INSTALL_DIR}/worker/.env
Environment=PATH=${NODE_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/env bash ${INSTALL_DIR}/worker/scripts/start.sh
Restart=always
RestartSec=5

[Install]
${UNIT_WANTED_BY}
EOF
  # 系统级 unit 若已存在且本次是普通用户 → 无写权限，提前给出可执行的替代路径
  if [ ! -w "${SERVICE_UNIT}" ]; then
    echo "[install-worker] ERROR: 无写权限：${SERVICE_UNIT}" >&2
    echo "  系统级 unit 需 root；请去掉 --system-service 改用用户级（默认），或加 sudo 重跑。" >&2
    exit 1
  fi
  ${SERVICE_CTL} daemon-reload
  ${SERVICE_CTL} enable --now vteam-worker >/dev/null 2>&1 || true
  if ${SERVICE_CTL} is-active --quiet vteam-worker; then
    echo "[install-worker] ✅ systemd 服务已启动：vteam-worker（${SYSTEMD_SCOPE} 级）"
    echo "  状态：${SERVICE_CTL} status vteam-worker；日志：${SERVICE_LOG_HINT}"
    if [ "${SYSTEMD_SCOPE}" = "user" ]; then
      # 用户级 unit 默认随会话消亡；linger 让其登出后继续运行并开机自启。
      if command -v loginctl >/dev/null 2>&1; then
        if loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null | grep -qx yes; then
          echo "  开机自启：已启用 linger（登出后保持运行）"
        elif loginctl enable-linger "$(id -un)" 2>/dev/null; then
          echo "  开机自启：已启用 linger（登出后保持运行）"
        else
          echo "  ⚠️  开机自启：未启用 linger，需 root 执行一次 sudo loginctl enable-linger $(id -un)"
          echo "      否则 SSH 登出后 worker 会停止（重登可恢复）"
        fi
      else
        echo "  ⚠️  未找到 loginctl，开机自启需另行配置"
      fi
    fi
    echo "  停止：${SERVICE_CTL} stop vteam-worker"
    echo "  卸载：${SERVICE_CTL} disable --now vteam-worker && rm -f ${SERVICE_UNIT} && ${SERVICE_CTL} daemon-reload"
    exit 0
  fi
  echo "[install-worker] ⚠️  systemd 服务启动失败，请检查：${SERVICE_LOG_HINT} -n 50" >&2
  exit 1
fi

echo "[install-worker] 启动 worker（workerId=${WORKER_ID}，server=${SERVER_URL}）..."
if [ -n "${CONCURRENCY_SET}" ]; then
  echo "[install-worker] 并发上限：WORKER_MAX_INSTANCES=${CONCURRENCY}（已写入 .env；worker 读该变量，随注册上报 capabilities.maxInstances）"
else
  echo "[install-worker] 并发上限：未传 --concurrency → 不写 WORKER_MAX_INSTANCES，保留 worker 缺省（5）"
fi
exec ./scripts/start.sh
