# Task 15 — AuthModule 端到端 curl 验证

## 环境
- 服务：`node dist/src/main.js`，全局前缀 `/api/v1`，端口 3000
- 数据库：SQLite `prisma/dev.db`（已 seed：admin/member 角色 + admin 账号）
- 时间：2026-08-07

## 1. POST /auth/register（公开）→ 201
```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"secret123","displayName":"Alice Wang","email":"alice@x.com"}'
```
```
{"id":"u_1786061432411","username":"alice","displayName":"Alice Wang"}
HTTP 201
```
✅ 返回 `{id, username, displayName}`（不含 password_hash），对齐 09 §3.1。

## 2. POST /auth/register 重复用户名 → 409 USERNAME_CONFLICT
```bash
curl -X POST http://localhost:3000/api/v1/auth/register ... -d '{"username":"alice",...}'
```
```
{"code":"USERNAME_CONFLICT","message":"用户名 alice 已被占用"}
HTTP 409
```
✅ 对齐 09 §2.1 409 `*_CONFLICT`。

## 3. POST /auth/login（公开，seed admin）→ 200
```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}'
```
```
{"accessToken":"eyJ...","refreshToken":"eyJ...",
 "user":{"id":"u_admin","username":"admin","displayName":"平台管理员",
         "email":"admin@aiagents.local","roleId":"r_admin","roleName":"admin","enabled":true}}
HTTP 200
```
✅ 返回 `{accessToken, refreshToken, user}`，对齐 09 §3.1。

## 4. POST /auth/login 错误密码 → 401 AUTH_INVALID_CREDENTIALS
```bash
curl -X POST .../auth/login -d '{"username":"admin","password":"WRONG"}'
```
```
{"code":"AUTH_INVALID_CREDENTIALS","message":"用户名或密码错误"}
HTTP 401
```

## 5. GET /auth/profile 携带合法 token → 200
```bash
curl http://localhost:3000/api/v1/auth/profile -H "Authorization: Bearer $ADMIN_TOKEN"
```
```
{"id":"u_admin","username":"admin","displayName":"平台管理员","email":"admin@aiagents.local","roleId":"r_admin","roleName":"admin","enabled":true}
HTTP 200
```
✅ 不含 password_hash。

## 6. GET /auth/profile 无 token → 401 AUTH_UNAUTHORIZED（全局守卫）
```
{"code":"AUTH_UNAUTHORIZED","message":"未认证或 token 无效/已过期"}
HTTP 401
```

## 7. GET /auth/profile 无效 token → 401 AUTH_UNAUTHORIZED
```
{"code":"AUTH_UNAUTHORIZED","message":"未认证或 token 无效/已过期"}
HTTP 401
```

## 8. GET /health（@Public 标记）无 token → 200
```
{"status":"ok","info":{},"error":{},"details":{}}
HTTP 200
```
✅ 公开端点放行，其余端点默认需 token。

## 9. POST /auth/refresh 有效 refresh token → 200 新 token 对
```
{"accessToken":"eyJ...","refreshToken":"eyJ..."}
HTTP 200
```

## 10. POST /auth/refresh 无效 token → 401 AUTH_REFRESH_INVALID
```
{"code":"AUTH_REFRESH_INVALID","message":"refresh token 无效或已过期"}
HTTP 401
```

## 11. 安全：refresh token 当 access token 用 → 401
```
{"code":"AUTH_UNAUTHORIZED","message":"未认证或 token 无效/已过期"}
HTTP 401
```
✅ jwt.strategy 仅接受 `type=access`，`type=refresh` 一律拒绝。

## 结论
注册/登录/鉴权三场景 + 错误码（201/409/401/200）全部通过；全局守卫生效（除 @Public 端点外需 token）。