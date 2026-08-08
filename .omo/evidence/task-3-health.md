# Task 3 - Health 端点验证

## 环境
- 目录：`/data/git-project/aiagents/server/`
- 框架：NestJS 10 (`@nestjs/core ^10.0.0`) + TypeScript 5
- 依赖：@nestjs/config ^4.0.4, @nestjs/jwt ^11.0.2, @nestjs/passport ^11.0.5, passport ^0.7.0, passport-jwt ^4.0.1, bcrypt ^6.0.0, @nestjs/swagger ^7.4.2, @nestjs/terminus ^11.1.1, pino ^10.3.1, pino-http ^11.0.0

## 全局前缀
`app.setGlobalPrefix('api/v1')` — 对齐 09 篇 API 契约，所有路由挂载于 `/api/v1`。

## Swagger 文档
`SwaggerModule.setup('api/v1/docs', app, document)` — 挂载于 `/api/v1/docs`，返回 200。

## 验证命令
```
npm run build   # EXIT=0
```

## health 响应（curl localhost:3001/api/v1/health）
```
{"status":"ok","info":{},"error":{},"details":{}}
HTTP_CODE=200
```

## 启动日志（路由确认）
```
[Nest] ... [RouterExplorer] Mapped {/api/v1/health, GET} route
[Nest] ... [Bootstrap] 🚀 Server running on http://localhost:3001/api/v1
```

## 模块骨架（Phase 1）
- `src/auth/auth.module.ts` (AuthModule)
- `src/users/users.module.ts` (UsersModule)
- `src/projects/projects.module.ts` (ProjectsModule)
- `src/realtime/realtime.module.ts` (RealtimeModule)
- `src/health/health.module.ts` + `health.controller.ts` (HealthModule, @nestjs/terminus)

业务逻辑留待 Task 15-19 实现，本轮仅建模块骨架。