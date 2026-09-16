# T14 证据 — 原型 tab 回补（`task-8b-proto-tab.md`，旧标签保留供 T12/T13 按计划索引）

## 1. 变更（仅 `web/app/(main)/docs/page.tsx`，+~90 行）
- Tab 栏：旧任务页视觉逐字照抄（pill 容器 `neutral[100]` + `radius.md` + `border`、active 白底 + `boxShadow`、两枚 SVG 图标、徽标 pill 样式），testid `docs-tab-bar/docs-tab-docs/docs-tab-protos`（全仓 grep 事前 0 命中，无碰撞）。
- `PrototypePanel` 经 `next/dynamic ssr:false` 懒加载（旧页同款 loading 占位），props `taskId={taskKey} initialProtoId={protoParam ?? undefined}`，`key={taskKey:proto}` 保证任务/深链切换重挂载；内部不动。
- 徽标：旧页同查询 `["docs-proto-count", taskKey] → GET /docs-site/:taskId/prototypes` 计数，`taskKey==="all"` 时 `enabled:false`（团队级不取数）。
- URL：mount effect 同模式读 `?proto=`（有即 `setTab("protos")`）；`syncUrl` 加 `proto?` 字段（extend 不 fork），既有 handler 透传保留，team/task 切换清 `proto`；tab 点击只切显隐 + 落 URL 快照（`?doc=`/`?proto=` 双保留，筛选/选择全保留）。初始 `?proto=` 有无决定 tab，挂载后最后点击为准。
- 团队级：原型 tab `disabled + aria-disabled + title="请先选择具体任务后查看原型"`（tab 栏仍渲染）+ `docs-proto-empty`「请先选择任务」空态；docs tab 内容为既有合站整体下移（filter/tree/viewer/delete/SSE 零改）。

## 2. 门
- `npx tsc --noEmit -p tsconfig.json`（web/ 内）：EXIT 0，零错。
- `npx eslint "app/(main)/docs/page.tsx"`：EXIT 0。
- `grep -rn "PrototypePanel\|usePrototypes\|useDeleteArtifact"` 本文件：仅 import/调用，`web/src/features/docs-site/` 零改（`git status` 仅 `page.tsx` + 证据/screenshot 为本 todo 文件）。
- Playwright 临时 spec（6/6 绿，跑完 spec+config+test-results+`.auth` 全删）：
  - docs tab 默认 + tab 栏 testids + console 零 error → `t14-docs-tab.png`
  - 徽标 `1` → 点原型 tab → `docs-prototype-panel` 含 `t14qa-demo` → `t14-protos-tab.png`
  - `?proto=t14qa-demo` 直达 protos 选中 → `t14-proto-deeplink.png`
  - `?doc=<首行slug>` 仍进 docs tab + `artifact-viewer` 可见
  - `task=all`：protos `toBeDisabled`、force 点不切 tab、console 零 error → `t14-team-disabled.png`；`?proto=` + task=all → `docs-proto-empty`「请先选择任务」→ `t14-team-proto-empty.png`

## 3. Fixture 与清理收据
- Fixture：`/app/uploads/t14qa-demo.tsx`（docker cp 进容器）+ `POST /tasks/t_0000000001/artifacts {type:file, fileRef:/uploads/t14qa-demo.tsx, category:设计}` → `art_0000000043`，`GET prototypes` 得 `id=t14qa-demo/file=t14qa-demo/index.tsx`（append fileRef 直写 bypass uploads allowlist，tsx 无需加白）。
- 清理：`DELETE /artifacts/art_0000000043 → {"deleted":true}`，容器 `rm` tsx（`ls` 无残留），复查 `GET prototypes → {"items":[]}`；本地 dev server（:3001，`API_PROXY_TARGET=http://localhost:13000`）已停；`lsof -i :3001` 空。

## 4. 风险/交接
- `PrototypePanel` 选态为内部 state，`?proto=` 仅首挂载生效 → 跨深链用 `key` 重挂载覆盖；tab 内二次选择不回写 URL（既有组件行为，不动）。
- 正式 e2e（T12 `docs-unified.spec.ts`）可直接复用本临时 spec 五断言；旧 `?proto=` 深链（别名页透传保留）已验证可达。
