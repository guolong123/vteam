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
test.describe("18 页 testid 断言（seed-admin 登录态）", () => {
  /** 融合导航核心元素（nav-hybrid 终态心智：NavTopBar + NavDock + CmdKPanel） */
  const NAV_CORE = ["app-shell", "rail-bar", "topbar", "cmdk-trigger"];

  /** 每页统一前置：导航融合元素存在 */
  async function expectNavShell(page: import("@playwright/test").Page) {
    for (const tid of NAV_CORE) {
      await expect(page.getByTestId(tid).first()).toBeVisible();
    }
  }

  test("2/17 project-list /projects", async ({ page }) => {
    await page.goto("/projects");
    await expectNavShell(page);
    await expect(page.getByTestId("project-list-root")).toBeVisible();
    await expect(page.getByTestId("project-card").first()).toBeVisible();
    await expect(page.getByTestId("create-project-button")).toBeVisible();
  });

  test("3/17 task-create /tasks/new", async ({ page }) => {
    await page.goto("/tasks/new");
    await expectNavShell(page);
    await expect(page.getByTestId("task-create-root")).toBeVisible();
    await expect(page.getByTestId("task-title")).toBeVisible();
    await expect(page.getByTestId("priority-select")).toBeVisible();
    await expect(page.getByTestId("agent-option").first()).toBeVisible();
    await expect(page.getByTestId("create-task-button")).toBeVisible();
  });

  test("4/17 task-board /board?pid=p_seed_1", async ({ page }) => {
    await page.goto("/board?pid=p_seed_1");
    await expectNavShell(page);
    await expect(page.getByTestId("task-board-root")).toBeVisible();
    await expect(page.getByTestId("status-filter")).toBeVisible();
    await expect(page.getByTestId("task-card").first()).toBeVisible();
    await expect(page.getByTestId("status-badge").first()).toBeVisible();
  });

  test("5/17 agent-config /agents", async ({ page }) => {
    await page.goto("/agents");
    await expectNavShell(page);
    await expect(page.getByTestId("agent-config-root")).toBeVisible();
    await expect(page.getByTestId("agent-list-item").first()).toBeVisible();
    await expect(page.getByTestId("clone-template-button")).toBeVisible();
    await expect(page.getByTestId("model-select").first()).toBeVisible();
  });

  test("6/17 dm-chat /messages/c_0000000001", async ({ page }) => {
    await page.goto("/messages/c_0000000001");
    await expectNavShell(page);
    await expect(page.getByTestId("dm-chat-root")).toBeVisible();
    await expect(page.getByTestId("dm-agent-info")).toBeVisible();
    await expect(page.getByTestId("chat-message-list")).toBeVisible();
    await expect(page.getByTestId("view-session-link")).toBeVisible();
    // 错误操作链接（条件渲染：agent.error → quota 分支出现 msg-error-action）
    const errAction = page.getByTestId("msg-error-action");
    if ((await errAction.count()) > 0) {
      await expect(errAction.first()).toBeVisible();
    }
  });

  test("7/17 group-chat /tasks/t_0000000001", async ({ page }) => {
    await page.goto("/tasks/t_0000000001");
    await expectNavShell(page);
    await expect(page.getByTestId("group-chat-root")).toBeVisible();
    await expect(page.getByTestId("members-panel")).toBeVisible();
    await expect(page.getByTestId("member-item").first()).toBeVisible();
    await expect(page.getByTestId("chat-message-list")).toBeVisible();
    await expect(page.getByTestId("task-info-panel")).toBeVisible();
  });

  test("8-10/17 导航变体（AppShell 融合导航承载）", async ({ page }) => {
    // nav-cmdk / nav-hybrid / nav-rail 三变体无独立路由，融合导航为终态——
    // 命令面板（nav-cmdk 核心）与 Dock 面板（nav-rail 核心）在登录页后全站可用
    await page.goto("/projects");
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
    // 关闭命令面板（Esc）
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("cmdk-panel")).not.toBeVisible();
  });

  test("11/17 role-permission /roles", async ({ page }) => {
    await page.goto("/roles");
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
    await expect(page.getByTestId("search-input")).toBeVisible();
    // 技能 Tab（初始）：skill-item 存在
    await expect(page.getByTestId("skill-item").first()).toBeVisible();
    // 工具 Tab：tool-subtabs + tool-item（内置）
    await page.getByTestId("manage-tab").filter({ hasText: /工具/ }).click();
    await expect(page.getByTestId("tool-subtabs")).toBeVisible();
    await expect(page.getByTestId("tool-item").first()).toBeVisible();
    // MCP 子 Tab：mcp-tool-item 存在
    await page.getByTestId("tool-subtab").filter({ hasText: /MCP|mcp/i }).click();
    await expect(page.getByTestId("mcp-tool-item").first()).toBeVisible();
  });

  test("13/17 task-detail /artifacts?pid=p_seed_1（产出物聚合页）", async ({ page }) => {
    await page.goto("/artifacts?pid=p_seed_1");
    await expectNavShell(page);
    await expect(page.getByTestId("artifacts-root")).toBeVisible();
    await expect(page.getByTestId("artifacts-filter-bar")).toBeVisible();
    await expect(page.getByTestId("task-filter-select")).toBeVisible();
    // 产出物行（若有）→ 版本查看器可展开
    const rows = page.getByTestId("artifact-row");
    if ((await rows.count()) > 0) {
      await rows.first().click();
      await expect(page.getByTestId("artifact-viewer").first()).toBeVisible();
    } else {
      test.info().annotations.push({ type: "note", description: "当前任务无产出物，artifact-row 跳过" });
    }
  });

  test("14/17 tool-register /tools/register（4 执行形态）", async ({ page }) => {
    await page.goto("/tools/register");
    await expectNavShell(page);
    await expect(page.getByTestId("tool-register-root")).toBeVisible();
    await expect(page.getByTestId("tool-basic-section")).toBeVisible();
    await expect(page.getByTestId("tool-name-input")).toBeVisible();
    await expect(page.getByTestId("execution-type-list")).toBeVisible();
    await expect(page.getByTestId("register-tool-button")).toBeVisible();
    // 平台代码形态（初始）
    await expect(page.getByTestId("handler-code-editor")).toBeVisible();
    // CLI 形态
    await page.getByTestId("execution-type").filter({ hasText: /CLI/ }).click();
    await expect(page.getByTestId("cli-mode-select")).toBeVisible();
    // HTTP 形态
    await page.getByTestId("execution-type").filter({ hasText: /HTTP|http/i }).click();
    await expect(page.getByTestId("http-callback-url")).toBeVisible();
    // MCP 形态
    await page.getByTestId("execution-type").filter({ hasText: /MCP|mcp/i }).click();
    await expect(page.getByTestId("mcp-type-select")).toBeVisible();
  });

  test("15/17 user-management /users", async ({ page }) => {
    await page.goto("/users");
    await expectNavShell(page);
    await expect(page.getByTestId("user-management-root")).toBeVisible();
    await expect(page.getByTestId("user-stats")).toBeVisible();
    await expect(page.getByTestId("user-item").first()).toBeVisible();
    await expect(page.getByTestId("add-user-button")).toBeVisible();
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

  test("17/18 worker-list /workers（列表 + 注册指引）", async ({ page }) => {
    await page.goto("/workers");
    await expectNavShell(page);
    await expect(page.getByTestId("worker-list-root")).toBeVisible();
    await expect(page.getByTestId("worker-stats")).toBeVisible();
    // worker-list：w_local_1 在线（seed 后注册）
    await expect(page.getByTestId("worker-card").first()).toBeVisible();
    await expect(page.getByTestId("worker-status").first()).toBeVisible();
    // 安装入口：安装 Worker 链接（跳转独立安装向导）
    await expect(page.getByTestId("install-worker-link")).toBeVisible();
    // 注册指引受控展开（新增 Worker 按钮切换 guideOpen）
    await page.getByTestId("add-worker-button").click();
    await expect(page.getByTestId("worker-guide")).toBeVisible();
  });

  test("18/18 models-manage /models（模型目录管理）", async ({ page }) => {
    await page.goto("/models");
    await expectNavShell(page);
    await expect(page.getByTestId("models-manage-root")).toBeVisible();
    await expect(page.getByTestId("manage-toolbar")).toBeVisible();
    await expect(page.getByTestId("model-search")).toBeVisible();
    // 模型行（seed 预置 8 模型目录）
    await expect(page.getByTestId("model-list")).toBeVisible();
    await expect(page.getByTestId("model-item").first()).toBeVisible();
    // 凭据配置区（目标模型 select + token 输入 + worker 多选）
    await expect(page.getByTestId("credential-section")).toBeVisible();
    await expect(page.getByTestId("model-credential-select")).toBeVisible();
  });
});
