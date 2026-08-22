---
slug: docs-site-rebuild
status: awaiting-approval
intent: clear
review_required: false
pending-action: write .omo/plans/docs-site-rebuild.md
approach: 零复用 md-docs 代码，按 vteam 三端架构（Next.js App Router + NestJS + Prisma 镜像派生视图）从0重建文档站，功能对齐 md-docs 的“文档展示+原型展示”双视图，删除 web 侧所有直接复制的 md-docs 组件与兼容 hack，以 vteam 设计 token/状态/鉴权/测试基建为唯一事实源
---

# Draft: docs-site-rebuild

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
| id | outcome | status | evidence path |
| --- | --- | --- | --- |
| C1 | server 镜像与数据面契约定型（registry/prd/prototypes） | active | server/src/docs-site/*, server/src/artifacts/artifacts.service.ts |
| C2 | web 文档视图重建（文档树 + 内容 + 章节菜单） | active | web/app/(main)/docs/[taskId]/page.tsx, web/src/components/docs/* |
| C3 | web 原型视图重建（列表+网格+DeviceFrame 预览+iFrame 沙箱渲染） | active | web/src/components/docs/prototype-panel.tsx, prototype-tsx-viewer.tsx, device-frame.tsx, proto-shared/* |
| C4 | 共享能力与样式基建（tokens/Mermaid/鉴权/错误态/删除与迁移） | active | web/src/theme/tokens.ts, web/lib/api.ts, web/src/components/docs/mermaid-block.tsx |
| C5 | 质量门与兼容性收敛（类型/测试/视觉/性能） | active | .omo/evidence/* |

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
| assumption | adopted default | rationale | reversible? |
| --- | --- | --- | --- |
| 路由形态 | 保留 Next.js App Router 文件路由 ` /docs/[taskId]?doc=&proto= & tab`，不引入 md-docs 的 ` #/p/<project>/...` hash 路由 | web 已是 Next.js 15 + Turbopack，hash 路由与 App Router、Link 预取、SEO、分享冲突；现有 `?doc=&proto=` 已被 e2e 覆盖 | 是（可改回 hash，但需重寫分享与深链） |
| 数据源 | 保留现有 server 镜像派生视图口径（`DocsMirrorService` + `docsRoot/<taskId>/` + `/docs-site/:taskId/registry\|prd/:file\|prototypes`），不直读 artifacts DB | 镜像=派生视图是权威设计 art_0000000026，支持白名单防穿越、启动重建、幂等覆盖；直读 DB 会重开权限/版本/去重问题 | 是 |
| 原型编译 | 保留 `esbuild-wasm + iframe sandbox(allow-scripts) + /vendor/react-runtime.js + collectCss 注入` 方案，不改服务端编译 | 已在 web 验证可行，安全隔离为 null origin，且 PROTO_SHARED_SOURCES 生成链路与 postinstall 对齐；服务端编译需新增构建服务与缓存 | 是 |
| 文档内原型内嵌 | v1 不恢复 md-docs 的 ` ```prototype / prototype-list / @prototype[]` 文档内嵌能力，保持 DocsMarkdown 纯渲染 | vteam 当前 DocsMarkdown 已去占位符插件，恢复它需重新引入 parser/remark 插件与项目级原型解析，复杂度与收益不成比例；可作为 v1.1 | 是（后续加） |
| 样式基建 | 统一走 `web/src/theme/tokens.ts` + Tailwind 4（不引入 md-docs 的 `@tailwindcss/vite` 与 `index.css @theme`） | tokens 是 web 单一事实源，混用两套 theme 会导致暗色/圆角/阴影不一致 | 是 |
| 多项目抽象 | 文档站以 `taskId` 为唯一作用域，不引入 md-docs 的 `docs/<project>` 多项目抽象 | vteam 的项目=task 归属，server 镜像按 taskId 隔离已满足；多项目会与现有项目/任务模型冲突 | 是 |
| 删除范围 | 删除 `web/src/components/docs/*` 中所有从 md-docs/prototype-viewer 复制的文件（含 device-frame/device-switcher/proto-shared 拷贝），按新结构重建 | 直接对应“不复用代码，删后重建”诉求，避免渐进修补的兼容债 | 否（删除不可逆，需用户确认） |

## Findings (cited - path:lines)

**md-docs 核心能力（功能对标基线）**
- 项目抽象：`docs/<project>/**.md` 递归收集，`_meta.md` 定义项目元信息，站点首页 `docs/README.md` — `md-docs/src/docs/scanner.ts:6-35,146-232`；项目排序 order+id，`PROJECTS` 单例 `scanner.ts:234`
- 文档元信息：frontmatter `title/order/kind/parent/description/id`，缺省推断 `displayName/order/parent`（子目录名即 parent，`index.md` 自身为父）— `md-docs/src/docs/scanner.ts:71-152,188-216`
- 文档层级：`projectRoots`/`childrenOf`/`projectDocPath` 一级树（两层）— `scanner.ts:242-276`，对应 `DocExplorer.tsx:33-36,128-206` 左侧树
- 原型归属项目：`docs/<project>/prototypes/<name>/index.tsx` 自动收集零注册，id=目录名 — `scanner.ts:218-223`，`plugin.ts:77-99` 的 `collectProtos`
- 内容注入：Vite 插件 `mdDocsPlugin` 运行时扫描 `virtual:md-docs-content`（`Map</docs/rel, 绝对路径>` 原文 JSON）与 `virtual:md-docs-protos`（`/@fs/` 静态 import 映射）— `md-docs/src/cli/plugin.ts:21-212`，并 `buildDepsAlias` 逐包 alias 到 `clientRoot/node_modules` — `plugin.ts:113-134`
- hash 路由：`#/p/<project>/docs/<id>` / `#/p/<project>/protos/<id>` / 空→项目列表，旧 `#docs/<id>` 兼容跳转 — `md-docs/src/App.tsx:40-91`；`ProjectView` 面包屑+`docs|protos` pill tab+DeviceSwitcher — `ProjectView.tsx:52-131`
- DocExplorer 三栏：左文档树（父可折叠）+中内容+右章节菜单（从 raw 提 `##/###`，去重，IntersectionObserver 高亮，scrollIntoView）— `DocExplorer.tsx:69-257`；parser 三标记块级/清单/内联— `parser.ts:8-160`，`DocMarkdown` 通过 `placeholderPlugin+unknownHandler` 将占位转为自定义 mdast 并映射 `PrototypeEmbed/PrototypeList` — `DocMarkdown.tsx:27-210`；PrototypeEmbed 含自动缩放/高度自适应/全屏/跳转— `prototype-viewer/src/components/PrototypeEmbed.tsx:18-209`
- Mermaid：````mermaid 代码块→MermaidBlock（浅色 themeVariables, strict）— `md-docs/src/components/MermaidBlock.tsx`（与 `web/src/components/docs/mermaid-block.tsx:1-136` 同源）
- DeviceFrame：`desktop` 浏览器窗口 chrome / `mobile` 手机壳 chrome，固定 `DEVICE_SPECS.width/height`— `prototype-viewer/src/components/DeviceFrame.tsx:13-106`，md-docs 同款
- Prototype 预览：`ProjectProtos` 左原型列表+右 DeviceFrame 直接预览— `md-docs/src/docs/ProjectProtos.tsx`（已在 codegraph 中验证与 `PrototypeNav/DeviceFrame` 动态渲染链路）

**prototype-viewer 参考（抽取源头）**
- 顶栏双入口 `protos|docs` + hash 路由 `#<protoId>` / `#docs/<docId>`，registry 硬编码 `DOCS: DocDef[]` — `prototype-viewer/src/prd/docs.ts:26-446`（含 requirements/hld/dld 子文档 parent 链），`prototype-viewer/src/App.tsx:32-58`（parseHash 兼容 `prd` 旧 hash），DeviceFrame/Mermaid/PrototypeEmbed 完全同源

**vteam 当前文档站实现（待删重建对象）**
- 入口：`web/app/(main)/docs/[taskId]/page.tsx:1-183` — Client Component，面包屑+ `docs|protos` pill tab（对齐 md-docs ProjectView 视觉），`DocExplorer(taskId, initialDocId)` + `PrototypePanel(taskId, initialProtoId)` 懒加载，`?doc=&proto=` 定位，`protoCount` 徽标
- 文档视图：`web/src/components/docs/doc-explorer.tsx:41-360` — 复刻 md-docs DocExplorer 三栏但数据源改为 `GET /docs-site/:taskId/registry`（tanstack query 30s 轮询）+ `GET /docs-site/:taskId/prd/:file`（fetch Bearer），章节提取/高亮/滚动同 md-docs
- Markdown：`web/src/components/docs/prd-markdown.tsx:36-182` — 简化版，仅 `react-markdown+remark-gfm+MermaidBlock`，**已移除** parser 的 `prototype` 占位插件与 `PrototypeEmbed` 内嵌（与 md-docs 功能差）
- 原型视图：`web/src/components/docs/prototype-panel.tsx:36-253` — 列表+网格+DeviceFrame，外包空态/错误态；`prototype-tsx-viewer.tsx:27-486` — esbuild-wasm 编译+`PROTO_SHARED_SOURCES` 别名解析+`react` 虚拟模块+iFrame sandbox+collectCss 高度自适应，`prototype-safelist.ts` 追加 Tailwind 兜底
- 共享：`device-frame.tsx:22-106` / `device-switcher.tsx` / `proto-shared/*`（types/ui/styles/sources.generated.ts）均为 md-docs 口径的直接复制
- 服务端：`server/src/docs-site/docs-site.controller.ts:38-134` — 纯数据端点 `registry/prd/:file/prototypes/prototypes/*`，JWT+`assertMember` 项目成员校验；`docs-mirror.service.ts:25-378` — F1 镜像派生视图（artifacts当前版本→`docsRoot/<taskId>/(<slug>.md|prototypes/<slug>/index.tsx|.prototype.json)`，启动 rebuildAll，锁串行，toSlug/docIdFor 白名单）
- 兼容债表象（需重建收敛）：Next.js App Router 与 md-docs Vite hash/virtual-modules 模型不兼容（`virtual:md-docs-content`/`import.meta.glob`/`@md-docs` alias 在 web 无意义）；Tailwind 双 theme（`index.css @theme` vs `tokens.ts`）；`collectCss` 遍历 `document.styleSheets` 在 Next CSR/SSR 混合下易受跨源/样式丢失影响；`md-docs-check.mjs` 等脚本残留；`prototype-safelist.ts` 硬编码兜底难以维护

**架构约束（重建必须对齐）**
- web：Next.js 15.5 App Router + Turbopack，`src/theme/tokens.ts` 为设计 token 单源，`@tanstack/react-query`、`zustand`、`react-markdown+mermaid` 已在依赖 — `web/package.json:1-37`
- server：NestJS 10 全局前缀 `/api/v1`，Swagger `/api/v1/docs`，Prisma MySQL，模块按 `server/src/docs-site/*` 组织 — `server/package.json`；鉴权为全局 `JwtAuthGuard` + `CurrentUser`，`WORKER_TOKEN` 独立
- 质量基建：web `eslint + playwright e2e(single)`, server `jest --runInBand`, 无复用 md-docs 的 `oxlint/vite` 链

## Decisions (with rationale)
- 删除后重建而非渐进修补：md-docs 的 Vite 插件/virtual-modules/hash 路由与 vteam Next.js 架构本质不兼容，修补只会叠加 alias/样式/路由 hack（已出现 `collectCss` 跨源、`safelist` 兜底等问题），一次性按 vteam 架构重建可彻底清债
- 保留 server 镜像契约、重建 web 渲染层：镜像层是任务产出物的派生视图（art_0000000026），契约（registry shape: `id/name/kind/description/file/order`，白名单 `[a-z0-9_-].md/json` 与 `<name>/index.tsx`）已稳定且被 e2e 依赖，重建主料放在 web 以降低风险
- 功能对齐 md-docs 但按 task 作用域裁剪：md-docs 的“项目列表+项目视图”是 `docs/<project>` 多项目文件扫描的产物，vteam 的等价物是 `taskId` 作用域的单项目视图（任务详情→文档站），保留其双 tab（文档/原型）与三栏/网格体验，舍弃文件扫描与虚拟模块机制
- 原型渲染保留 iframe 沙箱：agent 产出为不可信 TSX，`sandbox="allow-scripts"` 的 null origin 隔离是唯一满足安全要求的方案，且编译链路已打通（`PROTO_SHARED_SOURCES` + `react-runtime.js`），重建时只做插件/样式提取的健壮性重构而非方案替换
- 样式单源化到 tokens：所有新组件禁用魔法色/间距，统一 `neutral/brand/radius/space/fontSize`，删除 Tailwind safelist 硬编码，回归可审计的 token 体系

## Scope IN
- 删除 `web/src/components/docs/*` 中所有从 md-docs/prototype-viewer 复制的代码（含 `device-frame.tsx`/`device-switcher.tsx`/`proto-shared/*`/`prototype-safelist.ts`/`prd-markdown.tsx` 旧实现等），并清理 `web/app/(main)/docs/[taskId]/page.tsx` 的兼容样式 hack
- 按 `web/src/features/docs-site/`（或 `web/src/modules/docs-site/`，以 web 既有分层为准）新建单源模块：`DocExplorer`（文档树+内容+章节）+ `DocsMarkdown`（react-markdown+remark-gfm+MermaidBlock）+ `PrototypePanel`（列表/网格/DeviceFrame）+ `PrototypeSandbox`（esbuild-wasm 编译+iFrame，替代 `prototype-tsx-viewer.tsx`）+ `DeviceFrame/Switcher`（按 tokens 重写）
- 统一数据hooks：`useDocsRegistry(taskId)` / `useDocContent(taskId,file)` / `usePrototypes(taskId)` / `usePrototypeSource(taskId,file)`，基于 `tanstack/react-query + api.get/fetch Bearer`，30s 轮询保留可配置
- server 侧仅做“契约加固”：补齐 `DocsMirrorService` 单测覆盖的缺口、补 `readMirrorDoc/listPrototypes/readPrototype` 边界与日志的最小改动，不重写镜像机制；如需删除 `docs-site.constants` 的 `DEFAULT_DOCS_ROOT/resolveDocsRoot` 等仅做命名/注释对齐
- 视觉与交互对齐 md-docs：面包屑 `h-9` + pill tab `h-11` + 三栏 `w-64|flex-1|w-60(lg)` + 窄屏 pill 横滑，品牌色选中态 `brand-50/700`，kind 徽标与层级缩进保留
- 质量门：`tsc --noEmit` + `eslint` + `jest`（server）+ `playwright`（web 文档站深链）+ 暗色/空态/错误态视觉回归
- 文档与清理：删除 `check-md-docs.mjs` 等残留脚本的文档站相关检查，或迁移为新路径检查

## Scope OUT (Must NOT have)
- 不在本次重建中引入文件系统扫描（`import.meta.glob`/`virtual:md-docs-*`/`plugin.ts`）或把 `md-docs` 作为依赖/子进程拉起
- 不恢复文档内 ` ```prototype / prototype-list / @prototype[]` 内嵌渲染（v1 明确不做，避免 remark 插件与项目级原型解析回退）
- 不改 server 存储模型（不新增 DB 表、不改 artifacts 表结构、不把镜像改为直读 DB）
- 不引入新的运行时/构建工具（不切 `oxlint`、不引入 `vite` 到 web、不新增除 `esbuild-wasm/mermaid/react-markdown` 外的依赖）
- 不做多项目（`docs/<project>`）抽象与站点级项目列表页（vteam 作用域是单 task）
- 不在 web 引入 hash 路由或全局状态重构（不新增 `zustand` docs store，除非现有局部 state 确实无法满足）
- 不改动 `worker`/`platform-mcp`/`realtime` 等无关模块

## Open questions
| question | why it matters | owner decision? | adopted default if unanswered |
| --- | --- | --- | --- |
| 删除范围是否包含 `server/src/docs-site/*` 全量重写，还是仅加固契约？ | 用户原话“删除现有代码后重建”存在歧义，重写服务端会扩大风险与迁移成本 | 是 | 仅加固契约，不重写镜像服务（除非审批时明确要） |
| 是否接受 v1 暂不恢复文档内原型内嵌（` ```prototype` 块） | 影响 md-docs 功能对齐度的定义与 e2e 覆盖 | 是 | v1 不恢复，列为 v1.1 |
| 原型沙箱是否可接受保留 `collectCss` 方案（遍历 styleSheets 注入 iframe），或要求改为构建期抽取固定 CSS 文件 | 关系到暗色/跨源样式丢失的根治程度 | 是 | 先做健壮性加固（try/catch+去重保留），后续单独立项抽 CSS |
| 新模块落位 `web/src/features/docs-site` 还是 `web/src/components/docs-site` / `web/src/modules/docs-site` | 需对齐 web 既有分层约定，避免新旧并存两套目录 | 是 | `web/src/features/docs-site`，并在 page.tsx 以 barrel 导出收敛 import |

## Approval gate
status: awaiting-approval
approach: 删后重建、契约保留、web单源重写：保留 server DocsMirror 派生视图与 /docs-site/* 契约，仅重建 web 渲染层到 web/src/features/docs-site 单模块，剔除所有 md-docs 复制代码与 Vite 虚拟模块 hack，按 tokens 统一视觉与交互，功能对齐 md-docs 双视图但以 taskId 单作用域裁剪
next-action: 待用户显式批准后，执行 scaffold 创建 .omo/plans/docs-site-rebuild.md 并 APPEND 完整 Todos
<!-- Durable gate: on resume, read this field and continue at brief/plan creation; do not re-explore. -->

