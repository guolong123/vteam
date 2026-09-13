# worker 镜像（Phase 5 T3，D4 Oracle 实测方案；2026-08 agent-browser 集成版）。
# 双阶段：build（TS 编译）→ runner（全局安装 opencode CLI + agent-browser + 运行 dist）。
# opencode CLI = npm 包 opencode-ai（**不锁版本**，每次构建取最新；见下方 OPENCODE_CLI_SPEC）。
# agent-browser = Vercel / vercel-labs/agent-browser（Rust + Chrome CDP，给 opencode Agent 补浏览器能力）。
#
# 基座说明：原 node:22-alpine (musl) 跑不了 Chrome(glibc)，切到 debian bookworm-slim；
# Chrome 依赖由 `agent-browser install --with-deps` 自动补齐（apt）。

# ---- 阶段 1：build ----
FROM docker.ketaops.cc/library/node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com && npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- 阶段 2：runner ----
FROM docker.ketaops.cc/library/node:22-bookworm-slim
# 国内源加速（apt：阿里云镜像）
RUN apt-get update && apt-get install -y ca-certificates && \
    sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null || true
# 国内源加速（npm）
RUN npm config set registry https://registry.npmmirror.com
# opencode CLI 全局安装（serve spawn 依赖，需在 PATH；npm 全局 bin 默认进 PATH）
# 不锁版本：每次构建取 npm registry 上的最新版。如需复现某次构建，构建时覆盖
#   --build-arg OPENCODE_CLI_SPEC=opencode-ai@1.18.30
# 构建日志会打印实际装到的版本（下方 echo），便于事后追溯"这个镜像用的是哪版"。
ARG OPENCODE_CLI_SPEC=opencode-ai
# bun：omo 官方安装器（bunx oh-my-openagent install）的运行依赖，仅构建期需要。
RUN npm i -g "${OPENCODE_CLI_SPEC}" agent-browser bun && \
    echo "opencode CLI installed: $(opencode --version)" && \
    echo "bun installed: $(bun --version)"
# oh-my-openagent（OmO）：官方 opencode 编排插件，11 个 agent + 生命周期 hook + 内置 MCP。
# 用**官方安装器**装（README 明确要求走 install，会做订阅检测/模型映射/配置迁移）：
#   非交互参数：--no-tui --skip-auth（容器内无浏览器/无 OAuth）
#   所有 provider 显式 no —— 模型此时不由安装器决定，改由 vteam 的 omo 配置页统一指定
#   （默认全部指向 opencode 免费模型，见 worker 侧 writeOmoConfig）。
# 安装器把插件注册进 $HOME/.config/opencode/opencode.json；真正的 opencode 运行时
# 工作目录是 /data/vteam-worker，其 opencode.json 由 worker 注入器维护（含本插件条目）。
ARG OMO_INSTALL_SPEC=oh-my-openagent@latest
RUN bunx "${OMO_INSTALL_SPEC}" install --no-tui --platform=opencode --skip-auth \
      --claude=no --openai=no --gemini=no --copilot=no --opencode-zen=no \
      --zai-coding-plan=no --opencode-go=no --kimi-for-coding=no \
      --bailian-coding-plan=no --minimax-cn-coding-plan=no --minimax-coding-plan=no \
      --vercel-ai-gateway=no 2>&1 | tail -20 && \
    test -f /root/.config/opencode/opencode.json && \
    echo "omo plugin registered by installer:" && cat /root/.config/opencode/opencode.json && \
    # 能力标记：运行期据此判断"本镜像是否内置 OmO"，决定是否展示/允许开启开关。
    # 写在镜像里（不是数据卷）——没有内置 OmO 的镜像就不会有这个文件。
    OMO_VER="$(bunx "${OMO_INSTALL_SPEC}" --version 2>/dev/null | tail -1 || echo unknown)" && \
    printf '{"bundled":true,"spec":"%s","version":"%s"}' "${OMO_INSTALL_SPEC}" "${OMO_VER}" \
      > /opt/omo-bundled.json && \
    echo "omo capability marker: $(cat /opt/omo-bundled.json)"

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

# 运行时代码区（与持久化卷 /data/vteam-worker 分离，避免卷遮挡代码）
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules

# D2 网络拓扑：serve 绑定 0.0.0.0（本地默认 127.0.0.1 铁律，容器内必须覆盖为 0.0.0.0）；
# WORKER_ADVERTISE_HOST 公布给 server（compose 网络服务名 http://worker）。
# X_WORKER_TOKEN 运行时必填（不固化在镜像内），以下均可由 compose / docker run 覆盖。
ENV OPENCODE_SERVE_HOSTNAME=0.0.0.0
ENV WORKER_ADVERTISE_HOST=http://worker
ENV SERVER_URL=http://server:3000
ENV WORKER_ID=w_keta-worker
# agent-browser 容器内默认参数（--no-sandbox 为容器必开；--disable-gpu 无 GPU 环境必开）
ENV AGENT_BROWSER_ARGS=--no-sandbox,--disable-gpu
# 可选：stream/dashboard 端口（默认 OS 随机，此处不固定，避免多实例冲突）
# ENV AGENT_BROWSER_STREAM_PORT=9223

CMD ["node", "dist/index.js"]
