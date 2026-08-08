# Task 15 — 密码 bcrypt 哈希落库验证

## 验证方式
读 `prisma/dev.db` 的 `users` 表，对每条 `password_hash` 断言：
- 匹配 bcrypt 前缀 `$2b$`（本轮 BCRYPT_ROUNDS=10）
- 用 bcrypt.compare 验证明文能否还原（alice / secret123）

## 结果
```
seed-admin   | $2b$10$R5... | isBcrypt=true
seed-member  | $2b$10$R5... | isBcrypt=true
sse_test     | $2b$10$MB... | isBcrypt=true
admin        | $2b$10$9z... | isBcrypt=true
alice        | $2b$10$Zp... | isBcrypt=true | plaintextMatches=true
```

## 结论
- 全部 `password_hash` 为 bcrypt 哈希（`$2b$10$`），非明文。
- `alice` 注册时明文 `secret123` 经 bcrypt.compare 验证通过（`plaintextMatches=true`）。
- API 响应（register/login/profile）均**不含** password_hash，对齐 09 §3.2 / 15 篇 §3.1。

## 实现位置
- `server/src/auth/auth.service.ts`：`bcrypt.hash(password, 10)` 落库；`bcrypt.compare` 校验。