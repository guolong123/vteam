"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { setAuthToken } from "@/lib/api";

/** 登录用户信息（对齐 09 篇 §3.1 Auth 模块响应中的 user 字段）。 */
export interface User {
  id: string;
  username: string;
  displayName: string;
  email?: string;
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
  /** 登出：清空 token/user 与 api 层 token。 */
  logout: () => void;
}

/**
 * 认证状态 store。token + user 持久化到 localStorage（使用 zustand persist），
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

      logout: () => {
        setAuthToken(null);
        set({ token: null, user: null });
      },
    }),
    {
      name: "agent-platform-auth",
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