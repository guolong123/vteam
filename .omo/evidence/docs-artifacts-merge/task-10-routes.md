# T10 路由收敛与导航改址 — 证据

## 1. 别名机制选择（T8 合同核查结论）

`web/app/(main)/docs/page.tsx:774`：`export default function DocsUnifiedPage()` —— **零 props**，
纯 URL 驱动（effect 内读 `window.location.search` 的 `?teamId=/taskId=/doc=`；无 `teamId` 时只渲染
`docs-team-picker` 团队选择器）。故：

- 无法以 prop 预填 taskId；
- 仅注入 `?taskId=` 不够——无 `teamId` 时别名页永远落在团队选择器，task 预填 + `?doc=` 深链双双失效；
- 最终机制：别名页 deferred mount，先经 `window.history.replaceState` 一次性注入
  `?taskId=`（路径 `:taskId`）+ `?teamId=`（经 `GET /tasks/:id` 反查，不覆盖调用方显式 teamId），
  再挂载统一组件。零 router 导航、零历史记录、URL 路径保持 `/docs/:taskId`。
  反查失败 → 仍挂载（选择器兜底），绝不 404。T8 文件本身零修改。

## 2. 孤儿 `docs-site.spec.ts` 删除前 project 列表证明

`web/playwright.config.ts` projects（全文，共 6 个）：

| project | testMatch |
|---|---|
| setup | `auth.setup.ts` |
| login | `login.spec.ts` |
| pages | `pages.spec.ts` |
| team-users | `team-user-members.spec.ts` |
| perf | `perf.spec.ts` |
| guard | `guard.spec.ts` |

`docs-site.spec.ts` 与任一 testMatch 均无交集。实测收据：

```
$ npx playwright test e2e/docs-site.spec.ts --list
Error: No tests found.
$ npx playwright test --list | grep -c docs-site
0
$ npx playwright test --list (按 project 统计): {"setup":1,"login":6,"pages":16,"team-users":1,"perf":3,"guard":9}
```

结论：孤儿 spec，不在任何 project —— 删除（`git rm`）而非接入。已删：`ls web/e2e/docs-site.spec.ts` →
`No such file or directory`。

## 3. 变更清单（7 文件，含 1 删除）

- `web/app/(main)/artifacts/page.tsx`：重写为瘦重定向页（旧 1070 行实现删除）。
  effect 内读 `window.location.search`（SSR-safe），`router.replace('/docs?' + params)` 全量透传；
  最小 loading 壳保留 `data-testid="artifacts-root"`（过渡期，非质量门）。
- `web/app/(main)/docs/[taskId]/page.tsx`：重写为 T8 默认导出薄别名（deferred mount + replaceState
  注入 taskId/teamId，直接渲染，无跳转；`?doc=` 原样透传）。
- `web/app/(main)/board/page.tsx:509`：`router.push('/artifacts?teamId=…')` → `router.push('/docs?teamId=…')`。
  `:333` 的 `/docs/${task.id}` 原样保留。
- `web/app/(main)/teams/[id]/session/page.tsx:1311`：`onOpenArtifacts` 同上改址。
  `:1323` 的 `/docs/${task.id}?doc=…` 原样保留；`tasks/page.tsx:322` 只读未动。
- `web/src/components/layout/app-shell.tsx`：仅注释同步（Dock 高亮映射说明改称 docs 路由；
  `artifacts: "teams"` 的 KEY_LOOKUP 条目保留 = 零行为变更）。
- `web/e2e/pages.spec.ts:223`：13/17 改断言重定向落地
  (`toHaveURL(/\/docs\?.*teamId=/)` + `type=text` 透传 + `docs-shell/filter-bar/task-filter-select/docs-tree`
  可见）。`guard.spec.ts:15` 未动（`/artifacts?…` 未登录仍跳 `/login`，重定向页同受 AppShell 守卫）。
- `web/e2e/docs-site.spec.ts`：`git rm` 删除。

未碰：`docs/page.tsx`（T8）、`file-preview.tsx`（T9）、hooks、docs-markdown、board/session 其余逻辑、
任何 server 文件、`testids.ts`（纯 reference）、`nav-dock.tsx` 注释（非本次清单，有意不动）。

## 4. 验证门输出

- `tsc`：`./node_modules/.bin/tsc --noEmit -p tsconfig.json`（web 内）→ 零输出，`TSC_EXIT:0`。
- `eslint`（7 touched 文件）：`0 errors, 4 warnings` —— 均为 pre-existing 未用变量警告
 （session/page 2 处 `_drop`、pages.spec 2 处未用 import），与本次变更无关。
- 零引用门：`grep -rn "router.push(\`/artifacts" web --include="*.tsx"` → `0`。
  别名兼容保留：`/docs/` path push 仅存 board:333、tasks:322、session:1323 三处（上游 grep 实测）。
  （session/page:215 的 `` `/tasks/…/artifacts` `` 为 REST API 路径，非路由跳转，不计。）
- Playwright（web dev `:3001` + compose server `:13000`，`--reporter=line`）：
  - `npx playwright test e2e/pages.spec.ts e2e/guard.spec.ts` → **23 passed, 3 failed**。
    3 失败全部位于未触碰文件/路径：4b/17 board-drawer（`task-detail-drawer` 无元素——live seed 无卡片）、
    team-session zero-task、12/17 skills（`search-input` 缺失）。失败面与本次 diff
    （`git status` touched 7 文件）零交集，且 live 后端镜像早于 T4–T8（聚合端点 404 收据见 T5 证据），
    判定为并行波 moving-target/环境既有失败，非回归。13/17（本 todo）与 9 个 guard 用例全绿。
  - Throwaway 别名探针（临时 spec+config，跑后已删 `t10-probe.spec.ts`/`t10.playwright.config.ts`）→ **2 passed**：
    1. `/docs/t_0000000005?doc=__no_such_doc__`：URL 保持 `/docs/t_…`（无跳转）且含 `taskId=`；
       `docs-team-picker` 计数 0；`task-filter-select` 值为 `t_0000000005`；未知 doc 落
       `docs-doc-missing`/`docs-viewer-empty` 空态之一（实测命中）——旧深链零 404（QA failure case）。
    2. `/artifacts?teamId=…&taskId=…&type=text`：落地 `/docs` 且三参数全在 URL，`docs-shell` 可见。
- 路由冒烟（curl，鉴权前 SSR 层）：`/artifacts?…`、`/docs/:id?doc=`（已知/未知 doc）、`/docs?teamId=` 全部 HTTP 200。

## 5. 清理收据

- Throwaway：`web/e2e/t10-probe.spec.ts`、`web/t10.playwright.config.ts` 已 `rm`（`git status` 无残留）；
  `test-results/` 为 gitignore，不进提交；`.auth/user.json` 被 setup project 刷新，不 stage。
- 自启 web dev（`API_PROXY_TARGET=http://localhost:13000 npm run dev -- --port 3001`，PID 85918）已 kill。
- T9 并行波脏文件（`docs/page.tsx`、`file-preview.tsx`、`t9-qa.*` 等）一律不 stage、不提交。

## 6. 风险

- 别名页 `teamId` 反查多一次 `GET /tasks/:id`（与旧别名页同源同权；失败即选择器兜底，无白屏）。
- deferred mount 期间短暂 `docs-loading` 壳（与统一页既有 loading 态同 testid，无新门）。
- 3 个 pages.spec 既有失败留待 T12 全量 QA 时按当时 seed/镜像重验。
