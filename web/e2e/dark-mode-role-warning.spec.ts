import { mkdirSync } from "node:fs";
import { LANDING_ADMIN } from "@/lib/landing";
import { dirname } from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * opencode-native-permissions-and-fixes todo 8 · dark-mode role selection + warnings
 * =================================================================================
 * 角色选中态 (`role-item`) 原来是硬编码浅色 hex，深色下整块发白。
 * 现改为 globals.css 的 `:root`/`.dark` 变量对（`--color-role-*-{color,bg,border}`），
 * 浅色值逐字节等于原 hex（无浅色回归），深色为半透明 tint。
 *
 * 1. dark：选中 role-item 的计算背景是深色变量（非 #EFF6FF、非 #ffffff）。
 * 2. light：同一断言等于浅色变量（= 原 hex，无回归）。
 *
 * 注：原本还覆盖「外部 Agent 警示块」的配色，该面板已随外部 agent 功能下线移除。
 *
 * 主题走应用自己的 `theme-toggle`（theme-store → html.dark），与真实用户一致。
 * 截图用 viewport + scrollIntoViewIfNeeded（fullPage 在本应用不可靠：主区域是内部滚动容器）。
 *
 * 运行（从 web/）：
 *   npx playwright test --config .t8.playwright.config.ts
 * （独立 tmp config，不碰 playwright.config.ts；baseURL 指向 compose web :13001）
 */

// 浅色变量 = 原硬编码 hex（逐字节相等，无回归的证明锚点）。
const LIGHT = {
  roleProductBg: "rgb(239, 246, 255)", // #EFF6FF
  warningText: "rgb(180, 83, 9)", // #B45309
  warningBg: "rgb(255, 251, 235)", // #FFFBEB
  warningBorder: "rgb(253, 230, 138)", // #FDE68A
} as const;

async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByTestId("username").fill("admin");
  await page.getByTestId("password").fill("admin123");
  await page.getByTestId("login-button").click();
  await expect(page).toHaveURL(new RegExp(`${LANDING_ADMIN}$`), { timeout: 15_000 });
}

/** 经应用自己的主题菜单切换（与 ThemeProvider 写入 html.dark 同源）。 */
async function setTheme(page: Page, theme: "light" | "dark") {
  await page.getByTestId("theme-toggle").click();
  await page.getByTestId(`theme-option-${theme}`).click();
  await expect(page.locator("html")).toHaveClass(
    theme === "dark" ? /dark/ : /^(?!.*dark).*$/,
    { timeout: 10_000 },
  );
}

async function openRolesTab(page: Page) {
  await page.goto("/agents");
  await expect(page.getByTestId("agent-config-root")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("manage-tab").filter({ hasText: "角色" }).click();
  await expect(page.getByTestId("agent-role-root")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("role-item").first()).toBeVisible({ timeout: 15_000 });
}

test.describe("Todo 8 · dark-mode role selection + warnings", () => {
  test("dark 主题：选中 role-item 无浅色硬编码", async ({ page }) => {
    test.setTimeout(300_000);
    await loginAsAdmin(page);
    await setTheme(page, "dark");
    await openRolesTab(page);

    const active = page.locator('[data-testid="role-item"][data-active="true"]').first();
    await expect(active).toBeVisible();
    const roleBg = await active.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(roleBg).not.toBe(LIGHT.roleProductBg);
    expect(roleBg).not.toBe("rgb(255, 255, 255)");
    // 半透明 tint：alpha 通道存在（rgba），区别于原不透明浅色
    expect(roleBg).toMatch(/^rgba\(/);

    // 证据截图：角色选中态（外部 Agent 面板已随该功能下线移除）
    const shot = process.env.T8_SCREENSHOT;
    if (shot) {
      mkdirSync(dirname(shot), { recursive: true });
      await page.screenshot({ path: shot });
    }
  });

  test("light 主题：同一位置等于原浅色 hex（无回归）", async ({ page }) => {
    test.setTimeout(300_000);
    await loginAsAdmin(page);
    await setTheme(page, "light");
    await openRolesTab(page);

    // 首个内置角色是 product（#EFF6FF）；选中态背景必须逐字节等于原值。
    const product = page.locator('[data-testid="role-item"][data-role-key="product"]').first();
    await expect(product).toBeVisible();
    await product.click();
    await expect(product).toHaveAttribute("data-active", "true");
    const roleBg = await product.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(roleBg).toBe(LIGHT.roleProductBg);
  });
});
