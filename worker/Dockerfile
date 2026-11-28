# worker 镜像（Phase 5 T3，D4 Oracle 实测方案；2026-08 agent-browser 集成版）。
# 双阶段：build（TS 编译）→ runner（全局安装 opencode CLI + agent-browser + 运行 dist）。
# opencode CLI = npm 包 @opencode/cli（**锁版本** @opencode/cli@2.3.2，见下方 OPENCODE_CLI_SPEC）。
# agent-browser = Vercel / vercel-labs/agent-browser（Rust + Chrome CDP，给 opencode Agent 补浏览器能力）。
#
# 基座说明：原 node:22-alpine (musl) 跑不了 Chrome(glibc)，切到 debian bookworm-slim；
# Chrome 系统依赖由独立 apt 层显式安装（`--with-deps` 在无 sudo 的构建环境不可靠，见下）。

# 基础镜像可覆盖：CI 在拉不到内网镜像源时传 --build-arg NODE_IMAGE=docker.io/library/node:22-bookworm-slim
ARG NODE_IMAGE=docker.ketaops.cc/library/node:22-bookworm-slim

# 包源可覆盖（**构建位置决定该用哪个源**）：
#   · 国内构建（内网/本地）：默认阿里云 apt + npmmirror npm —— 快；
#   · 海外 CI runner（GitHub Actions）：必须传空串走官方源 —— 阿里云从海外拉
#     deb 包实测极慢（2026-11-25 v1.7.2 发布：worker 两个架构卡在
#     `mirrors.aliyun.com` 下载 120MB 依赖 17+ 分钟无进展，最终超时取消）。
# 用法：--build-arg APT_MIRROR= --build-arg NPM_REGISTRY=https://registry.npmjs.org
ARG APT_MIRROR=https://mirrors.aliyun.com
ARG NPM_REGISTRY=https://registry.npmmirror.com

# ---- 阶段 1：build ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_REGISTRY
RUN npm config set registry ${NPM_REGISTRY} && npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- 阶段 2：runner ----
FROM ${NODE_IMAGE}
# ARG 作用域按阶段隔离：runner 阶段必须重新声明才能用（否则为空串 → 静默走官方源）。
ARG APT_MIRROR
ARG NPM_REGISTRY
# 包源：APT_MIRROR 为空则保持官方源（海外 CI runner 用），非空则替换为镜像源。
# 注意 `set -e` 与 `|| true` 的组合：debian.sources / sources.list 只存在其一。
RUN apt-get update && apt-get install -y ca-certificates && \
    if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s|http://deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s|http://deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list 2>/dev/null || true; \
      echo "apt mirror -> ${APT_MIRROR}"; \
    else \
      echo "apt mirror -> 官方源（未替换）"; \
    fi
# npm 源（同上：空则官方）
RUN npm config set registry ${NPM_REGISTRY}
# opencode CLI 全局安装（serve spawn 依赖，需在 PATH；npm 全局 bin 默认进 PATH）
# **锁版本**（计划 T1 / D2）：v1 的 npm 包 `opencode-ai` 已冻结在 1.19.3（不再发版），
# 永远到不了 v2；v2 换了包名 → `@opencode/cli`。不锁版本会让"镜像里跑的是哪一版"不可知，
# 而控制面调度器按 opencode 版本串精确过滤 worker（版本闸门必须先于 v2 worker 上线）。
# 复现/升级某次构建时覆盖：
#   --build-arg OPENCODE_CLI_SPEC=@opencode/cli@2.3.2
# 构建日志会打印实际装到的版本（下方 echo），便于事后追溯"这个镜像用的是哪版"。
#
# 2.0.32 → 2.3.2（2026-11-18 发布）实测结论（升级依据，勿凭版本号升级）：
# - **无端点移除**：对比仓库基线 docs/agent-platform/opencode-v2-contract-baseline/openapi.json
#   （2.0.28 快照，142 ops）与线上最新 spec（173 ops）⇒ 移除 0 个、新增 31 个（多为
#   `experimental/*`），worker 用到的 9 个端点（/api/{agent,info,integration,location/reload,
#   mcp,model,provider,session,skill}）全部保留；
# - **无响应形态变化**：上述端点的 200 JSON schema 与基线逐字相同（含 `{location,data}`
#   包装形态）——这是最隐蔽的破坏点，已逐端点比对；
# - **系统库依赖未变**：2.3.2 与 2.0.32 的 linux-arm64 二进制动态依赖同为
#   libc/libm/libpthread/libdl/librt/libgcc_s/libstdc++ ⇒ 镜像现有 apt 包已够，无需新增；
# - 二进制体积 207MB → 248MB（镜像会变大，属预期）。
#
# 锁版语义不变：worker 上报**规范化 semver**（`2.3.2`），控制面按精确串过滤 worker，
# 故 worker/src/runtime/opencode-version.ts 的 REQUIRED_OPENCODE_CLI_SPEC 必须与这里同步
# （有单测钉死两者一致性，见 opencode-version.spec.ts）。
ARG OPENCODE_CLI_SPEC=@opencode/cli@2.3.2
# **必须钉版本**：`agent-browser` 若不带版本，上游每次发版都会让这一层及**其后所有层**
# 失效（v1.1.1→v1.2.0 实测：基础镜像 tag 浮动 + 未钉版本 ⇒ 6 个构建 job 的缓存命中数为 0，
# 镜像层全变 ⇒ 集群每次发布都要整包重拉）。`agent-browser` 的版本同时决定它下载的
# Chrome for Testing 版本（`agent-browser install` 无版本参数）⇒ 钉住它，Chrome 层才稳定。
# 0.33.1 是首个带「默认 1h daemon idle timeout」的版本（#1605）：agent 从不
# 显式 close 时，daemon + Chrome 树空闲 1h 后被回收（孤儿进程泄漏 backstop）。
# --restore (v0.31.0) 一并启用，保 cookies/localStorage 登录态；注意它**不保
# 打开的 tabs**（实测各版本均如此），但 agent 命令间隔远小于 1h，正常执行不受
# 影响。worker shim 注入 --restore <scope>，见 src/browser/browser-tools.ts。
ARG AGENT_BROWSER_SPEC=agent-browser@0.33.1
RUN set -e; \
    npm i -g "${OPENCODE_CLI_SPEC}" "${AGENT_BROWSER_SPEC}" && \
    echo "opencode CLI installed: $(opencode --version)" && \
    echo "agent-browser installed: $(agent-browser --version)" && \
    # 镜像瘦身（2026-11-28）：npm 全局安装的 tarball 缓存留在 /root/.npm（实测 630MB），
    # 必须在**同一层**清掉——放到后续层删除不会缩小总层数与总体积。
    npm cache clean --force && \
    # @opencode/cli 的 optionalDependencies 会把当前架构的 glibc/baseline/musl 四种
    # 平台二进制全装进来（x64 实测 4×242MB），但 postinstall 在构建期就选定了其中一个
    # 并硬链到 bin/opencode.exe，运行期不会再用其余变体。只保留当前架构的 glibc 包。
    CLI_MOD=/usr/local/lib/node_modules/@opencode/cli/node_modules/@opencode; \
    ARCH="$(uname -m)"; \
    if [ "$ARCH" = "x86_64" ]; then KEEP="cli-linux-x64"; else KEEP="cli-linux-arm64"; fi; \
    for d in "$CLI_MOD"/cli-linux-*; do \
      [ -d "$d" ] || continue; \
      [ "$(basename "$d")" = "$KEEP" ] || rm -rf "$d"; \
    done; \
    echo "opencode platform packages kept: $(ls "$CLI_MOD")"
# 系统依赖：git 工具链 + Agent 常用命令 + Chrome 运行库
# 说明：git/openssh-client 为 git 工具链路保留；python3/pip3（Agent 跑脚本/数据分析）、
# curl（HTTP 请求）、jq（JSON 处理）、bash（Agent 脚本常依赖 bash）、wget（下载）、
# ca-certificates（HTTPS）；unzip/zip/xz-utils（多附件放宽格式后，用户可发压缩包，
# Agent 需能在执行目录自行解压——zip/tar.gz/xz 均有命令行工具可用，python3 亦可兜底）。
# Chrome 的 30+ 运行库在下一个独立层显式安装（不用 `agent-browser install --with-deps`：
# 它内部走 `sudo apt-get`，镜像里没有 sudo ⇒ 构建期只下载 Chrome、不装系统库，
# 运行期表现为 `error while loading shared libraries`；2026-11-10 线上实测缺 24 个库）。
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git openssh-client \
      python3 python3-pip curl jq bash wget ca-certificates procps \
      unzip zip xz-utils \
      fonts-noto-cjk fonts-noto-color-emoji fonts-liberation fontconfig \
      fonts-noto fonts-dejavu-core fonts-freefont-ttf fonts-unifont 2>/dev/null || \
      apt-get install -y --no-install-recommends \
        fonts-noto-cjk fonts-noto-color-emoji fonts-liberation fontconfig \
        fonts-noto fonts-dejavu-core fonts-freefont-ttf 2>/dev/null || \
      apt-get install -y --no-install-recommends \
        fonts-noto-cjk fonts-noto-color-emoji fonts-liberation fontconfig 2>/dev/null || true && \
    rm -rf /var/lib/apt/lists/* && fc-cache -f || true

# Chrome for Testing 运行库（显式安装，见上：不能依赖 `--with-deps`）。
# 包清单来自 agent-browser 的依赖列表 + ldd 实测缺失项；Debian bookworm 包名。
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libglib2.0-0 libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 \
      libxrandr2 libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 \
      libgtk-3-0 libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 \
      libcairo-gobject2 libcairo2 libgdk-pixbuf-2.0-0 libxrender1 \
      libasound2 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 libnspr4 \
      libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 \
      libxshmfence1 libgbm1 && \
    rm -rf /var/lib/apt/lists/*

# agent-browser 浏览器本体 + Chrome
# x64: Chrome for Testing 有预编译包，直接 `agent-browser install`（系统库已在上层装好）
# ARM64: Chrome for Testing 无 Linux ARM64 包，直接 apt chromium（不尝试下载 x64 Chrome：
#   既省 ~194MB 下载/重试时间，也避免 arm64 构建期误执行 x64 二进制）。
RUN set -e; \
    ARCH="$(uname -m)"; \
    if [ "$ARCH" = "x86_64" ]; then \
      if agent-browser install; then \
        echo "agent-browser: Chrome for Testing installed"; \
      else \
        echo "agent-browser: Chrome for Testing failed, fallback to apt chromium"; \
        apt-get update && ( apt-get install -y --no-install-recommends chromium chromium-driver 2>/dev/null || apt-get install -y --no-install-recommends chromium-browser chromium-chromedriver 2>/dev/null || apt-get install -y --no-install-recommends chromium 2>/dev/null || true ); \
        rm -rf /var/lib/apt/lists/*; \
      fi; \
    else \
      echo "agent-browser: $ARCH has no Chrome for Testing build; install apt chromium"; \
      apt-get update && ( apt-get install -y --no-install-recommends chromium chromium-driver 2>/dev/null || apt-get install -y --no-install-recommends chromium-browser chromium-chromedriver 2>/dev/null || apt-get install -y --no-install-recommends chromium 2>/dev/null || true ); \
      rm -rf /var/lib/apt/lists/*; \
    fi; \
    # 兼容系统 chromium 路径：优先 /usr/bin/chromium，其次 /usr/bin/chromium-browser
    if [ -x /usr/bin/chromium ]; then echo "chromium found at /usr/bin/chromium"; \
    elif [ -x /usr/bin/chromium-browser ]; then ln -sf /usr/bin/chromium-browser /usr/bin/chromium && echo "linked chromium-browser -> chromium"; \
    fi; \
    # 把 Chrome 移出 /root：k8s 的 worker-home PVC 挂在 /root，会遮住镜像里的浏览器；
    # 运行时由 worker-entrypoint.sh 把 /opt 下的 browsers 链回 /root/.agent-browser。
    if [ -d /root/.agent-browser/browsers ]; then \
      mkdir -p /opt/agent-browser && mv /root/.agent-browser/browsers /opt/agent-browser/browsers && \
      chmod -R a+rX /opt/agent-browser; \
    fi

# 构建期验收：Chrome/Chromium 必须真的能执行（缺系统库会在这里失败，而不是上线后才由 Agent 发现）。
RUN set -e; \
    agent-browser --version; \
    CHROME="$(ls -d /opt/agent-browser/browsers/chrome-*/chrome 2>/dev/null | head -1)"; \
    if [ -n "$CHROME" ]; then echo "verifying $CHROME"; "$CHROME" --version; \
    elif [ -x /usr/bin/chromium ]; then echo "verifying /usr/bin/chromium"; /usr/bin/chromium --version; \
    else echo "ERROR: no Chrome/Chromium binary installed" >&2; exit 1; fi

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

# ── PID1 reaper（僵尸进程修复，2026-11-10）──────────────────────────────────
# 症状（实测）：容器 PID1 = node dist/index.js 时，agent-browser/Chrome 的子进程
# 在父进程退出后会被 reparent 到 PID1；它们随后退出时 node 不会 wait()，形成
# `Z`（defunct）僵尸（PPID=1）。一次「打开→截图→关闭」稳定留下约 20 个，
# 且不会随 daemon 关闭而消失（RSS=0 但 PID 表占位，最终打满容器 pid cgroup）。
#
# 修复：用 tini 作为 PID1（--init 语义的镜像内等价物，不依赖编排层传 --init）：
# tini 会回收所有 reparent 到它的孤儿进程，僵尸被立即 reaped。compose 另加
# `init: true` 双保险；k8s/裸 docker run 只依赖本 ENTRYPOINT。
# 安装放**最后**（独立小层）：不弄脏前面 apt/chrome 大层缓存。
RUN apt-get update && \
    apt-get install -y --no-install-recommends tini && \
    rm -rf /var/lib/apt/lists/*

# 启动脚本：/root 被 k8s PVC 覆盖时把 /opt 下的 Chrome 链回 agent-browser 的 state dir，
# 然后 exec node（保持 tini 为 PID1，node 仍是唯一主进程）。
COPY docker/worker-entrypoint.sh /usr/local/bin/worker-entrypoint.sh
RUN chmod 755 /usr/local/bin/worker-entrypoint.sh

# 注意：ENTRYPOINT 只加 tini，命令仍是 CMD，`docker run <image> <cmd>` 仍可覆盖命令。
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/worker-entrypoint.sh"]
