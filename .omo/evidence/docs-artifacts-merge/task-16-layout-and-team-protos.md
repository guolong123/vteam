# Task-16 证据 — docs 全宽布局 + 团队级原型 tab

## 1. 范围（单任务双变更，同文件）

- `web/app/(main)/docs/page.tsx`（布局 A + 原型 tab B）
- `web/src/features/docs-site/hooks.ts`（+ `useTeamPrototypes` / `TeamPrototypeListItem`）
- `web/src/features/docs-site/prototype-panel.tsx`（团队模式：新增可选 `teamId/tasks` props，同一组件内分支，无新文件）
- `web/src/components/ui/page-window.tsx`（+ 可选 `fluid` prop；`maxWidth` 缺省 1080 未动）
- 本证据文件（新增）

## 2. DoneClaim

### (A) 布局修复（旧 → 新）

| 缺陷 | 旧值 | 新值 | 位置 |
|---|---|---|---|
| 页面限宽 | `PageWindow maxWidth={1280}` | `PageWindow fluid`（内层 `maxWidth:none/margin:0`；缺省 1080 原样保留，他页不受影响） | page.tsx 头部 / page-window.tsx +`fluid?: boolean` |
| 树列过窄 | `width: 360`，标题与 4 徽章同行挤压（「电…」「к…」1~2 字即截断，见 before 图） | `width: 440`；行改为两行：第一行 `[类型徽章] 标题(flex, ellipsis)`，第二行 `任务名(次 muted, flex) + 分类徽章 + vN`；分类/版本/任务名无一删除 | `DocTreeRow` |
| 查看器限高 | 内容区 `minHeight:96 + maxHeight:420` | 内容区 `flex:1 + minHeight:0 + overflow:auto`；外层 section +`flex:1/minHeight:0`；头（版本切换）/尾（timeline）+`flexShrink:0` pinned | `VersionViewer` |
| 树限高 | `maxHeight:640` | `height: calc(100vh - 280px) + minHeight:400 + overflow:auto`；右侧内容列同高；分栏容器 `alignItems:stretch + flex:1/minHeight:0` | 主体分栏 |

### (B) 团队级原型 tab

- 后端冻结契约（并行任务实现中，截图时 **404 未部署**，已用 curl 取证 `team-protos:404`）：
  `GET /api/v1/teams/:id/prototypes → { items: [{ id; metaId?; name; file; artifactId?; taskId; taskName }] }`。
  源码仍走任务级 `GET /docs-site/:taskId/prototypes/<file>`。
- 客户端已按契约实现：`useTeamPrototypes(teamId, tasks?)` 主查团队端点；
  主端点报错时自动回退逐任务 `usePrototypes` 聚合并补 `taskId/taskName`（`viaFallback` 标记，
  后端落地后自动走主端点，零改动切换）。**after 截图走回退路径**（非伪造：真实逐任务 API 数据）。
- `docs-tab-protos` 在全任务模式下 **enabled**（`disabled/aria-disabled/置灰/title` 全删，
  `handleTabProtos` 去守卫）；`task=all` 渲染 `<PrototypePanel teamId tasks>`，
  条目第二行显示 `taskName`（任务级保持显示 `proto.id` 不变），沙箱取**选中条目**的
  `taskId`；切具体任务时仍走任务级窄化（`taskId` 分支保留）。
- `docs-proto-empty` 的「请先选择任务」死端删除；该 testid 移入 `PrototypePanel`
  真正为空态内层（团队/任务双文案），其余 15 个 testid 原位保留（`docs-content-view`
  仍只在 `file-preview.tsx` 内，不重复）。

### 命令 + 结果

- `npx tsc --noEmit -p tsconfig.json`（web）：exit 0
- `npx eslint` 四目标文件：0 errors（初版 1 warning `exhaustive-deps` 已修，加 `useMemo` 包裹后复检 clean）
- Playwright 临时 spec（`t16.tmp.spec.ts` + `t16.tmp.config.ts`，跑后已删）：
  host dev `:3001`（`API_PROXY_TARGET=http://localhost:13000`），真表单登录 seed-admin，
  before/after × 1920×1080/1440×900 共 12 张，全 pass（2 tests × 2 run）

### 截图（`img/` 下，before=未改代码，after=本提交代码）

- `t16-before-tree-{1920x1080,1440x900}.png`：360px 列 + 标题截断 1~2 字 + 原型 tab 置灰
- `t16-before-viewer-*.png`：420px 封顶查看器
- `t16-before-protos-*.png`：原型 tab disabled（force 点无面板）
- `t16-after-tree-*.png`：全宽 + 440px 两行（标题 ~20 字 + 任务名次行 + 双徽标）
- `t16-after-viewer-1920x1080.png`：查看器纵向填充、头尾 pinned、footer timeline 落底
- `t16-after-protos-1920x1080.png`：全任务模式原型 tab 可点，列表 `t16qa-demo` + 任务名
  `T16 docs layout QA task`，沙箱渲染出真实源码（`t12qa demo prototype`）
- `t16-after-protos-1440x900.png` / `t16-after-tree-1440x900.png`：同上窄视口对照

### 清理收据（live 库 tm_0000000002 零残留）

- fixture：任务 `t_0000000007` + 文 `art_0000000043/45/46` + 原型行 `art_0000000044`
  （`/app/uploads/t16qa-demo.tsx` 字节）+ seed-admin 入队（`tum_0000000009`）
- 清理：4 行 DELETE 200；`rm /app/uploads/t16qa-demo.tsx`（`ls` 确认 gone）；
  `DELETE /teams/:id/users/u_seed_admin` 200；`DELETE /teams/:id/queue/t_0000000007` 200；
  复查：团队 artifacts 无 `t_0000000007` 行（total 回 27）、`tasks?teamId=` 空、
  `queue: []`、`userMembers` 仅 `u_admin`
- 残留说明：空任务行 `t_0000000007` 无 DELETE 端点（404 `Cannot DELETE /api/v1/tasks/...`），
  已去队、无产出物、列表不可见，仅 DB 空行，待任务删除 API 落地再清
- 进程：host dev `:3001` 已 `pkill`，`lsof -i :3001` 空；临时 spec/config/test-results 已删
- Git：`git status` 他波 ~46 脏文件未碰；`git add` 仅 5 路径（4 代码 + 本证据）

### 风险

1. after 截图走**回退路径**（团队端点 404）：主端点部署后需重验 `viaFallback=false`
   分支（面板行为一致，仅数据源切换；徽标 `team-proto-count` 同理）。
2. `web/e2e/docs-unified.spec.ts:366-372`「团队级原型 tab 禁用 + 空态」断言与本需求
   直接冲突（`toBeDisabled` + 「请先选择任务」），下次跑 docs project 必红 1 用例；
   按任务文件清单未改该 spec，留给编排器/T12 侧更新。
3. `?proto=` 深链跨任务：team key 含 `teamId`，任务级含 `taskKey`，`initialProtoId`
   按 id 匹配，跨分支 id 命名空间一致（原型 id 全局按名排序），行为与 T14 一致。
