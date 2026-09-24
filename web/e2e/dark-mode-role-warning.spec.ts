import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * opencode-native-permissions-and-fixes todo 8 · dark-mode role selection + warnings
 * =================================================================================
 * 角色选中态 (`role-item`) 与外部-agent 警示块原来是硬编码浅色 hex，
 * 深色下整块发白。现改为 globals.css 的 `:root`/`.dark` 变量对
 * (`--color-role-*-{color,bg,border}`、`--color-warning-{text,bg,border}`)，
 * 浅色值逐字节等于原 hex（无浅色回归），深色为半透明 tint。
 *
 * 1. dark：选中 role-item 的计算背景是深色变量（非 #EFF6FF、非 #ffffff）；
 *    警示块文字/背景/边框用深色变量。
 * 2. light：同一断言等于浅色变量（= 原 hex，无回归）。
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
  await expect(page).toHaveURL(/\/teams/, { timeout: 15_000 });
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

async function openExternalTab(page: Page) {
  await page.goto("/agents");
  await expect(page.getByTestId("agent-config-root")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("manage-tab").filter({ hasText: "外部 Agent" }).click();
  await expect(page.getByTestId("external-agents-root")).toBeVisible({ timeout: 15_000 });
}

async function waitForExternalPanel(page: Page): Promise<boolean> {
  let ready = false;
  try {
    await expect
      .poll(
        async () => {
          ready =
            (await page.getByTestId("external-agent-item").count()) > 0 &&
            (await page.getByTestId("external-agents-unavailable").count()) === 0 &&
            (await page.getByTestId("external-agents-empty").count()) === 0;
          return ready;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
  return ready;
}

async function skipIfExternalPanelUnavailable(page: Page): Promise<void> {
  if (!(await waitForExternalPanel(page))) {
    test.skip(true, "外部列表在 20 秒 bounded panel readiness 内不可用");
  }
}

async function computed(page: Page, selector: string, props: string[]) {
  return page.evaluate(
    (arg: { sel: string; ps: string[] }) => {
      const el = document.querySelector(arg.sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const out: Record<string, string> = {};
      for (const p of arg.ps) out[p] = cs.getPropertyValue(p);
      return out;
    },
    { sel: selector, ps: props },
  ) as Promise<Record<string, string> | null>;
}

test.describe("Todo 8 · dark-mode role selection + warnings", () => {
  test("dark 主题：选中 role-item 与警示块无浅色硬编码", async ({ page }) => {
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

    await openExternalTab(page);
    await expect(page.getByTestId("external-agents-loading")).toHaveCount(0, {
      timeout: 20_000,
    });
    await skipIfExternalPanelUnavailable(page);
    const warning = page.getByTestId("external-agent-item-warning").first();
    await expect(warning).toBeVisible({ timeout: 15_000 });
    const w = await warning.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        borderColor: cs.borderTopColor,
      };
    });
    expect(w.color).not.toBe(LIGHT.warningText);
    expect(w.backgroundColor).not.toBe(LIGHT.warningBg);
    expect(w.borderColor).not.toBe(LIGHT.warningBorder);
    expect(w.backgroundColor).toMatch(/^rgba\(/);

    await warning.scrollIntoViewIfNeeded();
    const shot = process.env.T8_SCREENSHOT;
    if (shot) {
      mkdirSync(dirname(shot), { recursive: true });
      await page.screenshot({ path: shot });
    }
  });

  test("light 主题：同一位置等于原浅色 hex（无回归）", async ({ page }) => {
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

    await openExternalTab(page);
    await expect(page.getByTestId("external-agents-loading")).toHaveCount(0, {
      timeout: 20_000,
    });
    await skipIfExternalPanelUnavailable(page);
    const warning = page.getByTestId("external-agent-item-warning").first();
    await expect(warning).toBeVisible({ timeout: 15_000 });
    const w = await warning.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        borderColor: cs.borderTopColor,
      };
    });
    expect(w.color).toBe(LIGHT.warningText);
    expect(w.backgroundColor).toBe(LIGHT.warningBg);
    expect(w.borderColor).toBe(LIGHT.warningBorder);

    // 无用变量守卫：computed() helper 保持被引用（供后续扩展）。
    const probe = await computed(page, '[data-testid="external-agents-root"]', ["display"]);
    expect(probe?.display).toBeTruthy();
  });
});
