import { test, expect, type APIRequestContext } from "@playwright/test";
import crypto from "node:crypto";
import path from "node:path";

/**
 * 外部渠道用户管理 E2E（契约 §3.4）
 * =============================================
 * 覆盖完整链路：入站消息自动沉淀外部用户 → /chat 左侧「外部用户」Tab → 点击用户
 * → 中间只读消息回看 → 右侧资料维护（姓名/岗位/公司/联系方式）保存并回显。
 *
 * 造数方式：**纯 API，不直连数据库**（与契约 §4 Lead 验收要求一致）：
 * 1. seed-admin 登录取 token；
 * 2. 建临时团队（复用 seed 团队的成员）；
 * 3. 建 generic_webhook 消息渠道（fieldMappings 把 sender.name 映射为外部用户名），
 *    绑定到临时团队；
 * 4. 用 HMAC 签名的入站报文 POST /message-channels/:id/inbound 发两条消息
 *    → 服务端自动创建 external_users + external_user_id 关联。
 *
 * 断言的选择器全部来自契约 3.4 的固定 testid，便于实现与测试互不漂移。
 * 运行：cd web && npx playwright test --project=external-users
 */

const WEBHOOK_SECRET = "e2e-external-webhook-secret";
/** 每次运行唯一的外部展示名：避免历史运行的同名目录行合并（无 userid 时按 name 去重）。 */
const STAMP = Date.now();
const EXTERNAL_DISPLAY_NAME = `企微用户-E2E-${STAMP}`;
const PROFILE = {
  name: `宋工-${STAMP}`,
  position: "运维工程师",
  company: "某某科技",
  contact: "song@example.com",
};

let TEAM_ID = "";
let CHANNEL_ID = "";
let EXTERNAL_USER_ID = "";

async function seedAdminHeaders(
  request: APIRequestContext,
): Promise<{ Authorization: string }> {
  const login = await request.post("/api/v1/auth/login", {
    data: { username: "seed-admin", password: "Admin@123456" },
  });
  expect(login.ok()).toBeTruthy();
  const { accessToken } = (await login.json()) as { accessToken: string };
  return { Authorization: `Bearer ${accessToken}` };
}

/** 建临时团队 + webhook 渠道 + 两条外部用户入站消息。 */
async function createFixture(request: APIRequestContext): Promise<void> {
  const headers = await seedAdminHeaders(request);

  // 1) seed 团队取成员（agentId/roleId），用于建临时团队。
  const teamsResponse = await request.get(
    "/api/v1/teams?page=1&pageSize=100",
    { headers },
  );
  expect(teamsResponse.ok()).toBeTruthy();
  const teams = (await teamsResponse.json()) as {
    items?: Array<{ id: string; name: string; members?: Array<{ agentId: string; roleId?: string }> }>;
  };
  const seedTeam = teams.items?.find((team) => team.name === "vteam开发团队");
  expect(seedTeam, "seed 团队 vteam开发团队 不存在，先跑 server seed").toBeTruthy();

  const teamResponse = await request.post("/api/v1/teams", {
    headers,
    data: {
      name: `e2e-外部用户-${STAMP}`,
      members: (seedTeam?.members ?? []).map((member) => ({
        agentId: member.agentId,
        roleId: member.roleId,
      })),
    },
  });
  expect(teamResponse.status()).toBe(201);
  const team = (await teamResponse.json()) as { id?: string };
  expect(team.id).toBeTruthy();
  TEAM_ID = team.id ?? "";

  // 2) generic_webhook 渠道：sender.name → 外部用户展示名。
  const channelResponse = await request.post("/api/v1/message-channels", {
    headers,
    data: {
      name: `e2e-external-webhook-${STAMP}`,
      type: "generic_webhook",
      config: {
        fieldMappings: {
          _default: { content: "{{text}}", user: "{{sender.name}}" },
        },
      },
      secrets: { secret: WEBHOOK_SECRET },
    },
  });
  expect(channelResponse.status()).toBe(201);
  const channel = (await channelResponse.json()) as { id?: string };
  expect(channel.id).toBeTruthy();
  CHANNEL_ID = channel.id ?? "";

  const bindResponse = await request.post(
    `/api/v1/teams/${TEAM_ID}/message-channels`,
    { headers, data: { messageChannelIds: [CHANNEL_ID] } },
  );
  expect(bindResponse.ok()).toBeTruthy();

  // 3) 两条入站消息（HMAC 签名，raw body 必须与签名串一致）。
  const texts = [
    "通过接口创建的告警默认是开启的，怎么改成禁用呢？",
    "另外看板上的筛选条件能否记住上一次选择？",
  ];
  for (const [index, text] of texts.entries()) {
    const rawBody = JSON.stringify({
      text,
      sender: { id: `e2e-ext-${STAMP}`, name: EXTERNAL_DISPLAY_NAME },
    });
    const signature = `sha256=${crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex")}`;
    const inbound = await request.post(
      `/api/v1/message-channels/${CHANNEL_ID}/inbound`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-vteam-signature": signature,
          "x-vteam-event-id": `e2e-ext-${STAMP}-${index}`,
        },
        data: rawBody,
      },
    );
    expect(
      inbound.ok(),
      `inbound 失败：${inbound.status()} ${await inbound.text()}`,
    ).toBeTruthy();
  }

  // 4) 解析出外部用户 id，供断言与 API 校验使用。
  const listResponse = await request.get(
    `/api/v1/external-users?keyword=${encodeURIComponent(EXTERNAL_DISPLAY_NAME)}`,
    { headers },
  );
  expect(listResponse.ok()).toBeTruthy();
  const list = (await listResponse.json()) as {
    items?: Array<{ id: string; name: string; messageCount: number }>;
  };
  const externalUser = list.items?.find((item) =>
    (item.name ?? "").includes(EXTERNAL_DISPLAY_NAME),
  );
  expect(externalUser, "入站消息未沉淀出外部用户目录行").toBeTruthy();
  EXTERNAL_USER_ID = externalUser?.id ?? "";
  expect(externalUser?.messageCount).toBeGreaterThanOrEqual(2);
}

async function deleteFixture(request: APIRequestContext): Promise<void> {
  const headers = await seedAdminHeaders(request);
  if (CHANNEL_ID) {
    await request.delete(`/api/v1/message-channels/${CHANNEL_ID}`, { headers });
  }
  if (TEAM_ID) {
    await request.delete(`/api/v1/teams/${TEAM_ID}`, { headers });
  }
}

test.describe("外部渠道用户管理（/chat 外部用户 Tab）", () => {
  test.beforeAll(async ({ request }) => {
    await createFixture(request);
  });
  test.afterAll(async ({ request }) => {
    await deleteFixture(request);
  });

  test("外部用户 Tab 展示入站消息沉淀出的目录用户", async ({ page }) => {
    await page.goto("/chat");

    // 既有三 Tab 仍在（回归），第 4 个 Tab 存在且带计数。
    await expect(page.getByTestId("conversation-filter-all")).toBeVisible();
    await expect(page.getByTestId("conversation-filter-group")).toBeVisible();
    await expect(page.getByTestId("conversation-filter-dm")).toBeVisible();
    const externalTab = page.getByTestId("conversation-filter-external");
    await expect(externalTab).toBeVisible();
    await expect(externalTab).toContainText("外部用户");

    await externalTab.click();
    await expect(page.getByTestId("external-user-list")).toBeVisible();
    const row = page
      .getByTestId("external-user-item")
      .filter({ hasText: EXTERNAL_DISPLAY_NAME });
    await expect(row).toBeVisible();
    // 行内回落展示名（未维护资料时）；公司·岗位只在右侧表单维护后才展示。
    await expect(row).toContainText(EXTERNAL_DISPLAY_NAME);
  });

  test("点击外部用户：中间只读展示其消息，右侧维护资料并持久化", async ({
    page,
    request,
  }) => {
    await page.goto("/chat");
    await page.getByTestId("conversation-filter-external").click();
    await page
      .getByTestId("external-user-item")
      .filter({ hasText: EXTERNAL_DISPLAY_NAME })
      .click();

    // URL 可刷新/分享：?c=external:<id>（encodeURIComponent 后冒号为 %3A）。
    await expect(page).toHaveURL(
      new RegExp(`external(?:%3A|:)${EXTERNAL_USER_ID}`),
    );

    // 中间：仅该用户发出的消息，按时间正序；只读（无输入框）。
    const conversation = page.getByTestId("external-user-conversation");
    await expect(conversation).toBeVisible();
    await expect(conversation).toContainText(EXTERNAL_DISPLAY_NAME);
    const messages = page.getByTestId("external-user-message");
    await expect(messages).toHaveCount(2);
    await expect(messages.first()).toContainText("告警默认是开启");
    await expect(messages.last()).toContainText("筛选条件能否记住");
    await expect(page.getByTestId("external-user-readonly-hint")).toBeVisible();
    await expect(page.getByTestId("chat-input")).toHaveCount(0);
    await page.screenshot({
      path: path.join(process.cwd(), "..", "e2e-evidence", "external-users-conversation.png"),
      fullPage: true,
    });

    // 右侧：维护姓名/岗位/公司/联系方式 → 保存成功。
    const panel = page.getByTestId("external-user-profile-panel");
    await expect(panel).toBeVisible();
    await panel.getByTestId("external-user-name").fill(PROFILE.name);
    await panel.getByTestId("external-user-position").fill(PROFILE.position);
    await panel.getByTestId("external-user-company").fill(PROFILE.company);
    await panel.getByTestId("external-user-contact").fill(PROFILE.contact);
    await panel.getByTestId("external-user-save").click();
    await expect(page.getByTestId("external-user-saved")).toBeVisible();

    // 保存后立即回显：消息区头部与左侧列表都切到新姓名。
    await expect(conversation).toContainText(PROFILE.name);
    await expect(
      page.getByTestId("external-user-item").filter({ hasText: PROFILE.name }),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(process.cwd(), "..", "e2e-evidence", "external-users-profile-saved.png"),
      fullPage: true,
    });

    // 刷新后仍在（持久化到 DB，不是前端内存态）。
    await page.reload();
    await expect(page.getByTestId("external-user-conversation")).toContainText(
      PROFILE.name,
    );
    await expect(page.getByTestId("external-user-name")).toHaveValue(PROFILE.name);
    await expect(page.getByTestId("external-user-position")).toHaveValue(
      PROFILE.position,
    );
    await expect(page.getByTestId("external-user-company")).toHaveValue(
      PROFILE.company,
    );
    await expect(page.getByTestId("external-user-contact")).toHaveValue(
      PROFILE.contact,
    );

    // 服务端真值校验（API 与 UI 同源）。
    const headers = await seedAdminHeaders(request);
    const detailResponse = await request.get(
      `/api/v1/external-users/${EXTERNAL_USER_ID}`,
      { headers },
    );
    expect(detailResponse.ok()).toBeTruthy();
    const detail = (await detailResponse.json()) as {
      name?: string;
      position?: string | null;
      company?: string | null;
      contact?: string | null;
      displayName?: string;
      messageCount?: number;
    };
    expect(detail.name).toBe(PROFILE.name);
    expect(detail.position).toBe(PROFILE.position);
    expect(detail.company).toBe(PROFILE.company);
    expect(detail.contact).toBe(PROFILE.contact);
    // 渠道展示名保留（人工姓名不覆盖入站展示名）。
    expect(detail.displayName).toBe(EXTERNAL_DISPLAY_NAME);
    expect(detail.messageCount).toBeGreaterThanOrEqual(2);
  });
});
