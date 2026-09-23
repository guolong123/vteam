import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * 统一文档站永久 e2e（docs-artifacts-merge T12，DB-only 合站回归门）。
 * ============================================================================
 * 五组：happy（选择器→chips→树→查看器→版本→删除→原型 tab→深链）
 *       / edge（txt/pdf/docx/ghost 渲染分支）/ failure（未知 doc/无 teamId/
 *       团队级原型聚合）/ XSS（脚本剥离 + 链接白名单）/ prototypes（徽标/tab/深链）。
 *
 * Fixture（自给自足，beforeAll 经 API 直写 + afterAll 经 API 全删）：
 * - 任务 t_0000000001（团队 tm_0000000001，seed-admin 可见）上 10 行 `t12qa-*`：
 *   text 含 XSS payload（category=测试报告）/ md（需求）/ txt（设计）/
 *   pdf（测试用例）/ docx（运维）/ text v1+v2（实现）/ text（其他）/
 *   text 无分类 NULL（删除用）/ ghost 缺失文件 / tsx 原型（设计）。
 * - 分类覆盖七类 + NULL（未分类 chip 用）；`计划` 类由系统自动归档产生，e2e fixture 不预置该类行；file 行 content 纯空白（防 append P2
 *   落盘覆盖 fileRef）；断言一律按 `t12qa-` 前缀过滤自家行（live 库 moving-target）。
 * - tsx 字节不走 uploads 白名单：`web/e2e/fixtures/t12qa-demo.tsx` 须事先
 *   `docker cp web/e2e/fixtures/t12qa-demo.tsx aiagents-compose-server:/app/uploads/`
 *  （uploads_data 卷持久化；卷重建后重跑此命令即可；缺失时原型组 fail-fast 提示）。
 *
 * 约束（T8/T9/T10 learnings）：chips 经 getByRole(button, exact) 点、
 * [data-key]+data-active 断言（不用 hasText）；不测 data-render="text-fallback"
 *（已退役）；不测 chip→URL 激活（chips 只读 state 默认）；中文 query 自行编码
 *（本文件经 UI 点击，无手写中文 URL）。
 */

const TEAM_ID = "tm_0000000001";
const TASK_ID = "t_0000000001";
const SERVER = "http://localhost:13000";
const TASK_URL = `/docs?teamId=${TEAM_ID}&taskId=${TASK_ID}`;
const P = "t12qa-";
/** 团队级原型断言用的任务标题：beforeAll 运行时解析——任务可被改名，写死即数据漂移。 */
let seededTaskTitle = "";

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
  return url as string;
}

const seedIds: Record<string, string> = {};

test.beforeAll("T12 fixture seeding（删旧→直写 10 行）", async ({ playwright }) => {
  const api = await playwright.request.newContext();
  const auth = await loginAsSeedAdmin(api);
  const headers = { Authorization: auth };
  const base = `${SERVER}/api/v1`;

  // 运行时解析 TASK_ID 的当前标题（团队级聚合断言要用「任务名」，而任务名会被人改）。
  const taskRes = await api.get(`${base}/tasks/${TASK_ID}`, { headers });
  expect(taskRes.ok()).toBe(true);
  const taskRow = await taskRes.json();
  seededTaskTitle = String((taskRow?.task ?? taskRow)?.title ?? "");
  expect(seededTaskTitle).toBeTruthy();

  // 幂等：先删残留 t12qa 行（复跑/中断残留不污染树计数）。
  const existing = await api.get(
    `${base}/teams/${TEAM_ID}/artifacts?page=1&pageSize=100`,
    { headers },
  );
  expect(existing.ok()).toBe(true);
  const { items } = await existing.json();
  for (const it of items.filter((r: { title: string }) =>
    r.title.startsWith(P),
  )) {
    await api.delete(`${base}/artifacts/${it.id}`, { headers });
  }

  // 文件字节（ concern: 自包含 Buffer，不依赖外部样本文件）。
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
  // 最小合法空 zip（22B）作 docx 字节：下载卡不断言内容解析，仅需磁盘存在给 size。
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
    const { artifact } = await res.json();
    seedIds[body.title] = artifact.id as string;
    return artifact.id as string;
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
  // tsx 原型：字节由卷内 /app/uploads/t12qa-demo.tsx 提供（见文件头），此处只注册行。
  await create({
    type: "file",
    title: `${P}demo`,
    fileRef: "/uploads/t12qa-demo.tsx",
    content: "      ",
    category: "设计",
  });

  // 原型非空门（fail-fast：缺字节时给重播种命令，不跑一半才红）。
  const protos = await api.get(`${base}/docs-site/${TASK_ID}/prototypes`, {
    headers,
  });
  expect(protos.ok()).toBe(true);
  const { items: protoItems } = await protos.json();
  expect(
    protoItems.some(
      (p: { id: string }) => p.id === "t12qa-demo",
    ) ||
      "缺 /app/uploads/t12qa-demo.tsx 字节：docker cp web/e2e/fixtures/t12qa-demo.tsx aiagents-compose-server:/app/uploads/ 后重跑",
  ).toBe(true);
  await api.dispose();
});

test.afterAll("T12 fixture cleanup（删全部 t12qa 行）", async ({ playwright }) => {
  const api = await playwright.request.newContext();
  const auth = await loginAsSeedAdmin(api);
  const headers = { Authorization: auth };
  const base = `${SERVER}/api/v1`;
  const list = await api.get(
    `${base}/teams/${TEAM_ID}/artifacts?page=1&pageSize=100`,
    { headers },
  );
  if (list.ok()) {
    const { items } = await list.json();
    for (const it of items.filter((r: { title: string }) =>
      r.title.startsWith(P),
    )) {
      await api.delete(`${base}/artifacts/${it.id}`, { headers });
    }
  }
  await api.dispose();
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
      "t12qa-demo",
    );
    await page.screenshot({
      path: "../.omo/evidence/docs-artifacts-merge/img/t12-protos-tab.png",
    });
  });

  test("?proto= 深链：直达选中", async ({ page }) => {
    await page.goto(`${TASK_URL}&proto=t12qa-demo`);
    await expect(page.getByTestId("docs-tab-protos")).toHaveAttribute(
      "data-active",
      "true",
    );
    const panel = page.getByTestId("docs-prototype-panel");
    await expect(panel).toBeVisible();
    await expect(
      panel.locator('button[aria-current="page"]', { hasText: "t12qa-demo" }),
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
    // beforeAll 在 t_0000000001 上播种了 t12qa-demo：团队聚合须含该条目及其任务名（运行时解析）。
    await expect(panel).toContainText("t12qa-demo");
    await expect(panel).toContainText(seededTaskTitle);
    // 旧「请先选择任务」死端已删：非空时无空态。
    await expect(page.getByTestId("docs-proto-empty")).toHaveCount(0);
    await expect(panel).not.toContainText("请先选择任务");
  });

  test("团队级（task=all）：?proto= 深链直达选中", async ({ page }) => {
    await page.goto(`/docs?teamId=${TEAM_ID}&proto=t12qa-demo`);
    await expect(page.getByTestId("docs-tab-protos")).toHaveAttribute(
      "data-active",
      "true",
    );
    const panel = page.getByTestId("docs-prototype-panel");
    await expect(panel).toBeVisible();
    await expect(
      panel.locator('button[aria-current="page"]', { hasText: "t12qa-demo" }),
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
