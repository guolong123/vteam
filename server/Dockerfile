# syntax=docker.ketaops.cc/docker/dockerfile:1

# ---------- deps：安装全量依赖（含 devDeps，供 nest build / prisma generate） ----------
FROM docker.ketaops.cc/library/node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- build：编译 NestJS 产物 + 生成 Prisma Client ----------
FROM docker.ketaops.cc/library/node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# @prisma/client 运行时需要生成的 client（Prisma 6 无自动 postinstall generate）
RUN npx prisma generate
RUN npm run build

# ---------- runner：生产运行（标准 NestJS 进程，非 standalone） ----------
FROM docker.ketaops.cc/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# prisma schema 供 migrate（T2/compose 执行）与客户端引用
COPY --from=build /app/prisma ./prisma
EXPOSE 3000
CMD ["node", "dist/src/main"]
