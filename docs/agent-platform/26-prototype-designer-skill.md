---
name: prototype-designer
description: 原型页面设计技能——按平台 TSX 规范编写 React 组件原型并提交，文档站「原型」tab 编译渲染（无需改代码）。适用于任务需要产出原型/UI 稿/页面示意时。
version: 2.0.0
allowed-tools:
  - task_context
  - submit_artifact
  - read_file
---

# 原型设计（Prototype Designer）— TSX

## 目标

为当前任务设计并提交**可渲染的 TSX 原型页面**：编写 React 组件（TSX），经 `submit_artifact` 提交后，文档站「原型」tab 自动编译并渲染。**无需改动任何代码、无需重新部署。**

## 工作流程

1. **分析需求**：用 `task_context` 获取任务标题/描述/背景，明确原型要展示什么（业务页面、管理界面、流程示意等）。
2. **设计结构**：规划页面布局与组件组合（原生 HTML 元素 + 平台共享组件 + tailwind 样式）。
3. **编写 TSX**：按下方规范生成 `<kebab-name>/index.tsx` 文件。
4. **自检**：组件导出 meta + default function、仅使用允许的 import、语法合法。
5. **提交**：`submit_artifact`（type=file）提交原型文件（见「提交方式」）。
6. **确认**：可经 `read_file` 复查已提交文件内容。

## TSX 规范（v2）

### 文件结构

每个原型 = 一个目录 `<kebab-name>/`，内含 `index.tsx`：

```
prototypes/
  my-dashboard/
    index.tsx        ← 唯一文件
  login-page/
    index.tsx
```

### 组件格式

```tsx
export const meta = {
  id: "my-dashboard",        // 必填：唯一英文短名（kebab-case，= 目录名）
  name: "仪表盘",             // 必填：文档站列表展示名
  device: "desktop",          // 可选："desktop"（默认）| "mobile"
};

export default function MyDashboard() {
  return (
    <div className="min-h-full bg-slate-50 p-6">
      {/* 页面内容 */}
    </div>
  );
}
```

### 可用平台共享库（`@proto/shared`）

通过 `import { ... } from "@proto/shared"` 引入以下组件：

**业务组件（components）：**
| 组件 | 说明 |
|---|---|
| `AgentAvatar` | Agent 头像（含角色色环） |
| `AgentBadge` | Agent 角色徽章（产品/架构/开发/测试） |
| `ChatBubble` | 聊天气泡（user/agent/system） |
| `MessageInput` | 消息输入框 |
| `StatusBadge` | 任务状态徽章（进行中/待验收/已完成/已归档） |
| `Sidebar` | 侧边导航栏 |
| `TopBar` | 顶部导航栏 |
| `EmptyState` | 空状态占位 |

**导航组件（nav）：**
| 组件 | 说明 |
|---|---|
| `NavDock` | 底部 Dock 导航（含图标+标签） |
| `NavTopBar` | 顶部导航栏（含项目名+用户头像） |
| `CmdKPanel` | Command-K 快捷面板 |

**UI 组件（ui）：**
| 组件 | 说明 |
|---|---|
| `UiStatusBadge` | 通用状态标签（tone 版） |
| `ProgressBar` | 进度条 |
| `Avatar` | 用户头像（文字首字母） |
| `Button` | 按钮 |
| `IconSearch` / `IconPlus` / `IconEdit` / `IconMore` | 图标 |
| `IconChevronLeft` / `IconChevronRight` | 箭头图标 |
| `IconLock` / `IconClock` / `IconRefresh` | 功能图标 |
| `IconMonitor` / `IconSmartphone` | 设备图标 |

**样式 token（styles）：**
| 导出 | 说明 |
|---|---|
| `roles` | 角色色阶（product/architect/developer/tester） |
| `statusColors` | 状态色阶（进行中/待验收/已完成/已归档） |
| `neutral` / `space` / `radius` / `fontSize` / `shadow` | 设计 token |

### 样式规范

- 使用 **tailwind CSS 类**（平台已内置）。
- 品牌色阶：`brand-50`/`brand-100`/…/`brand-600`/`brand-700`（主色）。
- 语义色阶：`success-*`（成功）、`warning-*`（警告）、`danger-*`（危险）、`info-*`（信息）。
- 可用原生 HTML 元素（`div`/`span`/`table`/`form` 等）+ tailwind 类自由组合。
- 可嵌套使用平台共享组件（如 `<NavDock />` + 自定义内容区）。

### 规范约束

- **必须**：导出 `meta`（含 id/name）+ `export default function`。
- **仅允许 import**：`@proto/shared` + `react`（useState 等）+ 原生元素。
- **禁止**：import 其他第三方库/Node 模块/平台 API/网络请求/本地存储。
- **交互**：可用 `useState` 实现客户端状态（tab 切换、表单输入等）；无服务端交互。
- **数据为演示值**：原型是静态展示/演示，数据写示例值（如"1286""进行中"），不要留空。
- **命名**：目录名 `id` 用英文 kebab-case（`my-dashboard`）；`name` 可用中文。

### 示例（最小完整原型）

```tsx
import { StatusBadge } from "@proto/shared";
import { useState } from "react";

export const meta = {
  id: "task-overview",
  name: "任务总览",
};

export default function TaskOverview() {
  const [activeTab, setActiveTab] = useState("all");

  return (
    <div className="min-h-full bg-slate-50 p-6">
      <h1 className="text-xl font-semibold text-slate-900">任务总览</h1>
      <p className="mt-1 text-sm text-slate-500">当前迭代演示</p>

      <div className="mt-6 grid grid-cols-4 gap-3">
        {[
          { label: "总任务", value: "1286" },
          { label: "运行中", value: "8", trend: "+2" },
          { label: "待审批", value: "6" },
          { label: "已完成", value: "1272" },
        ].map((item) => (
          <div key={item.label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-2xl font-semibold text-slate-900">{item.value}</p>
            <p className="text-xs text-slate-500">{item.label}</p>
            {item.trend && <p className="text-[11px] font-medium text-green-600">{item.trend}</p>}
          </div>
        ))}
      </div>

      <div className="mt-6 flex border-b border-slate-200">
        {["all", "active", "done"].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium ${
              activeTab === tab ? "border-b-2 border-brand-500 text-brand-600" : "text-slate-500"
            }`}
          >
            {tab === "all" ? "全部" : tab === "active" ? "进行中" : "已完成"}
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white">
        {["文档站改造", "MCP 接入", "Agent 优化"].map((name) => (
          <div key={name} className="flex items-center justify-between border-b border-slate-100 px-4 py-3 last:border-0">
            <span className="text-sm text-slate-900">{name}</span>
            <StatusBadge status="进行中" />
          </div>
        ))}
      </div>
    </div>
  );
}
```

## 提交方式

- **目录结构**：原型文件为 `<kebab-name>/index.tsx`（id 与目录名一致）。
- **fileRef**：`index.tsx` 在工作目录的路径（绝对路径）。
- **调用**：

```
submit_artifact { taskId: <任务ID>, selfInstanceId: <你的实例ID>, type: "file", title: "<显示名>", fileRef: "<工作目录>/<kebab-name>/index.tsx" }
```

提交成功后，文档站「原型」tab 自动出现该原型（列表按名称展示，点击编译渲染）。

## 文档内嵌入原型

原型提交后，可在 markdown 文档中**嵌入可交互的原型预览**，支持三种嵌入语法。文档站会自动编译原型并在 iframe 中渲染，用户可切换设备（PC / 移动端）查看效果。

### 块级嵌入（推荐）

在 markdown 中使用 3 反引号 `prototype` 围栏，内部为 YAML 格式的 key: value 行：

````markdown
```prototype
id: my-dashboard
title: 仪表盘预览    # 可选，覆盖原型名称
device: desktop      # 可选：desktop | mobile，默认 desktop
height: 520          # 可选：iframe 最大高度 px，默认 640
```
````

**参数说明：**

| 参数 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 原型 ID（与 `meta.id` 一致） |
| `title` | 否 | 显示标题（默认使用原型 `name`） |
| `device` | 否 | 初始设备：`desktop`（默认）或 `mobile` |
| `height` | 否 | iframe 最大高度（px），默认 640 |

**渲染效果：** 原型在 DeviceFrame 中渲染，顶部显示标题和设备切换按钮（PC / 移动端），用户可交互操作原型。

### 原型清单

使用 `prototype-list` 列出当前文档引用的全部原型：

````markdown
```prototype-list
```
````

清单以链接形式展示所有引用的原型，点击可跳转到原型视图。如需内嵌所有原型（而非链接列表），添加 `embed: true`：

````markdown
```prototype-list
embed: true
```
````

### 行内引用

使用 `@prototype[id]` 语法在文本中嵌入原型引用标签：

```markdown
查看效果：@prototype[my-dashboard]（点击跳转原型视图）
```

渲染为可点击的蓝色标签，点击后跳转到该原型的全屏预览视图。

### 嵌入规则

1. **按项目解析**：嵌入的原型必须属于当前项目（与文档同目录下的 `prototypes/`），引用其他项目的原型会提示"原型不存在于当前项目"
2. **反引号规则**：解析器只识别**恰好 3 个反引号**的 `prototype` 围栏；展示标记写法本身时，必须用 4+ 反引号包裹
3. **设备切换**：嵌入的原型支持实时切换 PC / 移动端视图，无需重新加载

### 示例

````markdown
## 功能演示

以下是任务管理原型的预览：

```prototype
id: task-management
title: 任务管理界面
device: desktop
```

也可以查看移动端效果：

```prototype
id: task-management
title: 任务管理（移动端）
device: mobile
height: 720
```

本文档引用的原型清单：

```prototype-list
```
````

## 原型实现方式

### 数据链路

```
TSX 源码 (<kebab-name>/index.tsx)
  → submit_artifact (type=file, 写入 uploads/<uuid>.tsx)
  → DocsMirrorService.syncTask 提取 *.tsx → docs-root/<taskId>/prototypes/<slug>/index.tsx
  → GET /docs-site/:taskId/prototypes 列表 + GET /docs-site/:taskId/prototypes/<file> 原文
  → PrototypeSandbox 拉取源码 → esbuild-wasm 编译 → iframe srcdoc 渲染
```

- **镜像层**：`syncTask` 扫描该任务 `type=file` 且 `contentRef` 以 `.tsx` 结尾的产出物当前版本，按 `prototypeSlug` 写入 `docs-root/<taskId>/prototypes/`，旧 `.md` / `.prototype.json` 镜像共存；支持全量重建（`rebuildAll`，启动时触发）。
- **文档注册表**：`buildRegistry` 只收录 `.md` 产出物，`listPrototypes` 扫描 `prototypes/<name>/index.tsx` 目录并通过 `contentRef → artifactId` 反查关联产出物。
- **产出物版本**：镜像始终为 `currentVersion` 的正文，历史版本不入站；删除产出物后镜像幂等清理。

### 编译渲染

由 `web/src/features/docs-site/prototype-sandbox.tsx` 完成：

1. **拉取**：`GET /docs-site/:taskId/prototypes/<file>`（`Authorization: Bearer <token>`）+ `/vendor/react-runtime.js`。
2. **编译**：`esbuild-wasm`（`initialize({ wasmURL: "/esbuild/esbuild.wasm" })`），`bundle: true, format: "iife", globalName: "__ProtoModule", jsx: "transform", target: "es2017"`，插件 `protoCompilePlugin` 将 `react` / `react-dom` / `@proto/shared` / `@proto/shared/*` / `_shared/*` / `@md-docs/*` 分流到虚拟命名空间（React 来自 `globalThis`，`@proto/shared` 置空占位，不走网络）。
3. **装配 srcdoc**：`buildSrcdoc(runtimeJs, bundleCode, cssText)` 拼接 `<!DOCTYPE html>`：`cdn.tailwindcss.com` + `baseStyle` + 父页面 `collectCss()` + `runtimeJs` + `bundleCode` + `renderScript`（取 `__ProtoModule.default` 或 `Component`，`ReactDOMClient.createRoot` / `ReactDOM.render` 兼容分支）。
4. **挂载**：`iframe sandbox="allow-scripts" srcDoc={srcdoc}`；`isFramed` 时固定 `height:100%`，否则监听 `postMessage({ type:'proto-height' })` + `ResizeObserver` 自适应高度（120–4096px 钳制）。

### 样式与布局

- **Tailwind**：iframe 内通过 `cdn.tailwindcss.com` 即时编译类名，支持 `brand-*` / `success-*` / `warning-*` / `danger-*` / `info-*` 等语义色；同时注入父页面已加载样式表（`collectCss` 遍历 `document.styleSheets`）。
- **DeviceFrame**（`device-frame.tsx`）：`desktop` 为浏览器窗体（红黄绿三点 + 地址栏 + `spec.width × spec.height`，默认 1280×800）；`mobile` 为手机外壳（圆角 + 刘海 + 信号/电量图标 + `390×844`），由 `DEVICE_SPECS` 定义，`DeviceSwitcher` 在原型头与嵌入卡片中切换。
- **约束**：iframe 仅 `allow-scripts`，无网络/存储访问；原型内禁止第三方库与 API 调用，所有数据为静态演示值。

### 关联组件

| 组件/模块 | 职责 |
|---|---|
| `DocsMirrorService` | 镜像导出与重建（`syncTask` / `rebuildAll` / `listPrototypes` / `readPrototype`） |
| `DocsSiteController` | `registry` / `prd/:file` / `prototypes` / `prototypes/*` 四端点，JWT + 项目成员校验 |
| `PrototypePanel` | 「原型」tab：左侧列表 + 右侧 `DeviceFrame > PrototypeSandbox` 预览，支持删除（`DELETE /artifacts/:id`） |
| `PrototypeSandbox` | 编译 + iframe 渲染，含 loading / error 态 |
| `DeviceFrame` / `DeviceSwitcher` | 设备外壳与切换器 |

## 常见错误

| 错误 | 规避 |
|---|---|
| 缺少 `meta` 导出 | 必须 `export const meta = { id, name }` |
| 缺少 `export default function` | 必须默认导出 React 组件 |
| import 非允许模块 | 仅 `@proto/shared` + `react` + 原生元素 |
| 语法错误（JSX/TS） | 提交前确保 TSX 语法合法 |
| 数据留空 | 全部写演示值 |
| 嵌入原型不存在 | 确保 `id` 与原型 `meta.id` 一致，且原型属于当前任务（同 `taskId` 反查）；跨任务引用会渲染为黄底提示 |
