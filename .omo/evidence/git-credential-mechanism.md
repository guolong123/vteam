# 证据：仓库权限与凭证机制（Git）（17 篇）

- 日期：2026-08-06
- 任务：新建 `docs/agent-platform/17-仓库权限与凭证机制.md`（445 行，9 节，mermaid 4 块）+ 微调 `01-背景与目标.md` 边界声明（第 64/66 行）

## 产出物

| 文件 | 改动 | 验证 |
|------|------|------|
| `docs/agent-platform/17-仓库权限与凭证机制.md` | 新建（frontmatter: id=git-credential-mechanism, order=17, kind=技术设计） | 445 行；mermaid 块 ×4（≥2）；FR/章节引用 07/09/11/13/14/15/16 篇 |
| `docs/agent-platform/01-背景与目标.md` | 第 64 行「不做仓库操作与发布流水线」→「不做 PR 合并与发布流水线」；第 66 行改为「仓库拉取/推送经本版凭证机制支持（见 17 篇…）」 | grep 断言 2/2 命中 |

## 17 篇结构（9 节）

1. 定位与文档关系（01 篇边界调整说明 + 文档关系表）
2. 现状与机制定位（opencode 事实表 6 条 + 三层架构 mermaid）
3. 凭证管理模型（credentials / repo_grants 两表 + 凭证来源 + 安全基线）
4. 内置 git 工具族（7 工具清单 + 注册路径 + execute 模板）
5. 权限申请与临时凭证衔接（完整时序图 + effect 分支表 + approved 作用域 + 凭证不进上下文）
6. 注入方式（GIT_SSH_COMMAND / SSH_AUTH_SOCK / credential helper 对照表 + 覆盖面对比）
7. worker 侧生命周期（ssh-agent 状态图 + 清理触发点表）
8. 权限与审计（bash 兜底双轨 + 审计表 + 角色授权衔接）
9. 边界与开放问题（01 篇调整摘要表 + 5 个开放问题）

## 关键事实依据（已核实）

- opencode 无内置 git 工具、无 git 凭证机制（registry.ts 全 grep 0 命中）
- bash git 权限前缀已支持：`permission: {bash: {"git *": "allow"}}`（permission/arity.ts:83-86）
- shell.env 是官方注入点：shell.ts:416-426 / plugins.mdx:261-273
- 自定义工具 execute 内可注入任意 env：registry.ts:178-192
- 内部 git 子进程只继承进程 env（extendEnv: true）→ 开放问题①

## 验证结果

| 检查项 | 结果 |
|--------|------|
| md-docs build 退出码 | **0**（`md-docs build --out-dir /tmp/opencode/git-cred/site`） |
| build 产物含 key | `git-credential-mechanism` 命中（index-*.js） |
| dev 服务注入 | `virtual:md-docs-content` 200（2.4MB）：key 命中 1、git_push 命中、标题「仓库权限与凭证机制」命中 |
| grep 断言（17 篇） | git_push=9、SSH_AUTH_SOCK=10、credential helper=7、request=7、用完即删=8、mermaid 块=4（≥2） |
| 01 篇边界 | 「不做 PR 合并与发布流水线」+「仓库拉取/推送经本版凭证机制支持」均命中 |
| 行数 | 17 篇 445 行（≥400 要求） |
