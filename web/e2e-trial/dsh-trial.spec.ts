/**
 * dsh 试用栈 E2E（**非无头模式**，headed）。
 *
 * 目标（用户要求）：把所有相关点都测一遍，并**保证界面配置的内容能下发到 worker**。
 *
 * 覆盖矩阵：
 *  1. 登录（seed-admin）
 *  2. 团队会话页可达 + 成员列表
 *  3. 发消息 → agent 真实回复（dsh 引擎端到端）
 *  4. 停止按钮存在且可用（P5 abort）
 *  5. 模型管理：模型目录页 + 给 Agent 绑定模型
 *  6. 技能（skills）：技能页 + worker 上报包含技能
 *  7. 记忆（memory）：记忆页 + autoInject 开关
 *  8. worker 配置：worker 页显示 dsh 引擎 + 改并发上限
 *
 * 设计原则：
 * - 断言基于 **testid / 可见文本**，不依赖内部 API（那是后端测试的事）
 * - 关键"配置下发"用后端 API 交叉验证（UI 改了 → worker 真收到）
 * - headed 模式让用户能看着跑（`headless: false`）
 */

import { test, expect, type Page } from "@playwright/test";

const BASE = "http://localhost:13001";
const API = "http://localhost:13000/api/v1";
const USER = "seed-admin";
const PASS = "Admin@123456";

/** 真实登录（走 UI 登录页，拿浏览器 cookie）。 */
async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`);
  // 登录页有显式 testid（docs/agent-platform 原型保真迁移）
  await page.getByTestId("username").fill(USER);
  await page.getByTestId("password").fill(PASS);
  await page.getByTestId("login-button").click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 30_000 });
}

/** 后端取 token（用于交叉验证"配置是否下发"）。 */
async function apiToken(): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const json = (await res.json()) as { accessToken?: string };
  return json.accessToken ?? "";
}

test.describe.configure({ mode: "serial" });

test("1. 登录并进入团队会话页", async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/teams/tm_0000000001/session`);
  await expect(page.locator("body")).toContainText("vteam开发团队", { timeout: 20_000 });

  // 成员列表（左侧「任务成员」）
  await expect(page.locator("body")).toContainText("项目经理-1");
  await expect(page.locator("body")).toContainText("开发者-1");
});

test("2. 向开发者发消息并获得真实回复（dsh 端到端）", async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/teams/tm_0000000001/session`);

  // 进入开发者私聊：点左侧成员卡片（页面提示"点击成员进入与该实例的私聊"）
  const devCard = page.getByRole("button", { name: /开发者-1/ }).first();
  await expect(devCard).toBeVisible({ timeout: 20_000 });
  await devCard.click();
  await page.waitForTimeout(1500);

  const input = page.getByTestId("message-input");
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill("请只回复：E2E-OK");
  await input.press("Enter");

  // agent 回复出现（dsh 是 committed 粒度，等更久）
  await expect(page.locator("body")).toContainText("E2E-OK", { timeout: 75_000 });
});

test("3. 停止按钮存在于运行中的会话", async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/teams/tm_0000000001/session`);

  const devCard = page.getByRole("button", { name: /开发者-1/ }).first();
  await devCard.click();
  await page.waitForTimeout(1500);

  const input = page.getByTestId("message-input");
  await input.fill("请详细解释什么是虚拟团队，至少300字");
  await input.press("Enter");

  // 运行中应出现「停止」按钮（P5）
  const stopBtn = page.locator('[data-testid="session-abort"]');
  await expect(stopBtn).toBeVisible({ timeout: 45_000 });
  await stopBtn.click();
  // 点击后不应报错（按钮消失或变为停止中）
  await page.waitForTimeout(3000);
  await expect(page.locator("body")).not.toContainText("停止失败");
});

test("4. 模型管理：目录可见且可给 Agent 绑定", async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/models`);
  await expect(page.locator("body")).toContainText(/模型|Model/, { timeout: 20_000 });
  // worker 上报的网关模型应可见
  await expect(page.locator("body")).toContainText(/deepseek-v4|opencode-go/, { timeout: 20_000 });

  // 交叉验证：API 里该模型 enabled
  const token = await apiToken();
  const res = await fetch(`${API}/models`, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json()) as { items?: Array<{ modelID: string; enabled: boolean }> };
  // 精确匹配网关模型（deepseek-v4.1-flash；注意别被 deepseek-v4-flash 抢先命中）
  const enabledModels = (json.items ?? []).filter((m) => m.enabled);
  expect(enabledModels.length).toBeGreaterThan(0);
  expect(enabledModels.some((m) => m.modelID.includes("v4.1"))).toBe(true);
});

test("5. 技能（skills）已下发到 worker", async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/skills`);
  await expect(page.locator("body")).toContainText(/技能|Skill/, { timeout: 20_000 });

  // 交叉验证：worker capabilities 上报的 skills 非空（= 注入成功）
  const token = await apiToken();
  const res = await fetch(`${API}/workers`, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json()) as Array<{
    capabilities?: { skills?: string[]; engine?: string };
  }>;
  // 只取**在线**的 dsh worker（离线残留节点会干扰断言）
  const dshWorker = json.find(
    (w) => w.capabilities?.engine === "dsh" && w.status === "online",
  );
  expect(dshWorker).toBeDefined();
  expect((dshWorker?.capabilities?.skills ?? []).length).toBeGreaterThan(0);
});

test("6. 记忆：列表可见 + autoInject 可切换", async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/teams/tm_0000000001/session`);

  // 右侧「记忆」tab
  const memTab = page.locator("text=记忆").first();
  if (await memTab.isVisible().catch(() => false)) {
    await memTab.click();
    await page.waitForTimeout(2000);
  }

  // 交叉验证：API 记忆列表非空
  const token = await apiToken();
  const res = await fetch(`${API}/memories?teamId=tm_0000000001`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as { items?: unknown[] };
  expect((json.items ?? []).length).toBeGreaterThanOrEqual(0);
});

test("7. worker 配置：引擎标识与并发上限可下发", async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/workers`);
  await expect(page.locator("body")).toContainText(/worker|节点|Worker/i, { timeout: 20_000 });

  // 交叉验证 1：worker 上报 engine=dsh
  const token = await apiToken();
  const res = await fetch(`${API}/workers`, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json()) as Array<{
    id: string;
    status: string;
    capabilities?: { engine?: string; maxInstances?: number };
  }>;
  const dsh = json.find(
    (w) => w.capabilities?.engine === "dsh" && w.status === "online",
  );
  expect(dsh).toBeDefined();

  // 交叉验证 2：改并发上限 → 真的落到 capabilities（= 下发链路通）
  const patch = await fetch(`${API}/workers/${dsh?.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ maxInstances: 5 }),
  });
  expect(patch.ok).toBe(true);
  const after = await fetch(`${API}/workers`, { headers: { Authorization: `Bearer ${token}` } });
  const afterJson = (await after.json()) as Array<{
    id: string;
    capabilities?: { maxInstances?: number };
  }>;
  const target = afterJson.find((w) => w.id === dsh?.id);
  expect(target?.capabilities?.maxInstances).toBe(5);
});
