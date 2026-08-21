import type { Metadata } from "next";
import "./globals.css";
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