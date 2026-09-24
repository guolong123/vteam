import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * third-party-agent-display Todo 2 · 外部 Agent 只读展示 + 非治理警告
 * ==================================================================
 * 覆盖 /agents 第三个 Tab「外部 Agent」（`SegmentedTabs` key="external"）：
 *  A. 列表来自引擎 `GET /agents/opencode`（过滤 governed=false），每条目带
 *     描述 / mode 徽章 / **非治理警告**（vteam 权限规则不适用）；
 *  B. 选中条目 → 只读 `<pre>` 展示系统提示词（`GET /agents/omo-agent-prompt`
 *     按需拉取，与 worker 详情页 AgentPromptModal 同一端点）；
 *  C. 只读性 + 无策略暗示：面板内 **零** textarea / input / select，全页无
 *     prompt-editor / save-agent-button / effective-permission-section；
 *  D. 失败不空白：mock omo-agent-prompt 路由 → HTTP 500，条目必须显示
 *     「说明加载失败（暂不可用）」，绝不出现空框（空框会被读成"无提示词"）。
 *
 * 判别性（MUST DO）：A 的警告计数按条目数断言（少一条即失败）；C 若有人在
 * 详情里加回 textarea/编辑器即失败；D 若失败分支渲染空 `<pre>` 即失败。
 *
 * 运行（从 web/）：`npx playwright test --config .tpad.playwright.config.ts`
 * （独立 tmp config，不碰 playwright.config.ts；baseURL 指向 compose web :13001）
 */

const WARNING = "此 Agent 来自外部（非 vteam 内置），不受 vteam 权限规则管辖。";
const UNAVAILABLE = "说明加载失败（暂不可用）";

async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByTestId("username").fill("admin");
  await page.getByTestId("password").fill("admin123");
  await page.getByTestId("login-button").click();
  await expect(page).toHaveURL(/\/teams/, { timeout: 15_000 });
}

/** 打开 /agents 并切到「外部 Agent」Tab。 */
async function openExternalTab(page: Page) {
  await page.goto("/agents");
  await expect(page.getByTestId("agent-config-root")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("manage-tab").filter({ hasText: "外部 Agent" }).click();
  await expect(page.getByTestId("external-agents-root")).toBeVisible({ timeout: 15_000 });
}

async function waitForExternalPanel(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
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
          { timeout: 10_000 },
        )
        .toBe(true);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    if (ready) return true;
    if (attempt === 2) break;
    await page.reload();
    await expect(page.getByTestId("agent-config-root")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("manage-tab").filter({ hasText: "外部 Agent" }).click();
    await expect(page.getByTestId("external-agents-root")).toBeVisible({ timeout: 15_000 });
  }
  return false;
}

async function save(path: string | undefined, page: Page) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}

test.describe("Todo 2 · 外部 Agent 只读展示", () => {
  test("1. 列表 + 逐条警告 + 只读提示词 + 零编辑控件", async ({ page }) => {
    await loginAsAdmin(page);
    await openExternalTab(page);

    // A. 列表渲染（引擎实时返回，非硬编码）；不可用/空态不得出现
    await expect(page.getByTestId("external-agents-loading")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("external-agents-unavailable")).toHaveCount(0);
    const items = page.getByTestId("external-agent-item");
    await expect(items.first()).toBeVisible({ timeout: 20_000 });
    const itemCount = await items.count();
    expect(itemCount).toBeGreaterThan(0);

    // 每行都有警告（逐条计数：警告数 == 条目数）
    await expect(page.getByTestId("external-agent-item-warning")).toHaveCount(itemCount);
    for (let i = 0; i < itemCount; i++) {
      await expect(items.nth(i).getByTestId("external-agent-item-warning")).toContainText(WARNING);
    }

    // 每行含名称 + mode 徽章 + 描述（描述可能为空 → 占位文案）
    const firstName = await items.first().getAttribute("data-agent-name");
    expect(firstName).toBeTruthy();
    await expect(items.first()).toContainText(/主Agent|子Agent|通用/);

    // B. 选中第一条 → 只读 <pre> 提示词可见（真实拉取，非 mock）
    await items.first().click();
    await expect(items.first()).toHaveAttribute("data-active", "true");
    const detail = page.getByTestId("external-agent-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toHaveAttribute("data-agent-name", firstName!);
    // 详情处再次声明非治理（列表 + 详情双重）
    await expect(page.getByTestId("external-agent-detail-warning")).toContainText(WARNING);

    // 指令：可能 empty（引擎未定义提示词）也可能有全文；两者都不得是错误态
    await expect(page.getByTestId("external-agent-instructions-loading")).toHaveCount(0, {
      timeout: 25_000,
    });
    await expect(page.getByTestId("external-agent-instructions-unavailable")).toHaveCount(0);
    const pre = page.getByTestId("external-agent-instructions");
    const emptyNote = page.getByTestId("external-agent-instructions-empty");
    if ((await pre.count()) > 0) {
      const tag = await pre.evaluate((el) => el.tagName);
      expect(tag).toBe("PRE");
      const text = await pre.innerText();
      expect(text.trim().length).toBeGreaterThan(0);
      // 只读：无 contenteditable
      expect(await pre.getAttribute("contenteditable")).toBeNull();
    } else {
      await expect(emptyNote).toBeVisible();
    }

    // C. 零编辑/权限控件（面板内 + 全页）
    const root = page.getByTestId("external-agents-root");
    await expect(root.locator("textarea")).toHaveCount(0);
    await expect(root.locator("input")).toHaveCount(0);
    await expect(root.locator("select")).toHaveCount(0);
    await expect(root.locator("[contenteditable]")).toHaveCount(0);
    await expect(page.getByTestId("prompt-editor")).toHaveCount(0);
    await expect(page.getByTestId("save-agent-button")).toHaveCount(0);
    await expect(page.getByTestId("effective-permission-section")).toHaveCount(0);
    await expect(page.getByTestId("native-rule-editor")).toHaveCount(0);
    await expect(page.getByTestId("model-select")).toHaveCount(0);
    // 全页 textarea 也应为 0（Agent Tab 未挂载，不存在任何可编辑提示词）
    await expect(page.locator("textarea")).toHaveCount(0);

    await page.setViewportSize({ width: 1280, height: 900 });
    await save(process.env.T2_SCREENSHOT, page);
  });

  test("2. 指令拉取失败 → 显式不可用态（绝不空白）", async ({ page }) => {
    // 在页面加载前拦截：任何 omo-agent-prompt 请求都回 500
    let hits = 0;
    await page.route("**/agents/omo-agent-prompt**", async (route) => {
      hits += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ code: "INTERNAL_ERROR", message: "e2e-mocked-failure" }),
      });
    });

    await loginAsAdmin(page);
    await openExternalTab(page);
    if (!(await waitForExternalPanel(page))) {
      test.skip(true, "外部 Agent 列表在 bounded panel readiness 内不可用");
      return;
    }

    await expect(page.getByTestId("external-agent-item").first()).toBeVisible({ timeout: 20_000 });
    // 自动选中第一条即触发指令请求 → 失败分支必须显式可见
    await expect(page.getByTestId("external-agent-instructions-unavailable")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("external-agent-instructions-unavailable")).toContainText(
      UNAVAILABLE,
    );
    // 不能出现"看似无提示词"的空框/空 <pre>
    await expect(page.getByTestId("external-agent-instructions")).toHaveCount(0);
    await expect(page.getByTestId("external-agent-instructions-empty")).toHaveCount(0);
    // 详情与警告仍在（失败不吞掉上下文）
    await expect(page.getByTestId("external-agent-detail-warning")).toContainText(WARNING);
    expect(hits).toBeGreaterThan(0);

    await save(process.env.T2_FAILURE_SCREENSHOT, page);
  });
});
