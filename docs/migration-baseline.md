# 迁移基线折叠：部署约束与存量库接管

> 基线 `server/prisma/migrations/20260925000000_squashed_baseline/migration.sql`
> 由 81 个迁移折叠而来。折叠前 81 个原始迁移归档在
> `.omo/evidence/tech-debt-remediation/legacy-migrations/`（含
> `PRE-SQUASH-MIGRATION-LOCK.toml`）。
>
> **本文档的每条行为描述都在 Prisma 6.19.3 + MySQL 8 上实测过**，
> 不是从文档或记忆推断的。复现命令见各节。

## 1. 基线的来源（不要用 schema.prisma 重建）

基线是从**折叠前的权威 schema** 导出的，不是从 `server/prisma/schema.prisma`
生成的。两者不等价，且差异是**静默的**：

`prisma migrate diff --from-empty --to-schema-datamodel` 生成的基线曾把
`agents.agent_key` 从 `varchar(63)` 放宽成 `varchar(191)`、
`agent_roles.default_opencode_agent_name` 从 `128` 放宽成 `191`、
`artifacts.category` 从 `TEXT` 收窄成 `VARCHAR(191)`，并丢掉
`hooks.updated_at` / `triggers.updated_at` 的
`ON UPDATE CURRENT_TIMESTAMP(3)`。

原因：`schema.prisma` 不携带列长、列默认值、`ON UPDATE`、索引前缀长度，
Prisma 一律按 191 输出。

**当时没有任何检查报红**——gate 绿、`migrate deploy` 绿、`migrate status` 绿、
e2e 全过。发现它的唯一方式是拿新基线去比对折叠前的 dump
（`.omo/evidence/ddl-W8-task43-20260924.sql`）。

> 结论：**不要用 `schema.prisma` 重建基线。** 需要重建时，从折叠前的
> mysqldump 恢复进临时库，再 `mysqldump --no-data` 导出。
> 一份有已知偏差的基线比 81 个诚实的迁移更危险，因为它看起来是权威的。

## 2. 折叠后的实际部署行为（实测）

设 `DB` 为目标库，基线含 **47 条普通 `CREATE TABLE`（0 条 `IF NOT EXISTS`）**。

### 2.1 空库 —— 正常路径

`migrate deploy` 干净应用，产出 `_prisma_migrations` 恰好 1 行、
`finished_at` 已记录、0 回滚、47 张应用表。

已在两个真实环境验证：本地 `docker compose down -v` 重建、k8s 删除 namespace 重建。

### 2.2 存量库 —— Prisma 会干净地拒绝（不是 1050）

```
Error: P3005
The database schema is not empty. Read more about how to baseline an existing
production database: https://pris.ly/d/migrate-baseline
```

实测要点：

- **不会**执行到 `CREATE TABLE`，因此**不会**出现 `Error 1050 Table already exists`
- **不会**创建 `_prisma_migrations`（失败后该表不存在），数据库零写入
- 重复执行仍是同一个 P3005，不是「卡在失败迁移」的死状态

复现：

```bash
docker exec <db> mysql -uroot -p -e "CREATE DATABASE scratch CHARACTER SET utf8mb4;
  CREATE TABLE scratch.agent_questions (id VARCHAR(64) PRIMARY KEY) ENGINE=InnoDB;"
docker run --rm --network <net> -v "$PWD/server/prisma:/app/prisma" -w /app \
  -e DATABASE_URL='mysql://root:<pw>@db:3306/scratch' \
  --entrypoint sh <prisma-image> -c "npx prisma migrate deploy"   # → P3005
```

## 3. 存量库接管：先判定属于哪一类，再动手

**`migrate resolve --applied` 是一句声明，不是校验。** 它把迁移名写进
`_prisma_migrations` 而不执行任何 SQL。库的实际 schema 是否真的等于基线，
Prisma 不检查。选错分支会**静默**留下一个「迁移记录说已到最新、实际没有」的库。

按这个顺序判定：

```bash
# a) 迁移记录状态
docker exec <db> mysql -uroot -p -D <db> -N -B -e \
  "SELECT migration_name, finished_at IS NOT NULL FROM _prisma_migrations ORDER BY finished_at;"

# b) 关键列是否存在（基线里应当【不存在】，存量旧库里常常还在）
docker exec <db> mysql -uroot -p -D <db> -N -B -e "
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema='<db>'
    AND column_name IN ('main_agent_id','main_agent_instance_id','execution_mode',
                        'task_agent_id','fire_at');"

# c) 频道类型（task_group 应已并入 team_group）
docker exec <db> mysql -uroot -p -D <db> -N -B -e \
  "SELECT type, COUNT(*) FROM chat_channels GROUP BY type;"

# d) 表数
docker exec <db> mysql -uroot -p -D <db> -N -B -e "
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema='<db>' AND table_name<>'_prisma_migrations';"
```

| 判定结果 | 该走哪条路 |
|---|---|
| `_prisma_migrations` 无基线记录 **且** (b) 为空、(c) 无 `task_group`、(d)=47 | **可以** `migrate resolve --applied 20260925000000_squashed_baseline` |
| `_prisma_migrations` 无基线记录 **但** (b) 有残留列 / (c) 有 `task_group` | **不要 resolve。** 库落后于基线，见 3.1 |
| `_prisma_migrations` 已有基线记录 | 已接管，直接 `migrate deploy`（会报无待应用迁移） |

### 3.1 库落后于基线时的正确做法

基线是「81 个迁移全部应用后」的终态，**不包含**任何中间步骤。库落后时
`resolve --applied` 会把缺失的 DDL 一起跳过。

两种可选路径，**按是否需要保留数据决定**：

**A. 保留数据（生产默认）** —— 手工补齐差额，再 resolve：

1. 全库 dump 兜底（见 `docs/tech-debt-rollback.md` 第 2 节）
2. 按差额逐条执行缺失的 DDL/DML。折叠前的原始迁移在归档里，按
   `migration_name` 排序即原始执行顺序：
   `.omo/evidence/tech-debt-remediation/legacy-migrations/<name>/migration.sql`
3. 复查 (b)(c)(d) 全部符合基线
4. `npx prisma migrate resolve --applied 20260925000000_squashed_baseline`
5. `npx prisma migrate deploy` —— 应报 `No pending migrations to apply`

> 归档目录**不在 git 里**。换机器或清工作区就取不到了，见第 5 节。

**B. 放弃数据（仅限可弃环境）** —— 重建库，直接走 2.1：

```bash
docker compose down -v && docker compose up -d --build     # 本地
kubectl delete namespace <ns> && scripts/deploy-k8s.sh      # k8s
```

## 4. 部署链路上的表现（k8s）

`chart/vteam/templates/job-init.yaml` 执行
`npx prisma migrate deploy && node dist/prisma/seed.js`，
`backoffLimit: 6`。`server` Deployment **没有 initContainer 等待该 Job**。

存量库上 `migrate deploy` 返回 P3005（非零退出）时：

- `&&` 短路 → **seed 不执行**
- Job 重试至 `backoffLimit` 后失败
- `scripts/deploy-k8s.sh` 只 `warn`（不 fail），继续
- server 仍然 rollout，**跑在一个从未被迁移过的库上**

后果是**部署看起来成功、实际 schema 未对齐**，不是数据库损坏。
排查时先看 Job，不要只看 rollout：

```bash
kubectl get job <release>-init -n <ns>
kubectl logs job/<release>-init -n <ns> --tail=50 | grep -E "P3005|Error"
```

## 5. 归档的脆弱性（当前真实风险）

`docs/tech-debt-rollback.md` 按「文件:行号」引用了折叠前的迁移，例如
`20260907000001_drop_task_agent_domain/migration.sql:20`。这些文件已不在
`server/prisma/migrations/` 下，只存在于
`.omo/evidence/tech-debt-remediation/legacy-migrations/`。

而该归档目录：

- **不在 git 中**（`.omo/evidence/` 按约定不提交）
- 只存在于本工作区
- 会随临时目录清理或工作区重置消失

一旦丢失，3.1 路径 A 的第 2 步就无法执行，存量库将**只剩路径 B（放弃数据）**。
恢复原始迁移内容前，**先把这个归档落到一个受版本控制或备份策略覆盖的位置**。
