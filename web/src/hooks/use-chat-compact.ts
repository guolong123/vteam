"use client";

import { useEffect, useState } from "react";

/**
 * 聊天页高度紧凑模式。
 *
 * 现有侧栏只按宽度折叠，1440×900 这类“宽但矮”的笔记本会把消息区压在
 * 头部、成员条和 composer 之间。这里单独监听视口高度，让聊天 chrome
 * 能按高度降级；SSR 首帧固定 false，水合后再更新，避免服务端/客户端不一致。
 */
export function useChatCompact(maxHeight = 900): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const update = () => setCompact(window.innerHeight <= maxHeight);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [maxHeight]);

  return compact;
}
