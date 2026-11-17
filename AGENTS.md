# AGENTS.md

本文件记录**本地开发/测试环境的唯一约定**，避免多 worktree 环境互相干扰。

## 本地环境（唯一入口）

| 项 | 值 |
|---|---|
| Web | http://127.0.0.1:13001 |
| API | http://127.0.0.1:13000 |
| 账号 | `seed-admin` / `Admin@123456` |
| docker 项目 | `vteam-compose`（主工作区 docker-compose.yml） |
| MySQL | 容器 `vteam-compose-db`，库 `vteam`，root 密码 `vteam-root` |

**只用 13001。** 其他 worktree 曾经起过自己的 compose 项目（如 `vteam-ws` → 13201），
数据完全独立、极易混淆（团队页能看到、会话页却看不到），已于 2026-11-17 停用。
如需在别的 worktree 调试，临时起端口前先在本文件登记。

### 常用命令

```bash
# 起/停（项目名 vteam；在主工作区根目录执行）
docker compose -p vteam up -d
docker compose -p vteam ps
docker compose -p vteam logs -f server

# 改了 server/worker 代码后重建
docker compose -p vteam build server worker
docker compose -p vteam up -d server worker

# 改了 prisma schema 后跑迁移（init 镜像与 server 是**独立镜像**，要分别 build）
docker compose -p vteam build init
docker compose -p vteam run --rm --no-deps init sh -c "npx prisma migrate deploy"

# 健康检查
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:13000/api/v1/health
```

## 造测试数据的两个必写表

团队「能看到」与「进得去」由两张表分别决定，**少写一张就会出现"团队页有、会话页没有"**：

| 表 | 含义 | 漏写的后果 |
|---|---|---|
| `team_members` | **Agent 席位**（一个成员在一个团队里的身份，`tmm_`） | 团队没有 agent、无法 @、MCP 工具 403（未绑岗位） |
| `team_user_members` | **人类用户**与该团队的关系（`user_id`，含 `role`） | 会话列表按它过滤 → 该团队的群聊**不出现在 /chat** |

**注意：本地有两个管理员账号** —— `admin`（`u_admin`）和 `seed-admin`（`u_seed_admin`）。
造数据时**两个都要加** `team_user_members`，否则用其中一个登录会看不到新团队
（2026-11-17 实测：只给 seed-admin 加了，用 admin 登录只看到 1 个群）。

另外两个容易漏的字段：

- `team_members.role_id`：不绑岗位（`agent_roles.id`，如 `ar_product`）→ MCP 工具调用
  403 `PLATFORM_MCP_TOOL_NOT_PERMITTED …未绑定岗位`
- `chat_channels` 需要一条 `type='team_group'`（每团队一群）才有群聊会话

## 本地验证跨群/多席位场景的最小数据集

```sql
-- 3 个团队 + 1 个成员跨 3 团队（每个团队 1 席位）+ 每团队 1 群聊频道 + 用户关系
-- 参考实现见本仓库提交历史 2026-11-17「跨群功能验证」；要点：
--   members(mbr_cross) → team_members(tmm_cross_1..3, 各 role_id=ar_product)
--   → chat_channels(c_tm_test_a..c, type=team_group)
--   → team_user_members(tm_test_a..c, u_seed_admin, role=owner)
```

## 关键排查索引（踩过的坑）

| 现象 | 先看这里 |
|---|---|
| 会话列表少团队 | `team_user_members` 是否漏写（见上） |
| MCP 工具 403「不是该团队的会话成员」 | 传的 `selfInstanceId` 必须是**该团队**的席位；跨群用 `vteam_my_groups` 返回的 `seatId` |
| MCP 工具 403「未绑定岗位」 | `team_members.role_id` 为空 |
| 回复写进了别人的会话 | 完成回调的 `sessionId` 是 `ses_`（opencode id），需按 `instanceRef` 反查；代码已 fail-closed，不再按 agent 猜席位 |
| 私聊派发到错误成员 | 同 agent 多席位时 mention 必须带 `instanceId`；后端已改为「多席位报错不猜」 |
