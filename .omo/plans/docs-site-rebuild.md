# docs-site-rebuild - Work Plan

## TL;DR (For humans)

**What you'll get:** 一个按 vteam 架构从0重建的文档站，删除所有直接复制的 md-docs 代码后，在 `web/src/features/docs-site` 下提供与 md-docs 功能一致的“文档+原型”双视图（任务级作用域），并保留服务端镜像契约不动，确保现有任务产出物流转不受影响。

**Why this approach:** md-docs 的 Vite 虚拟模块/hash路由与 vteam 的 Next.js App Router 本质不兼容，修补只会叠加 hack；保留服务端“派生视图”契约（已稳定且被 e2e 依赖）仅重建 web 渲染层是风险最低、收益最高的路径；原型沙箱沿用已验证的 `esbuild-wasm+iframe` 隔离方案仅做健壮化，避免重引服务端编译。

**What it will NOT do:** 不把 md-docs 当依赖拉起、不引入 `virtual:md-docs-*`/`@md-docs` alias、不改 DB 模型、不做多项目 `docs/<project>` 抽象、不为 web 引入 Vite/hash 路由。

**Effort:** Large — 约 14 个实现任务分 3 波，涉及删除+新建模块+编译沙箱+视觉对齐+测试。
**Risk:** Medium — 主要是原型沙箱的样式跨源与 esbuild-wasm 体积，依赖 `PROTO_SHARED_SOURCES` 生成链与 `/vendor/react-runtime.js` 的健壮性，需以 sandbox 白名单与样式提取加固收敛。
**Decisions to sanity-check:** 1) 以 `taskId` 单作用域替代 md-docs 多项目是裁剪而非缺功能（vteam 任务即项目）；2) v1 即恢复文档内 `prototype` 内嵌（为对齐 md-docs 功能，代价是重新引入 parser 插件）；3) 原型编译保留浏览器端 esbuild 方案。

Your next move: 批准后运行 `$start-work docs-site-rebuild` 启动执行；或先跑高精度复审。

---

> TL;DR (machine): Large/Medium — delete-and-rebuild web docs-site under features/docs-site, keep server mirror contract, restore md-docs parity (docs+protos+embed+mermaid) on Next.js tokens

## Scope
### Must have
- 删除 `web/src/components/docs/*` 中所有从 md-docs/prototype-viewer 复制的文件（`device-frame.tsx`/`device-switcher.tsx`/`proto-shared/**`/`prototype-safelist.ts`/`prd-markdown.tsx` 旧实现/`prototype-tsx-viewer.tsx` 旧实现/`prototype-panel.tsx` 旧实现/`doc-explorer.tsx` 旧实现/`mermaid-block.tsx` 旧实现等）与 `web/app/(main)/docs/[taskId]/page.tsx` 的兼容 margin/hack 样式，保留 `server/src/docs-site` 契约
- 新建 `web/src/features/docs-site/` 单源模块（barrel 导出）：`parser.ts`（移植 md-docs parser，按 task 原型解析）+ `docs-markdown.tsx`（placeholderPlugin/unknownHandler + remark-gfm + MermaidBlock + PrototypeEmbed/List/Inline）+ `doc-explorer.tsx`（左文档树+中内容+右章节菜单，三栏 `w-64|flex-1|w-60`，窄屏 pill）+ `device-frame.tsx`/`device-switcher.tsx`（按 `web/src/theme/tokens.ts` 重写）+ `prototype-sandbox.tsx`（替代旧 viewer，esbuild-wasm 编译+iframe sandbox）+ `prototype-panel.tsx`（列表+网格+DeviceFrame 预览）+ `hooks.ts`（`useDocsRegistry/useDocContent/usePrototypes/usePrototypeSource`）+ `types.ts`
- 数据面：`GET /docs-site/:taskId/registry`（`DocDef{id,name,kind,description,file,order}`）30s 轮询、`GET /docs-site/:taskId/prd/:file` Bearer 拉取、`GET /docs-site/:taskId/prototypes` 与 `GET .../prototypes/*` 白名单拉取，原型列表 id 排序，registry 空态/错误态/重试完整
- 文档视图：文档树父可折叠（`parent` 层级）、选中态 `brand-50/700`、kind 徽标、子文档缩进与 `border-l`，章节从 `##/###` 提取去重（≤80）、IntersectionObserver 高亮、`scrollIntoView` 不改 URL
- 原型视图：左侧分组导航（`全部原型` 标题 + `name/description/id` 卡片）+ 右侧 `DeviceFrame` 预览（`desktop 1280x800 / mobile 390x844` 固定宽高，`DEVICE_SPECS`），顶部 `DeviceSwitcher`，底部网格卡片（`rounded-[--radius-card] border shadow-panel hover:shadow-frame`），空态“暂无原型”与原型列表加载失败重试
- 文档内原型内嵌：支持 md-docs 三标记 ` ```prototype {id,title,device,height}` / ```prototype-list``` / `@prototype[id]`，按当前 `taskId` 的 `prototypes` 解析，块级自动缩放（容器宽/原型宽，不超1）与高度自适应（`maxHeight 640` 截断滚动）、全屏遮罩、跳转到原型 tab（`?proto=<id>` 深链）
- Mermaid：` ```mermaid` → 浅色 `base` theme（`primaryColor #e0ebfe` 等与 `mermaid-block.tsx:15-26` 一致）、加载占位与失败回退源码、宽图横向滚动
- 鉴权与安全：所有拉取经 `lib/api` Authorization 头与 `getAuthToken()`，`iframe sandbox="allow-scripts"` 无 `allow-same-origin`，`file` 白名单 `[a-z0-9_-].md` / `[a-z0-9_-]/index.tsx` / `[a-z0-9_-].json` 防穿越，`taskId` 白名单 `^t_[a-zA-Z0-9_]+$`（与 `docs-site.controller.ts:106` 一致）
- 视觉对齐 md-docs：面包屑 `h-9 border-slate-200 bg-white px-4` + tab 栏 `h-11 pill border-slate-200 bg-slate-100/70 p-0.5 active bg-white shadow-sm`，与 `ProjectView.tsx:54-121` 同款 svg 图标与原型数量徽标
- 质量门：`tsc --noEmit`、`eslint`、`server jest --runInBand`、`web playwright` 文档站深链、暗色与空态视觉回归、性能（原型 tab 懒加载 `dynamic ssr:false`）

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 不引入 `md-docs` 依赖、不复用其源码（零拷贝重写，仅可参考逻辑）、不引入 `virtual:md-docs-content/protos`、`import.meta.glob`、`mdDocsPlugin`、`buildDepsAlias`、`@md-docs` alias
- 不为 web 引入 `vite`/`@tailwindcss/vite`/`oxlint`，不新增除 `esbuild-wasm/mermaid/react-markdown/remark-gfm` 外运行时依赖
- 不改 `server` 存储模型（不新增 DB 表、不改 `artifacts`/`artifactVersion` 结构、不把镜像改为直读 DB），不重写 `DocsMirrorService` 同步/锁/白名单核心逻辑
- 不做 `docs/<project>` 多项目抽象与站点级项目列表页（作用域固定 `taskId`）
- 不在 web 引入 `hash` 路由（保留 `App Router + ?doc=&proto=`），不新增全局 `zustand` docs store（局部 `useState` 足够）
- 不在本次引入服务端预编译/SSR 原型渲染（保持浏览器端 esbuild 方案）
- 不改 `worker`/`platform-mcp`/`realtime`/`artifacts` 等无关模块

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + 补齐（server `jest --runInBand` 补 `docs-mirror.service.spec`/`docs-site.controller.spec` 缺口；web 以 `playwright` 覆盖文档站深链与空/错态，辅以 `tsc --noEmit` 与 `eslint`）
- Evidence: `.omo/evidence/docs-site-rebuild/task-<N>-<slug>.md`（每 todo 一份，含命令、断言与截图/日志路径；不在 ulw-loop 时用 `.omo/evidence/`）
- 关键命令：`npm run lint --prefix web`、`npm run lint --prefix server`、`npm test --prefix server -- --runInBand`、`npx tsc --noEmit -p web/tsconfig.json`、`npx playwright test web/e2e/docs-site.spec.ts`（若无则新建）
- 人工 QA 替代：agent 以 `playwright` 打开 `http://localhost:13001/docs/<taskId>?doc=<id>&proto=<id>` 截图对比三栏/网格/沙箱高度/Mermaid 渲染

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- Wave 1（清理与基建，可并行）：T1 删除归档 + T2 新模块骨架 + T3 parser 移植 — T3 依赖 T2 落位，其余可并行启动；T4/T5 依赖 T2/T3 完成
- Wave 2（核心视图，可并行）：T4 DocsMarkdown（含原型嵌入）+ T5 DeviceFrame/Switcher 完成后，并行 T6 DocExplorer + T7 hooks + T8 PrototypeSandbox；T9 PrototypePanel 依赖 T7/T8；T10 DocsPage 集成依赖 T6/T9
- Wave 3（加固与收尾，可并行）：T11 服务端加固 + T12 残留清理 + T13 类型/单测/e2e 补齐 + T14 文档与证据；T11 与 web 波无依赖可与 Wave2 尾部重叠，但为质量门收敛放在最后波

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2,3,4,5,6,7,8,9,10,12 | — |
| 2 | 1 | 3,4,5,6,7,8,9,10 | 3 |
| 3 | 2 | 4,6,9 | 2 |
| 4 | 2,3 | 6,9,10 | 5 |
| 5 | 2 | 9,10 | 4 |
| 6 | 2,4 | 10,13 | 7,8 |
| 7 | 2 | 9,10,13 | 6,8 |
| 8 | 2,7 | 9,10,13 | 6,7 |
| 9 | 7,8 | 10,13 | 6 |
| 10 | 4,5,6,9 | 13,14 | 11,12 |
| 11 | 1 | 13 | 10,12,14 |
| 12 | 1,2,10 | 13,14 | 10,11 |
| 13 | 6,7,8,9,10,11,12 | 14 | 11,12 |
| 14 | 10,13 | — | 11,12,13 |

## Todos
> Implementation + Test = ONE todo. Never separate.
- [x] 1. 删除并归档 legacy docs 代码与兼容 hack
  What to do / Must NOT do: 删除 `web/src/components/docs/**`（`doc-explorer.tsx:1-360`、`prd-markdown.tsx:1-182`、`prototype-panel.tsx:1-253`、`prototype-tsx-viewer.tsx:1-486`、`device-frame.tsx:1-106`、`device-switcher.tsx`、`mermaid-block.tsx:1-136`、`proto-shared/**`、`prototype-safelist.ts:1-18` 等）与 `md-docs` 复制残留；清理 `web/app/(main)/docs/[taskId]/page.tsx:24-26` 的旧 `dynamic` 引用与样式 hack；将删除列表写入 `docs-site-rebuild-deletion.md` 证据；Must NOT 动 `server/src/docs-site/*` 核心逻辑与 `web/src/theme/tokens.ts`
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2,3,4,5,6,7,8,9,10,12
  References (executor has NO interview context - be exhaustive): `web/src/components/docs/doc-explorer.tsx:1-15` 数据源注释、`web/src/components/docs/prd-markdown.tsx:1-15` 简化说明、`web/src/components/docs/prototype-panel.tsx:1-15` polish 注释、`web/src/components/docs/prototype-tsx-viewer.tsx:1-26` 编译链路注释、`web/src/components/docs/device-frame.tsx:1-14` DeviceFrame 注释、`web/src/components/docs/prototype-safelist.ts:1-7` safelist、`md-docs/src/docs/scanner.ts:1-35` 多项目约定（对比删除依据）、`server/src/docs-site/docs-site.controller.ts:28-34` 端点契约（保留依据）
  Acceptance criteria (agent-executable): `grep -r "from.*components/docs" web --include="*.ts" --include="*.tsx"` 零命中（除新 `features/docs-site`）；`ls web/src/components/docs` 不存在或仅含 `README.md` 说明；`git status --porcelain` 显示删除文件清单与证据文件已提交
  QA scenarios (name the exact tool + invocation): happy — `npx tsc --noEmit -p web/tsconfig.json` 通过且 `npm run lint --prefix web` 无 docs 旧路径报错，证据 `.omo/evidence/docs-site-rebuild/task-1-deletion.md`；failure — 人为保留一个旧 `proto-shared/types.ts` 引用，`grep` 仍命中则判定失败并记录
  Commit: Y | chore(docs-site): remove legacy md-docs copy and compat hacks

- [x] 2. 新建 `web/src/features/docs-site` 模块骨架与 barrel
  What to do / Must NOT do: 新建目录 `web/src/features/docs-site/` 含 `index.ts` barrel、`types.ts`（`DocDef/TocItem/DeviceType/PrototypeListItem` 对齐 `doc-explorer.tsx:25-39` 与 `prototype-panel.tsx:23-29`）、`parser.ts` 占位、`docs-markdown.tsx` 占位、`doc-explorer.tsx` 占位、`device-frame.tsx`/`device-switcher.tsx` 占位、`prototype-sandbox.tsx` 占位、`prototype-panel.tsx` 占位、`hooks.ts` 占位、`mermaid-block.tsx` 占位；导出统一供 `app/(main)/docs/[taskId]/page.tsx` 消费；Must NOT 引入 `virtual:md-docs-*` 或 `@md-docs` alias
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 3,4,5,6,7,8,9,10
  References (executor has NO interview context - be exhaustive): `web/src/theme/tokens.ts`（`neutral/radius/space/fontSize` 单源）、`web/app/(main)/docs/[taskId]/page.tsx:1-183` 现有 tab/面包屑结构（新 barrel 需兼容其 props）、`web/lib/api.ts`（`api.get/getAuthToken/API_BASE_URL`）、`md-docs/src/docs/scanner.ts:37-54` DocDef 形状（新 types 需对齐但按 task 裁剪）
  Acceptance criteria (agent-executable): `ls web/src/features/docs-site` 列出 10 文件且 `import { DocExplorer } from "@/src/features/docs-site"` 可被 `npx tsc --noEmit -p web/tsconfig.json` 解析；`grep -r "virtual:md-docs" web` 零命中
  QA scenarios (name the exact tool + invocation): happy — 创建后 `npx tsc --noEmit -p web/tsconfig.json` 通过，证据 `.omo/evidence/docs-site-rebuild/task-2-scaffold.md` 含 `ls` 输出；failure — 故意在 `types.ts` 导出错名，`tsc` 报错则捕获
  Commit: Y | feat(docs-site): scaffold features/docs-site module

- [x] 3. 移植并适配 md-docs parser（任务级原型解析）
  What to do / Must NOT do: 以 `md-docs/src/docs/parser.ts:1-167` 为逻辑蓝本重写 `web/src/features/docs-site/parser.ts`：保留三标记（` ```prototype` 块含 `id/title/device/height`、` ```prototype-list``` 清单、`@prototype[id]` 内联）、4+ 反引号围栏与 ` ````markdown` 示例区跳过、`parseYamlLines` 注释与引号处理、占位前缀 `@@PROTO_EMBED_/_LIST_/_INLINE_` 与 `isPlaceholderLine`；适配：`PrototypeEmbedSpec` 按 task 原型解析（不再 `docs/<project>`），`embed` 未给 `id` 时保留原文代码块；Must NOT 引入 `virtual:md-docs-*`，Must NOT 把 parser 与 UI 耦合
  Parallelization: Wave 1 | Blocked by: 2 | Blocks: 4,6,9
  References (executor has NO interview context - be exhaustive): `md-docs/src/docs/parser.ts:1-167` 全量（含 `parseYamlLines:56-65`、`parsePrdMarkdown:72-160`）、`md-docs/src/docs/DocMarkdown.tsx:27-85` placeholderPlugin 消费侧（parser 产物的契约）、`prototype-viewer/src/prd/parser.ts`（若存在则同源对比）
  Acceptance criteria (agent-executable): 单测 `node --test` 或 `jest` 覆盖：块级 `id:foo` 解析、4反引号包裹不解析、`````markdown 围栏跳过、内联 `@prototype[agent-list]` 拆分、无 id 块保留原文；`npx tsc --noEmit -p web/tsconfig.json` 通过
  QA scenarios (name the exact tool + invocation): happy — `npm test --prefix web -- --runInBand` 或 `npx jest web/src/features/docs-site/parser.spec.ts --runInBand` 全绿，证据 `.omo/evidence/docs-site-rebuild/task-3-parser.md` 含用例输出；failure — 输入 ` ```prototype\ntitle: foo\n``` `（无 id）断言保留原文代码块，否则失败
  Commit: Y | feat(docs-site): port parser for prototype embeds

- [x] 4. 重写 DocsMarkdown（含占位插件、原型嵌入、Mermaid）
  What to do / Must NOT do: 重写 `web/src/features/docs-site/docs-markdown.tsx` 基于 `md-docs/src/docs/DocMarkdown.tsx:27-210`：实现 `placeholderPlugin(parsed)` 将占位行转为 `prototype/prototype-list/prototype-inline` 自定义 mdast、`protoUnknownHandler` 产 `div[data-proto][data-ph]`、`remarkGfm` 与 `components` 覆盖（`h1/h2/h3 id=headingId` 供 TOC、`p/ul/ol/li/table/th/td/a/code/pre/blockquote/hr` 按 `tokens.ts` 样式）、`pre` 识别 `language-mermaid` 委 `MermaidBlock`、`div[data-proto]` 拦截渲染 `PrototypeEmbed(task prototypes)`/`PrototypeList`/`InlineLink(?proto=)`；Must NOT 重新引入 `@md-docs` 或 `PROTOTYPES` 硬编码注册表，Must NOT 用 `dangerouslySetInnerHTML` 除 `MermaidBlock` 外
  Parallelization: Wave 2 | Blocked by: 2,3 | Blocks: 6,9,10
  References (executor has NO interview context - be exhaustive): `md-docs/src/docs/DocMarkdown.tsx:27-210`（`placeholderPlugin:27-85`、`protoUnknownHandler:88-96`、`headingId:99-105`、`PrdMarkdown:113-210`、`PrototypeList:212-250`）、`web/src/components/docs/prd-markdown.tsx:11-34` 旧 `headingId/textOf`（新实现需替换为 tokens 版）、`web/src/components/docs/mermaid-block.tsx:1-136` 旧 Mermaid 主题（新 `mermaid-block.tsx` 需对齐 `MERMAID_THEME_VARIABLES:15-26`）
  Acceptance criteria (agent-executable): 给定含 ` ```prototype\nid: demo\n``` ` 与 ` ```mermaid\ngraph TD` 的 markdown，`render(<DocsMarkdown>)` 产出 `[data-proto="embed"]` 与 `[data-testid="docs-mermaid"]`；无 `id` 块回退为代码块；`npx tsc --noEmit` 通过
  QA scenarios (name the exact tool + invocation): happy — `npx playwright test` 或 `jest` 快照包含 `PrototypeEmbed` 与 `MermaidBlock`，证据 `.omo/evidence/docs-site-rebuild/task-4-markdown.md`；failure — `device: mobile` 的 embed 未传给 `PrototypeEmbed` 则失败
  Commit: Y | feat(docs-site): rebuild docs markdown with prototype embeds

- [x] 5. 重写 DeviceFrame 与 DeviceSwitcher（tokens 单源）
  What to do / Must NOT do: 重写 `device-frame.tsx`/`device-switcher.tsx` 对齐 `prototype-viewer/src/components/DeviceFrame.tsx:13-106` 与 `web/src/components/docs/device-frame.tsx:22-106`：`DeviceFrame{device,children,label}` 按 `DEVICE_SPECS[device].width/height` 渲染 `DesktopFrame`（红黄绿+地址栏 `IconLock`）与 `MobileFrame`（状态栏/刘海/Home条），内容区 `overflow-auto bg-slate-50` 固定宽高；`DeviceSwitcher` 为两按钮 `desktop/mobile` 切换；全部尺寸/圆角/阴影走 `tokens.ts`（`radius/space`），Must NOT 用魔法色，Must NOT 依赖 `prototype-safelist.ts`
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 9,10
  References (executor has NO interview context - be exhaustive): `prototype-viewer/src/components/DeviceFrame.tsx:13-106` 源实现、`web/src/components/docs/device-frame.tsx:22-106` 旧复制（含 `DEVICE_SPECS`）、`md-docs/src/components/DeviceFrame.tsx`（同源）、`web/src/theme/tokens.ts`（`radius.lg/space.md` 等）
  Acceptance criteria (agent-executable): `render(<DeviceFrame device="desktop">)` 含 `prototype.vteam.local` 与三色点，`device="mobile"` 含 `9:41` 与刘海；`DeviceSwitcher` 点击回调正确；`grep -r "bg-slate-50" web/src/features/docs-site/device-frame.tsx` 命中且 `npx tsc --noEmit` 通过
  QA scenarios (name the exact tool + invocation): happy — `playwright` 截图对比 desktop/mobile 外框，证据 `.omo/evidence/docs-site-rebuild/task-5-device.md`；failure — 传入非法 `device` 不崩溃（回退 desktop）否则失败
  Commit: Y | feat(docs-site): rebuild device frame and switcher

- [x] 6. 重写 DocExplorer（三栏+章节+轮询）
  What to do / Must NOT do: 重写 `doc-explorer.tsx` 对齐 `md-docs/src/docs/DocExplorer.tsx:33-260` 但数据源为 hooks：`useDocsRegistry(taskId)`（`tanstack query 30s refetchInterval`，`EMPTY_DOCS` 稳定引用）、`useDocContent(taskId, activeDoc.file)`（`fetch ${API_BASE_URL}/docs-site/${taskId}/prd/${file} Bearer`，`cancelled` 竞态处理）、`rootDocs/childrenOf/findDoc/activeDoc/expanded/activeSection/mainRef` 状态、章节 `toc` 从 `source` 提 `##/###` 去重 `≤80`、`IntersectionObserver(root:mainRef, rootMargin:"-80px 0px -30% 0px")` 高亮、`scrollToHeading` 平滑滚动；左侧 `w-64` 文档树（父折叠、kind 徽标、子缩进 `border-l pl-4`）、窄屏 pill 横滑、中 `flex-1 overflow-y-auto`、右 `w-60 lg:block` 章节菜单；空态“暂无 doc 产出物”、registry 错误重试、文档加载错误；Must NOT 用 `window.location.hash`，Must NOT 写 `zustand` 全局 store
  Parallelization: Wave 2 | Blocked by: 2,4 | Blocks: 10,13
  References (executor has NO interview context - be exhaustive): `web/src/components/docs/doc-explorer.tsx:41-360` 旧实现（`useQuery:49-55`、`initialDocId:68-75`、`fetch prd:99-121`、`toc:124-144`、`IntersectionObserver:147-163`、`三栏:173-358`）、`md-docs/src/docs/DocExplorer.tsx:33-260` 源三栏与 `expanded` 逻辑、`server/src/docs-site/docs-site.controller.ts:44-72` registry/prd 契约
  Acceptance criteria (agent-executable): 传入 `taskId`，`queryKey ["docs-registry",taskId]` 轮询，`initialDocId` 命中选中；切换文档触发 `fetch /prd/<file>`；`toc` 点击 `scrollIntoView` 且 `activeSection` 高亮；`registryQuery.isError` 显示重试按钮可 `refetch`；`npx tsc --noEmit` 通过
  QA scenarios (name the exact tool + invocation): happy — `msw` 模拟 `registry` 返回 2 顶级+1 子，断言树展开/选中/章节数，证据 `.omo/evidence/docs-site-rebuild/task-6-explorer.md`；failure — `registry` 500 时显示“文档列表加载失败”且重试可恢复，否则失败
  Commit: Y | feat(docs-site): rebuild doc explorer

- [x] 7. 实现数据 hooks（registry/content/prototypes/source）
  What to do / Must NOT do: 新建 `hooks.ts` 导出 `useDocsRegistry(taskId)`（`api.get<DocDef[]>('/docs-site/${taskId}/registry')`，`enabled:!!taskId`，`refetchInterval:30_000`，`retry:false`）、`useDocContent(taskId,file)`（`fetch ${API_BASE_URL}/docs-site/${taskId}/prd/${encodeURIComponent(file)}` Bearer，`null→loading, error→string`）、`usePrototypes(taskId)`（`api.get<{items:PrototypeListItem[]}>('/docs-site/${taskId}/prototypes')`，`items.sort by id`）、`usePrototypeSource(taskId,file)`（`fetch /prototypes/${encodeFile(file)}` Bearer，`encodeFile: file.split('/').map(encodeURIComponent).join('/')`）；统一 `queryKey` 命名与 `enabled` 守卫；Must NOT 在 hooks 内做白名单校验（白名单在 server），Must NOT 缓存 `getAuthToken()` 结果
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 9,10,13
  References (executor has NO interview context - be exhaustive): `web/src/components/docs/doc-explorer.tsx:49-55` registry query、`web/src/components/docs/doc-explorer.tsx:99-121` prd fetch、`web/src/components/docs/prototype-panel.tsx:43-65` prototypes 拉取、`web/src/components/docs/prototype-tsx-viewer.tsx:190-207` fetchPrototypeSource 与 `encodeFile`、`web/lib/api.ts`（`API_BASE_URL/getAuthToken`）
  Acceptance criteria (agent-executable): `useDocsRegistry` 在 `taskId=""` 时不发请求；`useDocContent` `file` 变更时 `cancelled` 旧请求不写 `source`；`usePrototypes` 空 `items` 返回 `[]`；`encodeFile("a b/c.tsx")==="a%20b/c.tsx"`；`npx tsc --noEmit` 通过
  QA scenarios (name the exact tool + invocation): happy — `jest` + `msw` 断言四 hooks 的 loading/error/ready 三态，证据 `.omo/evidence/docs-site-rebuild/task-7-hooks.md`；failure — token 缺失时 `fetch` 不带 `Authorization` 仍应 401 透传错误，而非静默空
  Commit: Y | feat(docs-site): add data hooks

- [x] 8. 重写 PrototypeSandbox（esbuild-wasm 编译+iframe 沙箱）
  What to do / Must NOT do: 重写 `prototype-sandbox.tsx` 以 `web/src/components/docs/prototype-tsx-viewer.tsx:27-486` 为蓝本：单例 `ensureEsbuild()`（`wasmURL "/esbuild/esbuild.wasm"`）、`protoCompilePlugin()`（`react→REACT_NS` 虚拟模块导出 `useState...`、`react-dom/client→REACT_DOM_NS`、`@proto/shared` 与 `../_shared/*` 解析到 `PROTO_SHARED_SOURCES`（`sources.generated.ts` 生成）、`@md-docs/*` → `EMPTY_NS`）、`compilePrototype(source)`（`bundle:true, format:"iife", globalName:"__ProtoModule", jsx:"transform", target:"es2017"`）、`collectCss()`（遍历 `document.styleSheets` try/catch 去重）、`buildSrcdoc(runtimeJs,bundleCode,cssText)`（`runtime /vendor/react-runtime.js` + bundle + `renderScript` 兼容 `mod.default|mod.Component|PrototypeDef.Component` + `postMessage proto-height` + `ResizeObserver`）、`iframe sandbox="allow-scripts" srcDoc` 与高度自适应（非 `device` 模式 `120-4096`，`isFramed` 填满容器）；同步更新 `web/scripts/sync-runtime.mjs` 与 `postinstall` 生成逻辑，使 `PROTO_SHARED_SOURCES` 产出到 `web/src/features/docs-site/proto-shared/sources.generated.ts`（原路径 `src/components/docs/proto-shared` 失效）；Must NOT 加 `allow-same-origin`，Must NOT 把 `react` 打进 bundle（走全局 runtime）
  Parallelization: Wave 2 | Blocked by: 2,7 | Blocks: 9,10,13
  References (executor has NO interview context - be exhaustive): `web/src/components/docs/prototype-tsx-viewer.tsx:27-486` 全量（`ensureEsbuild:38-46`、`resolveSharedFile:52-62`、`protoCompilePlugin:67-186`、`fetchPrototypeSource:197-207`、`fetchRuntimeJs:209-216`、`collectCss:219-242`、`buildSrcdoc:244-308`、`compilePrototype:312-345`、`PrototypeTsxViewer:364-486`）、`web/scripts/sync-runtime.mjs`（runtime 打包来源，需改输出路径为 `src/features/docs-site/proto-shared/sources.generated.ts`）、`web/src/components/docs/proto-shared/sources.generated.ts`（旧生成路径，迁移依据）、`web/src/components/docs/proto-shared/types.ts`（`DeviceType/DEVICE_SPECS` 将迁至新 `proto-shared/types.ts`）
  Acceptance criteria (agent-executable): 给定 `taskId/file`，`compilePrototype` 产出 `__ProtoModule` IIFE；`buildSrcdoc` 含 `postMessage` 且 `sandbox` 仅 `allow-scripts`；`collectCss` 跨源 `cssRules` 读取失败不抛；`iframe` 在 `device` 模式 `height:100%`，非 `device` 模式响应 `proto-height` 介于 120-4096
  QA scenarios (name the exact tool + invocation): happy — `jest` 模拟 `fetchPrototypeSource` + `fetchRuntimeJs` + `esbuild.build` 成功，断言 `srcdoc` 含 `React.createElement`，证据 `.omo/evidence/docs-site-rebuild/task-8-sandbox.md`；failure — 编译错误抛 `原型编译失败` 且 UI 显示 `[data-testid="proto-error"]`，否则失败
  Commit: Y | feat(docs-site): rebuild prototype sandbox

- [x] 9. 重写 PrototypePanel（列表+网格+DeviceFrame 预览）
  What to do / Must NOT do: 重写 `prototype-panel.tsx` 对齐 `web/src/components/docs/prototype-panel.tsx:36-253` 但用新 hooks 与 sandbox：挂载 `usePrototypes(taskId)` 拉列表（`initialProtoId` 命中否则首个）、`selectedId/device` 状态、`DeviceSwitcher` 右上、`DeviceFrame` 包 `PrototypeSandbox(taskId,file,name,device)` 预览、窄屏横向 pill（`md:hidden`）、侧栏 `w-64` 导航（`全部原型` 标题、卡片含 `name/description/id`）、底部网格 `>1` 时展示 `sm:grid-cols-2 lg:grid-cols-3` 卡片（`rounded-[--radius-card] shadow-panel hover:shadow-frame`，选中 `brand-50/200`）；空态 `border-dashed` 提示与 `listError` 重试；Must NOT 用 `PROTOTYPES` 硬编码，Must NOT 在 panel 内直接 `esbuild`
  Parallelization: Wave 2 | Blocked by: 7,8 | Blocks: 10,13
  References (executor has NO interview context - be exhaustive): `web/src/components/docs/prototype-panel.tsx:36-253` 旧 panel（含 `useState:37-40`、`fetchPrototypes:43-65`、`selected:67`、`md:hidden pill:99-117`、`aside w-64:119-170`、`DeviceFrame preview:188-204`、`网格:206-249`）、`md-docs/src/docs/ProjectProtos.tsx`（网格与列表对齐）、`web/src/features/docs-site/prototype-sandbox.tsx`（新 sandbox 接口）
  Acceptance criteria (agent-executable): `items=[]` 时显示空态不渲染 `DeviceFrame`；`items` 有值时默认选中 `initialProtoId` 或首个；点击网格卡片切换 `selectedId` 且 `PrototypeSandbox key` 更新；窄屏 pill 与侧栏同步选中态；`npx tsc --noEmit` 通过
  QA scenarios (name the exact tool + invocation): happy — `msw` 返回 3 原型，断言选中/切换/网格数，证据 `.omo/evidence/docs-site-rebuild/task-9-panel.md`；failure — `usePrototypes` 抛错时显示 `原型列表加载失败` 且重试按钮出现，否则失败
  Commit: Y | feat(docs-site): rebuild prototype panel

- [x] 10. 重写 DocsPage 集成（面包屑+tab+深链+懒加载）
  What to do / Must NOT do: 重写 `web/app/(main)/docs/[taskId]/page.tsx:29-183` 集成新模块：`useParams taskId`、`useSearchParams ?doc & ?proto` 初始定位、`useState tab:docs|protos`（`?proto` 存在默认 `protos`）、`taskQuery api.get('/tasks/${taskId}')` 标题、`protoCountQuery api.get('/docs-site/${taskId}/prototypes')` 徽标、面包屑 `h-9`（返回任务 `/tasks/${taskId}` + 任务标题 + `文档/原型` 文案）、tab 栏 `h-11 pill`（`docs-tab-docs/protos` testid，`aria-selected/data-active`，svg 图标）、内容区 `flex-1 min-h-0 overflow-hidden` 内 `tab===docs ? <DocExplorer taskId initialDocId> : <PrototypePanel taskId initialProtoId>`（`PrototypePanel` 保持 `dynamic ssr:false` 懒加载 `加载原型…` 占位）；Must NOT 用 `window.location.hash`，Must NOT 保留 `marginLeft:-80` hack
  Parallelization: Wave 2 | Blocked by: 4,5,6,9 | Blocks: 13,14
  References (executor has NO interview context - be exhaustive): `web/app/(main)/docs/[taskId]/page.tsx:29-183` 现有 page（含 `useSearchParams:33-38`、`taskQuery:40-46`、`protoCountQuery:49-55`、`breadcrumb:64-105`、`tab bar:107-175`、`dynamic PrototypePanel:24-27`）、`web/src/features/docs-site/index.ts` barrel（新导出）、`web/lib/stores/authStore.ts`（`useAuthStore`）
  Acceptance criteria (agent-executable): 访问 `/docs/t_abc?doc=foo` 默认 `docs` tab 且 `DocExplorer` 收到 `initialDocId="foo"`；访问 `?proto=bar` 默认 `protos` tab 且 `PrototypePanel` 收到 `initialProtoId="bar"`；切换 tab 更新 `crumb` 文案；`protoCount` 徽标仅 `>0` 显示；`npx tsc --noEmit` 通过
  QA scenarios (name the exact tool + invocation): happy — `playwright` 访问两深链断言 tab 与 `data-testid="docs-shell/tab-bar/docs-explorer/prototype-panel"`，证据 `.omo/evidence/docs-site-rebuild/task-10-page.md` 含截图；failure — `taskId=""` 时 `taskQuery/prototypes` 不发请求（`enabled` 守卫），否则失败
  Commit: Y | feat(docs-site): integrate docs page

- [x] 11. 加固服务端契约（白名单、日志、单测缺口）
  What to do / Must NOT do: 最小改动加固 `server/src/docs-site/docs-site.controller.ts:104-134`（`assertMember` 的 `taskId` 白名单与 `FORBIDDEN 403` 文案对齐 `constants.ts:13-22`）与 `docs-mirror.service.ts:1-378`（`readMirrorDoc` 的 `^[a-z0-9_-]+\.md$`、`readPrototype` 的 `<name>/index.tsx|.json` 白名单、`listPrototypes` 对 `index.tsx` 存在性与 meta `name` 提取的 `try/catch`、`toSlug/docIdFor/prototypeSlug` 去重与 `doc-` 兜底）；补齐 `docs-mirror.service.spec.ts` 与 `docs-site.controller.spec.ts` 中 `registry/buildRegistry` 去重、空 `title`→`doc-xxxx`、TSX/JSON 混合列表排序、`syncTask` 锁串行等缺口；Must NOT 改镜像同步主流程与存储路径
  Parallelization: Wave 3 | Blocked by: 1 | Blocks: 13
  References (executor has NO interview context - be exhaustive): `server/src/docs-site/docs-site.controller.ts:104-134`（`assertMember`）、`server/src/docs-site/docs-site.constants.ts:13-35`（`DOCS_SITE_ERRORS/DEFAULT_DOCS_ROOT/resolveDocsRoot`）、`server/src/docs-site/docs-mirror.service.ts:177-257`（`readMirrorDoc/listPrototypes/readPrototype` 白名单）、`server/src/docs-site/docs-mirror.service.ts:305-378`（`buildRegistry/toSlug/docIdFor`）、`server/src/docs-site/*.spec.ts` 现有单测
  Acceptance criteria (agent-executable): `readMirrorDoc(taskId,"../evil.md")===null`；`readPrototype(taskId,"../../etc/passwd")===null`；`buildRegistry` 对同名标题产出唯一 `id`（`doc-xxxx` 后缀）；`npm test --prefix server -- --runInBand src/docs-site` 全绿
  QA scenarios (name the exact tool + invocation): happy — `npm test --prefix server -- --runInBand` 全绿，证据 `.omo/evidence/docs-site-rebuild/task-11-server.md` 含覆盖率；failure — 传入 `file="a b.md"` 含空格时白名单拒绝 `null`，否则失败
  Commit: Y | fix(docs-site): harden whitelist and tests

- [x] 12. 清理残留脚本、样式与 safelist
  What to do / Must NOT do: 删除 `prototype-safelist.ts` 硬编码（样式改由 `tokens.ts` 与 `DeviceFrame` 固定），重写 `mermaid-block.tsx` 对齐 `web/src/components/docs/mermaid-block.tsx:15-26` 的 `MERMAID_THEME_VARIABLES` 与 `ensureMermaidInitialized` 单例（`theme:"base", securityLevel:"strict"`），健壮化 `collectCss` 的 `cssRules` 跨源 `try/catch` 与去重；清理 `check-md-docs.mjs`/`md-docs-check.mjs`/`check-docs-border.mjs`/`proto-docs-check.mjs` 等根目录脚本中对旧 `components/docs` 路径的检查（改为新 `features/docs-site` 路径或删除）；同步校验 `web/public/esbuild/esbuild.wasm` 与 `web/public/vendor/react-runtime.js` 静态资源不受路径迁移影响；Must NOT 改 `web/src/theme/tokens.ts` 本身
  Parallelization: Wave 3 | Blocked by: 1,2,10 | Blocks: 13,14
  References (executor has NO interview context - be exhaustive): `web/src/components/docs/prototype-safelist.ts:1-18`（待删）、`web/src/components/docs/mermaid-block.tsx:1-136` 旧实现、`md-docs/src/components/MermaidBlock.tsx`（对齐源）、`check-md-docs.mjs`/`md-docs-check.mjs`/`check-docs-border.mjs`/`proto-docs-check.mjs` 根脚本、`web/src/components/docs/prototype-tsx-viewer.tsx:219-242` collectCss 旧实现、`web/public/esbuild/esbuild.wasm` 与 `web/public/vendor/react-runtime.js`（沙箱依赖静态资源）
  Acceptance criteria (agent-executable): `grep -r "prototype-safelist" web` 零命中；`grep -r "collectCss" web/src/features/docs-site` 命中且含 `try/catch`；`npx playwright test` 文档站 Mermaid 用例仍绿；`npm run lint --prefix web` 无 safelist 残留报错
  QA scenarios (name the exact tool + invocation): happy — 渲染含 ` ```mermaid` 的文档，`[data-testid="docs-mermaid"]` 出现，证据 `.omo/evidence/docs-site-rebuild/task-12-cleanup.md`；failure — 人为让 `document.styleSheets[0].cssRules` 抛 `SecurityError`，`collectCss` 不抛且 `srcdoc` 仍生成，否则失败
  Commit: Y | chore(docs-site): cleanup safelist and styles

- [x] 13. 补齐类型、单测与 e2e（深链、空态、暗色）
  What to do / Must NOT do: 补齐 `web/src/features/docs-site/**/*.spec.ts`（parser、hooks、DocExplorer 空/错态、PrototypePanel 空/错态、PrototypeSandbox 编译失败态）与 `server/src/docs-site/*.spec.ts` 增量；新增 `web/e2e/docs-site.spec.ts` 覆盖 `?doc=&?proto=` 深链、`docs-tab-docs/protos` 切换、`docs-registry-retry`、`proto-error`、`docs-mermaid`；跑 `npx tsc --noEmit -p web/tsconfig.json` 与 `npx tsc --noEmit -p server/tsconfig.json`；Must NOT 用 `grep-only` 断言覆盖率，Must NOT 跳过暗色 `dark:` 类回归
  Parallelization: Wave 3 | Blocked by: 6,7,8,9,10,11,12 | Blocks: 14
  References (executor has NO interview context - be exhaustive): `web/playwright.config.ts`、`web/e2e/**` 现有 e2e、`server/jest.config`、`web/src/components/docs/doc-explorer.tsx:179-185` 空态文案（新测试需对齐）、`web/src/components/docs/prototype-panel.tsx:69-92` 空态（新测试需对齐）
  Acceptance criteria (agent-executable): `npx tsc --noEmit -p web/tsconfig.json` 与 `npx tsc --noEmit -p server/tsconfig.json` 零错；`npm test --prefix server -- --runInBand` 与 `npx jest web/src/features/docs-site --runInBand` 全绿；`npx playwright test web/e2e/docs-site.spec.ts` 全绿
  QA scenarios (name the exact tool + invocation): happy — `npx playwright test --reporter=list` 输出含 `docs-site` 5 用例全绿，证据 `.omo/evidence/docs-site-rebuild/task-13-tests.md` 含日志与截图；failure — 模拟 `registry` 空数组，断言空态文案“暂无 doc 产出物”出现，否则失败
  Commit: Y | test(docs-site): add unit and e2e coverage

- [x] 14. 文档、证据与迁移收尾
  What to do / Must NOT do: 更新 `web/README.md` 的“文档站”章节（说明新 `features/docs-site` 结构与 `taskId` 作用域）、在 `server/README.md` 补充 `docs-site` 端点契约表；产出 `.omo/evidence/docs-site-rebuild/` 聚合证据（`task-1..13` 明细 + 截图）；在 `learnings.md` 记录“md-docs 复制债→features 单源”决策；Must NOT 在本次改 `docs/agent-platform` 需求文档（仅 README 级说明）
  Parallelization: Wave 3 | Blocked by: 10,13 | Blocks: —
  References (executor has NO interview context - be exhaustive): `web/README.md`、`server/README.md`、`learnings.md`、`.omo/evidence/` 目录约定
  Acceptance criteria (agent-executable): `web/README.md` 含 `features/docs-site` 且无 `components/docs` 旧路径；`.omo/evidence/docs-site-rebuild/` 下含 13 份 `task-*.md` 与至少 3 张 `playwright` 截图；`git log --oneline` 含 `docs-site` 前缀提交
  QA scenarios (name the exact tool + invocation): happy — `ls .omo/evidence/docs-site-rebuild` 列出 13+ 文件，证据 `.omo/evidence/docs-site-rebuild/task-14-docs.md`；failure — `grep -r "components/docs" web/README.md` 仍命中旧路径则失败
  Commit: Y | docs(docs-site): update readme and evidence

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Scope fidelity

## Post-rebuild deployment fix (T15 — 阻塞 docker compose 构建)

> 背景：T1 删除 `web/src/components/docs/**` 后，`web/Dockerfile` 与 `web/scripts/sync-runtime.mjs` 仍引用旧路径，
> `docker compose up -d --build` 在 `[web build 5/12]` 报 `COPY web/src/components/docs/proto-shared ... not found`。
> 新沙箱 `prototype-sandbox.tsx` 已改为 stub 解析共享模块（`SHARED_NS` 返回 `export const dummy=1`），
> `PROTO_SHARED_SOURCES` 无运行时消费方，故生成链仅需兼容即可，无需恢复旧源文件。

- [x] 15. 修复 web 构建引用的 proto-shared 旧路径
  What to do / Must NOT do:
  1. `web/Dockerfile`（第 10-11 行）：删除注释 `# postinstall (sync-runtime.mjs) 需要读取 proto-shared 源码生成 sources.generated.ts` 与 `COPY web/src/components/docs/proto-shared ./web/src/components/docs/proto-shared` 两行。⚠️ 依赖第 2 点的 `mkdirSync(sharedDir, {recursive:true})` 兜底：否则 `npm ci` 的 postinstall 期间 `web/src/features/docs-site/proto-shared/` 尚不存在（`COPY web/ ./web/` 在第 13 行、`npm ci` 之后），`writeFileSync(sources.generated.ts)` 会抛 `ENOENT` 使 `npm ci` 失败。
  2. `web/scripts/sync-runtime.mjs`（第 26 行）：`const sharedDir = join(webRoot, "src", "components", "docs", "proto-shared")` → `const sharedDir = join(webRoot, "src", "features", "docs-site", "proto-shared")`；在 `mkdirSync(vendorDir)` 附近补 `mkdirSync(sharedDir, { recursive: true })`；并将第 31-42 行的 6 个 `readFileSync` 改为逐文件 `existsSync` 守卫（缺失则 `console.warn` 跳过），确保 postinstall 绝不因源文件缺失而中断。
  3. Must NOT 恢复 `src/components/docs/**` 旧目录或旧源文件；Must NOT 改动 `web/src/features/docs-site/prototype-sandbox.tsx` 的 stub 逻辑；Must NOT 改 `web/package.json` 的 postinstall（仍为 `node scripts/sync-runtime.mjs`）。
  Acceptance criteria (agent-executable): `docker compose up -d --build` 全绿（web 镜像构建通过，postinstall 无 ENOENT）；`docker compose ps` 五服务 running；`grep -r "components/docs" web/Dockerfile web/scripts web --include="*.mjs"` 零命中（仅剩 postcss.config.mjs / globals.css 的注释提及，属无害历史说明，可留可清）。
  QA scenarios: happy — 构建日志 `[web] ... DONE` 且 `curl -s http://localhost:13001/` 返回 Next 页面；failure — 手动将 `sharedDir` 改回旧路径，`npm run sync:runtime --prefix web` 应警告缺文件而非抛 `ENOENT`；failure2 — 注释掉 `mkdirSync(sharedDir)` 后在干净 context 跑 `npm ci` 应复现 ENOENT（验证该兜底必要性）。
  Commit: Y | fix(docs-site): repair docker build proto-shared path after T1 removal

## Post-rebuild visual overhaul (T16 — 用户反馈"全面的丑"修复)

> 背景：用户反馈文档站"还是很丑啊，页面没有使用markdown渲染库吗？……总结就是全面的丑，和当前其它功能完全不搭"。
> 根因：docs-site 用 Tailwind slate 硬编码浅色类，游离在全应用 tokens 主题体系（`web/src/theme/tokens.ts` + `globals.css` CSS 变量，随 `.dark` 反转）之外。
> 修复：7 个渲染面全部 tokens 化 + markdown 富化（GFM 表格/代码块/引用等），双主题跟随。

- [x] 16. 视觉改造：docs-site 全部渲染面 tokens 化 + markdown 富化
  What to do / Must NOT do:
  1. `docs-markdown.tsx`：全部 slate 类 → tokens inline-style；富化 GFM 表格（table/thead/th/td + overflow-x 包裹）、代码块语言标签头、行内代码 pill、blockquote、链接（#2563EB 下划线）、strong/em/del、任务列表 checkbox、img、hr；mermaid 路径保留。
  2. `doc-explorer.tsx`/`page.tsx`/`prototype-panel.tsx`/`prototype-sandbox.tsx`/`device-frame.tsx`/`device-switcher.tsx`：tokens 化；响应式断点用 Tailwind 类（`hidden lg:flex`/`md:flex-row`/`sm:grid-cols-2 lg:grid-cols-3`），**不得**写 `@media` 键进 inline style（React 静默忽略）。
  3. 保留全部 e2e testid 契约（`docs-shell`/`docs-tab-protos`/`proto-frame`/`proto-error` 等）。
  4. Must NOT 引入新依赖（无 shiki/prism 高亮）；Must NOT 改 `tokens.ts`/`globals.css` 本身；Must NOT 改 server。
  Acceptance criteria (agent-executable): `npx tsc --noEmit -p web/tsconfig.json` 零错；`npm run lint --prefix web` 无新增 error；`docker compose up -d --build` 通过；Playwright 计算样式断言浅色（h1=neutral-900/thead=neutral-50/th=neutral-700）与深色（h1=neutral-50/thead=neutral-900/th=neutral-200）双主题正确；`grep -r "data-testid" web/src/features/docs-site` 含 `docs-shell`/`proto-frame`。
  QA scenarios: happy — 浏览器 QA 双主题断言全绿，证据 `.omo/evidence/docs-site-rebuild/task-16-visual-overhaul.md`；failure — 深色下 thead 仍为浅色 `#f8fafc` 则失败。
  Commit: N（与既有 docs-site 工作同批，未单独提交）

## Commit strategy
- 每 todo 一提交，前缀 `feat|fix|chore|test|docs(docs-site):`，Wave 内可并行提交但依赖波需串行；`T1` 删除提交需含证据文件 `docs-site-rebuild-deletion.md`
- 最终 `F1-F4` 验证波不产生业务提交，仅产出 `.omo/evidence/docs-site-rebuild/verification.md`
- 分支：`feat/docs-site-rebuild`（由 worker 按 `docs-site-rebuild` plan 创建），PR 标题 `feat(docs-site): rebuild from scratch aligned to md-docs`
- 回滚：任一 todo 失败回滚当波提交（`git revert` 当波 commit），不影响已合入的前波

## Success criteria
- `web/src/components/docs` 旧复制代码零残留（`grep -r "components/docs" web --include="*.tsx"` 零命中，`ls web/src/features/docs-site` 10 文件存在）
- 文档视图与原型视图在 `taskId` 作用域下与 md-docs 功能一致：文档树/章节/轮询/Mermaid 渲染、原型列表/网格/DeviceFrame 预览/esbuild 沙箱隔离、白名单防穿越、空/错态重试、`?doc=&?proto=` 深链均通过 `playwright` e2e
- 文档内原型内嵌（` ```prototype/@prototype/prototype-list`）按 task 原型解析生效，块级缩放/高度自适应/全屏/跳转可用
- 类型与质量门全绿：`npx tsc --noEmit -p web/tsconfig.json`、`npx tsc --noEmit -p server/tsconfig.json`、`npm run lint --prefix web`、`npm run lint --prefix server`、`npm test --prefix server -- --runInBand`、`npx playwright test web/e2e/docs-site.spec.ts`
- 无新增 DB 表/不改存储模型、无 `virtual:md-docs-*`/`vite` 引入、无 `hash` 路由回归，`web/README.md` 与证据目录已更新

