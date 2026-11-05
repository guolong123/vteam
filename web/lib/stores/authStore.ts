"use client";

import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";
import { setAuthToken, setRefreshHandler, setUnauthorizedHandler } from "@/lib/api";
import { jwtExpiryMs, proactiveRefreshDelayMs } from "@/lib/jwt";

export const AUTH_PERSIST_KEY = "agent-platform-auth";

// 记住我模式 → localStorage（跨会话持久）；未勾选 → sessionStorage（会话级）。
// persist 的 storage 固定为 dualStorage，由 persistMode 决定每次写入落在哪个 Web Storage。
let persistMode: "remember" | "session" = "remember";

const dualStorage: StateStorage = {
  getItem: (name) => {
    if (typeof window === "undefined") return null;
    return (
      window.localStorage.getItem(name) ?? window.sessionStorage.getItem(name)
    );
  },
  setItem: (name, value) => {
    if (typeof window === "undefined") return;
    const active =
      persistMode === "remember" ? window.localStorage : window.sessionStorage;
    const inactive =
      persistMode === "remember" ? window.sessionStorage : window.localStorage;
    active.setItem(name, value);
    // 切换模式时清除对立 storage 的旧数据，避免脏 token 残留
    inactive.removeItem(name);
  },
  removeItem: (name) => {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(name);
    window.sessionStorage.removeItem(name);
  },
};

/** 登录用户信息（对齐 09 篇 §3.1 Auth 模块响应中的 user 字段）。 */
export interface User {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  /** 角色信息（后端 AuthUserView 返回；旧持久化数据可能缺失 → 可选，缺失时视为非 admin） */
  roleId?: string;
  roleName?: string;
  /**
   * 角色权限（后端 AuthUserView 透传 role.permissions；旧持久化数据可能缺失 →
   * 可选，缺失时按「无权限」处理，导航全过滤、守卫拒绝受限路由）。
   */
  permissions?: Record<string, unknown>;
  enabled?: boolean;
}

interface AuthState {
  token: string | null;
  /**
   * refresh token（默认 7 天有效）：仅用于续期，不参与任何业务请求鉴权。
   * 有了它，accessToken（默认 2h）到期后可静默换新，实现「记住我」下 1 周免登录。
   * 旧持久化数据可能没有该字段（上线前登录的用户）→ 那批人到期后仍需重登一次。
   */
  refreshToken: string | null;
  user: User | null;
  /** 登录成功后写入 token/refreshToken/user，并同步到 api 层。 */
  setAuth: (token: string, refreshToken: string | null, user: User) => void;
  /** 仅更新 token（如 refresh 后），同步到 api 层。 */
  setToken: (token: string | null) => void;
  /** 仅更新 user 信息。 */
  setUser: (user: User | null) => void;
  /**
   * 设置 token 持久化模式（登录前调用）：记住我=true → localStorage（跨会话）；
   * false → sessionStorage（会话级，关闭浏览器即失效）。
   */
  setPersistMode: (remember: boolean) => void;
  /** 登出：清空 token/user 与 api 层 token。 */
  logout: () => void;
}

/**
 * 认证状态 store。token + user 经 zustand persist 持久化到 dualStorage
 * （记住我 → localStorage 跨会话；未勾选 → sessionStorage 会话级），
 * 刷新页面后自动恢复；恢复时同步 token 到 api 层（onRehydrateStorage）。
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (setStore, getStore) => ({
      token: null,
      refreshToken: null,
      user: null,

      setAuth: (token, refreshToken, user) => {
        setAuthToken(token);
        setStore({ token, refreshToken, user });
        scheduleProactiveRefresh({ token, refreshToken });
      },

      /** 仅换 accessToken（旧调用方兼容路径）：沿用 store 里已有的 refreshToken 排期。 */
      setToken: (token) => {
        const refreshToken = getStore().refreshToken;
        setAuthToken(token);
        setStore({ token });
        scheduleProactiveRefresh({ token, refreshToken });
      },

      setUser: (user) => setStore({ user }),

      setPersistMode: (remember) => {
        persistMode = remember ? "remember" : "session";
      },

      logout: () => {
        setAuthToken(null);
        clearProactiveRefresh();
        setStore({ token: null, refreshToken: null, user: null });
      },
    }),
    {
      name: AUTH_PERSIST_KEY,
      storage: createJSONStorage(() => dualStorage),
      partialize: (state) => ({
        token: state.token,
        refreshToken: state.refreshToken,
        user: state.user,
      }),
      onRehydrateStorage: () => (state) => {
        // localStorage → memory 水合完成后，把 token 同步到 api 层，
        // 并按 token 剩余寿命排期主动续期（刷新页面后同样保持免登录）。
        // ⚠️ 此处**不能**引用 useAuthStore：同步存储下水合可能发生在 create() 期间，
        // 那时 const 绑定尚未完成（TDZ）→ 直接用 state 里的 token 对排期即可。
        if (state?.token) {
          setAuthToken(state.token);
          scheduleProactiveRefresh({
            token: state.token,
            refreshToken: state.refreshToken ?? null,
          });
        }
      },
    }
  )
);

/* ------------------------------------------------------------------ *
 * token 续期（保证「记住我」下 1 周免登录）
 * ------------------------------------------------------------------ */

/** 在飞刷新 Promise（单飞：并发 401 只发一次 POST /auth/refresh）。 */
let inflightRefresh: Promise<string | null> | null = null;
/** 主动续期定时器（到期前按剩余寿命排期刷新）。 */
let proactiveTimer: ReturnType<typeof setTimeout> | null = null;
/** 主动续期提前量下限（与 lib/jwt 同源口径的最小值）。 */
const PROACTIVE_MIN_DELAY_MS = 60_000;

function clearProactiveRefresh(): void {
  if (proactiveTimer !== null) {
    clearTimeout(proactiveTimer);
    proactiveTimer = null;
  }
}

/**
 * 调 POST /auth/refresh 换新 token 对并写回 store。
 *
 * 单飞语义：并发调用共享同一个在飞 Promise——多个请求同时 401 时只打一次刷新，
 * 否则刷新竞态会让后到的响应覆盖先到的（服务端每次刷新都签发新对，多个在飞刷新
 * 各自的 refreshToken 都合法，覆盖虽不致命但会多打请求、浪费窗口）。
 *
 * 失败语义：refreshToken 过期/账号禁用 → 返回 null（**不在这里登出**，
 * 由调用方 api 层判定是否触发 unauthorizedHandler），避免刷新失败时把用户
 * 的「刚刚还能用的页面」直接清掉。
 */
export async function refreshAccessToken(): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh;
  const refreshToken = useAuthStore.getState().refreshToken;
  if (!refreshToken) return null;

  inflightRefresh = (async () => {
    try {
      // 动态 import 规避循环依赖：api.ts ← authStore.ts（顶部静态 import 会成环）
      const { request } = await import("@/lib/api");
      const pair = await request<{ accessToken: string; refreshToken: string }>(
        "/auth/refresh",
        { method: "POST", body: { refreshToken } }
      );
      // 同步 api 模块token + store（含新 refreshToken：服务端每次刷新轮换一对，
      // 不写回会让下一次续期用旧 refreshToken —— 旧值仍有效但浪费窗口）。
      setAuthToken(pair.accessToken);
      useAuthStore.setState({
        token: pair.accessToken,
        refreshToken: pair.refreshToken,
      });
      scheduleProactiveRefresh({
        token: pair.accessToken,
        refreshToken: pair.refreshToken,
      });
      return pair.accessToken;
    } catch {
      return null;
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

/**
 * 排期「到期前主动续期」：按 accessToken 的 exp 算出剩余寿命后按 80% 处刷新。
 * 主动刷新的价值：用户长时间挂在页面上时，不会在某个操作瞬间撞 401（虽然 401
 * 也已经能自动重试，但主动刷新省掉那一次失败往返，SSE/轮询也更平滑）。
 * token 无法解析 exp → 不排期（依赖 401 被动续期兜底）。
 */
function scheduleProactiveRefresh(auth: {
  token: string | null;
  refreshToken: string | null;
}): void {
  clearProactiveRefresh();
  if (typeof window === "undefined") return;
  const { token, refreshToken } = auth;
  if (!token || !refreshToken) return;
  const expiry = jwtExpiryMs(token);
  const delay = proactiveRefreshDelayMs(expiry);
  if (delay === null) return;
  proactiveTimer = setTimeout(() => {
    proactiveTimer = null;
    void refreshAccessToken();
  }, Math.max(delay, PROACTIVE_MIN_DELAY_MS));
}

// 注册刷新处理器（api 层 401 时调用）：返回新 token 或 null。
setRefreshHandler(refreshAccessToken);

// 模块加载时注册 401 处理器：token 真的失效（续期也失败）→ 清登录态 + 重定向 /login。
// next/router 在 lib 层不可靠，用 window.location；SSR 环境 window 不存在时跳过。
setUnauthorizedHandler(() => {
  useAuthStore.getState().logout();
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
});