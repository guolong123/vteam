# Task 4 — Schema 验证证据

## 结论

`server/prisma/schema.prisma` 数据模型验证通过（`prisma validate`），SQLite 验证库 `prisma db push` 成功，19 张业务表全部建出，预留表 `audit_logs` 未建（符合规格）。

## 1. `prisma validate` 输出

```
The schema at prisma/schema.prisma is valid 🚀
```

## 2. `prisma db push --skip-generate` 输出

```
Datasource "db": SQLite database "dev.db" at "file:./dev.db"
SQLite database dev.db created at file:./dev.db
🚀  Your database is now in sync with your Prisma schema. Done in 381ms
```

## 3. 验证库落库结果

经 `sqlite_master` 查询（python3 sqlite3 读取 `prisma/dev.db`）：

- **建出表数：19**
- **`audit_logs` 未建**（预留，下一版启用，符合规格）

## 4. 版本与依赖

- `prisma`：6.19.3
- `@prisma/client`：6.19.3
- `package.json` 已含 `@prisma/client` 与 `prisma` 依赖

## 5. 关键设计决策（双库兼容）

规格文档 15 篇 §2.1 描述「双 provider（mysql + sqlite）」与 §2.4「Json 列统一 Prisma Json」，但存在两个 Prisma 现实约束，落地时做了等价实现：

1. **provider 数组写法不可用**：Prisma 自 2.22.0 起移除了 `provider = ["mysql", "sqlite"]` 数组写法（单一 datasource 只能声明单一 provider）。双库兼容改为「可移植类型 + 切换 provider」达成（详见 schema 头部注释）。
2. **Prisma 5 的 SQLite 不支持 Json 类型**：`Json` 列在 SQLite 的支持始于 Prisma 6.2.0。为满足规格硬约束「Json 列 + SQLite 验证库可落库」，将 Prisma 从 5 升级至 6.19.3。

落地类型策略（与 15 篇 §2/08 篇 §6.2 对齐）：
- 状态/类型/优先级一律 `String` 列 + 应用层常量（不声明 Prisma enum）
- Json 列统一 Prisma `Json` 类型（SQLite 以 TEXT 存储）
- 时间统一 UTC + `DateTime`
- 布尔用 `Boolean`（SQLite 映射 INTEGER 0/1）
- 外键级联一律 `ON DELETE RESTRICT`

## 6. 验证命令（可复现）

```bash
cd /data/git-project/aiagents/server
npx prisma validate
DATABASE_URL="file:./dev.db" npx prisma db push --skip-generate
```