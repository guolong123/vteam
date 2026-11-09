"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 聊天气泡渲染风格：native=现有气泡（含过程折叠）；dsh=DSH 流式过程样式。 */
export type ChatStreamStyle = "native" | "dsh";

export const CHAT_STREAM_STYLE_STORAGE_KEY = "vteam-chat-stream-style";

interface ChatPrefsState {
  streamStyle: ChatStreamStyle;
  setStreamStyle: (style: ChatStreamStyle) => void;
}

export const useChatPrefsStore = create<ChatPrefsState>()(
  persist(
    (set) => ({
      streamStyle: "native",
      setStreamStyle: (streamStyle) => set({ streamStyle }),
    }),
    { name: CHAT_STREAM_STYLE_STORAGE_KEY },
  ),
);
