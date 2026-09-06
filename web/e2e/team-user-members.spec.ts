import { test, expect } from "@playwright/test";

/**
 * team-user-members 团队用户成员管理（Todo 6）
 * =============================================
 * - 新建临时团队 → 按用户 ID 添加用户成员 → 断言行出现 → 移除 → 断言消失 → 清理团队
 * - 失败行内展示，不跳转
 * - 登录态：storageState（auth.setup.ts 真实表单登录 seed-admin）
 */
test.describe("team-user-members 团队用户成员管理", () => {
  test("team-user-members 添加/移除往返", async ({ page, request }) => {
    const login = await request.post("/api/v1/auth/login", {
      data: { username: "seed-admin", password: "Admin@123456" },
    });
    expect(login.ok()).toBeTruthy();
    const { accessToken } = await login.json();
    const headers = { Authorization: `Bearer ${accessToken}` };

    // 被添加用户：seed-member（经 /users?search 解析出 userId；该接口挂 AdminGuard，seed-admin 可调）
    const found = await request.get("/api/v1/users?search=seed-member&pageSize=5", { headers });
    expect(found.ok()).toBeTruthy();
    const users = ((await found.json()) as { items: { id: string; username: string }[] }).items ?? [];
    const target = users.find((u) => u.username === "seed-member") ?? users[0];
    expect(target?.id).toBeTruthy();
    const targetUserId = target.id as string;

    // 新建临时团队（创建者即 owner；成员至少 1 个 Agent 实例以满足建团队约束）
    let agentId = "a_product";
    const seed = await request.get("/api/v1/teams/tm_0000000001", { headers });
    if (seed.ok()) {
      const members = (((await seed.json()) as { members: { agentId: string }[] }).members ?? []);
      if (members[0]?.agentId) agentId = members[0].agentId;
    }
    const created = await request.post("/api/v1/teams", {
      headers,
      data: { name: `e2e-UserMembers-${Date.now()}`, members: [{ agentId }] },
    });
    expect(created.ok()).toBeTruthy();
    const teamId = ((await created.json()) as { id: string }).id;
    expect(teamId).toBeTruthy();

    try {
      await page.goto(`/teams/${teamId}`);
      await expect(page.getByTestId("team-detail-root")).toBeVisible();
      await expect(page.getByTestId("user-members-section")).toBeVisible();
      // 创建者即 owner 已在列表（后端建团队即写 owner 行），故初始非空
      await expect(page.getByTestId("user-members-empty")).toHaveCount(0);
      const ownerRow = page.getByTestId("user-member-row").filter({ hasText: "u_seed_admin" });
      await expect(ownerRow).toBeVisible();
      await expect(ownerRow.getByTestId("user-member-role")).toContainText("owner");
      // Agent 成员区不受影响
      await expect(page.getByTestId("member-row").first()).toBeVisible();

      // 添加用户成员
      await page.getByTestId("user-member-userid-input").fill(targetUserId);
      await page.getByTestId("user-member-add-confirm").click();
      const row = page.getByTestId("user-member-row").filter({ hasText: targetUserId });
      await expect(row).toBeVisible();
      await expect(row.getByTestId("user-member-role")).toContainText("member");
      await expect(page.getByTestId("user-member-error")).toHaveCount(0);
      expect(page.url()).toContain(`/teams/${teamId}`);

      // 重复添加 → 行内错误，不跳转
      await page.getByTestId("user-member-userid-input").fill(targetUserId);
      await page.getByTestId("user-member-add-confirm").click();
      await expect(page.getByTestId("user-member-error")).toBeVisible();
      expect(page.url()).toContain(`/teams/${teamId}`);

      // 移除用户成员（owner 创建者行保留，故列表非空）
      await row.getByTestId("user-member-remove").click();
      await expect(page.getByTestId("user-member-row").filter({ hasText: targetUserId })).toHaveCount(0);
      await expect(page.getByTestId("user-members-empty")).toHaveCount(0);
      await expect(ownerRow).toBeVisible();
      expect(page.url()).toContain(`/teams/${teamId}`);
    } finally {
      await request.delete(`/api/v1/teams/${teamId}`, { headers });
    }
  });
});
