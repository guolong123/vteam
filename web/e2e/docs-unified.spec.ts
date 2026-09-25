import { execFileSync } from "node:child_process";
import path from "node:path";
import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * 统一文档站永久 e2e（docs-artifacts-merge T12，DB-only 合站回归门）。
 * ============================================================================
 * 五组：happy（选择器→chips→树→查看器→版本→删除→原型 tab→深链）
 *       / edge（txt/pdf/docx/ghost 渲染分支）/ failure（未知 doc/无 teamId/
 *       团队级原型聚合）/ XSS（脚本剥离 + 链接白名单）/ prototypes（徽标/tab/深链）。
 *
 * Fixture（自给自足，beforeAll 经 API 创建临时团队/任务 + afterAll 删除临时团队）：
 * - 运行时从 seed 的 `vteam开发团队` 解析 7 个成员，再创建临时团队和任务；不依赖
 *   旧运行留下的 task/session/channel 行。
 * - 任务上 10 行 `t12qa-*`：text 含 XSS payload（category=测试报告）/ md（需求）/
 *   txt（设计）/ pdf（测试用例）/ docx（运维）/ text v1+v2（实现）/ text（其他）/
 *   text 无分类 NULL（删除用）/ ghost 缺失文件 / tsx 原型（设计）。
 * - 分类覆盖七类 + NULL（未分类 chip 用）；`计划` 类由系统自动归档产生，e2e fixture
 *   不预置该类行；file 行 content 纯空白（防 append P2 落盘覆盖 fileRef）；断言
 *   一律按 `t12qa-` 前缀过滤自家行。
 * - 原型字节由 beforeAll 从仓库 fixture 复制到 server 的 uploads 卷，并使用本轮
 *   唯一文件名；afterAll 删除该文件，避免把“手工准备文件”变成测试前置条件。
 *
 * 约束（T8/T9/T10 learnings）：chips 经 getByRole(button, exact) 点、
 * [data-key]+data-active 断言（不用 hasText）；不测 data-render="text-fallback"
 *（已退役）；不测 chip→URL 激活（chips 只读 state 默认）；中文 query 自行编码
 *（本文件经 UI 点击，无手写中文 URL）。
 */

const SERVER = "http://localhost:13000";
const SERVER_CONTAINER = "aiagents-compose-server";
const SEED_TEAM_NAME = "vteam开发团队";
const P = "t12qa-";
const PROTOTYPE_META_ID = "t12qa-demo";

let TEAM_ID = "";
let TASK_ID = "";
let TASK_URL = "";
let PROTOTYPE_ID = "";
/** 团队级原型断言用的任务标题：beforeAll 运行时解析——任务可被改名，写死即数据漂移。 */
let seededTaskTitle = "";
const uploadedPaths = new Set<string>();
let prototypePath = "";

/** 自家树行（按标题前缀过滤，隔离 moving-target 邻居行）。 */
function ownRows(page: import("@playwright/test").Page) {
  return page.getByTestId("docs-tree-item").filter({ hasText: P });
}

function ownRow(page: import("@playwright/test").Page, title: string) {
  return page
    .getByTestId("docs-tree-item")
    .filter({ hasText: title })
    .first();
}

/** 行内主按钮（首个 button=选中，第二个=删除）。 */
async function selectRow(page: import("@playwright/test").Page, title: string) {
  await ownRow(page, title).locator("button").first().click();
}

async function loginAsSeedAdmin(api: APIRequestContext): Promise<string> {
  const login = await api.post(`${SERVER}/api/v1/auth/login`, {
    data: { username: "seed-admin", password: "Admin@123456" },
  });
  expect(login.ok()).toBe(true);
  const { accessToken } = await login.json();
  return `Bearer ${accessToken}`;
}

async function uploadSample(
  api: APIRequestContext,
  auth: string,
  name: string,
  mimeType: string,
  buffer: Buffer,
): Promise<string> {
  const res = await api.post(`${SERVER}/api/v1/uploads`, {
    headers: { Authorization: auth },
    multipart: { file: { name, mimeType, buffer } },
  });
  expect(res.ok()).toBe(true);
  const { url } = await res.json();
  expect(url.startsWith("/uploads/")).toBe(true);
  uploadedPaths.add(url as string);
  return url as string;
}

const seedIds: Record<string, string> = {};

type SeedMember = { agentId: string; roleId?: string | null };
type SeedTeam = { id: string; name: string; members?: SeedMember[] };
type SeedTeamList = { items?: SeedTeam[] };
type CreatedTask = { id?: string; title?: string; task?: { id?: string; title?: string } };
type ArtifactList = { items?: Array<{ id: string; title: string }> };

function removeContainerFiles(paths: Iterable<string>): void {
  const files = [...paths]
    .filter((file) => file.length > 0)
    .map((file) => (file.startsWith("/uploads/") ? `/app${file}` : file));
  if (files.length === 0) return;
  execFileSync("docker", ["exec", SERVER_CONTAINER, "rm", "-f", ...files]);
}

function providePrototypeFixture(): { path: string; id: string } {
  const id = `${P}demo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fileName = `${id}.tsx`;
  const source = path.resolve(process.cwd(), "e2e/fixtures/t12qa-demo.tsx");
  execFileSync("docker", [
    "cp",
    source,
    `${SERVER_CONTAINER}:/app/uploads/${fileName}`,
  ]);
  return { path: `/uploads/${fileName}`, id };
}

async function resolveSeedMembers(
  api: APIRequestContext,
  base: string,
  headers: { Authorization: string },
): Promise<SeedMember[]> {
  const response = await api.get(`${base}/teams?page=1&pageSize=100`, { headers });
  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as SeedTeamList;
  const seedTeam = payload.items?.find((team) => team.name === SEED_TEAM_NAME);
  expect(seedTeam).toBeDefined();
  const members = seedTeam?.members ?? [];
  expect(members).toHaveLength(7);
  return members.map((member) => ({
    agentId: member.agentId,
    ...(member.roleId ? { roleId: member.roleId } : {}),
  }));
}

test.beforeAll("T12 fixture seeding（创建临时团队/任务→直写 10 行）", async ({ playwright }) => {
  const api = await playwright.request.newContext();
  try {
    const auth = await loginAsSeedAdmin(api);
    const headers = { Authorization: auth };
    const base = `${SERVER}/api/v1`;
    const members = await resolveSeedMembers(api, base, headers);
    const teamResponse = await api.post(`${base}/teams`, {
      headers,
      data: {
        name: `${P}team-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        members,
      },
    });
    expect(teamResponse.status()).toBe(201);
    const teamPayload = (await teamResponse.json()) as { id?: string };
    expect(teamPayload.id).toBeTruthy();
    TEAM_ID = teamPayload.id ?? "";

    const taskResponse = await api.post(`${base}/tasks`, {
      headers,
      data: {
        teamId: TEAM_ID,
        title: `${P}task-${Date.now()}`,
        priority: "medium",
      },
    });
    expect(taskResponse.status()).toBe(201);
    const taskPayload = (await taskResponse.json()) as CreatedTask;
    TASK_ID = taskPayload.id ?? taskPayload.task?.id ?? "";
    expect(TASK_ID).toBeTruthy();
    TASK_URL = `/docs?teamId=${encodeURIComponent(TEAM_ID)}&taskId=${encodeURIComponent(TASK_ID)}`;

    const taskRes = await api.get(`${base}/tasks/${TASK_ID}`, { headers });
    expect(taskRes.ok()).toBe(true);
    const taskRow = (await taskRes.json()) as { title?: string; task?: { title?: string } };
    seededTaskTitle = String(taskRow.title ?? taskRow.task?.title ?? "");
    expect(seededTaskTitle).toBeTruthy();

    const existing = await api.get(
      `${base}/teams/${TEAM_ID}/artifacts?page=1&pageSize=100`,
      { headers },
    );
    expect(existing.ok()).toBe(true);
    const existingPayload = (await existing.json()) as ArtifactList;
    for (const artifact of (existingPayload.items ?? []).filter((item) =>
      item.title.startsWith(P),
    )) {
      await api.delete(`${base}/artifacts/${artifact.id}`, { headers });
    }

    const prototypeFixture = providePrototypeFixture();
    prototypePath = prototypeFixture.path;
    PROTOTYPE_ID = prototypeFixture.id;
    const mdUrl = await uploadSample(
      api,
      auth,
      "t12qa-req.md",
      "text/markdown",
      Buffer.from("# t12qa 需求文档\n\nT12 统一文档站 e2e 需求 fixture。\n", "utf8"),
    );
    const txtUrl = await uploadSample(
      api,
      auth,
      "t12qa-design.txt",
      "text/plain",
      Buffer.from("t12qa design notes\nsecond line\n", "utf8"),
    );
    const pdfUrl = await uploadSample(
      api,
      auth,
      "t12qa-case.pdf",
      "application/pdf",
      Buffer.from(
        "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 60>>stream\nBT /F1 18 Tf 50 100 Td (t12qa pdf fixture) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n",
        "utf8",
      ),
    );
    const docxUrl = await uploadSample(
      api,
      auth,
      "t12qa-ops.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      Buffer.concat([Buffer.from("PK\x05\x06", "binary"), Buffer.alloc(18)]),
    );

    const create = async (body: Record<string, string>) => {
      const res = await api.post(`${base}/tasks/${TASK_ID}/artifacts`, {
        headers: { ...headers, "Content-Type": "application/json" },
        data: body,
      });
      expect(res.ok()).toBe(true);
      const payload = (await res.json()) as { artifact?: { id?: string } };
      expect(payload.artifact?.id).toBeTruthy();
      const id = payload.artifact?.id ?? "";
      seedIds[body.title] = id;
      return id;
    };

    await create({
      type: "text",
      title: `${P}xss-report`,
      content:
        "# t12qa XSS 探针\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n[ok](https://example.com)\n",
      category: "测试报告",
    });
    await create({
      type: "file",
      title: `${P}req-md`,
      fileRef: mdUrl,
      content: " ",
      category: "需求",
    });
    await create({
      type: "file",
      title: `${P}design-txt`,
      fileRef: txtUrl,
      content: "  ",
      category: "设计",
    });
    await create({
      type: "file",
      title: `${P}case-pdf`,
      fileRef: pdfUrl,
      content: "   ",
      category: "测试用例",
    });
    await create({
      type: "file",
      title: `${P}ops-docx`,
      fileRef: docxUrl,
      content: "    ",
      category: "运维",
    });
    await create({
      type: "text",
      title: `${P}impl-note`,
      content: "t12qa impl v1 正文",
      category: "实现",
    });
    await create({ type: "text", title: `${P}impl-note`, content: "t12qa impl v2 正文" });
    await create({
      type: "text",
      title: `${P}misc`,
      content: "t12qa misc 其他分类正文",
      category: "其他",
    });
    await create({ type: "text", title: `${P}scratch`, content: "t12qa 待删除草稿" });
    await create({
      type: "file",
      title: `${P}ghost`,
      fileRef: "/uploads/t12qa-ghost-missing.pdf",
      content: "     ",
    });
    await create({
      type: "file",
      title: `${P}demo`,
      fileRef: prototypePath,
      content: "      ",
      category: "设计",
    });

    const protos = await api.get(`${base}/docs-site/${TASK_ID}/prototypes`, {
      headers,
    });
    expect(protos.ok()).toBe(true);
    const prototypePayload = (await protos.json()) as {
      items?: Array<{ id: string }>;
    };
    expect(prototypePayload.items?.some((item) => item.id === PROTOTYPE_ID)).toBe(true);
  } finally {
    await api.dispose();
  }
});

test.afterAll("T12 fixture cleanup（删临时团队/任务及上传文件）", async ({ playwright }) => {
  const api = await playwright.request.newContext();
  try {
    if (TEAM_ID) {
      const auth = await loginAsSeedAdmin(api);
      const headers = { Authorization: auth };
      const base = `${SERVER}/api/v1`;
      const list = await api.get(
        `${base}/teams/${TEAM_ID}/artifacts?page=1&pageSize=100`,
        { headers },
      );
      if (list.ok()) {
        const payload = (await list.json()) as ArtifactList;
        for (const artifact of (payload.items ?? []).filter((item) =>
          item.title.startsWith(P),
        )) {
          await api.delete(`${base}/artifacts/${artifact.id}`, { headers });
        }
      }
      const deleted = await api.delete(`${base}/teams/${TEAM_ID}`, { headers });
      expect(deleted.ok()).toBe(true);
    }
  } finally {
    await api.dispose();
    removeContainerFiles([prototypePath, ...uploadedPaths]);
  }
});

test.describe("happy：选择器→chips→树→查看器→版本→删除→深链", () => {
  test("选择器 + 树：任务预填 + 自家 10 行", async ({ page }) => {
    await page.goto(TASK_URL);
    await expect(page.getByTestId("docs-shell")).toBeVisible();
    await expect(page.getByTestId("docs-filter-bar")).toBeVisible();
    await expect(page.getByTestId("task-filter-select")).toHaveValue(TASK_ID);
    await expect(ownRows(page)).toHaveCount(10);
    await expect(page.getByTestId("docs-viewer-empty")).toBeVisible();
  });

  test("chips：分类过滤 + data-active 契约", async ({ page }) => {
    await page.goto(TASK_URL);
    await expect(ownRows(page)).toHaveCount(10);
    // 实现 chip：点中文按钮，断言 [data-key]+data-active（T8 范式）。
    await page.getByRole("button", { name: "测试报告", exact: true }).click();
    await expect(
      page.locator(
        '[data-testid="category-filter-option"][data-key="测试报告"]',
      ),
    ).toHaveAttribute("data-active", "true");
    await expect(ownRow(page, `${P}xss-report`)).toBeVisible();
    await expect(ownRow(page, `${P}req-md`)).toHaveCount(0);
    // 未分类 chip：NULL 行可见、已分类行隐藏。
    await page.getByRole("button", { name: "未分类", exact: true }).click();
    await expect(ownRow(page, `${P}scratch`)).toBeVisible();
    await expect(ownRow(page, `${P}xss-report`)).toHaveCount(0);
    // 全部：恢复 10 行（经 [data-key] 定位，同名三枚中的分类那枚）。
    await page
      .locator('[data-testid="category-filter-option"][data-key="all"]')
      .click();
    await expect(ownRows(page)).toHaveCount(10);
  });

  test("树→查看器：md 渲染 + ?doc= 回写", async ({ page }) => {
    await page.goto(TASK_URL);
    await selectRow(page, `${P}req-md`);
    const viewer = page.getByTestId("artifact-viewer");
    await expect(viewer).toBeVisible();
    await expect(
      viewer.locator('[data-testid="docs-content-view"][data-render="md-file"]'),
    ).toBeVisible();
    await expect(viewer.getByRole("heading", { name: /t12qa 需求文档/ })).toBeVisible();
    await expect(page).toHaveURL(/\/docs\?.*doc=.+/);
  });

  test("版本查看器：v2 默认 + 切 v1", async ({ page }) => {
    await page.goto(TASK_URL);
    await selectRow(page, `${P}impl-note`);
    const viewer = page.getByTestId("artifact-viewer");
    await expect(viewer).toContainText("t12qa impl v2 正文");
    await viewer.locator('button[data-version="1"]').click();
    await expect(viewer).toContainText("t12qa impl v1 正文");
    await expect(page.getByTestId("artifact-version-timeline")).toContainText("v1");
    await expect(page.getByTestId("artifact-version-timeline")).toContainText("v2");
  });

  test("删除：UI 删 scratch 行 + API 404", async ({ page, request }) => {
    const doomed = seedIds[`${P}scratch`];
    expect(doomed).toBeTruthy();
    await page.goto(TASK_URL);
    await expect(ownRows(page)).toHaveCount(10);
    page.on("dialog", (d) => d.accept());
    const row = ownRow(page, `${P}scratch`);
    await row.hover();
    await row.getByTestId("docs-delete-button").click();
    await expect(ownRow(page, `${P}scratch`)).toHaveCount(0);
    await expect(ownRows(page)).toHaveCount(9);
    const login = await request.post("/api/v1/auth/login", {
      data: { username: "seed-admin", password: "Admin@123456" },
    });
    const { accessToken } = await login.json();
    const gone = await request.get(`/api/v1/artifacts/${doomed}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(gone.status()).toBe(404);
  });

  test("?doc= 深链：直达查看器", async ({ page }) => {
    await page.goto(TASK_URL);
    await expect(ownRow(page, `${P}misc`)).toBeVisible();
    const slug = await ownRow(page, `${P}misc`).getAttribute("data-doc-id");
    expect(slug).toBeTruthy();
    await page.goto(
      `${TASK_URL}&doc=${encodeURIComponent(slug as string)}`,
    );
    await expect(page.getByTestId("artifact-viewer")).toBeVisible();
    await expect(page.getByTestId("artifact-viewer")).toContainText(
      "t12qa misc 其他分类正文",
    );
  });
});

test.describe("prototypes：徽标→tab→深链→团队级聚合（T16）", () => {
  test("徽标 + tab：原型非空", async ({ page }) => {
    await page.goto(TASK_URL);
    const tab = page.getByTestId("docs-tab-protos");
    await expect(tab).toBeVisible();
    // 徽标为异步查询（docs-proto-count），等数字出现再读（首屏快照必为 0）。
    await expect(tab).toContainText(/[1-9][0-9]*/);
    const label = (await tab.textContent()) ?? "";
    const n = Number(label.replace(/[^0-9]/g, ""));
    expect(n >= 1).toBe(true);
    await tab.click();
    await expect(page.getByTestId("docs-prototype-panel")).toBeVisible();
    await expect(page.getByTestId("docs-prototype-panel")).toContainText(
      PROTOTYPE_META_ID,
    );
    await page.screenshot({
      path: "../.omo/evidence/docs-artifacts-merge/img/t12-protos-tab.png",
    });
  });

  test("?proto= 深链：直达选中", async ({ page }) => {
    await page.goto(`${TASK_URL}&proto=${PROTOTYPE_META_ID}`);
    await expect(page.getByTestId("docs-tab-protos")).toHaveAttribute(
      "data-active",
      "true",
    );
    const panel = page.getByTestId("docs-prototype-panel");
    await expect(panel).toBeVisible();
    await expect(
      panel.locator('button[aria-current="page"]', { hasText: PROTOTYPE_META_ID }),
    ).toBeVisible();
  });

  test("返回按钮：从会话页进入文档站后可返回", async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/session`);
    await page.goto(TASK_URL);
    const back = page.getByTestId("docs-back");
    await expect(back).toBeVisible();
    await expect(back).toContainText("返回");
    await back.click();
    await expect(page).toHaveURL(/\/teams\//);
  });

  test("团队级（task=all）：原型 tab 可用 + 跨任务列表", async ({ page }) => {
    // T16 起原型为团队级：task=all 下 tab 保持可用（旧 disabled 断言已随需求删除）。
    await page.goto(`/docs?teamId=${TEAM_ID}`);
    const tab = page.getByTestId("docs-tab-protos");
    await expect(tab).toBeVisible();
    await expect(tab).toBeEnabled();
    await tab.click();
    const panel = page.getByTestId("docs-prototype-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(PROTOTYPE_META_ID);
    await expect(panel).toContainText(seededTaskTitle);
    // 旧「请先选择任务」死端已删：非空时无空态。
    await expect(page.getByTestId("docs-proto-empty")).toHaveCount(0);
    await expect(panel).not.toContainText("请先选择任务");
  });

  test("团队级（task=all）：?proto= 深链直达选中", async ({ page }) => {
    await page.goto(`/docs?teamId=${TEAM_ID}&proto=${PROTOTYPE_META_ID}`);
    await expect(page.getByTestId("docs-tab-protos")).toHaveAttribute(
      "data-active",
      "true",
    );
    const panel = page.getByTestId("docs-prototype-panel");
    await expect(panel).toBeVisible();
    await expect(
      panel.locator('button[aria-current="page"]', { hasText: PROTOTYPE_META_ID }),
    ).toBeVisible();
  });
});

test.describe("edge：txt/csv/json 预览 + pdf 沙箱 + docx 下载卡 + ghost", () => {
  test("txt→<pre> 预览 + 下载兜底", async ({ page }) => {
    await page.goto(TASK_URL);
    await selectRow(page, `${P}design-txt`);
    const viewer = page.getByTestId("artifact-viewer");
    await expect(
      viewer.locator(
        '[data-testid="docs-content-view"][data-render="text-preview"]',
      ),
    ).toBeVisible();
    await expect(viewer.locator("pre")).toContainText("t12qa design notes");
    await expect(viewer.getByTestId("docs-file-download")).toBeVisible();
  });

  test("pdf→沙箱 iframe（无 allow-scripts）", async ({ page }) => {
    await page.goto(TASK_URL);
    await selectRow(page, `${P}case-pdf`);
    const viewer = page.getByTestId("artifact-viewer");
    const body = viewer.locator(
      '[data-testid="docs-content-view"][data-render="pdf"]',
    );
    await expect(body).toBeVisible();
    const frame = viewer.getByTestId("docs-pdf-frame");
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute("sandbox", "allow-same-origin");
    const outer = (await frame.evaluate((el) => el.outerHTML)) as string;
    expect(outer.includes("allow-scripts")).toBe(false);
    await page.screenshot({
      path: "../.omo/evidence/docs-artifacts-merge/img/t12-pdf.png",
    });
  });

  test("docx→下载卡 + 零 iframe", async ({ page }) => {
    await page.goto(TASK_URL);
    await selectRow(page, `${P}ops-docx`);
    const viewer = page.getByTestId("artifact-viewer");
    await expect(
      viewer.locator(
        '[data-testid="docs-content-view"][data-render="file-card"]',
      ),
    ).toBeVisible();
    await expect(viewer.locator("iframe")).toHaveCount(0);
    await expect(viewer.getByTestId("docs-file-download")).toBeVisible();
  });

  test("ghost 不可访问引用→降级", async ({ page }) => {
    await page.goto(TASK_URL);
    await selectRow(page, `${P}ghost`);
    await expect(
      page
        .getByTestId("artifact-viewer")
        .locator(
          '[data-testid="docs-content-view"][data-render="inaccessible"]',
        ),
    ).toBeVisible();
  });
});

test.describe("failure：未知 doc + 无 teamId", () => {
  test("未知 ?doc= → 空态（不 404 不崩）", async ({ page }) => {
    await page.goto(`${TASK_URL}&doc=${encodeURIComponent("__no_such_doc__")}`);
    await expect(page.getByTestId("docs-doc-missing")).toBeVisible();
    await expect(page.getByTestId("artifact-viewer")).toHaveCount(0);
  });

  test("无 teamId → 团队选择器 → 可进站", async ({ page }) => {
    await page.goto("/docs");
    await expect(page.getByTestId("docs-team-picker")).toBeVisible();
    const first = page.getByTestId("docs-team-option").first();
    await expect(first).toBeVisible();
    await first.click();
    await expect(page).toHaveURL(/\/docs\?.*teamId=.+/);
    await expect(page.getByTestId("docs-filter-bar")).toBeVisible();
  });
});

test.describe("XSS：脚本剥离 + 链接白名单 + 零执行", () => {
  test("text→md：script 零元素 + javascript: 零 href + 安全链接保留", async ({
    page,
  }) => {
    const dialogs: string[] = [];
    const errors: string[] = [];
    page.on("dialog", (d) => dialogs.push(d.message()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(TASK_URL);
    await selectRow(page, `${P}xss-report`);
    const viewer = page.getByTestId("artifact-viewer");
    await expect(
      viewer.locator('[data-testid="docs-content-view"][data-render="text-md"]'),
    ).toBeVisible();
    // md 正常渲染（标题）+ <script> 以字面文本展示（零 script 元素）。
    await expect(
      viewer.getByRole("heading", { name: /t12qa XSS 探针/ }),
    ).toBeVisible();
    await expect(viewer.locator("script")).toHaveCount(0);
    // 白名单：javascript: 退化为无 href 锚点，https 保留。
    await expect(viewer.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(
      viewer.locator('a[href="https://example.com"]'),
    ).toHaveCount(1);
    expect(dialogs).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: "../.omo/evidence/docs-artifacts-merge/img/t12-xss.png",
    });
  });
});
