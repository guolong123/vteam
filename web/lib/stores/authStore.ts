"use client";

import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";
import { setAuthToken } from "@/lib/api";

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
  user: User | null;
  /** 登录成功后写入 token 与 user，并同步到 api 层。 */
  setAuth: (token: string, user: User) => void;
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
    (set) => ({
      token: null,
      user: null,

      setAuth: (token, user) => {
        setAuthToken(token);
        set({ token, user });
      },

      setToken: (token) => {
        setAuthToken(token);
        set({ token });
      },

      setUser: (user) => set({ user }),

      setPersistMode: (remember) => {
        persistMode = remember ? "remember" : "session";
      },

      logout: () => {
        setAuthToken(null);
        set({ token: null, user: null });
      },
    }),
    {
      name: AUTH_PERSIST_KEY,
      storage: createJSONStorage(() => dualStorage),
      partialize: (state) => ({
        token: state.token,
        user: state.user,
      }),
      onRehydrateStorage: () => (state) => {
        // localStorage → memory 水合完成后，把 token 同步到 api 层
        if (state?.token) {
          setAuthToken(state.token);
        }
      },
    }
  )
);