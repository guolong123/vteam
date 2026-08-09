# worker 镜像（Phase 5 T3，D4 Oracle 实测方案）。
# 双阶段：build（TS 编译）→ runner（全局安装 opencode CLI + 运行 dist）。
# opencode CLI = npm 包 opencode-ai@1.18.15（与宿主/SDK 版本一致，D4）。

# ---- 阶段 1：build ----
FROM docker.ketaops.cc/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- 阶段 2：runner ----
FROM docker.ketaops.cc/library/node:22-alpine
# opencode CLI 全局安装（serve spawn 依赖，需在 PATH；npm 全局 bin 默认进 PATH）
RUN npm i -g opencode-ai@1.18.15

# git 工具注入落点（.opencode/tools/，T5）+ serve 工作目录；与 config WORK_DIR 默认一致
WORKDIR /tmp/keta-worker

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

CMD ["node", "dist/index.js"]
