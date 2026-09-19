import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

/**
 * third-party-agent-display Todo 3 · 成员外部 Agent 选择（设置面）
 * ============================================================
 * 设置面 = 团队详情页 `/teams/[id]`（成员管理）。会话页 / 消息输入区不提供
 * picker（web/e2e/no-agent-picker.spec.ts 测试 1 + 5 守护该边界）。
 *
 * A. 选择 → 保存 → reload 持久化：外部 Agent 名**从引擎实时清单挑**（不硬编码），
 *    PATCH 落库后 reload 回读一致；
 * B. 覆盖 caveat 逐字可见（策略门生效时外部选择可能被策略候选覆盖）+ 优先级声明；
 * C. 引擎未上报的名字：reload 后出现 `member-external-agent-unknown` 警告，
 *    且该值仍作为当前选中项展示（绝不静默丢弃用户已存的选择）。
 * D. 受治理的 vteam 名字：引擎**上报过**它（只是不作为外部选项）→ 绝不谎报"未上报"，
 *    只标注「vteam 策略 Agent，非外部选项」。
 * E. 三态互不混淆：loading（请求被延迟）只说"加载中"、绝不说"不可用/worker 离线"；
 *    ready 说计数；unavailable（mock 500）只说离线、绝不说"加载中"。
 *
 * 清理纪律：全部写操作发生在**一次性团队**上（建 → 改 → 证据 → 删），
 * 种子团队 tm_0000000001 只做只读 before/after 快照（证明未被触碰）。
 * 运行（仓库根）：`bash scripts/e2e-member-external-agent.sh`
 */

const SERVER_URL = "http://localhost:13000";
const SEED_TEAM_ID = "tm_0000000001";
const RUN_TAG = `t3-${Date.now().toString(36)}`;
const UNKNOWN_NAME = "definitely-not-an-engine-agent";

const CAVEAT = "当引擎的 vteam 策略门生效时，该外部选择可能被策略候选 Agent 覆盖。";
const PRECEDENCE_FRAGMENT = "策略候选优先（worker 支持时）";
const UNKNOWN_WARNING = "该外部 Agent 当前未被引擎上报（可能已下线或重命名）。";

interface OpencodeAgentEntry {
  name: string;
  mode: string;
  hidden?: boolean;
  governed: boolean;
}

interface TeamMember {
  id: string;
  alias: string;
  agentId: string;
  opencodeAgentName?: string | null;
}

interface TeamDto {
  id: string;
  members: TeamMember[];
}

async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByTestId("username").fill("admin");
  await page.getByTestId("password").fill("admin123");
  await page.getByTestId("login-button").click();
  await expect(page).toHaveURL(/\/teams/, { timeout: 15_000 });
}

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

async function adminToken(request: APIRequestContext): Promise<string> {
  const login = await request.post(`${SERVER_URL}/api/v1/auth/login`, {
    data: { username: "admin", password: "admin123" },
  });
  expect(login.ok()).toBeTruthy();
  return ((await login.json()) as { accessToken: string }).accessToken;
}

/** 引擎实时外部清单（!governed && !hidden），非硬编码。 */
async function engineExternalNames(
  request: APIRequestContext,
  token: string,
): Promise<OpencodeAgentEntry[]> {
  const res = await request.get(`${SERVER_URL}/api/v1/agents/opencode`, {
    headers: authHeaders(token),
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { agents: OpencodeAgentEntry[]; degraded: boolean };
  expect(body.degraded).toBe(false);
  return body.agents.filter((a) => !a.governed && !a.hidden);
}

async function getTeam(
  request: APIRequestContext,
  token: string,
  teamId: string,
): Promise<TeamDto> {
  const res = await request.get(`${SERVER_URL}/api/v1/teams/${teamId}`, {
    headers: authHeaders(token),
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as TeamDto;
}

/** 种子团队成员 opencodeAgentName 只读快照（证明本 spec 未触碰种子团队）。 */
async function seedSnapshot(
  request: APIRequestContext,
  token: string,
): Promise<Record<string, string | null>> {
  const team = await getTeam(request, token, SEED_TEAM_ID);
  const snap: Record<string, string | null> = {};
  for (const m of team.members) snap[m.id] = m.opencodeAgentName ?? null;
  return snap;
}

function recordEvidence(entry: Record<string, unknown>) {
  const path = process.env.T3_EVIDENCE_JSON;
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  let records: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    records = Array.isArray(parsed) ? parsed : [];
  } catch {
    records = [];
  }
  records.push(entry);
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
}

async function save(path: string | undefined, page: Page) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}

test.describe("Todo 3 · 成员外部 Agent 选择（设置面）", () => {
  test("1. 选择外部 Agent → 保存 → reload 持久化 + 覆盖 caveat 可见", async ({
    page,
    request,
  }) => {
    const token = await adminToken(request);
    const seedBefore = await seedSnapshot(request, token);

    const externals = await engineExternalNames(request, token);
    expect(externals.length).toBeGreaterThan(0);
    // 优先挑名字里带 prometheus 的真实外部 agent；没有则用清单第一条（不硬编码）
    const chosen =
      externals.find((a) => /prometheus/i.test(a.name))?.name ?? externals[0].name;
    expect(chosen).toBeTruthy();
    console.log(
      `[t3] engine external agents=${externals.length}; chosen="${chosen}"`,
    );

    const created = await request.post(`${SERVER_URL}/api/v1/teams`, {
      headers: authHeaders(token),
      data: { name: `qa-t3-team-${RUN_TAG}`, members: [{ agentId: "a_developer" }] },
    });
    expect(created.status()).toBe(201);
    const team = (await created.json()) as TeamDto;
    const memberId = team.members[0].id;

    try {
      await loginAsAdmin(page);
      await page.goto(`/teams/${team.id}`);
      await expect(page.getByTestId("team-detail-root")).toBeVisible({ timeout: 15_000 });

      const row = page.locator(`[data-testid="member-row"][data-member-id="${memberId}"]`);
      await expect(row).toBeVisible({ timeout: 15_000 });

      // caveat 逐字可见（无需展开，直接渲染在成员行）
      await expect(row.getByTestId("member-external-agent-caveat")).toContainText(CAVEAT);
      await expect(row.getByTestId("member-external-agent-caveat")).toContainText(
        PRECEDENCE_FRAGMENT,
      );

      const select = row.getByTestId("member-external-agent-select");
      await expect(select).toBeVisible();
      await expect(select).toHaveValue("");
      // 选项来自引擎清单（含默认项 → 数量 > 1）
      expect(await select.locator("option").count()).toBeGreaterThan(1);
      await expect(select.locator(`option[value="${chosen}"]`)).toHaveCount(1);

      await select.selectOption(chosen);
      await row.getByTestId("member-save").click();
      await expect(page.getByTestId("team-action-error")).toHaveCount(0);

      await expect
        .poll(
          async () =>
            (await getTeam(request, token, team.id)).members.find((m) => m.id === memberId)
              ?.opencodeAgentName,
          { timeout: 15_000 },
        )
        .toBe(chosen);

      // reload：持久化回读（不是仅前端态）
      await page.goto(`/teams/${team.id}`);
      await expect(page.getByTestId("team-detail-root")).toBeVisible({ timeout: 15_000 });
      const reloadedRow = page.locator(
        `[data-testid="member-row"][data-member-id="${memberId}"]`,
      );
      await expect(reloadedRow.getByTestId("member-external-agent-select")).toHaveValue(chosen);
      await expect(reloadedRow.getByTestId("member-external-agent-caveat")).toContainText(CAVEAT);
      await expect(reloadedRow.getByTestId("member-external-agent-unknown")).toHaveCount(0);
      // 证据必须落在 READY 态：计数文案可见，且不得是"加载中/不可用"
      await expect(reloadedRow.getByTestId("member-external-agent-note")).toContainText(
        "个外部 Agent（引擎上报",
      );
      await expect(reloadedRow.getByTestId("member-external-agent-note")).not.toContainText(
        "不可用",
      );

      await page.setViewportSize({ width: 1280, height: 900 });
      await save(process.env.T3_SCREENSHOT, page);

      recordEvidence({
        test: "select_persist_and_caveat",
        engine_external_count: externals.length,
        chosen_external_agent: chosen,
        persisted_after_reload: true,
        caveat_verbatim: CAVEAT,
        precedence_line: "策略候选优先（worker 支持时）→ opencodeAgentName → 引擎默认",
        team_id: team.id,
        member_id: memberId,
      });
    } finally {
      const del = await request.delete(`${SERVER_URL}/api/v1/teams/${team.id}`, {
        headers: authHeaders(token),
      });
      console.log(`[cleanup] throwaway team ${team.id} DELETE -> ${del.status()}`);
      const seedAfter = await seedSnapshot(request, token);
      expect(seedAfter).toEqual(seedBefore);
      recordEvidence({
        test: "cleanup",
        throwaway_team_deleted: del.status(),
        seed_team_opencode_agent_names_before: seedBefore,
        seed_team_opencode_agent_names_after: seedAfter,
        seed_team_untouched: true,
      });
    }
  });

  test("2. 引擎未上报的名字 → member-external-agent-unknown 警告", async ({
    page,
    request,
  }) => {
    const token = await adminToken(request);
    const seedBefore = await seedSnapshot(request, token);

    const engineNames = await engineExternalNames(request, token);
    expect(engineNames.some((a) => a.name === UNKNOWN_NAME)).toBe(false);

    const created = await request.post(`${SERVER_URL}/api/v1/teams`, {
      headers: authHeaders(token),
      data: { name: `qa-t3-unknown-${RUN_TAG}`, members: [{ agentId: "a_tester" }] },
    });
    expect(created.status()).toBe(201);
    const team = (await created.json()) as TeamDto;
    const memberId = team.members[0].id;

    try {
      // 直接经 API 写入引擎未上报的名字（弱校验只告警不阻断）
      const patched = await request.patch(
        `${SERVER_URL}/api/v1/teams/${team.id}/members/${memberId}`,
        { headers: authHeaders(token), data: { opencodeAgentName: UNKNOWN_NAME } },
      );
      expect(patched.ok()).toBeTruthy();

      await loginAsAdmin(page);
      await page.goto(`/teams/${team.id}`);
      await expect(page.getByTestId("team-detail-root")).toBeVisible({ timeout: 15_000 });

      const row = page.locator(`[data-testid="member-row"][data-member-id="${memberId}"]`);
      const warning = row.getByTestId("member-external-agent-unknown");
      await expect(warning).toBeVisible({ timeout: 15_000 });
      await expect(warning).toContainText(UNKNOWN_WARNING);

      // 未上报的值仍作为当前选中项展示（不静默丢弃）
      const select = row.getByTestId("member-external-agent-select");
      await expect(select).toHaveValue(UNKNOWN_NAME);
      await expect(select.locator(`option[value="${UNKNOWN_NAME}"]`)).toHaveCount(1);

      await page.setViewportSize({ width: 1280, height: 900 });
      await save(process.env.T3_UNKNOWN_SCREENSHOT, page);

      recordEvidence({
        test: "unknown_name_warning",
        unknown_name: UNKNOWN_NAME,
        warning_verbatim: UNKNOWN_WARNING,
        warning_visible: true,
        current_value_still_selected: true,
        team_id: team.id,
        member_id: memberId,
      });
    } finally {
      const del = await request.delete(`${SERVER_URL}/api/v1/teams/${team.id}`, {
        headers: authHeaders(token),
      });
      console.log(`[cleanup] throwaway team ${team.id} DELETE -> ${del.status()}`);
      expect(await seedSnapshot(request, token)).toEqual(seedBefore);
    }
  });

  test("3. 受治理的 vteam 名字：不谎报未上报（只注明非外部选项）", async ({
    page,
    request,
  }) => {
    const token = await adminToken(request);
    const res = await request.get(`${SERVER_URL}/api/v1/agents/opencode`, {
      headers: authHeaders(token),
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { agents: OpencodeAgentEntry[] };
    const governed = body.agents.filter((a) => a.governed && !a.hidden);
    expect(governed.length).toBeGreaterThan(0);
    const governedName = governed[0].name;

    const created = await request.post(`${SERVER_URL}/api/v1/teams`, {
      headers: authHeaders(token),
      data: { name: `qa-t3-governed-${RUN_TAG}`, members: [{ agentId: "a_product" }] },
    });
    expect(created.status()).toBe(201);
    const team = (await created.json()) as TeamDto;
    const memberId = team.members[0].id;

    try {
      const patched = await request.patch(
        `${SERVER_URL}/api/v1/teams/${team.id}/members/${memberId}`,
        { headers: authHeaders(token), data: { opencodeAgentName: governedName } },
      );
      expect(patched.ok()).toBeTruthy();

      await loginAsAdmin(page);
      await page.goto(`/teams/${team.id}`);
      await expect(page.getByTestId("team-detail-root")).toBeVisible({ timeout: 15_000 });
      const row = page.locator(`[data-testid="member-row"][data-member-id="${memberId}"]`);
      // 引擎上报过它（只是受治理）→ 不得出现"未被引擎上报"警告
      await expect(row.getByTestId("member-external-agent-unknown")).toHaveCount(0);
      await expect(row.getByTestId("member-external-agent-select")).toHaveValue(governedName);
      await expect(
        row.getByTestId("member-external-agent-select").locator(`option[value="${governedName}"]`),
      ).toContainText("非外部选项");

      recordEvidence({
        test: "governed_name_not_unknown",
        governed_name: governedName,
        unknown_warning_absent: true,
        annotated_as_non_external_option: true,
        team_id: team.id,
        member_id: memberId,
      });
    } finally {
      const del = await request.delete(`${SERVER_URL}/api/v1/teams/${team.id}`, {
        headers: authHeaders(token),
      });
      console.log(`[cleanup] throwaway team ${team.id} DELETE -> ${del.status()}`);
    }
  });

  test("4. 三态互不混淆：加载中不得说「不可用」，不可用只说离线", async ({
    page,
    request,
  }) => {
    const token = await adminToken(request);
    const created = await request.post(`${SERVER_URL}/api/v1/teams`, {
      headers: authHeaders(token),
      data: { name: `qa-t3-state-${RUN_TAG}`, members: [{ agentId: "a_developer" }] },
    });
    expect(created.status()).toBe(201);
    const team = (await created.json()) as TeamDto;
    const memberId = team.members[0].id;

    let delayMs = 2500;
    const delayedRoute = async (route: import("@playwright/test").Route) => {
      try {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        await route.continue();
      } catch {
        // 导航换页可能让请求先被中止（continue 无对象可续）——不是测试失败
      }
    };

    try {
      await loginAsAdmin(page);
      await page.route("**/agents/opencode**", delayedRoute);

      // Phase A：加载窗口（清单请求被人为延迟）→ 只能显示"加载中"
      await page.goto(`/teams/${team.id}`);
      await expect(page.getByTestId("team-detail-root")).toBeVisible({ timeout: 15_000 });
      const row = page.locator(`[data-testid="member-row"][data-member-id="${memberId}"]`);
      await expect(row).toBeVisible();
      const note = row.getByTestId("member-external-agent-note");
      await expect(note).toContainText("引擎 Agent 列表加载中");
      await expect(note).not.toContainText("不可用");
      await expect(note).not.toContainText("worker 离线");
      await expect(row.getByTestId("member-external-agent-select")).toBeDisabled();

      // Phase B：真实响应到达 → READY（计数文案），加载文案消失
      delayMs = 0;
      await expect(note).toContainText("个外部 Agent（引擎上报", { timeout: 20_000 });
      await expect(note).not.toContainText("加载中");
      await expect(note).not.toContainText("不可用");
      await expect(row.getByTestId("member-external-agent-select")).toBeEnabled();

      // Phase C：请求失败 → UNAVAILABLE（只在此态说离线），不得回退成"加载中"。
      // query 未设 retry:false → 约 7s 默认退避重试后才进 error 态，故放宽超时。
      await page.unroute("**/agents/opencode**", delayedRoute);
      await page.route("**/agents/opencode**", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ code: "INTERNAL_ERROR", message: "e2e-mocked-failure" }),
        }),
      );
      await page.reload();
      await expect(page.getByTestId("team-detail-root")).toBeVisible({ timeout: 15_000 });
      const reloadedRow = page.locator(
        `[data-testid="member-row"][data-member-id="${memberId}"]`,
      );
      const reloadedNote = reloadedRow.getByTestId("member-external-agent-note");
      await expect(reloadedNote).toContainText("不可用", { timeout: 25_000 });
      await expect(reloadedNote).toContainText("worker 离线");
      await expect(reloadedNote).not.toContainText("加载中");
      // 不可用态仍可编辑已保存值（选择器不在 loading 的 disabled 分支）
      await expect(reloadedRow.getByTestId("member-external-agent-select")).toBeEnabled();

      recordEvidence({
        test: "three_states_distinct",
        loading_note: "引擎 Agent 列表加载中…",
        ready_note_contains: "个外部 Agent（引擎上报",
        unavailable_note_contains: "worker 离线或版本不支持",
        loading_window_never_claims_unavailable: true,
        unavailable_never_claims_loading: true,
        team_id: team.id,
        member_id: memberId,
      });
    } finally {
      await page.unroute("**/agents/opencode**").catch(() => {});
      const del = await request.delete(`${SERVER_URL}/api/v1/teams/${team.id}`, {
        headers: authHeaders(token),
      });
      console.log(`[cleanup] throwaway team ${team.id} DELETE -> ${del.status()}`);
    }
  });
});
