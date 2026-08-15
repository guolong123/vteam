<!-- 子文档：对应主 PRD 4.3 章节，由 docs/requirements.md 拆分扩展 -->

# 4.3 Skill 管理（需求设计说明）

## 模块概述

Skill 是可复用的能力包，由提示词模板、工具绑定与说明文档组成，可被多个 Agent 引用。本模块解决"如何沉淀和分发可复用能力"的问题：把"需求文档生成"、"测试用例生成"等高频能力封装为版本化的技能包，供 Agent 运行时加载，避免在每个 Agent 里重复维护提示词。

本模块与 4.2 Agent（Agent 通过 `skills` 字段引用技能包）、4.8 插件（Skill 可声明对插件的依赖）联动；Skill 市场属于生态能力，与 4.4 Blueprint 业务包共同构成"平台与业务分离"的加载层。

## 需求列表

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-301 | 提供 Skill 的创建 / 上传 / 版本管理（如"需求文档生成"、"测试用例生成"等技能包） | P1 |
| FR-302 | Skill 可声明所需工具与依赖（如引用 GitHub 插件），安装 / 卸载时自动校验依赖 | P1 |
| FR-303 | 提供 Skill 市场 / 目录，支持按命名空间发布与安装 | P2 |

## 详细设计说明

### Skill 资源结构（FR-301）

```yaml
apiVersion: orchestra.io/v1alpha1
kind: Skill
metadata:
  name: requirement-doc
  namespace: dev-team
spec:
  displayName: 需求文档生成
  category: prompt-template        # prompt-template | tool-binding | template
  version: 1.2.0                   # 语义化版本，发布后不可变
  description: 基于 issue 描述生成结构化需求文档
  prompt: |
    你正在撰写需求文档，请遵循以下模板结构...
  tools:
    - github.get_issue            # 技能运行时绑定的工具
    - github.create_issue_comment
  requiredPlugins:
    - name: github                 # 依赖的插件（FR-302）
      versionRange: ">=1.0.0"
  docs: |
    使用说明：本技能适用于需求分析阶段...
```

设计要点：

- Skill 按 `category` 分三类：提示词模板（纯 prompt）、工具绑定（提示词加工具组合）、模板（可参数化渲染的文档/代码骨架），三类在管理界面以分类栏区分展示。
- 版本为不可变发布制：新改动升版本号，历史版本保留可回滚；Agent 引用时声明版本范围（如 `1.2.x`），任务创建时解析为快照。
- Skill 归属于命名空间，命名空间内成员可引用；跨命名空间引用被 4.1 的隔离规则禁止。

### 依赖校验（FR-302）

安装与卸载两个方向都要做依赖校验：

- 安装 / 更新 Skill 时：校验 `requiredPlugins` 声明的插件在当前命名空间已安装且版本满足范围，否则安装失败并返回缺依赖清单。
- 卸载插件时：反向扫描引用该插件的 Skill 与 Agent，存在引用则阻止卸载，或要求先解除引用（fail-closed，不做静默破坏）。
- 工具绑定校验：`tools` 引用的工具必须来自已安装插件，Skill 发布前执行一次全量解析，任何悬空引用直接拒绝发布。

### Skill 市场与发布（FR-303）

- Skill 市场提供目录浏览、按命名空间发布 / 安装：发布即把 Skill 提升为市场可见（标记 published），安装即在目标命名空间创建副本。
- 市场内 Skill 与命名空间内 Skill 同名时提示覆盖或另建命名，避免静默冲突。
- 市场分发是 P2 能力：M1 阶段仅支持命名空间内创建与引用，市场形态在 M2 / M3 逐步落地。

### 运行时加载（与 4.2 / 4.7 联动）

- 任务创建时，Agent 引用的全部 Skill 被解析并合并为最终 prompt（Agent prompt 在前、Skill prompt 按引用顺序拼接），快照存入 Task 输入，保证执行结果可复现。
- Skill 绑定的工具并入 Agent 工具集时仍受 Agent 的 `allowedTools` 白名单约束（取交集），Skill 只声明"需要"，不能突破 Agent 权限边界。

### 与原型的关系

- `skill-manage` Skills 管理页：分类栏（提示词 / 工具绑定 / 模板）加技能卡片（版本 / 适用 Agent 数 / 发布状态），覆盖 FR-301 的创建与版本管理交互。
- `plugin-market` 插件市场：Skill 声明的 `requiredPlugins` 依赖在插件市场中体现安装 / 配置状态，与 FR-302 依赖校验对应。

## 界面原型

```prototype
id: skill-manage
title: Skills 管理
device: desktop
```

```prototype
id: plugin-market
title: 插件市场
device: desktop
```

| 原型页 | 对应需求 |
|---|---|
| skill-manage（Skills 管理） | FR-301 ~ FR-303 |
| plugin-market（插件市场） | FR-801 ~ FR-803 |

## 验收要点

- 创建 Skill 后能指定分类与版本，引用它的 Agent 在任务创建时加载到对应版本的快照 prompt。
- 发布一个声明依赖未安装插件的 Skill 被拒绝，并返回缺失插件清单。
- 卸载被 Skill 引用的插件时被阻止，提示先解除引用。
- 两个命名空间可各自安装同一市场 Skill 的不同版本，互不干扰。
- Skill 绑定的工具超出 Agent 白名单时，运行时按交集生效且不会报错中断任务。
