# worker 镜像（Phase 5 T3，D4 Oracle 实测方案；2026-08 agent-browser 集成版）。
# 双阶段：build（TS 编译）→ runner（全局安装 opencode CLI + agent-browser + 运行 dist）。
# opencode CLI = npm 包 @opencode/cli（**锁版本** @opencode/cli@2.0.32，见下方 OPENCODE_CLI_SPEC）。
# agent-browser = Vercel / vercel-labs/agent-browser（Rust + Chrome CDP，给 opencode Agent 补浏览器能力）。
#
# 基座说明：原 node:22-alpine (musl) 跑不了 Chrome(glibc)，切到 debian bookworm-slim；
# Chrome 依赖由 `agent-browser install --with-deps` 自动补齐（apt）。

# 基础镜像可覆盖：CI 在拉不到内网镜像源时传 --build-arg NODE_IMAGE=docker.io/library/node:22-bookworm-slim
ARG NODE_IMAGE=docker.ketaops.cc/library/node:22-bookworm-slim

# ---- 阶段 1：build ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com && npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- 阶段 2：runner ----
FROM ${NODE_IMAGE}
# 国内源加速（apt：阿里云镜像）
RUN apt-get update && apt-get install -y ca-certificates && \
    sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null || true
# 国内源加速（npm）
RUN npm config set registry https://registry.npmmirror.com
# opencode CLI 全局安装（serve spawn 依赖，需在 PATH；npm 全局 bin 默认进 PATH）
# **锁版本**（计划 T1 / D2）：v1 的 npm 包 `opencode-ai` 已冻结在 1.19.3（不再发版），
# 永远到不了 v2；v2 换了包名 → `@opencode/cli`。不锁版本会让"镜像里跑的是哪一版"不可知，
# 而控制面调度器按 opencode 版本串精确过滤 worker（版本闸门必须先于 v2 worker 上线）。
# 复现/升级某次构建时覆盖：
#   --build-arg OPENCODE_CLI_SPEC=@opencode/cli@2.0.32
# 构建日志会打印实际装到的版本（下方 echo），便于事后追溯"这个镜像用的是哪版"。
ARG OPENCODE_CLI_SPEC=@opencode/cli@2.0.32
# **必须钉版本**：`agent-browser` / `bun` 若不带版本，上游每次发版都会让这一层及**其后所有层**
# 失效（v1.1.1→v1.2.0 实测：基础镜像 tag 浮动 + 未钉版本 ⇒ 6 个构建 job 的缓存命中数为 0，
# 镜像层全变 ⇒ 集群每次发布都要整包重拉）。`agent-browser` 的版本同时决定它下载的
# Chrome for Testing 版本（`agent-browser install` 无版本参数）⇒ 钉住它，Chrome 层才稳定。
ARG AGENT_BROWSER_SPEC=agent-browser@0.27.0
ARG BUN_SPEC=bun@1.4.3
# bun：omo 官方安装器（bunx oh-my-openagent install）的运行依赖，仅构建期需要。
RUN npm i -g "${OPENCODE_CLI_SPEC}" "${AGENT_BROWSER_SPEC}" "${BUN_SPEC}" && \
    echo "opencode CLI installed: $(opencode --version)" && \
    echo "agent-browser installed: $(agent-browser --version)" && \
    echo "bun installed: $(bun --version)"
# 系统依赖：git 工具链 + Agent 常用命令 + Chrome 运行库
# 说明：git/openssh-client 为 git 工具链路保留；python3/pip3（Agent 跑脚本/数据分析）、
# curl（HTTP 请求）、jq（JSON 处理）、bash（Agent 脚本常依赖 bash）、wget（下载）、
# ca-certificates（HTTPS）。Chrome 的 30+ lib 由下一步 `agent-browser install --with-deps` 补齐，
# 此处只装 worker 本身需要的最小集，避免重复。
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git openssh-client \
      python3 python3-pip curl jq bash wget ca-certificates procps \
      fonts-noto-cjk fonts-noto-color-emoji fonts-liberation fontconfig \
      fonts-noto fonts-dejavu-core fonts-freefont-ttf fonts-unifont 2>/dev/null || \
      apt-get install -y --no-install-recommends \
        fonts-noto-cjk fonts-noto-color-emoji fonts-liberation fontconfig \
        fonts-noto fonts-dejavu-core fonts-freefont-ttf 2>/dev/null || \
      apt-get install -y --no-install-recommends \
        fonts-noto-cjk fonts-noto-color-emoji fonts-liberation fontconfig 2>/dev/null || true && \
    rm -rf /var/lib/apt/lists/* && fc-cache -f || true

# agent-browser 浏览器本体 + Chrome
# x64: Chrome for Testing 有预编译包，直接用 --with-deps
# ARM64: Chrome for Testing 无 Linux ARM64 包，需改用系统 chromium（debian 包名 chromium）
RUN set -e; \
    if agent-browser install --with-deps; then \
      echo "agent-browser: Chrome for Testing installed"; \
    else \
      echo "agent-browser: Chrome for Testing failed (likely ARM64), fallback to apt chromium"; \
      apt-get update && apt-get install -y --no-install-recommends chromium chromium-driver 2>/dev/null || apt-get install -y --no-install-recommends chromium-browser chromium-chromedriver 2>/dev/null || apt-get install -y --no-install-recommends chromium 2>/dev/null || true; \
      rm -rf /var/lib/apt/lists/*; \
    fi; \
    # 兼容系统 chromium 路径：优先 /usr/bin/chromium，其次 /usr/bin/chromium-browser
    if [ -x /usr/bin/chromium ]; then echo "chromium found at /usr/bin/chromium"; \
    elif [ -x /usr/bin/chromium-browser ]; then ln -sf /usr/bin/chromium-browser /usr/bin/chromium && echo "linked chromium-browser -> chromium"; \
    fi

# 验证安装（doctor 会检查 Chrome/daemon/config，失败不阻断构建，仅告警）
RUN agent-browser --version && agent-browser doctor --offline --quick || true; \
    if [ -x /usr/bin/chromium ]; then chromium --version || chromium-browser --version || true; fi

# 顺序说明：**易变的小步骤放最后**。OMO 走 `@latest` 的历史版本会频繁发版，若排在上面
# 的 apt / Chrome 大层之前，每次发版都会把 GB 级层一起作废 ⇒ 集群全量重拉。
# oh-my-openagent（OmO）：官方 opencode 编排插件，11 个 agent + 生命周期 hook + 内置 MCP。
# 用**官方安装器**装（README 明确要求走 install，会做订阅检测/模型映射/配置迁移）：
#   非交互参数：--no-tui --skip-auth（容器内无浏览器/无 OAuth）
#   所有 provider 显式 no —— 模型此时不由安装器决定，改由 vteam 的 omo 配置页统一指定
#   （默认全部指向 opencode 免费模型，见 worker 侧 writeOmoConfig）。
# 安装器把插件注册进 $HOME/.config/opencode/opencode.json；真正的 opencode 运行时
# 工作目录是 /data/vteam-worker，其 opencode.json 由 worker 注入器维护（含本插件条目）。
# **必须钉版本**（同上的理由）：OMO 发版频繁，`@latest` 会让**它之后的每一层**都失效；
# 本块已挪到 apt/Chrome 之后，所以 OMO 升级只影响这一小层。
# 升级 OMO 时改这一处（并跑一遍 worker 契约测试）。
ARG OMO_INSTALL_SPEC=oh-my-openagent@5.1.43
# 交叉构建兜底：amd64 在 arm64 宿主经 qemu 模拟时 Bun 会 abort（qemu 已知限制），
# 此时直接落盘与安装器等价的插件注册（opencode.json/tui.json 内容一致，运行期由
# opencode 自行从 npm 解析该插件，与架构无关）。
RUN set -e; \
    if bunx "${OMO_INSTALL_SPEC}" install --no-tui --platform=opencode --skip-auth \
         --claude=no --openai=no --gemini=no --copilot=no --opencode-zen=no \
         --zai-coding-plan=no --opencode-go=no --kimi-for-coding=no \
         --bailian-coding-plan=no --minimax-cn-coding-plan=no --minimax-coding-plan=no \
         --vercel-ai-gateway=no > /tmp/omo-install.log 2>&1; then \
      echo "omo installed via bunx installer"; tail -20 /tmp/omo-install.log; \
    else \
      echo "bunx installer failed (emulated build?) -> writing plugin registration directly"; \
      mkdir -p /root/.config/opencode; \
      printf '{\n  "plugin": [\n    "%s"\n  ]\n}\n' "${OMO_INSTALL_SPEC}" \
        | tee /root/.config/opencode/opencode.json > /root/.config/opencode/tui.json; \
    fi; \
    test -f /root/.config/opencode/opencode.json; \
    echo "omo plugin registered:"; cat /root/.config/opencode/opencode.json; \
    OMO_VER="$(npm view "${OMO_INSTALL_SPEC}" version 2>/dev/null || true)"; \
    if [ -z "${OMO_VER}" ]; then OMO_VER="$(bunx "${OMO_INSTALL_SPEC}" --version 2>/dev/null | tail -1 || true)"; fi; \
    [ -n "${OMO_VER}" ] || OMO_VER=unknown; \
    # 能力标记：运行期据此判断"本镜像是否内置 OmO"，决定是否展示/允许开启开关。
    # 写在镜像里（不是数据卷）——没有内置 OmO 的镜像就不会有这个文件。
    # "v2" 字段 = 内置 OmO 是否具备 **v2 形态入口**（导出 {id, setup}）。
    # 当前安装器装出的是 **v1 形态**（导出 {server}）⇒ v2 上不会运行 ⇒ 注入器据此
    # **不注册** OmO 条目（注册了也只会静默失败：plugins 是合法键，不产生归一化诊断）。
    # 只有换成 v2 形态入口的 OmO 后才可改成 true（改前先跑一遍 worker 契约测试）。
    printf '{"bundled":true,"v2":false,"spec":"%s","version":"%s"}' "${OMO_INSTALL_SPEC}" "${OMO_VER}" \
      > /opt/omo-bundled.json; \
    echo "omo capability marker: $(cat /opt/omo-bundled.json)"

# 运行时代码区（与持久化卷 /data/vteam-worker 分离，避免卷遮挡代码）
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules

# D2 网络拓扑：serve 绑定 0.0.0.0（本地默认 127.0.0.1 铁律，容器内必须覆盖为 0.0.0.0）；
# WORKER_ADVERTISE_HOST 公布给 server（compose 网络服务名 http://worker）。
# X_WORKER_TOKEN 运行时必填（不固化在镜像内），以下均可由 compose / docker run 覆盖。
# 代码版本注入（worker 自更新机制的容器路径）：构建时
#   docker build --build-arg CODE_VERSION=<git short SHA> ./worker
# 转为运行期 env WORKER_CODE_VERSION；运行期 env（compose -e / chart env）仍可覆盖。
# 说明：本 Dockerfile 直接由 src 经 tsc 编译（不经 scripts/pack-worker.sh），镜像内
# dist 无 version.js 文件戳，因此 env 是容器路径的唯一版本来源；未传 ARG 时用显式
# 占位值而非空串，避免「看起来注入成功实则回落 dev」。
# 运行时优先级见 worker/src/code-version.ts：env WORKER_CODE_VERSION > dist/version.js > 'dev'。
ARG CODE_VERSION=container-unstamped
ENV WORKER_CODE_VERSION=${CODE_VERSION}
ENV OPENCODE_SERVE_HOSTNAME=0.0.0.0
# serve 端口默认固定 18080（与安装向导 `docker run -p 18080:18080` 对齐，容器重启端口不变）；
# compose / k8s 仍可显式覆盖（compose=4000，chart 由 worker.env.servePort 下发）。
ENV OPENCODE_SERVE_PORT=18080
ENV WORKER_ADVERTISE_HOST=http://worker
ENV SERVER_URL=http://server:3000
ENV WORKER_ID=w_keta-worker
# agent-browser 容器内默认参数（--no-sandbox 为容器必开；--disable-gpu 无 GPU 环境必开）
ENV AGENT_BROWSER_ARGS=--no-sandbox,--disable-gpu
# 可选：stream/dashboard 端口（默认 OS 随机，此处不固定，避免多实例冲突）
# ENV AGENT_BROWSER_STREAM_PORT=9223

CMD ["node", "dist/index.js"]
