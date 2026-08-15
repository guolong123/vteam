<!-- 子文档：对应主 PRD 4.8 章节，由 docs/requirements.md 拆分扩展 -->

# 4.8 插件市场与第三方对接（需求设计说明）

## 模块概述

平台坚持"只做编排、不做实现"：具体执行（构建、部署、代码托管）交给专业系统完成，通过插件与协议对接。本模块解决"如何让第三方系统以统一方式接入平台"的问题：插件安装后注册一组 Tool 与配置项，Agent 通过工具白名单引用这些 Tool；MCP 协议让外部 Server 零改造接入；沙箱与凭证隔离保障多租户安全。

本模块与 4.2 Agent（`allowedTools` 引用插件工具）、4.3 Skill（依赖插件声明）、4.6 审批（高风险工具联动）、4.7 运行时（工具调用在会话内执行）、4.9 可观测（工具调用入 Trace）联动。

## 需求列表

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-801 | 提供插件市场：插件（Plugin）安装后注册一组 Tool 与配置项（如安装 Jenkins 插件 → 配置地址 / Token → 注册"触发构建"、"查询构建状态"等工具） | P0 |
| FR-802 | 首批内置插件：**Jenkins**（触发构建 / 查询状态 / 获取日志）、**GitHub**（创建 PR / 评论 / 查询 issue / 仓库操作）、**Gitee**（同上能力） | P0 |
| FR-803 | 支持 **MCP 协议接入**：外部 MCP Server 可注册为插件，自动发现其 Tools 并物化为平台工具 | P0 |
| FR-804 | 插件支持版本管理、依赖声明、兼容性校验；插件内凭证（Token / Key）加密存储、按命名空间隔离 | P1 |
| FR-805 | 插件沙箱：第三方插件运行受限，不能访问其他命名空间的凭证与数据 | P1 |
| FR-806 | 支持 A2A 协议（Agent-to-Agent）：外部 Agent 系统可通过 A2A 作为平台 Agent 的工具 / 被编排对象 | P2 |

## 详细设计说明

### 插件资源与工具注册（FR-801）

```yaml
apiVersion: orchestra.io/v1alpha1
kind: Plugin
metadata:
  name: jenkins
  namespace: dev-team
spec:
  version: 1.4.2
  source: builtin                  # builtin | market | mcp
  displayName: Jenkins 集成
  configSchema:                    # 安装后要求填写的配置项
    - name: serverUrl
      type: string
      required: true
    - name: apiToken
      type: secret                  # 加密存储，界面掩码展示
  declaredTools:
    - name: jenkins.trigger_build
      description: 触发 Jenkins 构建
      risk: normal
      configRefs: [serverUrl, apiToken]
    - name: jenkins.get_build_status
      description: 查询构建状态
      risk: normal
    - name: jenkins.delete_job
      description: 删除 Jenkins 任务
      risk: high                  # 高风险，触发 ToolApproval
  dependencies:
    - name: github
      versionRange: ">=2.0.0"     # 插件间依赖（FR-804）
```

设计要点：

- 安装插件分两步：安装（注册工具清单与配置 Schema）→ 配置（填写地址、凭证），配置完成后工具才可被 Agent 引用。
- 工具全名为 `<plugin>.<tool>`，Agent 白名单与 Skill 依赖均以此引用，见 4.2 / 4.3。
- `risk: high` 的工具自动接入 4.6 工具级审批（ToolApproval），不依赖 Agent 侧开关。

Plugin 资源新增 `runtime` 字段，声明插件所依赖的 CLI 环境与安装方式（平台只声明、不安装）：

```yaml
runtime:
  requirements:            # 声明依赖的 CLI（平台只声明不安装）
    - { name: jenkins-cli, version: ">=2.0", check: "jenkins-cli --version" }
  installHints:            # 安装方式提示（skill 自安装用，前端展示）
    - "curl -fsSL https://.../jenkins-cli -o /usr/local/bin/jenkins-cli && chmod +x /usr/local/bin/jenkins-cli"
```

- `requirements` 仅用于声明与环境预检（前端可见依赖清单），不触发平台安装；预检结果写入 Task status，缺失项在任务详情展示。
- `installHints` 由 skill 引用，Agent 在会话内通过 bash 工具执行安装（见 4.7「CLI 工具环境安装」）。
- 安装命令如命中 permission ask 规则则转 ToolApproval 人工审批（联动 4.6）。

### 首批内置插件（FR-802）

| 插件 | 核心工具（示例） |
|---|---|
| Jenkins | 触发构建、查询构建状态、获取构建日志 |
| GitHub | 创建 PR、评论、查询 issue、仓库操作（clone / create branch） |
| Gitee | 与 GitHub 同构能力，同一插件抽象层复用 |

- 内置插件与第三方插件共用同一 Plugin 资源模型与配置流程，仅 `source` 标记区分，保证治理一致。
- 插件配置项中的凭证一律走 4.1 的 Secret 加密存储（AES，NFR-01），界面掩码展示。

### MCP 协议接入（FR-803）

- 平台内置 MCP 客户端：外部 MCP Server（如 `npx @modelcontextprotocol/server-xxx`）注册为 MCP 插件，启动时通过 MCP 握手自动发现其 Tools 列表，物化为平台 Tool。
- MCP 工具名映射为 `<mcp-plugin>.<tool>`，进入 Agent 白名单与 Skill 依赖体系。
- MCP Server 生命周期由平台管理：按需启动 / 保活 / 回收；连接失败时工具调用返回可重试错误。
- MCP 是标准协议（NFR-08），第三方系统优先通过 MCP 接入，避免为每个系统定制适配器。

### 版本、依赖与凭证治理（FR-804）

- 插件语义化版本管理；升级校验兼容性（声明的工具清单变化需人工确认，避免破坏 Agent 白名单）。
- 依赖校验双向执行：安装校验依赖存在，卸载校验无反向引用（与 4.3 Skill 依赖校验同规则）。
- 凭证按命名空间隔离：同一插件在不同命名空间配置独立凭证，跨命名空间不可读取（沙箱硬约束）。

### 插件沙箱（FR-805）

- 第三方插件运行在受限沙箱：网络白名单（默认禁内网与云元数据地址，SSRF 防护见 NFR-01）、文件系统隔离、内存 / CPU 配额。
- 沙箱内插件只能访问自身命名空间的凭证与数据；越权访问在运行时被拒绝并审计（fail-closed）。
- 沙箱强化（进程隔离、能力最小化）为 M3 项，M1 / M2 以配置校验加运行时拦截为主。

### A2A 对接（FR-806）

- 平台实现 A2A Agent Card 发布与消费：外部 Agent 系统可通过 A2A 暴露为平台可调用的"工具"，也可被编排为流程节点。
- A2A 调用走标准协议（NFR-08），调用结果入 Trace；属于 P2，M3 落地。

### 与原型的关系

- `plugin-market` 插件市场：插件卡片展示 Jenkins / GitHub / Gitee / MCP / 企业微信 / PostgreSQL，含来源 badge 与安装 / 配置状态，对应 FR-801 至 803。
- `settings` 全局设置：集成分组在插件安装后联动显示各插件的设置项（地址 / Token / 连接状态），是插件配置的运维视图。

## 界面原型

```prototype
id: plugin-market
title: 插件市场
device: desktop
```

```prototype
id: settings
title: 全局设置
device: desktop
```

| 原型页 | 对应需求 |
|---|---|
| plugin-market（插件市场） | FR-801 ~ FR-803 |
| settings（全局设置） | FR-701、FR-801 |

## 验收要点

- 安装并配置 Jenkins 插件后，Agent 可引用 `jenkins.trigger_build` 工具并成功调用；未配置时工具调用返回明确错误。
- GitHub 与 Gitee 插件提供同构能力，工具全名带插件前缀，不产生命名冲突。
- 注册一个 MCP Server 后其 Tools 自动出现在插件工具列表中，可直接被 Agent 白名单引用。
- 插件升级后工具清单变化需要人工确认；删除被 Skill / Agent 引用的插件被阻止。
- 两个命名空间配置同一插件的不同凭证，沙箱内插件无法读取另一命名空间的数据，越权访问被审计拒绝。
