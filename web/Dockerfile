# syntax=docker.ketaops.cc/docker/dockerfile:1

# ---------- build：web 依赖 + worker 发布包 + next build（standalone 产物） ----------
FROM docker.ketaops.cc/library/node:22-alpine AS build
WORKDIR /app
# 布局对齐仓库：web/ 与 worker/ 并存，pack-worker.sh 的 ROOT 推导不变
#（compose build context 已改为仓库根，见 docker-compose.yml web 服务）。
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web/ ./web/
# worker 发布包 → web/public/worker-src.tar.gz（install-worker.sh 一键安装下载；
# 复用 pack-worker.sh 单一来源，镜像构建即自动打包，无需任何手动前置步骤）
COPY worker ./worker
COPY scripts/pack-worker.sh ./scripts/pack-worker.sh
RUN chmod +x scripts/pack-worker.sh \
    && cd worker && npm ci \
    && cd .. && ./scripts/pack-worker.sh \
    && rm -rf worker scripts
# rewrites 代理目标在 build 时编译进 routes-manifest.json，运行时 ENV 无效，
# 必须在构建期通过 build ARG 注入（compose: args: API_PROXY_TARGET=http://server:3000）。
# 缺省值对齐 compose 网络内服务名 server（Next standalone 监听 $HOSTNAME 而非 127.0.0.1，
# 容器内 localhost:3000 ECONNREFUSED → 浏览器 fetch TypeError: Failed to fetch）：
# 即使构建时漏传 ARG，代理目标也指向正确后端而非容器自身。
ARG API_PROXY_TARGET=http://server:3000
ENV API_PROXY_TARGET=$API_PROXY_TARGET
WORKDIR /app/web
RUN npm run build

# ---------- runner：standalone 运行 ----------
FROM docker.ketaops.cc/library/node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# standalone 产物（server.js + 精简 node_modules）
COPY --from=build /app/web/.next/standalone ./
# 铁律：standalone 产物不含 .next/static 与 public，漏 COPY 则白屏
COPY --from=build /app/web/.next/static ./.next/static
COPY --from=build /app/web/public ./public
COPY --from=build /app/web/next.config.ts ./next.config.ts
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
