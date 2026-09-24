import { test, expect } from "@playwright/test";
import { NAV_SHELL_TESTIDS, PAGE_SMOKE } from "./reference/testids";

/**
 * 18 页 data-testid 断言（Phase 5 T9 + C6）
 * =============================================
 * - 覆盖 15 个实际路由（login 独立 spec；nav-cmdk/nav-hybrid/nav-rail 三变体
 *   由 AppShell 融合导航承载，每页断言 NAV_SHELL_TESTIDS 核心元素即覆盖其终态）
 * - 每页断言：root + 代表性 3-5 testid（PAGE_SMOKE）+ 数据行存在性（seed 数据事实）
 * - 条件渲染区块（skills 工具 Tab / tool-register 执行形态）按可达性分态断言
 * - 登录态：storageState（auth.setup.ts 真实表单登录 seed-admin）
 */
const PAGES_TEAM_ID = "tm_0000000001";

async function ensurePagesTask(request: import("@playwright/test").APIRequestContext) {
  const login = await request.post("/api/v1/auth/login", {
    data: { username: "seed-admin", password: "Admin@123456" },
  });
  expect(login.ok()).toBeTruthy();
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = { Authorization: `Bearer ${accessToken}` };
  const teamResponse = await request.get(`/api/v1/teams/${PAGES_TEAM_ID}`, { headers });
  expect(teamResponse.ok()).toBeTruthy();
  const team = (await teamResponse.json()) as { currentTaskId: string | null };
  let taskId = team.currentTaskId;
  if (!taskId) {
    const created = await request.post("/api/v1/tasks", {
      headers,
      data: { teamId: PAGES_TEAM_ID, title: "e2e-BoardDrawer", priority: "medium" },
    });
    expect(created.status()).toBe(201);
    taskId = ((await created.json()) as { id: string }).id;
  }
  const taskResponse = await request.get(`/api/v1/tasks/${taskId}`, { headers });
  expect(taskResponse.ok()).toBeTruthy();
  const task = (await taskResponse.json()) as { status: string };
  if (task.status !== "in_progress") {
    expect(task.status).toBe("pending");
    const started = await request.post(`/api/v1/tasks/${taskId}/start`, { headers });
    expect(started.ok()).toBeTruthy();
  }
}

test.describe("18 页 testid 断言（seed-admin 登录态）", () => {
  test.beforeAll(async ({ request }) => {
    await ensurePagesTask(request);
  });
  /** 融合导航核心元素（nav-hybrid 终态心智：NavTopBar + NavDock + CmdKPanel） */
  const NAV_CORE = ["app-shell", "rail-bar", "topbar", "cmdk-trigger"];

  /** 每页统一前置：导航融合元素存在 */
  async function expectNavShell(page: import("@playwright/test").Page) {
    for (const tid of NAV_CORE) {
      await expect(page.getByTestId(tid).first()).toBeVisible();
    }
  }

  test("2/17 team-list /teams（项目列表已拆除，主工作台）", async ({ page }) => {
    await page.goto("/teams");
    await expectNavShell(page);
    await expect(page.getByTestId("teams-list-root")).toBeVisible();
    await expect(page.getByTestId("team-card").first()).toBeVisible();
    await expect(page.getByTestId("create-team-button")).toBeVisible();
  });

  test("3/17 task-create /tasks/new?teamId=tm_0000000001（团队预选，直出 Agent 选项）", async ({ page }) => {
    await page.goto("/tasks/new?teamId=tm_0000000001");
    await expectNavShell(page);
    await expect(page.getByTestId("task-create-root")).toBeVisible();
    await expect(page.getByTestId("task-title")).toBeVisible();
    await expect(page.getByTestId("priority-select")).toBeVisible();
    // T10 起 Agent 选择改为团队成员只读预览（team-member-preview-item；agent-option 已拆除）
    await expect(page.getByTestId("team-member-preview-item").first()).toBeVisible();
    await expect(page.getByTestId("create-task-button")).toBeVisible();
  });

  test("4/17 task-board /board?teamId=tm_0000000001", async ({ page }) => {
    await page.goto("/board?teamId=tm_0000000001");
    await expectNavShell(page);
    await expect(page.getByTestId("task-board-root")).toBeVisible();
    await expect(page.getByTestId("status-filter")).toBeVisible();
    await expect(page.getByTestId("task-card").first()).toBeVisible();
    await expect(page.getByTestId("status-badge").first()).toBeVisible();
  });

  test("4b/17 board-drawer 看板卡片开抽屉不进聊天", async ({ page, request }) => {
    // 空库时自建一个看板任务夹具（Bearer 同 7/17 原因）
    const cards = page.getByTestId("task-card");
    await page.goto("/board?teamId=tm_0000000001");
    await expectNavShell(page);
    if ((await cards.count()) === 0) {
      const login = await request.post("/api/v1/auth/login", {
        data: { username: "seed-admin", password: "Admin@123456" },
      });
      const { accessToken } = await login.json();
      await request.post("/api/v1/tasks", {
        headers: { Authorization: `Bearer ${accessToken}` },
        data: { teamId: "tm_0000000001", title: "e2e-BoardDrawer", priority: "medium" },
      });
      await page.reload();
    }
    await page.getByTestId("task-card").first().getByTestId("status-badge").first().click();
    await expect(page.getByTestId("task-detail-drawer")).toBeVisible();
    // 卡片点击不再跳转 /tasks/:id
    expect(page.url()).toContain("/board");
    await expect(page.getByTestId("enter-team-session-drawer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-detail-drawer")).toHaveCount(0);
  });

  test("5/17 agent-config /agents", async ({ page }) => {
    await page.goto("/agents");
    await expectNavShell(page);
    await expect(page.getByTestId("agent-config-root")).toBeVisible();
    await expect(page.getByTestId("agent-list-item").first()).toBeVisible();
    await expect(page.getByTestId("clone-template-button")).toBeVisible();
    await expect(page.getByTestId("model-select").first()).toBeVisible();
    await expect(page.getByTestId("persona-select").first()).toBeVisible();
    await expect(page.getByTestId("persona-select").first()).toBeEnabled();
  });

  test("7b/17 team-session /teams/tm_0000000001/session（团队唯一聊天入口）", async ({ page }) => {
    await page.goto("/teams/tm_0000000001/session");
    await expectNavShell(page);
    await expect(page.getByTestId("team-session-root")).toBeVisible();
    await expect(page.getByTestId("members-panel")).toBeVisible();
    await expect(page.getByTestId("dm-tabs")).toBeVisible();
    await expect(page.getByTestId("dm-tab-group")).toBeVisible();
    await expect(page.getByTestId("chat-message-list")).toBeVisible();
    // 私聊 Tab：点击成员私聊按钮进入 private: 频道
    const privates = page.locator('[data-testid^="dm-tab-private-"]');
    if ((await privates.count()) > 0) {
      await privates.first().click();
      await expect(page.getByTestId("chat-message-list")).toBeVisible();
      await page.getByTestId("dm-tab-group").click();
    }
    // 右栏新结构（Phase 7 改版）：一级 团队/任务 + 任务四子页（默认落任务见下方 T24 站内进入用例）
    const panel = page.getByTestId("task-panel");
    await expect(panel.getByRole("button", { name: "团队", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "任务", exact: true })).toBeVisible();
    // 任务 4 子页：状态/计划/产出/触发；「配置」不再出现
    await panel.getByRole("button", { name: "任务", exact: true }).click();
    await expect(page.getByTestId("task-subtab-scroll")).toBeVisible();
    await expect(page.getByTestId("team-subtab-scroll")).toHaveCount(0);
    // 任务 4 子页：状态/计划/产出/触发；「配置」不再出现
    for (const name of ["状态", "计划", "产出", "触发"]) {
      await expect(panel.getByRole("button", { name })).toContainText(name);
    }
    await expect(page.getByTestId("task-subtab-triggers")).toBeVisible();
    await expect(panel.getByRole("button", { name: "配置", exact: true })).toHaveCount(0);
    // 团队 2 子页：切团队 Tab → 只有概览/渠道；设置/记忆/操作不再出现
    await panel.getByRole("button", { name: "团队", exact: true }).click();
    await expect(page.getByTestId("team-subtab-scroll")).toBeVisible();
    await expect(panel.getByRole("button", { name: "概览" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "渠道" })).toBeVisible();
    for (const name of ["设置", "记忆", "操作"]) {
      await expect(panel.getByRole("button", { name, exact: true })).toHaveCount(0);
    }
    // 切回任务 Tab
    await panel.getByRole("button", { name: "任务", exact: true }).click();
    await expect(page.getByTestId("task-subtab-scroll")).toBeVisible();
  });

  test("team-session zero-task 零任务直聊（无选择器）", async ({ page, request }) => {
    const login = await request.post("/api/v1/auth/login", {
      data: { username: "seed-admin", password: "Admin@123456" },
    });
    const { accessToken } = await login.json();
    const headers = { Authorization: `Bearer ${accessToken}` };
    // 全新零任务团队（创建者即 owner；后端建团队即建 team_group 频道，即完整直聊路径；
    // 不复用种子 tm_0000000002：其建于频道自动创建之前，无频道只会进 team-session-empty）
    let agentId = "a_product";
    let roleId: string | undefined;
    const seed = await request.get("/api/v1/teams/tm_0000000001", { headers });
    if (seed.ok()) {
      const members = (((await seed.json()) as { members: { agentId: string; roleId?: string }[] }).members ?? []);
      if (members[0]?.agentId) agentId = members[0].agentId;
      if (members[0]?.roleId) roleId = members[0].roleId;
    }
    const created = await request.post("/api/v1/teams", {
      headers,
      data: { name: `e2e-ZeroTask-${Date.now()}`, members: [{ agentId, ...(roleId ? { roleId } : {}) }] },
    });
    expect(created.ok()).toBeTruthy();
    const teamId = ((await created.json()) as { id: string }).id;
    expect(teamId).toBeTruthy();
    await page.goto(`/teams/${teamId}/session`);
    await expectNavShell(page);
    await expect(page.getByTestId("team-session-root")).toBeVisible();
    await expect(page.getByTestId("team-session-empty")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("team-session-current-task")).toHaveCount(0);
    // 改版后无 team-right-empty 空态：零任务团队右栏仅「团队」主 Tab（无任务 Tab）
    await expect(page.getByTestId("task-panel").getByRole("button", { name: "任务", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("team-subtab-scroll")).toBeVisible();
    await expect(page.getByTestId("chat-message-list")).toBeVisible();
    const sent = `e2e-zerotask-${Date.now()}`;
    await page.getByTestId("message-input").fill(sent);
    await page.getByTestId("message-input-send").click();
    await expect(page.getByTestId("chat-message-list").getByText(sent)).toBeVisible();
    expect(page.url()).toContain(`/teams/${teamId}/session`);
    await expect(page.getByTestId("team-session-send-error")).toHaveCount(0);
    await expect(page.getByTestId("team-session-current-task")).toHaveCount(0);
    const after = await request.get(`/api/v1/teams/${teamId}`, { headers });
    if (after.ok()) {
      expect(((await after.json()) as { currentTaskId: string | null }).currentTaskId ?? null).toBeNull();
    }
    await request.delete(`/api/v1/teams/${teamId}`, { headers });
  });

  test("8-10/17 导航变体（AppShell 融合导航承载）", async ({ page }) => {
    // nav-cmdk / nav-hybrid / nav-rail 三变体无独立路由，融合导航为终态——
    // 命令面板（nav-cmdk 核心）与 Dock 面板（nav-rail 核心）在登录页后全站可用
    await page.goto("/teams");
    await expect(page.getByTestId("cmdk-trigger")).toBeVisible();
    // 唤起命令面板 → cmdk-panel 全组件（nav-cmdk 变体核心）
    await page.getByTestId("cmdk-trigger").click();
    await expect(page.getByTestId("cmdk-panel")).toBeVisible();
    await expect(page.getByTestId("cmdk-search")).toBeVisible();
    await expect(page.getByTestId("cmdk-item").first()).toBeVisible();
    // Dock 面板（nav-rail 变体核心：rail-bar/rail-icon/rail-panel/nav-item）
    await expect(page.getByTestId("rail-bar")).toBeVisible();
    await expect(page.getByTestId("rail-icon").first()).toBeVisible();
    await expect(page.getByTestId("nav-item").first()).toBeVisible();

    // Dock「导航」↔ Cmd+K「导航」组一致性（防回归）：
    // 两处曾各自硬编码，命令面板漏掉「团队管理」→ 搜无匹配命令。
    // 现命令面板导航组由 NAV_ITEMS 派生，数量与标签必须逐项相同。
    // （Todo 14 起「用户管理 / 角色权限 / 记忆管理」有意移出顶级导航，
    // 收敛至 /system 二级导航；下方断言其缺席 + 导航组以「系统管理」收尾。）
    // nav-item 文本含图标 span，先剥离图标字符（保留标签内部空格）。
    const stripIcon = (s: string) =>
      s.replace(/[^\u4e00-\u9fa5A-Za-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    const navLabels = (await page.getByTestId("nav-item").allInnerTexts())
      .map(stripIcon)
      .sort();
    // 「导航」组 = 命令面板全部项去掉「操作」组（新建任务）
    const cmdkNavLabels = (
      await page.locator('[data-testid="cmdk-item"] span.navcmdk-item-label').allInnerTexts()
    )
      .map(stripIcon)
      .filter((l) => l !== "新建任务")
      .sort();
    expect(cmdkNavLabels).toEqual(navLabels);
    // Todo 14 起 memories 已移出 NAV_ITEMS：导航组共 8 项、以「系统管理」收尾，
    // 「用户管理 / 角色权限 / 记忆管理」收敛至 /system 二级导航。
    // 搜「系统」必须命中「系统管理」；搜「记忆」不再命中任何「记忆管理」项。
    const navLabelsOrdered = (await page.getByTestId("nav-item").allInnerTexts()).map(stripIcon);
    expect(navLabelsOrdered).toHaveLength(8);
    expect(navLabelsOrdered[navLabelsOrdered.length - 1]).toBe("系统管理");
    await page.getByTestId("cmdk-search").locator("input").fill("系统");
    await expect(page.getByTestId("cmdk-item").first()).toBeVisible();
    await expect(page.getByTestId("cmdk-item").first()).toContainText("系统管理");
    await page.getByTestId("cmdk-search").locator("input").fill("记忆");
    await expect(page.getByTestId("cmdk-item").filter({ hasText: "记忆管理" })).toHaveCount(0);

    // 关闭命令面板（Esc）
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("cmdk-panel")).not.toBeVisible();
  });

  test("11/17 role-permission /roles", async ({ page }) => {
    await page.goto("/roles");
    // Todo 17：/roles 重定向至 /system/roles（旧书签兼容）
    await expect(page).toHaveURL(/\/system\/roles/);
    await expectNavShell(page);
    await expect(page.getByTestId("role-permission-root")).toBeVisible();
    await expect(page.getByTestId("role-item").first()).toBeVisible();
    await expect(page.getByTestId("permission-matrix")).toBeVisible();
    await expect(page.getByTestId("add-role-button")).toBeVisible();
  });

  test("12/17 skills-tools-manage /skills（双 Tab + 工具三子 Tab）", async ({ page }) => {
    await page.goto("/skills");
    await expectNavShell(page);
    await expect(page.getByTestId("skills-tools-manage-root")).toBeVisible();
    await expect(page.getByTestId("manage-tabs")).toBeVisible();
    // 搜索框已随 478f620 技能页重构移除（等效工具条保留）：断言工具条存在
    await expect(page.getByTestId("manage-toolbar")).toBeVisible();
    // 技能 Tab（初始）：skill-item 存在
    await expect(page.getByTestId("skill-item").first()).toBeVisible();
    // 工具 Tab：tool-subtabs + tool-item（内置）
    await page.getByTestId("manage-tab").filter({ hasText: /工具/ }).click();
    await expect(page.getByTestId("tool-subtabs")).toBeVisible();
    await expect(page.getByTestId("tool-item").first()).toBeVisible();
    // MCP 子 Tab：服务器列表 → 选中首个服务器 → 其工具列表（二级视图）
    await page.getByTestId("tool-subtab").filter({ hasText: /MCP|mcp/i }).click();
    await expect(page.getByTestId("mcp-server-section")).toBeVisible();
    await expect(page.getByTestId("mcp-server-item").first()).toBeVisible();
    await page.getByTestId("mcp-server-item").first().click();
    await expect(page.getByTestId("mcp-tool-item").first()).toBeVisible();
  });

  test("13/17 task-detail /artifacts?teamId=tm_0000000001 → /docs 重定向（路由收敛 T10）", async ({ page }) => {
    await page.goto("/artifacts?teamId=tm_0000000001&type=text");
    // 瘦重定向页：全量透传 searchParams，落地 /docs 且参数保留
    await expect(page).toHaveURL(/\/docs\?.*teamId=tm_0000000001/);
    await expect(page).toHaveURL(/type=text/);
    await expectNavShell(page);
    // 统一文档站渲染：teamId 生效（团队选择器不出现，直出筛选栏 + 文档树）
    await expect(page.getByTestId("docs-shell")).toBeVisible();
    await expect(page.getByTestId("docs-filter-bar")).toBeVisible();
    await expect(page.getByTestId("task-filter-select")).toBeVisible();
    await expect(page.getByTestId("docs-tree")).toBeVisible();
  });

  test("15/17 user-management /users", async ({ page }) => {
    await page.goto("/users");
    // Todo 17：/users 重定向至 /system/users（旧书签兼容）
    await expect(page).toHaveURL(/\/system\/users/);
    await expectNavShell(page);
    await expect(page.getByTestId("user-management-root")).toBeVisible();
    await expect(page.getByTestId("user-stats")).toBeVisible();
    await expect(page.getByTestId("user-item").first()).toBeVisible();
    await expect(page.getByTestId("add-user-button")).toBeVisible();
    // ISSUE-002：编辑按钮 → 弹窗出现且预填用户名 + 角色选择
    await page.getByTestId("user-edit-button").first().click();
    await expect(page.getByTestId("edit-user-overlay")).toBeVisible();
    await expect(page.getByTestId("edit-username-input")).toHaveValue(/.+/);
    await expect(page.getByTestId("edit-user-role-select").getByRole("button").first()).toBeVisible();
    await page.getByTestId("edit-user-cancel").click();
    // OBS-007：新增用户弹窗角色选择可见
    await page.getByTestId("add-user-button").click();
    await expect(page.getByTestId("user-form-overlay")).toBeVisible();
    await expect(page.getByTestId("user-role-select").getByRole("button").first()).toBeVisible();
    await page.getByTestId("user-form-cancel").click();
  });

  test("16/17 worker-install /workers/install（独立路由 · 3 步安装向导）", async ({ page }) => {
    await page.goto("/workers/install");
    await expectNavShell(page);
    await expect(page.getByTestId("worker-install-root")).toBeVisible();
    await expect(page.getByTestId("install-wizard")).toBeVisible();
    // ① 基础配置
    await expect(page.getByTestId("install-config")).toBeVisible();
    await expect(page.getByTestId("server-url-input")).toBeVisible();
    await expect(page.getByTestId("worker-id-input")).toBeVisible();
    await expect(page.getByTestId("regenerate-worker-id-button")).toBeVisible();
    // ② 安装方式 Tab：curl 初始激活 → docker 切换后命令区联动
    await expect(page.getByTestId("install-method-tabs")).toBeVisible();
    await expect(page.getByTestId("install-method-tab").first()).toBeVisible();
    // ③ 安装命令 + 步骤
    await expect(page.getByTestId("install-command-section")).toBeVisible();
    await expect(page.getByTestId("install-command")).toContainText("curl -fsSL");
    await expect(page.getByTestId("copy-command-button")).toBeVisible();
    await expect(page.getByTestId("install-steps")).toBeVisible();
    // 底部操作
    await expect(page.getByTestId("install-footer")).toBeVisible();
    await expect(page.getByTestId("install-confirm-button")).toBeVisible();
    await expect(page.getByTestId("install-cancel-button")).toBeVisible();
    // Tab 联动：docker 分支命令更新
    await page.getByTestId("install-method-tab").filter({ hasText: /docker/ }).click();
    await expect(page.getByTestId("install-command")).toContainText("docker run");
  });

  test("17/18 worker-list /workers（列表 + 唯一安装入口）", async ({ page }) => {
    await page.goto("/workers");
    await expectNavShell(page);
    await expect(page.getByTestId("worker-list-root")).toBeVisible();
    await expect(page.getByTestId("worker-stats")).toBeVisible();
    // worker-list：w_local_1 在线（seed 后注册）
    await expect(page.getByTestId("worker-card").first()).toBeVisible();
    await expect(page.getByTestId("worker-status").first()).toBeVisible();
    // 唯一安装入口：安装 Worker 链接（跳转独立安装向导）；「新增 Worker」入口已移除
    await expect(page.getByTestId("install-worker-link")).toBeVisible();
    await expect(page.getByTestId("add-worker-button")).toHaveCount(0);
    await expect(page.getByTestId("worker-guide")).toHaveCount(0);
  });

  test("18/18 models-manage /models（模型管理：Provider 单一视图）", async ({ page }) => {
    await page.goto("/models");
    await expectNavShell(page);
    await expect(page.getByTestId("models-manage-root")).toBeVisible();
    // 单一 Provider 视图（模型目录 Tab 已移除，统一走 Provider 查看）
    await expect(page.getByTestId("providers-root")).toBeVisible();
    await expect(page.getByTestId("provider-search")).toBeVisible();
    await expect(page.getByTestId("provider-list")).toBeVisible();
    await expect(page.getByTestId("provider-item").first()).toBeVisible();
    await expect(page.getByTestId("provider-credential-status").first()).toBeVisible();
    await expect(page.getByTestId("provider-fingerprint").first()).toBeVisible();
    // 展开首个 Provider 查看下属模型
    await page.getByTestId("provider-expand-toggle").first().click();
    await expect(page.getByTestId("provider-model-item").first()).toBeVisible();
    // 同步按钮在 Provider 页头
    await expect(page.getByTestId("sync-models-button")).toBeVisible();
    // 配置弹窗：点击配置 → provider 预填 + key 输入 + worker 多选（admin 会话）
    await page.getByTestId("provider-configure-button").first().click();
    await expect(page.getByTestId("provider-config-modal")).toBeVisible();
    await expect(page.getByTestId("provider-modal-key-input")).toBeVisible();
    await expect(page.getByTestId("provider-modal-workers")).toBeVisible();
    await page.getByTestId("provider-modal-cancel").first().click();
    await expect(page.getByTestId("provider-config-modal")).toHaveCount(0);
    // 新增 Provider（admin 会话）：点击 → 弹窗含 providerID/类型/模型ID/Key/worker 字段，取消关闭
    await expect(page.getByTestId("provider-add-button")).toBeVisible();
    await page.getByTestId("provider-add-button").click();
    await expect(page.getByTestId("provider-add-modal")).toBeVisible();
    await expect(page.getByTestId("provider-add-provider-input")).toBeVisible();
    await expect(page.getByTestId("provider-add-type")).toBeVisible();
    await expect(page.getByTestId("provider-add-baseurl-input")).toBeVisible();
    await expect(page.getByTestId("provider-add-model-id-input")).toBeVisible();
    await expect(page.getByTestId("provider-add-model-name-input")).toBeVisible();
    await expect(page.getByTestId("provider-add-key-input")).toBeVisible();
    await expect(page.getByTestId("provider-add-workers")).toBeVisible();
    await page.getByTestId("provider-add-modal-cancel").first().click();
    await expect(page.getByTestId("provider-add-modal")).toHaveCount(0);
    // 编辑 Provider 配置（admin 会话）：类型/Base URL 预填 + Provider ID 只读，取消关闭
    await page.getByTestId("provider-edit-button").first().click();
    await expect(page.getByTestId("provider-edit-modal")).toBeVisible();
    await expect(page.getByTestId("provider-edit-provider")).toBeDisabled();
    await expect(page.getByTestId("provider-edit-type")).toBeVisible();
    await expect(page.getByTestId("provider-edit-baseurl-input")).toBeVisible();
    await page.getByTestId("provider-edit-modal-cancel").first().click();
    await expect(page.getByTestId("provider-edit-modal")).toHaveCount(0);
    // 模型能力配置（admin 会话）：模型行「配置」→ 能力弹窗各控件可见，取消关闭
    //（仅开+断言+取消，不点保存——保存会 PATCH 真实模型行）
    await page.getByTestId("provider-model-edit-button").first().click();
    await expect(page.getByTestId("provider-model-capabilities-modal")).toBeVisible();
    await expect(page.getByTestId("provider-model-context-input")).toBeVisible();
    await expect(page.getByTestId("provider-model-output-input")).toBeVisible();
    await expect(page.getByTestId("provider-model-reasoning-toggle")).toBeVisible();
    await expect(page.getByTestId("provider-model-options-input")).toBeVisible();
    await expect(page.getByTestId("provider-model-effort-select")).toBeVisible();
    await expect(page.getByTestId("provider-model-probe-button")).toBeVisible();
    await page.getByTestId("provider-model-capabilities-cancel").first().click();
    await expect(page.getByTestId("provider-model-capabilities-modal")).toHaveCount(0);
  });

  test("旧路由 /providers 重定向到 /models（单一入口兼容）", async ({ page }) => {
    await page.goto("/providers");
    await expect(page).toHaveURL(/\/models$/);
    await expectNavShell(page);
    await expect(page.getByTestId("models-manage-root")).toBeVisible();
  });

  test("T24 有任务主 Tab + 子页状态保留（站内进入会话页）", async ({ page }) => {
    const panel = page.getByTestId("task-panel");
    await page.goto("/teams/tm_0000000001");
    await expectNavShell(page);
    await page.getByTestId("enter-team-session").first().click();
    await expect(page).toHaveURL(/\/session/);
    // 有任务：默认落任务 Tab（T17：不点任务按钮，直接断言任务选中态 + 任务子页可见 + 团队子页隐藏）
    await expect(panel.getByTestId("main-tab-task")).toBeVisible();
    await expect(panel.getByTestId("main-tab-task")).toHaveAttribute("data-active", "true");
    await expect(panel.getByTestId("main-tab-team")).toHaveAttribute("data-active", "false");
    await expect(page.getByTestId("task-subtab-scroll")).toBeVisible();
    await expect(page.getByTestId("team-subtab-scroll")).toHaveCount(0);
    // 手动切到团队 → 不被抢回任务
    await panel.getByTestId("main-tab-team").click();
    await expect(page.getByTestId("team-subtab-scroll")).toBeVisible();
    await expect(page.getByTestId("task-subtab-scroll")).toHaveCount(0);
    await panel.getByRole("button", { name: "任务", exact: true }).click();
    await expect(page.getByTestId("task-subtab-scroll")).toBeVisible();
    // 子页状态保留：切到计划 → 切团队 → 切回任务后仍在计划
    await panel.getByRole("button", { name: "计划" }).click();
    await expect(page.getByTestId("plan-status-block")).toBeVisible();
    await panel.getByRole("button", { name: "团队", exact: true }).click();
    await expect(page.getByTestId("team-subtab-scroll")).toBeVisible();
    await panel.getByRole("button", { name: "任务", exact: true }).click();
    await expect(page.getByTestId("plan-status-block")).toBeVisible();
    await expect(page.getByTestId("team-subtab-scroll")).toHaveCount(0);
  });

  test("T24 状态卡三层 + 队列空态（团队当前任务）", async ({ page, request }) => {
    await page.route("**/api/v1/teams/tm_0000000001", async (r) => {
      const res = await r.fetch();
      const json = await res.json();
      json.queue = [];
      await r.fulfill({ response: res, json });
    });
    await page.goto("/teams/tm_0000000001/session");
    await expectNavShell(page);
    const scroll = page.getByTestId("task-subtab-scroll");
    await page.getByTestId("task-panel").getByRole("button", { name: "任务", exact: true }).click();
    await expect(scroll).toBeVisible();
    const login = await request.post("/api/v1/auth/login", {
      data: { username: "seed-admin", password: "Admin@123456" },
    });
    const { accessToken } = await login.json();
    // 面板展示的是团队「当前任务」（队首随业务推进变化）→ 从团队接口取，不写死任务 id，
    // 否则任务一被验收/推进，断言就会打在一个已不是队首的任务上而失败。
    const teamRes = await request.get("/api/v1/teams/tm_0000000001", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const teamJson = await teamRes.json();
    const currentTaskId = (teamJson?.currentTaskId ?? "") as string;
    expect(currentTaskId).toBeTruthy();
    const taskRes = await request.get(`/api/v1/tasks/${currentTaskId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const taskJson = await taskRes.json();
    const taskTitle = ((taskJson.task ?? taskJson).title ?? "") as string;
    expect(taskTitle).toBeTruthy();
    const card = scroll.locator(":scope > div > div").first();
    // ① 标题独占行
    await expect(card.getByText(taskTitle).first()).toBeVisible();
    // ② 状态徽/编辑行
    await expect(card.getByRole("button", { name: "编辑" })).toBeVisible();
    // ③ 主操作等宽并排一行（row 布局回归守卫：pending_review → accept + reject 必须同排等宽）
    const actionsRow = card.getByTestId("task-status-actions-row");
    if ((await actionsRow.count()) > 0) {
      const btns = actionsRow.locator("button");
      await expect(btns).toHaveCount(2);
      const b0 = await btns.nth(0).boundingBox();
      const b1 = await btns.nth(1).boundingBox();
      expect(b0 && b1).toBeTruthy();
      expect(Math.abs(b0!.y - b1!.y)).toBeLessThan(2);
      expect(Math.abs(b0!.width - b1!.width)).toBeLessThan(2);
      expect(b0!.width).toBeGreaterThan(0);
    } else {
      // 单操作状态（start/resume/archive）：无并排容器，按钮整行即可
      await expect(
        card.locator(
          '[data-testid="task-accept"], [data-testid="task-reject"], [data-testid="start-task-button"], [data-testid="task-submit-review"], [data-testid="task-archive"], [data-testid="task-block"], [data-testid="task-resume"], [data-testid="enqueue-task-button"]',
        ).first(),
      ).toBeVisible();
    }
    // 状态卡内不含队列摘要行文案（队列卡是兄弟节点）
    await expect(card.getByText("暂无排队任务")).toHaveCount(0);
    await expect(card.getByText("当前执行中（队首）")).toHaveCount(0);
    // 队列卡兄弟节点存在；种子团队队列为空 → queue-empty 可见
    await expect(page.getByTestId("team-queue-card")).toBeVisible();
    await expect(page.getByTestId("queue-empty")).toBeVisible();
    await expect(page.getByTestId("queue-empty")).toContainText("暂无排队任务");
  });

  test("T24 触发子页可达（空触发器）", async ({ page }) => {
    await page.route("**/api/v1/triggers*", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 100 }),
      }),
    );
    const panel = page.getByTestId("task-panel");
    await page.goto("/teams/tm_0000000001/session");
    await panel.getByRole("button", { name: "任务", exact: true }).click();
    await expect(page.getByTestId("task-subtab-scroll")).toBeVisible();
    await panel.getByTestId("task-subtab-triggers").click();
    await expect(page.getByTestId("trigger-empty")).toBeVisible();
    await expect(page.getByTestId("trigger-empty")).toContainText("暂无触发器");
  });

  test("T24 触发行对齐原型：人话时间 + 精简元信息（系统行不可取消）", async ({
    page,
  }) => {
    const now = new Date();
    const due = new Date(now);
    due.setHours(0, 1, 0, 0);
    if (due.getTime() >= now.getTime()) due.setDate(due.getDate() - 1);
    const dueDayLabel = due.toDateString() === now.toDateString() ? "今天" : "昨天";
    const dueIso = due.toISOString();
    await page.route("**/api/v1/triggers*", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: "tmr_p1",
              kind: "receipt_nudge",
              status: "pending",
              dueAt: dueIso,
              nextFireAt: null,
              scopeType: "team",
              scopeId: "tm_0000000001",
              ownerInstanceId: "tmm_0000000002",
              fireCount: 0,
              skipReason: null,
              lastError: null,
              attempts: 0,
              createdAt: dueIso,
              source: "system",
              display: {
                description: "完工回执（第 4 次派发）",
                scopeLabel: "vteam开发团队",
                scopeTeam: "vteam开发团队",
                ownerLabel: "项目经理-1",
                taskLabel: "e2e-BoardDrawer",
              },
            },
          ],
          total: 1,
          page: 1,
          pageSize: 100,
        }),
      }),
    );
    const panel = page.getByTestId("task-panel");
    await page.goto("/teams/tm_0000000001/session");
    await panel.getByRole("button", { name: "任务", exact: true }).click();
    await panel.getByTestId("task-subtab-triggers").click();
    const row = page.getByTestId("trigger-row").first();
    await expect(row).toBeVisible();
    await expect(row.getByTestId("trigger-title")).toContainText("完工回执");
    await expect(row).toContainText("待触发");
    // 时间：nextFireAt 为 null 且 dueAt 已过 → 「应于 今天/昨天 HH:mm」（不再是被误读的绝对时间戳）
    await expect(row.getByTestId("trigger-time")).toContainText(`应于 ${dueDayLabel} 00:01`);
    await expect(row).toContainText("系统");
    // 精简：原型次行只留「来源 · 时间」，不再有 触发N次/类型/范围/归属/任务
    await expect(row).not.toContainText("类型");
    await expect(row).not.toContainText("归属");
    await expect(row).not.toContainText("任务");
    // 系统来源触发器只读（不因"对齐原型"而给出取消按钮）
    await expect(row.getByTestId("trigger-cancel")).toHaveCount(0);
    // 点击行 → 详情弹窗（行内精简掉的元信息收进弹窗）
    await row.click();
    const detail = page.getByTestId("trigger-detail-modal");
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId("trigger-detail-status")).toHaveText("待触发");
    await expect(detail.getByTestId("trigger-detail-body")).toContainText("催办");
    await expect(detail.getByTestId("trigger-detail-body")).toContainText("系统");
    await expect(detail.getByTestId("trigger-detail-body")).toContainText("vteam开发团队");
    await expect(detail.getByTestId("trigger-detail-body")).toContainText("项目经理-1");
    await expect(detail.getByTestId("trigger-detail-body")).toContainText("0 次");
    await expect(detail.getByTestId("trigger-detail-body")).toContainText("tmr_p1");
    // 系统来源：详情里同样无取消入口（与行内一致）
    await expect(detail.getByTestId("trigger-detail-cancel")).toHaveCount(0);
    await detail.getByTestId("trigger-detail-close").click();
    await expect(detail).toHaveCount(0);
  });

  test("T24 计划区两类来源 + 执行步骤行 + 文档弹窗渲染 Markdown（全 mock）", async ({ page }) => {
    const now = new Date().toISOString();
    await page.route("**/api/v1/tasks/*/plan-docs", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          files: [
            {
              name: "e2e-plan-a.md",
              updatedAt: now,
              content: "# e2e plan\n\n- 项一\n- 项二\n\n| A | B |\n| - | - |\n| 1 | 2 |\n",
              truncated: false,
            },
          ],
          workerId: "w1",
          directory: "/tmp",
          degraded: false,
        }),
      }),
    );
    await page.route("**/api/v1/tasks/*/artifacts*", (r) => {
      const url = r.request().url();
      const items = url.includes("category")
        ? [{ id: "a_plan_1", title: "e2e计划产出", type: "text", currentVersion: 3, acceptedFlag: false, updatedAt: now }]
        : [];
      return r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 50 }),
      });
    });
    await page.route("**/api/v1/artifacts/*/versions/*", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ contentRef: "# artifact md\n\n- ax\n" }),
      }),
    );
    await page.route("**/api/v1/tasks/*/plan-steps", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          steps: [
            { content: "e2e步骤一", status: "in_progress" },
            { content: "e2e步骤二", status: "pending" },
          ],
          workerId: "w1",
          degraded: false,
        }),
      }),
    );
    const panel = page.getByTestId("task-panel");
    await page.goto("/teams/tm_0000000001/session");
    await panel.getByRole("button", { name: "任务", exact: true }).click();
    await expect(page.getByTestId("task-subtab-scroll")).toBeVisible();
    await panel.getByRole("button", { name: "计划" }).click();
    await expect(page.getByTestId("plan-status-block")).toBeVisible();
    // 本地文件来源行 + 来源徽标
    await expect(page.getByTestId("plan-doc-row-e2e-plan-a.md")).toBeVisible();
    await expect(page.getByTestId("plan-doc-row-e2e-plan-a.md")).toContainText("本地文件");
    // 计划类产出物来源行 + 来源徽标（含版本）
    await expect(page.getByTestId("plan-artifact-row-a_plan_1")).toBeVisible();
    await expect(page.getByTestId("plan-artifact-row-a_plan_1")).toContainText("产出物 · v3");
    // 执行步骤行两态
    await expect(page.locator('[data-testid="plan-step-in_progress"]')).toContainText("e2e步骤一");
    await expect(page.locator('[data-testid="plan-step-pending"]')).toContainText("e2e步骤二");
    // 点击计划文档 → 弹窗弹出，正文按 Markdown 渲染（标题/列表/表格 成元素，而非原样 # 文本）
    await page.getByTestId("plan-doc-row-e2e-plan-a.md").click();
    const modal = page.getByTestId("plan-doc-modal");
    await expect(modal).toBeVisible();
    await expect(modal.locator("h1")).toHaveText("e2e plan");
    await expect(modal.locator("li")).toHaveCount(2);
    await expect(modal.locator("table")).toBeVisible();
    await expect(modal.getByTestId("plan-doc-modal-markdown")).not.toContainText("# e2e plan");
    await expect(modal.getByTestId("plan-doc-modal-markdown")).not.toContainText("| A | B |");
    await modal.getByTestId("plan-doc-modal-close").click();
    await expect(modal).toHaveCount(0);
    // 点击「产出物 · vN」行 → 内联弹窗预览（不再跳文档站）；text 产出物按 Markdown 渲染
    await page.getByTestId("plan-artifact-row-a_plan_1").click();
    const artModal = page.getByTestId("artifact-doc-modal");
    await expect(artModal).toBeVisible();
    await expect(artModal).toContainText("e2e计划产出");
    await expect(artModal.getByTestId("artifact-doc-modal-version")).toHaveText("v3");
    await expect(artModal.locator("h1")).toHaveText("artifact md");
    expect(new URL(page.url()).pathname).toBe("/teams/tm_0000000001/session");
    await artModal.getByTestId("artifact-doc-modal-close").click();
    await expect(artModal).toHaveCount(0);
  });

  test("T24 错误态分支（plan-docs-error + artifacts-error）", async ({ page }) => {
    await page.route("**/api/v1/tasks/*/plan-docs", (r) =>
      r.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ code: "INTERNAL", message: "e2e计划文档失败" }),
      }),
    );
    await page.route("**/api/v1/tasks/*/artifacts*", (r) =>
      r.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ code: "INTERNAL", message: "e2e产出物失败" }),
      }),
    );
    const panel = page.getByTestId("task-panel");
    await page.goto("/teams/tm_0000000001/session");
    await panel.getByRole("button", { name: "任务", exact: true }).click();
    await expect(page.getByTestId("task-subtab-scroll")).toBeVisible();
    await panel.getByRole("button", { name: "计划" }).click();
    await expect(page.getByTestId("plan-docs-error")).toBeVisible({ timeout: 20000 });
    await panel.getByRole("button", { name: "产出" }).click();
    await expect(page.getByTestId("artifacts-error")).toBeVisible({ timeout: 20000 });
  });

  test("T24 产出物列表不截断（mock 7 条全渲染）", async ({ page }) => {
    const now = new Date().toISOString();
    const seven = Array.from({ length: 7 }, (_, i) => ({
      id: `a_out_${i + 1}`,
      title: `e2e-out-${i + 1}`,
      type: "text",
      currentVersion: 1,
      acceptedFlag: false,
      updatedAt: now,
    }));
    await page.route("**/api/v1/tasks/*/artifacts*", (r) => {
      const url = r.request().url();
      const items = url.includes("category") ? [] : seven;
      return r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 50 }),
      });
    });
    const panel = page.getByTestId("task-panel");
    const scroll = page.getByTestId("task-subtab-scroll");
    await page.goto("/teams/tm_0000000001/session");
    await panel.getByRole("button", { name: "任务", exact: true }).click();
    await expect(scroll).toBeVisible();
    await panel.getByRole("button", { name: "产出" }).click();
    for (let i = 1; i <= 7; i++) {
      await expect(scroll.getByText(`e2e-out-${i}`, { exact: true })).toBeVisible();
    }
    await expect(scroll.getByText("7 个")).toBeVisible();
  });

  test("/system 落地页重定向到第一个子导航（不再空转占位页）", async ({ page }) => {
    await page.goto("/system");
    // 落地页服务端 redirect 到 SYSTEM_NAV_ITEMS 第一项（触发器）
    await expect(page).toHaveURL(/\/system\/triggers$/);
    await expectNavShell(page);
    await expect(page.getByTestId("system-sidebar")).toBeVisible();
    // 子页真实渲染（非占位"即将上线"）
    await expect(page.getByTestId("triggers-list")).toBeVisible();
    // 侧栏激活项与落点一致，面包屑同步
    await expect(page.getByTestId("system-sidebar-item").first()).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("system-breadcrumb-current")).toHaveText("触发器");
  });
});
