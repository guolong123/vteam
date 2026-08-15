# prototype-viewer — Orchestra 展示中心

Orchestra 通用任务编排平台的 UI 原型与文档展示中心。顶部两个主入口：

- **原型**：展示所有注册的原型页面（分组导航 + PC/移动端设备模拟 + URL hash 直达）
- **文档**：多文档阅读器（左侧文档列表 + 章节菜单，右侧文档内容；支持文档内嵌可交互原型）

## 快速开始

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc -b && vite build
npm run lint       # oxlint
```

## URL hash 路由

| hash | 视图 |
|---|---|
| 空 / `#protos` / `#<proto-id>` | 原型视图（`#flow-editor` 直达某原型） |
| `#docs` / `#prd`（旧） | 文档视图（默认第一个文档） |
| `#docs/<doc-id>` | 文档视图 + 指定文档（如 `#docs/architecture`） |

## 新增原型页面（3 步）

1. 在 `src/prototypes/<name>/` 下创建组件，接收 `PrototypeRenderProps`（`device` / `deviceWidth`），
   按 `device === "mobile"` 做基础响应式适配（如表格 → 卡片）。
2. 在 `src/prototypes/registry.ts` 中 import 并追加一条
   `{ meta: { id, name, group?, description? }, Component }`，`id` 即 URL hash。
3. 完成——自动出现在分组导航中，`#<id>` 直达，无需改 App / 导航组件。

可复用 `src/prototypes/_shared/ui.tsx` 的 `StatusBadge` / `ProgressBar` / `Avatar` / `Button` 及图标，
设计 token（brand / success / warning / danger / info 语义色）在 `src/index.css` 的 `@theme` 中定义。

## 文档阅读器与原型标记

文档注册在 `src/prd/docs.ts`（当前：需求规格 PRD / 架构设计 / 设计决策 ADR），
文件位于 `public/prd/`（由 `docs/` 同步而来）。进入文档视图后：
- 左侧上方：**文档列表**（切换文档）
- 左侧下方：**当前文档的章节菜单**（点击滚动定位，滚动高亮当前章节）
- 右侧：文档内容

文档中可用三类标记内嵌原型（规范见 PRD 4.11.1 节）：

````markdown
# 块级内嵌（推荐）
```prototype
id: flow-editor
title: 流程编排画布   # 可选
device: desktop       # 可选：desktop | mobile
height: 520           # 可选：内嵌高度 px
```

# 清单（列出本文档引用的全部原型）
```prototype-list
```

# 内联引用
@prototype[agent-list]
```
````

- 内嵌原型支持：PC/移动端切换、**全屏展示**（遮罩层）、**跳转到原型视图**
- 说明性示例需用 4 个及以上反引号包裹（```` ```prototype ````），解析器会跳过文档示例区。
- 同步文档：`cp ../docs/*.md public/prd/`

## 目录结构

```
src/
├── App.tsx                    # 应用壳：顶层双入口（原型/文档）+ hash 路由
├── components/
│   ├── DeviceFrame.tsx        # 设备模拟器（PC 窗口 / 手机边框）
│   ├── DeviceSwitcher.tsx     # PC / 移动端切换器
│   ├── PrototypeNav.tsx       # 原型分组导航
│   └── PrototypeEmbed.tsx     # 文档内嵌原型组件（设备切换/全屏/跳转）
├── prd/
│   ├── docs.ts                # 文档注册表（多文档列表）
│   ├── DocExplorer.tsx        # 文档阅读器（文档列表 + 章节菜单 + 内容）
│   ├── parser.ts              # 原型标记解析器（占位符替换）
│   └── PrdMarkdown.tsx        # 文档 Markdown 渲染（unknownHandler + components 拦截）
└── prototypes/
    ├── types.ts               # 原型接口契约（PrototypeDef / PrototypeRenderProps / DEVICE_SPECS）
    ├── registry.ts            # 原型注册表
    └── _shared/ui.tsx         # 共享 UI 组件
```
