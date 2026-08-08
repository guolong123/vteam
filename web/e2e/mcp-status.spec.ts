/**
 * T8c 前端三态展示 E2E：访问 skills 页 MCP 工具子 Tab，
 * 断言 mcp-status 徽章的 data-status 为真实三态（connected / failed / needs_auth）。
 *
 * ⚠️ 数据依赖：需要环境中有 source=mcp 的工具，且其 mcpServer 引用在
 * mcp_servers 表中存在并有 worker 心跳上报的 status。缺省数据下该行显示
 * disconnected（中性默认）→ 本测试会失败，属预期（数据驱动测试，非主套件
 * testMatch；按需用 `--config` 单独运行）。
 */
import { test, expect } from "@playwright/test";

test("skills 页 MCP 子 Tab 显示真实三态（T8c）", async ({ page }) => {
  await page.goto("/skills");

  // 切到工具 Tab → MCP 子 Tab
  await page.getByRole("button", { name: /工具/ }).first().click();
  await page.getByRole("button", { name: /MCP 工具/ }).click();

  // 等 MCP 工具行出现
  const item = page.getByTestId("mcp-tool-item").first();
  await expect(item).toBeVisible({ timeout: 15_000 });

  const status = await item.getAttribute("data-status");
  console.log("mcp-tool-item data-status =", status);
  // 三态之一：connected / failed / needs_auth
  expect(["connected", "failed", "needs_auth"]).toContain(status);

  // 徽章主题渲染：data-status 与 mcpStatusTheme 键一致
  const badge = item.getByTestId("mcp-status");
  const badgeStatus = await badge.getAttribute("data-status");
  expect(badgeStatus).toBe(status);
});
