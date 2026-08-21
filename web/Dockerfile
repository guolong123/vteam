# syntax=docker.ketaops.cc/docker/dockerfile:1

# ---------- build：web 依赖 + worker 发布包 + next build（standalone 产物） ----------
FROM docker.ketaops.cc/library/node:22-alpine AS build
WORKDIR /app
# 布局对齐仓库：web/ 与 worker/ 并存，pack-worker.sh 的 ROOT 推导不变
#（compose build context 已改为仓库根，见 docker-compose.yml web 服务）。
COPY web/package.json web/package-lock.json ./web/
COPY web/scripts ./web/scripts
# docs-site-rebuild：proto-shared 已迁至 web/src/features/docs-site/proto-shared，
# sync-runtime.mjs 已自带 mkdirSync + existsSync 兜底，无需预先 COPY；整树仍由下方 COPY web/ ./web/ 覆盖。
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
# 运行时代理目标由部署方以环境变量注入（middleware.ts 运行时读取），
# 不再构建期编译——同一镜像可部署 compose（http://server:3000）与
# k8s（http://vteam-server:3000）等任意环境，无需按环境重建。
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
