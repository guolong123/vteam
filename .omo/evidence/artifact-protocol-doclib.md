# Evidence: 12-产出物协议与文档库

## 变更

**新建文件**：`docs/agent-platform/12-产出物协议与文档库.md`（329 行，frontmatter: title=产出物协议与文档库 / id=artifact-protocol-doclib / order=12 / kind=技术设计）。

**内容覆盖（9 节详设）**：
- §1 定位与文档关系（04 篇 FR-38~46 功能依据、09 §3.6/§4/§5.4 API 落点、10 篇 §4.2/§8 消息衔接、08 篇 ArtifactsModule 与表、03 篇 FR-04 验收联动）
- §2 产出物模型：三类产出物特性表（text/doc/file × 内容载体/归档方式/查看形态，FR-39）、artifacts + artifact_versions 实体字段表（含 accepted_flag 验收基线、sha256、author_agent_id）、与任务/会话/Agent 关系
- §3 结构化协议：产出物声明 JSON Schema（{type, title, content?, fileRef?}）、校验规则表（type 枚举必填/title 必填/content-fileRef 二选一/未知字段忽略/非法回退）、与 opencode json_schema 对接（task.completed text part / message.part.delta file part）、结论文本 vs 文档文件声明差异表
- §4 版本机制：append 递增（FR-43）、版本元数据表、不可变性（已验收 409 ARTIFACT_ACCEPTED_IMMUTABLE）、并发 append 乐观锁 + sha256 幂等 + 同 Agent 连续产出合并 append、版本上限开放问题（mermaid flowchart 版本演进图）
- §5 归档链路：完整 mermaid 时序图（Agent→worker→控制面→DB→前端+群聊 system 消息）、拉取失败四步处理（2/4/8s 指数退避×3、pending artifact、会话恢复重拉）、50MB 大文件、手动补充入口（P1 旁路）
- §6 任务文档库：列表字段表（FR-44）、查看与版本切换只读（FR-45）、task-detail 原型落点、artifact.submitted 实时刷新
- §7 验收与不可变：accept 流程记录 accepted_flag、mermaid stateDiagram-v2 状态机（已完成→进行中 自动退回）、验收语义表（验收前/后）
- §8 上下文注入协议：注入位置与组装（FR-46/FR-15）、XML 提示块格式（<doclib>/<artifact>，对齐 11 篇 skill 注入风格）、mermaid 注入流程图、大小控制（32KB 截断/最新版本优先/可关闭）
- §9 边界与开放问题：不可删除、拉取失败不产生不完整归档、非法声明回退；4 项开放问题（版本存储成本/超大文档截断/文件存储下载/验收基线撤销）；与 09 §5.4 衔接说明

## 验证结果

- `md-docs build` exit=0（构建完成 → dist）
- grep 断言：产出物×51、ARTIFACT_ACCEPTED_IMMUTABLE×3、append×23、文档库上下文注入×1、json_schema×5、mermaid×4 块（≥2 要求）
- dist bundle 注入确认：`dist/assets/index-CEW0CGAk.js` 含 artifact-protocol-doclib×1 + 产出物协议与文档库×3
- 未修改 01-11 篇（仅新建 12 篇）

Tags: artifacts, doclib, artifact-protocol, acceptance-baseline
