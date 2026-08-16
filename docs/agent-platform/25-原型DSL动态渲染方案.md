# 原型 DSL 动态渲染方案（v1）

> 决策（用户确认方案 A）：agent 自行输出原型 DSL 文件 → 文档站原型 tab 动态扫描 + 通用渲染器渲染，**无需改代码/重构建**。
> 替代静态原型注册表（web/src/components/docs/prototypes/registry.ts 22 个编译期组件，删除）。

## 链路

```
agent submit_artifact (type=file, *.prototype.json)
  → 服务端 docs-mirror 镜像到 <docsRoot>/<taskId>/prototypes/<name>.json
  → GET /api/v1/docs-site/:taskId/prototypes（列表）
  → GET /api/v1/docs-site/:taskId/prototypes/:file（内容）
  → web 文档站「原型」tab：拉列表 → PrototypeRenderer（DSL → React 组件树）
```

## DSL v1 规范（JSON）

```jsonc
{
  "id": "string",                  // 唯一 id（kebab-case，= 文件名）
  "name": "string",                // 显示名（导航/列表）
  "description": "string",         // 可选
  "pages": [                       // 一个原型可多页（顶部 tab 切换）
    {
      "title": "string",
      "sections": [                // 自上而下区块
        { "type": "header", "title": "…", "subtitle": "…" },
        { "type": "stats", "items": [ { "label": "…", "value": "…", "trend": "…" } ] },
        { "type": "cards", "items": [ { "title": "…", "description": "…", "status": "success|warning|danger|info", "badge": "…" } ] },
        { "type": "table", "columns": [ { "key": "a", "label": "列A" } ], "rows": [ { "a": "值" } ] },
        { "type": "list", "items": [ { "title": "…", "description": "…" } ] },
        { "type": "form", "fields": [ { "label": "…", "type": "text|textarea|select", "options": ["…"], "placeholder": "…" } ], "submitLabel": "提交" },
        { "type": "tabs", "tabs": [ { "label": "…", "sections": [ /* 嵌套 sections */ ] } ] },
        { "type": "markdown", "content": "…" },
        { "type": "nav", "items": [ { "label": "…", "active": true } ] }
      ]
    }
  ]
}
```

- 组件集 v1：header / stats / cards / table / list / form / tabs / markdown / nav（展示型 + 轻交互：tab 切换、表单输入、折叠）
- 未知 type 的 section → 渲染为占位卡片（不崩溃，显示 type 名）
- 交互均为客户端状态（无服务端写操作），agent 产出为静态展示/演示数据

## Agent 产出引导

- agent 通过平台 MCP `submit_artifact`（type=file）提交 `*.prototype.json`（或附原型说明文档）
- 文档站原型 tab 自动列出该任务全部原型 DSL 文件并渲染
- 无需改动 web 代码 / 无需重新构建
