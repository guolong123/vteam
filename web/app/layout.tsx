import type { Metadata } from "next";
import "./globals.css";
// DSH primitives 设计令牌桥接（--dsw-*）：私聊 DSH 流式样式的 markdown/代码块/工具卡
// 全靠这些令牌排版，缺失会导致字号/行高/代码区背景全部失效（详见该文件头注释）。
import "@/src/styles/dsh-tokens.css";
// DSH 设计令牌（vendored，仅变量定义）：供 src/components/chat/dsh/ 下的
// @deepseek-ai/dsh-client-ui-primitives 组件取用 --dsw-* 令牌。
// 只定义变量、不含组件样式，也不含 scrollbar/focus 等全局行为样式（见文件头）。
import "@/src/theme/dsh/dsw-tokens.css";
import Providers from "./providers";
import CanvasUIGlobal from "@/src/components/canvasui/global";

export const metadata: Metadata = {
  title: "AI Agents",
  description: "AI 智能体平台",
};

const themeInitScript = `
(function() {
  try {
    var key = 'vteam-theme';
    var raw = localStorage.getItem(key);
    var pref = 'system';
    if (raw) {
      try { var parsed = JSON.parse(raw); pref = parsed.state && parsed.state.theme ? parsed.state.theme : 'system'; } catch(e) { pref = raw; }
    }
    var isDark = false;
    if (pref === 'dark') isDark = true;
    else if (pref === 'light') isDark = false;
    else isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var root = document.documentElement;
    if (isDark) root.classList.add('dark');
    root.setAttribute('data-theme', isDark ? 'dark' : 'light');
    root.style.colorScheme = isDark ? 'dark' : 'light';
  } catch(e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <Providers>
          <CanvasUIGlobal>{children}</CanvasUIGlobal>
        </Providers>
      </body>
    </html>
  );
}