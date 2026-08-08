import type { Metadata } from "next";
import "./globals.css";
import Providers from "./providers";
import CanvasUIGlobal from "@/src/components/canvasui/global";

export const metadata: Metadata = {
  title: "AI Agents",
  description: "AI 智能体平台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>
          <CanvasUIGlobal>{children}</CanvasUIGlobal>
        </Providers>
      </body>
    </html>
  );
}