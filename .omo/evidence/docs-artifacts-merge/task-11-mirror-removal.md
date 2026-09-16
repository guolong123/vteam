# Evidence — T11 删除镜像层与死端点 (task-11-mirror-removal)

- Plan: `.omo/plans/docs-artifacts-merge.md` todo 11 + 任务书 mandatory relocation
- Branch: `feat/docs-artifacts-merge` (HEAD 起点 `15d226b`)
- Date: 2026-09-16 (UTC)

## 1. 引用枚举 (LSP declined → grep 代替)

`lsp_find_references` 不可用（typescript server 未安装，用户此前已 decline；
按任务书 fallback 用 grep 全量枚举，未动用 explore/librarian 子代理）。
T11 前命中 `DocsMirrorService|syncTask|buildRegistry|readMirrorDoc|doSyncTask|rebuildAll`
的全部文件（`server/src`）：

| 文件 | 命中性质 | 处理 |
| --- | --- | --- |
| `docs-site/docs-mirror.service.ts` | 本体 | `git rm` 删除 |
| `docs-site/docs-mirror.service.spec.ts` | 本体 spec | `git rm` 删除 |
| `docs-site/docs-site.controller.ts` | import + `buildRegistry/readMirrorDoc/listPrototypes/readPrototype` 4 调用 | 删 registry/prd，原型改调新服务 |
| `docs-site/docs-site.controller.spec.ts` | registry/prd describes + mirror mock | 删两 describes，mock 换新服务 |
| `docs-site/docs-site.module.ts` | import/providers/exports | providers 换新服务，去 exports |
| `artifacts/artifacts.service.ts` | import + 构造器可选注入 + 4 处 `syncTask`（append/restore/archiveFile/remove） | 全删 |
| `artifacts/artifact-slug.ts:6` | 注释提及（T3 预告"T11 移除旧包装"） | 改写注释消 token（门禁要求，见 §5） |
| `artifacts/artifact-slug.spec.ts:41` | 注释提及 `buildRegistry` | 改写注释消 token（门禁要求，见 §5） |

未命中（已确认，无需处理）：`server/prisma/seed.ts`、全部 `server/scripts/`、
`server/src/platform-mcp/*`、`app.module.ts`（直引 `DocsSiteModule` 保留——模块本身仍提供原型端点）。
`artifacts.service.spec.ts:57` 用 3 参数构造（无 mirror mock），零改动。

## 2. 搬移记录（verbatim relocation）

- NEW `server/src/docs-site/prototypes.service.ts`：`@Injectable() PrototypesService`，
  构造器仅 `PrismaService`；`listPrototypes`/`readPrototype` 方法体与旧文件
  L236-392 逐字一致（含白名单正则、meta 正则、排序、`FileStorageService.readUploadedFile`
  静态调用、`Logger`）。唯一有意偏离 2 处（行为零影响，门禁要求）：
  1. `Logger(DocsMirrorService.name)` → `Logger(PrototypesService.name)`（类包装变化）；
  2. warn 字面 `[docs-mirror]` → `[prototypes]`（"零 `[docs-mirror]` 日志"验收要求；
     列表/来源/形状/顺序/meta 解析/auth 全部未动）。
- NEW `server/src/docs-site/prototypes.service.spec.ts`：T6 的
  `listPrototypes/readPrototype` describe 块（旧 spec L345-643）13 用例逐字搬移，
  断言一字未改；仅 import 路径更新 + 构造器改为 `new PrototypesService(prisma)`。
- 先行验证（删旧文件**之前**）：`npx jest src/docs-site/prototypes.service.spec.ts` →
  **13/13 green**。
- Controller：删 `registry()` + `prd()` 方法及 `@Get(':taskId/registry')` /
  `@Get(':taskId/prd/:file')` 路由；`Header`/`NotFoundException` 保留（原型方法仍用）；
  注入属性命名 `protoService`（`prototypes` 会与 `prototypes()` 方法名冲突导致
  TS2341，见 §6 gotcha）；`assertMember` 一字未动。
- `ArtifactsModule`：去 `DocsSiteModule` import（`RealtimeModule` 保留）。

## 3. 验证命令 + 结果

```
$ grep -rn "DocsMirrorService\|docs-site/:taskId/registry\|/prd/:file\|buildRegistry\|readMirrorDoc\|syncTask\|rebuildAll" server/src --include="*.ts" | wc -l
0
$ grep -rn "DocsMirrorService" server/src --include="*.spec.ts" | wc -l
0
$ npx tsc --noEmit -p tsconfig.json   # server/ 下
 exit 0（零错）
$ npm test --prefix server -- --runInBand
Test Suites: 117 passed, 117 total
Tests:       2650 passed, 2650 total
$ grep -rn "docs-site.*registry\|/prd/" web/app/\(main\)/docs   # T8 门复核（T11 依赖）
零命中（DB-only，可删端点）
```

## 4. Boot 证明（T8 worktree 模式）

- 干净 worktree：`git worktree add /tmp/t11-boot HEAD`（`15d226b`），仅叠加本 todo
  的 9 路径（4 改 + 2 新 + 2 删 + worktree 内 mirror 双文件删除），叠加后 worktree 内
  同款 grep 门 → `0`。脏树零混入。
- 容器：`aiagents-compose-server` 内 `/app/dist` 先备份 `/app/dist.bak-t11`（回滚点；
  另有前人 `dist.bak-t8`，均保留），overlay `/app/src`（后补删镜像双文件），
  `npx prisma generate` + `npx nest build`。
  - 构建 2 errors 均为他波合并漂移（`platform-mcp.service.ts:1670/1942`，
    与 T8 记录一致，非本 todo 门；未顺手修），emit 照常（T8 既定语义）。
  - emit 验证：`dist/src/docs-site/prototypes.service.js` 新鲜（build 时间戳），
    controller.js 引用 `prototypes.service`；`grep -c docs-mirror dist/src/docs-site/*.js
    dist/src/artifacts/artifacts.service.js` 全 0。
- `docker restart aiagents-compose-server` → `Up (healthy)`；
  重启后 8 分钟窗口日志 `grep -c docs-mirror` → **0**；
  `Nest application successfully started` 确认 listen。
- Live 端点（`admin/admin123` 登录取 token）：
  - `GET /api/v1/docs-site/t_0000000001/prototypes` → `{"items": []}` 200
    （DB 直读通路活；live 库经 SQL 确认**零 tsx/prototype.json 行**，
    故 T6 非空形状门按任务书 T4 先例走 jest + 代码通路，不伪造 fixture 污染共享库；
    搬移后新 spec 13/13 即 T6 断言原样重过）。
  - `GET .../registry` → **404**（路由已删）；`GET .../prd/whatever.md` → **404**。
- `docs-root` 无写入证明：重启前旧镜像残留（`t_0000000001..03` .md + 空 `t_0000000004`，
  mtime 15:34/15:44 均为旧代码写入）；新代码重启后 `find /app/docs-root -mmin -3` →
  **0**（旧代码每次启动 `rebuildAll` 必重写，新启动零写）。
- append 无镜像副作用：代码门（`syncTask` 全仓 server/src 零命中）+ 全量 jest
 （含 `artifacts.service.spec` 3 参构造 80+ 用例）。

## 5. 门禁额外改动说明（§1 中两处注释）

`artifact-slug.ts:6` 与 `artifact-slug.spec.ts:41` 不在任务书文件清单内，但零引用
grep 门按字面匹配注释 token（`DocsMirrorService` / `buildRegistry`），不改则门恒为
2 而非 0。改动各 1 行注释、零逻辑；`artifact-slug.spec` 所在 suite 仍全绿（§3 全量门内）。
`docs-site.constants.ts`（`resolveDocsRoot`/`DEFAULT_DOCS_ROOT`）未动：门禁模式未覆盖，
且不在文件清单内；其导出自 T11 起无调用方（死导出，非死 import/端点/写盘，门禁无要求）。

## 6. Issues/gotchas（同步 append 至 learnings.md / issues.md）

- `private readonly prototypes: PrototypesService` 与方法 `prototypes()` 同名 →
  TS2341（属性遮蔽方法）。注入属性必须另名（本 todo 用 `protoService`），路由方法名不变。
- 新文件 doc 注释若含 `DocsMirrorService` 字样会直接 trip 零引用门（门禁不分注释/代码）；
  写注释时即避开门禁 token。
- `docker cp A B` 不删除目标端多余文件：overlay 后须在容器内手动 `rm` 镜像双文件，
  否则旧 `src` 残留导致构建仍含死代码。
- `nest build` 失败仍 emit（2 errors 下 `dist` 照常更新，T8 已记录）；emit 新鲜度以
  `ls -la` 时间戳 + 内容 grep 为准，不以 exit 文案为准。
- 容器 `find` 为 BusyBox：无 `-newermt`，用 `-mmin -N` 做写入窗口断言。

## 7. 清理收据（teardown）

- `git worktree remove /tmp/t11-boot --force` + `prune` → `git worktree list` 仅剩主检出。
- 容器 `/tmp/t11src`、`t11-build.log` 已删（`/tmp` 仅剩 `node-compile-cache` 等系统项）；
  `/app/dist.bak-t11` 保留为回滚点（循 `dist.bak-t8` 前例）。
- server 容器保持 `Up (healthy)`（重启前即为运行态，本 todo 仅 restart 未 start，
  故不做 stop——停服会中断并行他波共享infra；healthy 状态即交接态）。
- host 无新建常驻进程（仅 jest 短命进程，已退出）；无 stray worktree。
- 未 push（任务书要求）。

## 8. 风险

- web 旧 `DocExplorer`（`useDocsRegistry`/`useDocContent`）仍调用已删端点，但自 T10 起
  已无路由挂载（`[taskId]/page.tsx` 为 T8 组件薄别名，`index.ts` 导出无人 import），
  属死代码非回归；web 不在本 todo 范围，未动（T12 可整体清理）。
- `docs-site.constants.ts` 残留无调用方的 `resolveDocsRoot` 导出（见 §5），死导出，
  T12 可删（需确认门禁模式仍不覆盖）。
- 容器内 `/app/src+/app/dist` 现为 HEAD+T11（超前于镜像构建 commit），下次
  `compose up --build` 即对齐；`dist.bak-t11` 可整体回滚。
- 并行他波脏文件（chat/tasks/timer 等）未纳入本次构建验证（worktree 隔离），
  全量 jest 在**脏树**跑过 2650 绿，含他波文件——即当前树整体可测。
