# Task 19 — OpenAPI 契约（Swagger 全端点）

## 目标
用 @nestjs/swagger 生成 OpenAPI 契约：全部已实现端点（auth/users/projects/health/realtime）带 DTO schema，对外暴露 Swagger UI + 契约 JSON，供前后端联调锚定。

## 说明
DTO 装饰器（@ApiProperty + class-validator）与控制器 @ApiTags/@ApiOperation 在前序 Task（15-18）已随模块落地，本任务补齐全局校验与契约导出验证。

## 改动
- `server/src/main.ts`：新增全局 `ValidationPipe`（whitelist + transform），使 class-validator 装饰器在运行时生效（对齐 09 篇 §2.1 VALIDATION_* 语义）。Swagger 配置（DocumentBuilder + SwaggerModule.setup at `api/v1/docs`）沿用既有代码。
- 契约 JSON 导出至 `.omo/evidence/api-contract.json`。

## 验证（curl localhost:3000/api/v1/docs-json）
- openapi: 3.0.0，title: AI Agents Platform API
- 端点路径（11 条）：
  - /api/v1（根）
  - /api/v1/auth/login /register /refresh /profile
  - /api/v1/users /users/{id} /users/{id}/status
  - /api/v1/projects
  - /api/v1/events（SSE）
  - /api/v1/health
- components.schemas：RegisterDto / LoginDto / RefreshDto / CreateProjectDto / UpdateUserStatusDto（均带 @ApiProperty）
- QueryProjectsDto 以 query parameters 形式展开（page/pageSize/status）
- POST /auth/register requestBody → `#/components/schemas/RegisterDto`

## Swagger UI
- `GET /api/v1/docs`（HTML UI）
- `GET /api/v1/docs-json`（OpenAPI JSON）

## 产物
- `.omo/evidence/api-contract.json`（前后端联调契约锚点）