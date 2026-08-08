# Task 11 — login 页保真迁移 + 真实认证

## 交付物

- **文件**：`web/app/login/page.tsx`（原型 `docs/agent-platform/prototypes/login/index.tsx` 保真迁移）
- **截图**：
  - `task-11-login-page.png`（桌面登录页正常态）
  - `task-11-login-error.png`（错误凭证错误态）
  - `task-11-login-success.png`（登录成功后 /projects 页）

## 原型保真

- 布局/间距/配色/文案零改动：左侧品牌区（Logo「A」+「Agent 协作平台」+ 价值主张 + 三功能 ✓ 列表 + 四角色点缀）+ 右侧登录表单（欢迎回来 / 账号 / 密码 / 登录按钮 / 立即注册）。
- 样式 token 全部引用 `web/src/theme/tokens.ts`（`neutral` / `space` / `radius` / `fontSize` / `fontFamily`），token 零改动。
- 响应式：`useIsMobile()`（`matchMedia` ≤768px）→ 移动端品牌区折叠为顶栏（`BrandPanel compact`）、表单单列；桌面端左右分栏。
- `data-testid` 与原型完全一致：`username` / `password` / `login-button` / `register-link`。
- 唯一结构调整：BrandPanel 的 `flexDirection` 从「基础对象 + compact 覆盖」改为条件分支赋值，以通过 web 项目 strict TS 的重复 key 检查（视觉输出等价）。

## 认证接入（Task 15 端点）

```ts
const res = await api.post<LoginResponse>("/auth/login", {
  username: username.trim(),
  password,
});
setAuth(res.accessToken, res.user);   // -> authStore（persist 到 localStorage）
router.push("/projects");
```

- `api.post` 走 `web/lib/api.ts`，baseURL `/api/v1`，对齐全局前缀。
- 成功：`setAuth(accessToken, user)` → store 持久化 + api 层同步 → `router.push("/projects")`。
- 已登录用户访问 /login 自动 `router.replace("/projects")`。

## 错误态

- 空账号/密码：`请输入账号和密码`（`data-testid="login-error"`，`role="alert"`）。
- 错误凭证：读取 `ApiError.message` → `用户名或密码错误`（服务端 401 `AUTH_INVALID_CREDENTIALS`），不跳转。
- 错误样式与原型视觉语言一致：小字号语义红（`#DC2626`），插入表单字段与按钮之间。

## 验证结果

### 1. 构建

```
cd web && npm run build   # 退出码 0
# /login 2.48 kB，静态预渲染成功
```

### 2. Playwright 实测（真实后端 Server:3000 + Web:3001，route 转发规避跨域）

| 场景 | 输入 | 结果 |
|------|------|------|
| 空表单 | — | 显示「请输入账号和密码」，停留 /login |
| 错误凭证 | admin / wrongpass | 显示「用户名或密码错误」，URL 仍为 /login，localStorage 无 token |
| 正确凭证 | admin / admin123 | 跳转 http://localhost:3001/projects，`agent-platform-auth` 中 token 已存，user=admin |

- 页面渲染断言：`欢迎回来`、`username`/`password`/`login-button`/`register-link` 各 ×1，品牌区文字存在。
- Console 无与登录页相关的错误（401 为错误凭证测试的预期响应）。

## 范围边界

- 未改视觉 / 文案 / token。
- 未实现注册流程（`register-link` 保持原型静态展示）。
- 未引入新依赖（仅用 React hooks + 现有 zustand/api/next）。
- 未修改 server/。