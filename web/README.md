# web — vteam 前端

vteam 的 Web 控制台，基于 Next.js App Router。面向任务、虚拟团队与协作过程的全部交互界面。

## 技术栈

- Next.js（App Router）+ React + TypeScript
- 设计 token 集中管理于 `src/theme/tokens.ts`（颜色 / 间距 / 圆角 / 字号，组件内不散落魔法值）
- SSE 实时消息（流式输出两阶段 loading）
- Playwright e2e 测试

## 页面结构

`app/` 下按路由组织：

```
app/
├── login/  register/          # 认证
├── page.tsx                   # 首页
└── (main)/                    # 主应用（登录后）
    ├── tasks/                 # 任务列表 / 创建 / 详情（看板、团队成员与实例）
    ├── messages/              # 群聊 / 私聊（SSE 流式输出）
    ├── issues/                # Issue 列表与管理
    ├── board/                 # 任务看板
    ├── agents/                # Agent 模板 / 自定义 / 克隆管理
    ├── models/                # 模型目录与可用性
    ├── workers/               # Worker 节点管理
    ├── tools/  skills/        # 工具与技能管理
    ├── projects/  users/  roles/   # 项目、用户、权限
    ├── git-repos/             # 仓库与凭证
    ├── docs/[taskId]/          # 文档站（任务级，features/docs-site）
    └── artifacts/             # 产出物 / 文档库
```

## 文档站（docs-site-rebuild）

- 单源模块 `src/features/docs-site/`（`parser/docs-markdown/doc-explorer/device-frame|switcher/prototype-sandbox|panel/hooks/mermaid-block/types`），零复用 `md-docs` 源码
- 数据源 `GET /docs-site/:taskId/registry|prd/:file|prototypes|prototypes/*`（JWT + 成员校验，白名单防穿越），`registry` 30s 轮询，`taskId` 单作用域（`docs/<project>` 多项目已裁剪）
- 双视图：文档（三栏 `w-64|flex-1|w-60` + 窄屏 pill + 章节 `IntersectionObserver`）与原型（列表+网格+`DeviceFrame` 预览，`esbuild-wasm + iframe sandbox(allow-scripts)`）
- 文档内原型内嵌：` ```prototype / ```prototype-list / @prototype[]` 按任务原型解析（缩放/高度自适应/全屏/跳转）
```

## 主题

`src/theme/tokens.ts` 定义了五类 Agent 角色的语义色与任务状态四色：

| 角色 | 语义色 |
|------|--------|
| 产品经理 | 蓝（#3B82F6） |
| 项目经理 | sky（#0EA5E9） |
| 架构师 | 紫（#8B5CF6） |
| 开发者 | 绿（#10B981） |
| 测试 | 橙（#F59E0B） |

任务状态：进行中（蓝）/ 待验收（琥珀）/ 已完成（绿）/ 已归档（灰）。

## 本地开发

前置：Node.js >= 18，后端 server 需可访问。

```bash
cd web
npm install
npm run dev        # 开发模式（Turbopack），默认 3001
```

## 构建

```bash
npm run build      # 生产构建
npm run start      # 启动生产服务
```

Docker 部署时使用 standalone 输出，构建 ARG 注入 `API_PROXY_TARGET`。

## 测试

```bash
npm run lint          # ESLint
npm run test:e2e      # Playwright e2e（配置见 playwright.config.ts）
```

e2e 用例位于 `web/e2e/`，覆盖登录、页面可达性、SSE 消息、MCP 状态与性能基线等场景。
