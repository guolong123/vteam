# syntax=docker/dockerfile:1

# ---------- build：npm ci + next build（standalone 产物） ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# rewrites 代理目标在 build 时编译进 routes-manifest.json，运行时 ENV 无效，
# 必须在构建期通过 build ARG 注入（compose: args: API_PROXY_TARGET=http://server:3000）
ARG API_PROXY_TARGET=http://localhost:3000
ENV API_PROXY_TARGET=$API_PROXY_TARGET
RUN npm run build

# ---------- runner：standalone 运行 ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# standalone 产物（server.js + 精简 node_modules）
COPY --from=build /app/.next/standalone ./
# 铁律：standalone 产物不含 .next/static 与 public，漏 COPY 则白屏
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./next.config.ts
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
