# Task 7 — 前端状态层接入（TanStack Query + Zustand）

## 目标
为页面迁移（Task 11-14）建立数据层基础：TanStack Query（服务端状态）+ Zustand（客户端状态）+ 统一 API fetch 封装。

## 完成内容

### 1. 依赖
- `@tanstack/react-query@^5.101.4`（脚手架 Task 2 已装）
- `zustand@^5.0.14`（脚手架 Task 2 已装）
- 无需额外安装。

### 2. QueryClientProvider 挂载
- `app/providers.tsx`（新增，client component）：`useState` 懒初始化 `QueryClient`，默认 `staleTime: 30s`、`retry: 1`、关闭窗口聚焦 refetch。
- `app/layout.tsx`：将 children 包进 `<Providers>`。

### 3. API 封装 `web/lib/api.ts`
- `API_BASE_URL`：默认 `/api/v1`（对齐 09 篇 §2），可用 `NEXT_PUBLIC_API_BASE_URL` 环境变量覆盖。
- 自动注入 `Authorization: Bearer <token>`（token 由 authStore 同步到模块级变量，SSR 安全）。
- 自动 JSON 序列化 body、拼接 query。
- 统一错误归一化：非 2xx 解析 `{code, message, details?}`，构造 `ApiError(status, code, message, details)`；网络层失败抛出 `NETWORK_ERROR`。
- 便捷方法 `api.get/post/patch/delete`。
- `web/lib/errors.ts`：`ApiError` 类 + `isApiError` 类型守卫。

### 4. Zustand store `web/lib/stores/authStore.ts`
- `useAuthStore`：`token` + `user`，`persist` 中间件持久化到 localStorage（key `agent-platform-auth`）。
- Actions：`setAuth`（登录）、`setToken`（refresh 后）、`setUser`、`logout`。
- 登录/登出/水合（`onRehydrateStorage`）时同步 token 到 api 层 `setAuthToken`。

## 验证
- `cd web && npm run build` → 退出码 `0`，编译成功，类型检查通过。
- 改动未触碰 `server/`。

## 未做（按范围约束）
- 未写具体业务查询（Task 11-14 各自接入 Task 11-14）。
- 未引入 Redux 等额外状态库。