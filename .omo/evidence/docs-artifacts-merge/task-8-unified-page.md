# T8 — 统一文档站页 `/docs`（团队级外壳，DB-only）证据

## 1. 变更文件（本次提交内，仅 2 项）

- `web/app/(main)/docs/page.tsx` — 新建（统一页全部逻辑，单文件 ~1100 行）。
- `.omo/evidence/docs-artifacts-merge/task-8-unified-page.md` — 本证据。
- 截图：`.omo/evidence/docs-artifacts-merge/img/t8-{team-picker,list,chips,viewer,version-switch,missing-doc,after-delete}.png`（7 张，随证据提交）。
- 未动：`tokens.ts`、`/artifacts` 页、`/docs/[taskId]`、session/board/tasks 页、hooks、docs-markdown、无新依赖。

## 2. 实现要点（供 T9/T10 消费，接口冻结）

- 默认导出 `DocsUnifiedPage`（`web/app/(main)/docs/page.tsx`）：T10 薄别名直接
  `import DocsUnifiedPage from "@/app/(main)/docs/page"`（或相对路径）零 prop 渲染；
  别名页需预填 taskId 时外层包一层读 `params.taskId` 再渲染（本组件从 `?taskId=` 读）。
- 内容区接缝 `DocContentView({ version, type, title })`（本文件内，T9 在此扩展/替换为富矩阵）：
  今日行为 `text → 纯文本 <pre>` / `doc|file → 下载卡（文件名/大小/类型徽章+下载链接）` /
  不可访问引用 → 纯文本降级；容器 `data-testid="docs-content-view"` + `data-render=text-fallback|file-card|inaccessible`。
- 查询契约（T9 直接复用）：`["artifact-detail", artifactId] → GET /artifacts/:id`，
  `["artifact-version", artifactId, version] → GET /artifacts/:id/versions/:version`；
  聚合查询 `["team-artifacts", teamId, taskKey, typeKey, categoryKey, acceptedKey] → GET /teams/:id/artifacts`。
- testid 契约：`docs-shell / docs-team-picker / docs-team-option[data-team-id] / docs-filter-bar /
  team-filter-select / task-filter-select / category-filter-option[data-key,data-active] /
  type-filter-option[data-key,data-active] / accepted-filter-option[data-key,data-active] /
  docs-tree / docs-tree-item[data-doc-id,data-artifact-id,data-active] / docs-viewer-empty /
  docs-doc-missing / artifact-viewer / artifact-version-switch[data-version,data-active] /
  artifact-version-timeline / docs-content-view[data-render] / docs-delete-button /
  docs-category-badge[data-category] / docs-file-link / docs-file-download / docs-file-badge /
  docs-title / docs-loading / docs-error / docs-retry`。
- `?doc=` 解析：`docIdFor(a.title, a.id, items.map({id,title}))`（与 session 页同输入）；未知 → `docs-doc-missing` 空态。
- 分类 chips：`全部`(local) + `ARTIFACT_CATEGORIES` import + `未分类`(local)；`uncategorized` 无服务端参数 → 单查询后前端 `category==null` 过滤。
- 文档树平铺依据见 §5（API 无 parent/children 字段）。

## 3. 命令 + 结果

- `npx tsc --noEmit -p tsconfig.json`（web/）：退出 0。
- `npx eslint "app/(main)/docs/page.tsx"`：0 errors 0 warnings（中途 2 unused 警告已通过删除死组件清零）。
- 门 1：`grep -rn 'tasks/\${.*}/artifacts\|tasks/.*artifacts' 'web/app/(main)/docs' --include='*.tsx'` → 0 命中（exit 1）。
- 门 2：`grep -rn 'docs-site.*registry\|/prd/' 'web/app/(main)/docs'` → 0 命中（exit 1）。
- 容器内 `npx tsc -p tsconfig.build.json --noEmit`（HEAD 全量，见 §6）：2 errors，
  均为 `src/platform-mcp/platform-mcp.service.ts` 他波合并码问题（1670 fromName / 1942 TASK_AGENT_COMPLETION_FORBIDDEN），与本 todo 无关；dist 正常 emit。
- Playwright（临时 spec，跑后已删；正式用例归 T12）：`2 passed` —
  test1（picker→list→9 chips→viewer→missing-doc→console-clean）+ test2
  （scratch v1+v2→选中→v2 文本→点 v1→v1 文本+timeline→hover 删除→行消失→API 404→console-clean）。

## 4. Live 收据（容器补丁后，§6）

- `GET /teams/tm_0000000001/artifacts?pageSize=3` → 200，`total=13`，项含 `taskName`（T5 冻结形状一致）。
- `GET /teams/tm_0000000002/artifacts?category=<encoded>`（seed-admin 非成员）→
  `{"code":"PERMISSION_TEAM_NOT_MEMBER","message":"您不是该团队成员"}`（越权 403 口径正常）。
- `GET /tasks?teamId=tm_0000000001` → 200（任务下拉数据源正常）。
- 中文 query 须 URL 编码（T5 learning 重申；本页经 `api.get` 的 `URLSearchParams` 自动编码）。

## 5. parent 全空证明（平铺依据）

- 服务端 grep：`grep -rn 'parent|children' server/src/artifacts` → 0 命中（聚合/任务两端点均无层级字段）。
- Live 响应键集合（`tm_0000000001`，n=13，全量键并集）：

```text
KEYS= ['acceptedFlag', 'authorAgentId', 'category', 'createdAt', 'currentVersion', 'fileUrl', 'id', 'taskId', 'taskName', 'title', 'type', 'updatedAt']
parentKeys= []
nullCategory= 9
```

## 6. 容器补丁说明（live QA 前置，非 git 内容，可回滚）

- 背景：compose server 镜像早于 T5，`GET /teams/:id/artifacts` live 404（对照收据已在 T5 证据；本次复测同 404 后才动手）。
- 做法（零他人文件、可回滚）：`git worktree add /tmp/t8clean HEAD`（干净 HEAD，T1–T7 已合入）→
  容器内 `cp -r /app/dist /app/dist.bak-t8`（回滚点）→ `docker cp` HEAD 版 `server/src` + `tsconfig*.json` + `nest-cli.json` 进 `/app` →
  容器内 `npx prisma generate` + `npx nest build` → `docker restart aiagents-compose-server` → healthy。
- 回滚：`docker exec … mv /app/dist.bak-t8 /app/dist && docker restart …`，或终极 `docker compose up -d --force-recreate server`（镜像未动）。
- 遗留（有意保留，T12 正式重建镜像时覆盖）：`/app/dist.bak-t8`、`/app/src`、`/app/*.json` 构建输入；线上行为 = HEAD 已提交代码，无未提交内容。
- QA 后容器状态：healthy；`docker exec` 侧无 /tmp 残留需求（harness 文件均在 host /tmp，git 外）。

## 7. 截图（`.omo/evidence/docs-artifacts-merge/img/`，本地留存）

> 注：仓库 `.gitignore:39` 忽略 `.omo/evidence/**/*.png`，截图不入库（与既有证据一致）；
> 路径在工作区内可读，7 张全部落盘（`ls` 可验，每张 40–150KB 非空）。

- `t8-team-picker.png`（40KB，无 teamId 团队选择器）
- `t8-list.png`（筛选栏 + 平铺树 + 未选空态）
- `t8-chips.png`（未分类激活态）
- `t8-viewer.png`（版本查看器 + 纯文本兜底）
- `t8-version-switch.png`（切到 v1 后的 v1 文本 + timeline）
- `t8-missing-doc.png`（未知 ?doc= 空态）
- `t8-after-delete.png`（删除后列表）

## 8. 清理收据

- Scratch 行：UI 删除 → `GET /api/v1/artifacts/<id>` 404（spec 内断言通过）；live 无 `t8-qa-scratch-%` 残留（删除即清理，版本连带删）。
- 临时文件：`web/e2e/docs-t8-qa.spec.ts`、`web/e2e/t8-qa.config.ts`、`web/test-results/` 已删；
  `git worktree remove --force /tmp/t8clean` 已执行；`/tmp/t8_token.txt` 已删；
  host dev 服务器（`:3001`）已停。
- 注意：`web/.auth/user.json` 被 setup project 刷新（登录态文件，gitignored，不入库）；
  `.omo/evidence/phase5-t9-playwright.json` 被 reporter 改写（非本 todo 文件，不 stage）。

## 9. 风险与交接

- 风险低：单新文件 + 证据；零现有文件改动；容器补丁内容 = 已提交 HEAD，无脏树混入。
- T9：只改 `DocContentView` 内部 + `file-preview.tsx` 新文件（import 进本页接缝处）；勿动查询/testid。
- T10：`artifacts/page.tsx` 瘦身重定向 + `[taskId]` 别名 import 本组件；本页 testid 保持稳定。
- T12：正式镜像重建后重跑 §4 live 门 + 本页 happy 组（spec 模板见本证据 §3，断言可直接移植）。
