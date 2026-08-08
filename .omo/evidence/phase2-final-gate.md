# Phase 2 最终门禁验证（T20 Final Gate）

日期：2026-08-07
执行人：Sisyphus-Junior（验证任务，仅验证不修复）

## 1. 门禁结果

| 门禁项 | 命令 | 结果 |
|--------|------|------|
| server 单元测试 | `npm run test -- --no-cache`（`jest --runInBand --no-cache`） | ✅ **17 suites / 171 tests 全过**（0 fail，9.3s） |
| server 构建 | `npm run build`（`nest build`） | ✅ exit 0 |
| web 构建 | `rm -rf .next && npm run build` | ✅ exit 0（14 路由，含 /board /tasks/[id] /messages/[id] /projects /agents /skills /users /workers） |
| 服务健康 | `curl http://localhost:3000/api/v1/health` | ✅ HTTP 200，body `{"status":"ok","info":{},"error":{},"details":{}}` |

> 注意：test 使用 `--no-cache` 规避 jest 缓存假象（learnings 已记录）；web build 前删除 `.next` 规避污染。

## 2. Phase 3+ 泄漏检查清单

### 2.1 artifacts 表写入（Phase 3 ArtifactsModule）

- `prisma.artifact` / `artifactVersion` 在 server/src 全量 grep：**0 命中**（排除 .spec.ts 后）
- `prisma/schema.prisma` 存在 `model Artifact`（L234）/ `model ArtifactVersion`（L251）——**表定义，允许**
- `backgroundDocs` 仅作为 task 表 `JsonValue` 写入：`tasks.service.ts:149` `backgroundDocs: (dto.backgroundDocs ?? []) as Prisma.InputJsonValue`，DTO 定义于 `create-task.dto.ts:54` ——**符合 Phase 2 允许范围**
- ✅ 结论：无泄漏

### 2.2 Agent CRUD（Phase 3：POST/PATCH/DELETE /agents）

- `src/agents/agents.controller.ts`：仅 `@Controller('agents')` + `@Get()` findAll ——**只允许 GET /agents**
- ✅ 结论：无泄漏

### 2.3 Worker / 真实分派（Phase 4）

- `prisma.worker` 实际调用：**0 命中**
- `WorkerClient` / opencode SDK：**0 命中**（仅 2 处注释提及 Phase 4 计划：`chat/mock-dispatcher.ts:103`、`chat/chat.module.ts:16`，属设计注释非实现）
- `schema.prisma` 有 `model Worker`（L365）——表定义，允许
- web 端 `/workers`、`/agents` 路由为 `EmptyState` 占位页（注释标注 Task 13/14 实现），无任何逻辑
- ✅ 结论：无泄漏

### 2.4 git 凭证（Phase 4：credentials/repo_grants）

- `schema.prisma`：**无** Credential / RepoGrant 表定义
- `prisma.credential` / `repoGrant` 在 server/src：**0 命中**
- `availableModels`：**0 命中**
- ✅ 结论：无泄漏

### 2.5 web 侧泛查

- grep `artifact|backgroundDocs|worker|credential|availableModels`（web/src）：仅命中导航/菜单文案（`nav-dock.tsx`、`app-shell.tsx` 的 "Worker 节点" 标签）与占位路由页
- ✅ 结论：无功能泄漏，仅为 Phase 4 预留导航 UI

## 3. 事件名点号契约检查

- `task_status_changed`（下划线变体）：server/src + web 全量 grep = **0 命中**
- `task.status.changed`（点号变体）：正确定义于 `src/common/constants/event.constants.ts:12` `TASK_STATUS_CHANGED: 'task.status.changed'`，并在 `tasks.service.ts`（L124/L202）广播使用
- ✅ 结论：事件名契约符合 09 篇 §4.2

## 4. 汇总

- 全部门禁 PASS：test 171/171、server build、web build、health 200
- Phase 3/4 泄漏检查：5 类全部无泄漏（仅 schema 定义与占位/注释，属允许范围）
- 事件名：下划线变体 0 泄漏

**判定：Phase 2 实现收口，可进入 F1-F4 终审。**
