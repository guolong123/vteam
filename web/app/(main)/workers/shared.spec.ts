import { test, expect } from "@playwright/test";
import { MCP_STATUS_THEME, type McpStatusEntry } from "./shared";

/**
 * worker 详情页 MCP 徽章主题 · 五态完备性门（app-unit）
 * =============================================
 * v2 的 MCP 状态是**五态**（connected / pending / disabled / failed / needs_auth，
 * 与 serve 的 `GET /api/mcp` 1:1 对齐）。`MCP_STATUS_THEME` 是该联合的 `Record`
 * ⇒ 少一个键 = 查表得 `undefined` ⇒ **详情页渲染抛错**（线上事故，不是样式问题）。
 *
 * 运行：`npx playwright test --project=app-unit`
 * 失败语义：主题表退回三态（缺 pending / disabled）时本 spec 立即红。
 */

const FIVE_STATES: McpStatusEntry["status"][] = [
  "connected",
  "pending",
  "disabled",
  "failed",
  "needs_auth",
];

test("五个合法 MCP 状态全部命中主题（查表不得为 undefined）", () => {
  for (const status of FIVE_STATES) {
    const theme = MCP_STATUS_THEME[status];
    expect(theme, `状态 ${status} 缺少主题条目`).toBeTruthy();
    expect(theme.label.length, `状态 ${status} 缺少展示文案`).toBeGreaterThan(0);
    expect(theme.mark.length, `状态 ${status} 缺少展示标记`).toBeGreaterThan(0);
    expect(theme.color, `状态 ${status} 缺少前景色`).toBeTruthy();
    expect(theme.bg, `状态 ${status} 缺少底色`).toBeTruthy();
    expect(theme.border, `状态 ${status} 缺少边框色`).toBeTruthy();
  }
});

test("pending / disabled 各自独立，且都不与 failed 混同", () => {
  // pending（还在连）与 disabled（配了但关着）都不是 failed —— 折叠即谎报。
  expect(MCP_STATUS_THEME.pending).not.toEqual(MCP_STATUS_THEME.failed);
  expect(MCP_STATUS_THEME.disabled).not.toEqual(MCP_STATUS_THEME.failed);
  // 两者彼此也不同：一者是进行中，一者是人为关掉。
  expect(MCP_STATUS_THEME.pending).not.toEqual(MCP_STATUS_THEME.disabled);
});

test("failed 保持警示外观（红），pending / disabled 不共用它", () => {
  /**
   * 断言口径随「全站视觉统一」（f3298151）调整：
   * 颜色此前是硬编码 `#DC2626`，现改为 CSS 变量 `var(--color-danger-text)`
   * （亮色 #B91C1C / 暗色 #FCA5A5），以支持暗色模式。
   *
   * 这里不再钉死具体色值（否则每调一次主题变量就红一次），而是钉住**语义**：
   * failed 必须走 danger 语义色，且 pending / disabled 绝不共用它。
   */
  expect(MCP_STATUS_THEME.failed.color).toBe("var(--color-danger-text)");
  expect(MCP_STATUS_THEME.pending.color).not.toBe(MCP_STATUS_THEME.failed.color);
  expect(MCP_STATUS_THEME.disabled.color).not.toBe(MCP_STATUS_THEME.failed.color);
  // 其余四态也各自独立（联合加态时漏配会被这条挡住）
  const colors = Object.values(MCP_STATUS_THEME).map((t) => t.color);
  expect(new Set(colors).size).toBe(colors.length);
});
