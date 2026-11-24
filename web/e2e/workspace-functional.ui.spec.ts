import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "fs";
import { resolve } from "path";

/**
 * 用户视角功能验收（多用户 / 多工作空间隔离）。
 * 每一步都是真实页面操作，并截图留证（.design/multi-workspace/shots/functional/）。
 *
 * 路径：
 *  管理员：登录 → 工作空间（建两个空间）→ 切空间 → 建团队 → 邀请成员
 *        → 跨空间只读（读横幅、写被拒）→ 资源迁移（UI 表单）→ 登出
 *  普通成员：登录 → 空间列表隔离（看不到未邀请空间）→ 切到被邀请空间 → 看到团队
 */
import { E2E_ADMIN_PASSWORD, E2E_ADMIN_USERNAME, E2E_MEMBER_PASSWORD, E2E_SEED_ADMIN_PASSWORD } from "./e2e-credentials";

const SHOT_DIR = resolve(
  __dirname,
  "../../.design/multi-workspace/shots/functional",
);
mkdirSync(SHOT_DIR, { recursive: true });
let seq = 0;
async function shot(page: Page, name: string) {
  seq += 1;
  const file = `${String(seq).padStart(2, "0")}-${name}.png`;
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(SHOT_DIR, file), fullPage: true });
  return file;
}

async function loginViaUi(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByTestId("username").fill(username);
  await page.getByTestId("password").fill(password);
  await page.getByTestId("login-button").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 30_000,
  });
}

test.describe.serial("用户视角功能验收", () => {
  const ts = Date.now();
  const sharedSpace = `验收空间-${ts}`; // 会邀请 seed-member
  const privateSpace = `私有空间-${ts}`; // 不邀请，用于隔离断言
  const foreignSpace = `他人空间-${ts}`; // seed-member 创建，管理员只读查看
  const teamName = `验收团队-${ts}`;

  test("管理员：建空间/切空间/建团队/邀请/只读/迁移", async ({ page }) => {
    test.setTimeout(180_000);
    // 1) 真实表单登录
    await loginViaUi(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
    await expect(page.getByTestId("logout-button")).toBeVisible();
    await shot(page, "admin-登录后");

    // 2) 工作空间页（初始）
    await page.goto("/workspaces");
    await expect(page.getByTestId("workspaces-page")).toBeVisible();
    await expect(page.getByText("我的工作空间")).toBeVisible();
    await shot(page, "管理员-工作空间列表");

    // 3) 创建两个空间（一个共享、一个私有）
    for (const name of [sharedSpace, privateSpace]) {
      await page.getByTestId("workspace-create-name").fill(name);
      await page.getByTestId("workspace-create-submit").click();
      await expect(page.getByTestId("workspace-notice")).toContainText("已创建");
      await expect(page.getByTestId("workspaces-page")).toContainText(name);
    }
    await shot(page, "管理员-已创建两个空间");

    // 4) 切换到「验收空间」（行内按钮）
    const sharedRow = page.getByTestId(/^workspace-row-/).filter({
      hasText: sharedSpace,
    });
    await sharedRow.getByRole("button", { name: "切换到该空间" }).click();
    await expect(page.getByTestId("workspace-notice")).toContainText("已切换");
    // 当前空间标记移动到该行
    await expect(sharedRow).toContainText("当前空间");
    await shot(page, "管理员-切换到验收空间");

    // 5) 在验收空间新建团队（真实表单）
    await page.goto("/teams");
    await shot(page, "管理员-验收空间团队列表(空)");
    await page.getByTestId("create-team-button").click();
    await page.waitForURL(/\/teams\/new/);
    await page.getByTestId("team-name-input").fill(teamName);
    await page.getByTestId("create-team-submit").click();
    // 创建成功后跳到团队详情 /teams/<id>
    await page.waitForURL(/\/teams\/tm_/, { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await shot(page, "管理员-团队创建成功(详情页)");
    await page.goto("/teams");
    await expect(page.getByText(teamName, { exact: false })).toBeVisible();
    await shot(page, "管理员-验收空间团队列表");

    // 6) 回到工作空间页，邀请 seed-member 进验收空间
    await page.goto("/workspaces");
    await page
      .getByTestId(/^workspace-row-/)
      .filter({ hasText: sharedSpace })
      .click();
    await page.getByTestId("workspace-invite-userid").fill("u_seed_member");
    await page.getByTestId("workspace-invite-submit").click();
    await expect(page.getByTestId("workspace-notice")).toContainText("已加入");
    await expect(
      page.getByTestId("workspace-member-u_seed_member"),
    ).toBeVisible();
    await shot(page, "管理员-已邀请成员");

    // 7) 管理员跨空间只读：先在「全部空间」里找到一个自己不是成员的他人空间
    //    （由 seed-member 通过 API 创建，模拟另一位用户的工作空间）
    const apiBase0 =
      process.env.WORKSPACE_API_BASE ?? "http://127.0.0.1:13200/api/v1";
    const memberLogin = await page.request.post(`${apiBase0}/auth/login`, {
      data: { username: "seed-member", password: E2E_SEED_ADMIN_PASSWORD },
    });
    const memberToken = ((await memberLogin.json()) as { accessToken: string })
      .accessToken;
    const foreignRes = await page.request.post(`${apiBase0}/workspaces`, {
      headers: { Authorization: `Bearer ${memberToken}` },
      data: { name: foreignSpace },
    });
    expect(foreignRes.status()).toBe(201);
    const foreignId = ((await foreignRes.json()) as { id: string }).id;

    await page.goto("/workspaces");
    await expect(page.getByTestId("admin-workspaces")).toBeVisible();
    await page.getByTestId("admin-workspace-search").fill(foreignSpace);
    await expect(page.getByTestId("admin-workspaces")).toContainText(foreignSpace);
    await page.getByTestId(`admin-workspace-view-${foreignId}`).click();
    await expect(page.getByTestId("workspace-view-banner")).toBeVisible();
    await expect(page.getByTestId("workspace-view-banner")).toContainText("只读");
    await shot(page, "管理员-全部空间与跨空间只读横幅");

    // 8) 只读态下写入口应直接置灰（服务端 403 由 API 套件覆盖）
    await page.goto("/teams");
    const createTeamBtn = page.getByTestId("create-team-button");
    await expect(createTeamBtn).toBeDisabled();
    await expect(createTeamBtn).toHaveAttribute("title", /只读/);
    await shot(page, "管理员-只读态新建团队置灰");
    await page.goto("/teams/new");
    await expect(page.getByTestId("team-create-read-only-hint")).toBeVisible();
    await expect(page.getByTestId("create-team-submit")).toBeDisabled();
    await shot(page, "管理员-只读态创建页提示");

    // 9) 退出只读视图
    await page.goto("/workspaces");
    await page.getByTestId("workspace-view-exit").click();
    await expect(page.getByTestId("workspace-view-banner")).toHaveCount(0);

    // 10) 资源迁移（UI 表单）：先在当前空间创建一个 Agent（API 造数，页面操作迁移）
    const token = await page.evaluate(() => {
      const raw = window.localStorage.getItem("agent-platform-auth");
      return raw ? JSON.parse(raw).state.token : "";
    });
    const apiBase = process.env.WORKSPACE_API_BASE ?? "http://127.0.0.1:13200/api/v1";
    const agentRes = await page.request.post(`${apiBase}/agents`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: `迁移验收Agent-${ts}`,
        type: "custom",
        agentKey: `ui-reloc-${ts}`,
        prompt: "functional test",
      },
    });
    expect(agentRes.status()).toBe(201);
    const agentId = ((await agentRes.json()) as { id: string }).id;

    await page.goto("/workspaces");
    await page.getByTestId("reloc-resource-id").fill(agentId);
    await page.getByTestId("reloc-target").fill("ws_system");
    await page.getByTestId("reloc-reason").fill("功能验收共享");
    await page.getByTestId("reloc-submit").click();
    await expect(page.getByTestId("workspace-notice")).toContainText("已迁移");
    await expect(page.getByTestId(/^relocation-/).first()).toContainText(agentId);
    await shot(page, "管理员-迁移共享与审计");

    // 11) 登出
    await page.getByTestId("logout-button").click();
    await page.waitForURL(/\/login/);
    await shot(page, "管理员-已登出");
  });

  test("普通成员：空间列表隔离 + 切到被邀请空间看到团队", async ({ page }) => {
    test.setTimeout(120_000);
    // 1) 普通成员真实登录
    await loginViaUi(page, "seed-member", E2E_SEED_ADMIN_PASSWORD);
    await shot(page, "成员-登录后");

    // 2) 空间列表/顶栏切换器：能看到被邀请的「验收空间」，看不到「私有空间」
    await page.goto("/workspaces");
    await expect(page.getByTestId("workspaces-page")).toBeVisible();
    await expect(page.getByTestId("workspace-current-summary")).toBeVisible();
    const switcherBtn = page.getByTestId("workspace-switcher-button");
    await expect(switcherBtn).toBeVisible();
    await switcherBtn.click();
    await expect(page.getByTestId("workspace-switcher-panel")).toBeVisible();
    const panelText = await page.getByTestId("workspace-switcher-panel").innerText();
    expect(panelText).toContain(sharedSpace);
    expect(panelText).not.toContain(privateSpace);
    await shot(page, "成员-空间列表(隔离)");

    // 3) 普通成员看不到管理员迁移面板
    await expect(page.getByTestId("workspace-relocations")).toHaveCount(0);

    // 4) 在切换器里搜索并切到被邀请空间 → 团队可见
    await page.getByTestId("workspace-switcher-search").fill(sharedSpace);
    const sharedOption = page
      .getByTestId("workspace-switcher-panel")
      .getByRole("option")
      .first();
    await sharedOption.click();
    await expect(page.getByTestId("workspace-switcher-panel")).toHaveCount(0);
    // 等切换真正完成（token 重签 + 顶栏空间名更新）再跳转，避免按旧空间取数
    await expect
      .poll(async () => switcherBtn.innerText(), { timeout: 15_000 })
      .toContain(sharedSpace);
    await page.goto("/teams");
    await expect(page.getByText(teamName, { exact: false })).toBeVisible();
    await shot(page, "成员-被邀请空间可看到团队");
  });


test("管理员：新增用户时可选择工作空间", async ({ page, request }) => {
  test.setTimeout(120_000);
  await loginViaUi(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);

  // 先通过页面创建一个空间，作为新用户的归属空间
  const spaceName = `用户空间-${ts}`;
  await page.goto("/workspaces");
  await page.getByTestId("workspace-create-name").fill(spaceName);
  await page.getByTestId("workspace-create-submit").click();
  await expect(page.getByTestId("workspace-notice")).toContainText("已创建");

  // 打开「新增用户」弹窗
  await page.goto("/system/users");
  await page.getByTestId("add-user-button").click();
  await expect(page.getByTestId("user-form-overlay")).toBeVisible();

  const username = `ui_user_${ts}`;
  const password = E2E_MEMBER_PASSWORD;
  await page.getByTestId("username-input").fill(username);
  await page.getByTestId("user-email-input").fill(`${username}@example.com`);
  await page.getByTestId("user-password-input").fill(password);

  // 选择空间（下拉里按名称匹配）
  const wsSelect = page.getByTestId("user-workspace-select");
  const optionValue = await wsSelect
    .locator("option")
    .evaluateAll(
      (els, name) =>
        (els as HTMLOptionElement[]).find((el) =>
          (el.textContent ?? "").includes(name as string),
        )?.value ?? "",
      spaceName,
    );
  expect(optionValue).toBeTruthy();
  await wsSelect.selectOption(optionValue);
  await page.getByTestId("user-workspace-role-select").getByRole("button", {
    name: "空间管理员",
  }).click();
  await shot(page, "管理员-新增用户选择空间");

  await page.getByTestId("user-form-submit").click();
  await expect(page.getByTestId("user-form-overlay")).toHaveCount(0);
  await expect(page.getByText(username, { exact: true }).first()).toBeVisible();
  await shot(page, "管理员-已创建并加入空间的用户");

  // 校验：新用户登录后当前空间即所选空间
  const apiBase =
    process.env.WORKSPACE_API_BASE ?? "http://127.0.0.1:13200/api/v1";
  const loginRes = await request.post(`${apiBase}/auth/login`, {
    data: { username, password },
  });
  expect(loginRes.status()).toBe(200);
  const body = (await loginRes.json()) as {
    user: { currentWorkspaceId?: string };
  };
  expect(body.user.currentWorkspaceId).toBeTruthy();
  const loginBody = (await (
    await request.post(`${apiBase}/auth/login`, {
      data: { username, password },
    })
  ).json()) as { accessToken: string };
  const spaces = (await (
    await request.get(`${apiBase}/workspaces`, {
      headers: { Authorization: `Bearer ${loginBody.accessToken}` },
    })
  ).json()) as Array<{ name: string }>;
  expect(spaces.map((w) => w.name)).toContain(spaceName);
});


test("空间管理员：可管本空间，但没有跨空间/平台级入口", async ({ page }) => {
  test.setTimeout(150_000);
  const apiBase =
    process.env.WORKSPACE_API_BASE ?? "http://127.0.0.1:13200/api/v1";

  // 管理员登录，准备一个「空间管理员」账号（平台角色 member + 空间角色 admin）
  await loginViaUi(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
  const adminToken = await page.evaluate(() => {
    const raw = window.localStorage.getItem("agent-platform-auth");
    return raw ? JSON.parse(raw).state.token : "";
  });
  const ws = await (
    await page.request.post(`${apiBase}/workspaces`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { name: `空间管理员验收-${ts}` },
    })
  ).json();
  const roles = (await (
    await page.request.get(`${apiBase}/roles`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
  ).json()) as Array<{ id: string; name: string }>;
  const memberRoleId = roles.find((r) => r.name === "member")?.id;
  const username = `ui_space_admin_${ts}`;
  const password = E2E_MEMBER_PASSWORD;
  const created = await page.request.post(`${apiBase}/users`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      username,
      password,
      displayName: username,
      roleId: memberRoleId,
      workspaceId: ws.id,
      workspaceRole: "admin",
    },
  });
  expect(created.status()).toBe(201);

  // 切换到空间管理员账号
  await page.getByTestId("logout-button").click();
  await page.waitForURL(/\/login/);
  await loginViaUi(page, username, password);

  // 工作空间页：无「全部空间」、无迁移面板、无跨空间只读入口；角色显示为空间管理员
  await page.goto("/workspaces");
  await expect(page.getByTestId("workspaces-page")).toBeVisible();
  await expect(page.getByTestId("workspace-current-summary")).toContainText(
    "空间管理员",
  );
  await expect(page.getByTestId("admin-workspaces")).toHaveCount(0);
  await expect(page.getByTestId("workspace-relocations")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "平台管理员只读查看" }),
  ).toHaveCount(0);
  await shot(page, "空间管理员-工作空间页(无跨空间入口)");

  // 本空间可正常创建团队（空间级能力开放）
  await page.goto("/teams");
  await expect(page.getByTestId("create-team-button")).toBeEnabled();
  await shot(page, "空间管理员-可管理本空间团队");

  // 平台级页面（用户管理）不可进入 → 路由守卫重定向
  await page.goto("/system/users");
  await page.waitForURL((url) => !url.pathname.startsWith("/system/users"), {
    timeout: 15_000,
  });
  await shot(page, "空间管理员-平台页面被重定向");
});


test("管理员：Worker 安装向导把空间加入码写进安装命令", async ({ page }) => {
  test.setTimeout(120_000);
  await loginViaUi(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
  await page.goto("/workers/install");
  await expect(page.getByTestId("install-wizard")).toBeVisible();

  const wsSelect = page.getByTestId("install-workspace-select");
  await expect(wsSelect).toBeVisible();
  // 空间列表异步加载：等选项出现后再取
  await expect
    .poll(async () => wsSelect.locator("option").count(), { timeout: 15_000 })
    .toBeGreaterThan(1);
  const optionValues = await wsSelect
    .locator("option")
    .evaluateAll((els) =>
      (els as HTMLOptionElement[]).map((el) => el.value).filter(Boolean),
    );
  const nonDefault = optionValues.find((v) => v !== "ws_default");
  expect(nonDefault).toBeTruthy();

  // 非默认空间：自动签发加入码，命令带 WORKSPACE_ID + WORKER_JOIN_TOKEN
  await wsSelect.selectOption(nonDefault!);
  const tokenInput = page.getByTestId("install-space-token-input");
  await expect(tokenInput).toHaveValue(/^wst_/, { timeout: 15_000 });
  const commandEl = page.getByTestId("install-command");
  // 单令牌：curl 只带 --token（空间由令牌反查），不再出现 WORKSPACE_ID / WORKER_JOIN_TOKEN
  await expect
    .poll(async () => (await commandEl.textContent()) ?? "")
    .toContain("--token wst_");
  const curlCmd = (await commandEl.textContent()) ?? "";
  expect(curlCmd).not.toContain("WORKSPACE_ID");
  expect(curlCmd).not.toContain("WORKER_JOIN_TOKEN");
  await shot(page, "管理员-安装命令单令牌(curl)");

  // docker 方式：只带 -e X_WORKER_TOKEN=<空间注册令牌>
  await page.getByTestId("install-method-tab").filter({ hasText: "docker" }).click();
  await expect
    .poll(async () => (await commandEl.textContent()) ?? "")
    .toContain("X_WORKER_TOKEN=wst_");
  const dockerCmd = (await commandEl.textContent()) ?? "";
  expect(dockerCmd).not.toContain("WORKSPACE_ID");
  expect(dockerCmd).not.toContain("WORKER_JOIN_TOKEN");
  await shot(page, "管理员-安装命令单令牌(docker)");

  // 默认空间同样是单令牌（空间由 token 反查，不再有免令牌特例）
  await wsSelect.selectOption("ws_default");
  await expect(page.getByTestId("install-space-token-input")).toHaveValue(
    /^wst_/,
    { timeout: 15_000 },
  );
  await expect
    .poll(async () => (await commandEl.textContent()) ?? "")
    .toContain("X_WORKER_TOKEN=wst_");
  await shot(page, "管理员-默认空间安装命令单令牌");
});


test("管理员：平台资源列表显示所属空间，创建入口提示目标空间", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await loginViaUi(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);

  // 不依赖特定空间数据：先通过 API 在当前空间造一个 Provider，确保列表有资源可断言
  const apiBase =
    process.env.WORKSPACE_API_BASE ?? "http://127.0.0.1:13000/api/v1";
  const loginRes = await page.request.post(`${apiBase}/auth/login`, {
    data: { username: E2E_ADMIN_USERNAME, password: E2E_ADMIN_PASSWORD },
  });
  const adminToken = ((await loginRes.json()) as { accessToken: string }).accessToken;
  const created = await page.request.post(`${apiBase}/models`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      providerID: `ui-badge-provider-${Date.now()}`,
      modelID: "m",
      name: "Badge Probe",
      providerType: "cloud",
    },
  });
  expect(created.ok()).toBeTruthy();

  // 模型/Provider 页：Provider 行有「所属空间」徽章 + 创建目标提示
  await page.goto("/models");
  await expect(page.getByTestId("create-space-hint").first()).toBeVisible();
  await expect(page.getByTestId("space-badge").first()).toBeVisible();
  await shot(page, "管理员-Provider列表显示所属空间");

  // 技能页：平台内置技能显示「平台共享」徽章
  await page.goto("/skills");
  await expect(page.getByTestId("space-badge").first()).toBeVisible();
  await expect(page.getByTestId("create-space-hint").first()).toBeVisible();
  await shot(page, "管理员-技能列表显示所属空间");
});


test("管理员：岗位/集成渠道也显示所属空间", async ({ page }) => {
  test.setTimeout(120_000);
  await loginViaUi(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);

  // Agent 页「角色」Tab：内置岗位显示平台共享徽章
  await page.goto("/agents");
  await page.getByRole("button", { name: "角色", exact: true }).click();
  await expect(page.getByTestId("space-badge").first()).toBeVisible();
  await shot(page, "管理员-岗位列表显示所属空间");

  // 集成渠道页：创建入口显示目标空间提示
  await page.goto("/integrations");
  await expect(page.getByTestId("create-space-hint").first()).toBeVisible();
  await shot(page, "管理员-集成渠道创建空间提示");
});


test("管理员：编辑用户时调整所属空间与当前空间", async ({ page }) => {
  test.setTimeout(120_000);
  const apiBase =
    process.env.WORKSPACE_API_BASE ?? "http://127.0.0.1:13200/api/v1";

  // 准备：管理员 API 登录、取空间与 member 角色、建一个临时用户（初始在 A 空间）
  const loginRes = await page.request.post(`${apiBase}/auth/login`, {
    data: { username: E2E_ADMIN_USERNAME, password: E2E_ADMIN_PASSWORD },
  });
  expect(loginRes.ok()).toBeTruthy();
  const admin = (await loginRes.json()) as { accessToken: string };
  const allRes = await page.request.get(`${apiBase}/workspaces/all`, {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
  });
  const spaces = (await allRes.json()) as Array<{
    id: string;
    name: string;
    isSystem: boolean;
  }>;
  const editable = spaces.filter((w) => !w.isSystem);
  expect(editable.length).toBeGreaterThanOrEqual(2);
  const [spaceA, spaceB] = editable;
  const rolesRes = await page.request.get(`${apiBase}/roles`, {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
  });
  const roles = (await rolesRes.json()) as Array<{ id: string; name: string }>;
  const memberRoleId = roles.find((r) => r.name === "member")?.id;
  const username = `ui_space_edit_${Date.now()}`;
  const password = E2E_MEMBER_PASSWORD;
  const createdRes = await page.request.post(`${apiBase}/users`, {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
    data: {
      username,
      password,
      displayName: username,
      email: `${username}@example.com`,
      roleId: memberRoleId,
      workspaceId: spaceA.id,
      workspaceRole: "member",
    },
  });
  expect(createdRes.status()).toBe(201);

  // UI：编辑该用户，勾选 B 空间并把当前空间切到 B
  await loginViaUi(page, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
  await page.goto("/system/users");
  await page.getByTestId("users-search").fill(username);
  const item = page.getByTestId("user-item").filter({ hasText: username });
  await expect(item.first()).toBeVisible({ timeout: 15_000 });
  await item.first().getByTestId("user-edit-button").click();
  await expect(page.getByTestId("edit-user-form")).toBeVisible();
  await page.getByTestId(`edit-user-space-${spaceB.id}`).check();
  await page.getByTestId("edit-user-current-space").selectOption(spaceB.id);
  await page.getByTestId("edit-user-submit").click();
  await expect(page.getByTestId("edit-user-form")).toBeHidden({
    timeout: 15_000,
  });
  await shot(page, "管理员-编辑用户所属空间");

  // 校验：用户重新登录，当前空间 = B，且加入 A/B 两个空间
  const verifyLogin = await page.request.post(`${apiBase}/auth/login`, {
    data: { username, password },
  });
  expect(verifyLogin.ok()).toBeTruthy();
  const verify = (await verifyLogin.json()) as {
    user: { currentWorkspaceId: string; workspaces: Array<{ id: string }> };
  };
  expect(verify.user.currentWorkspaceId).toBe(spaceB.id);
  const joined = verify.user.workspaces.map((w) => w.id);
  expect(joined).toContain(spaceA.id);
  expect(joined).toContain(spaceB.id);
});
});