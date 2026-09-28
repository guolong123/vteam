import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROLE_KEYS, roles, roleText, type RoleKey } from "../src/theme/tokens";

/**
 * chat-ux-hierarchy-and-streaming 复选框 11 · B10 角色色统一走 light/dark CSS 变量
 * =============================================
 * 单一角色色源 = `app/globals.css` 的 `:root` / `.dark` 变量对
 * (`--color-role-<kebab-role>-{color,bg,border}`)。本文件是窄归属的角色色门：
 *  - 源契约：`tokens.ts` 的 `roles` / `roleText` 两张表零硬编码 hex，逐项等于
 *    `var(--color-role-*)` 引用；角色键序/标签/条目数不变；globals.css 在
 *    `:root` 与 `.dark` 双侧都定义了被引用的变量（不新增第二套角色色源）。
 *  - 计算值契约（真浏览器，非源码 grep）：用已声明依赖 esbuild-wasm 把真实产品组件
 *    （MessageIdentity → AgentAvatar、ChatBubble）打包成 IIFE 注入空白页，注入**真实**
 *    `app/globals.css`，在 light 与 `.dark` 两种主题下断言身份文字 color、头像
 *    backgroundColor / borderTopColor **等于对应变量在当前主题下的解析值**，且
 *    light/dark 解析值彼此不同（证明真的随主题切换）。
 *  - 未知角色：头像回落 developer 变量、角色标签回落「开发者」，不抛异常。
 *  - 徽标：external 徽标与 mention(@你) 徽标仍在且色值仍跟随各自变量（不被本次改动波及）。
 *  - 失败语义（red）：改动前 `roles`/`roleText` 是硬编码 hex → 源契约红；计算值在 dark
 *    下是浅色不透明 hex，与 dark 变量解析值不同 → 计算值契约红。改动后双绿。
 *  - 回归：故意注入硬编码 hex 的探针元素必须被判为「不跟随变量」，否则本门形同虚设。
 *
 * 运行：`npx playwright test lib/role-theme.spec.ts --project=lib-unit`
 */

const WEB_ROOT = process.cwd();
const TOKENS_PATH = path.join(WEB_ROOT, "src", "theme", "tokens.ts");
const GLOBALS_CSS_PATH = path.join(WEB_ROOT, "app", "globals.css");

const HEX_RE = /#[0-9A-Fa-f]{6}\b/;

/** 计划锁定的六个角色键（顺序 = `roles` 声明序；改键/增删条目必须在此显式暴露）。 */
const EXPECTED_ROLE_KEYS = [
  "product",
  "project_manager",
  "architect",
  "developer",
  "tester",
  "plan",
] as const satisfies readonly RoleKey[];

/** 计划锁定的标签（B10 不改 label）。 */
const EXPECTED_LABELS: Record<RoleKey, string> = {
  product: "产品经理",
  project_manager: "项目经理",
  architect: "架构师",
  developer: "开发者",
  tester: "测试",
  plan: "计划员",
};

type RolePart = "color" | "bg" | "border";

/** 独立推导的期望变量名（不读 tokens，避免与被测实现同源）。 */
function expectedVar(role: string, part: RolePart): string {
  return `var(--color-role-${role.replace(/_/g, "-")}-${part})`;
}

/** 取 tokens.ts 中某张导出表的源码切片（用于硬编码 hex 扫描）。 */
function tableSlice(source: string, exportName: string): string {
  const start = source.indexOf(`export const ${exportName}`);
  expect(start, `tokens.ts 应导出 ${exportName}`).toBeGreaterThan(-1);
  const end = source.indexOf("};", start);
  expect(end, `${exportName} 表应以 }; 结束`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** globals.css 中匹配选择器的所有块的源码切片（`:root` 在该文件里有两块，故需取并集）。 */
function cssBlocks(source: string, selector: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(`${selector} {`, from);
    if (start < 0) break;
    const end = source.indexOf("\n}", start);
    expect(end, `${selector} 块应闭合`).toBeGreaterThan(start);
    blocks.push(source.slice(start, end));
    from = end + 2;
  }
  expect(blocks.length, `globals.css 应含 ${selector} 块`).toBeGreaterThan(0);
  return blocks;
}

/* ------------------------------------------------------------------ *
 * 测试缝：真实组件 + 真实 globals.css（不依赖 dev server / 后端 / 登录态）
 * ------------------------------------------------------------------ */

const HARNESS_SOURCE = `
import { createRoot, type Root } from "react-dom/client";
import { MessageIdentity } from "@/src/components/ui/message-identity";
import { ChatBubble } from "@/src/components/ui/chat-bubble";
import { ROLE_KEYS, type RoleKey } from "@/src/theme/tokens";

function Row({ role }: { role: string }) {
  const roleKey = role as RoleKey;
  return (
    <div data-fixture-role={role}>
      <MessageIdentity author={"作者-" + role} role={roleKey} time="12:00" />
    </div>
  );
}

function App() {
  return (
    <div>
      {ROLE_KEYS.map((r) => (
        <Row key={r} role={r} />
      ))}
      {/* 未知角色：必须安全回落 developer（头像/标签），不得抛异常 */}
      <Row role="__unknown_role__" />
      <div data-fixture-role="external">
        <MessageIdentity author="外部作者" role="developer" time="12:02" senderType="external" />
      </div>
      <div data-fixture-role="mention">
        <ChatBubble text="带高亮的消息" type="agent" author="作者" role="product" time="12:03" isMentionMe />
      </div>
      {/* 回归探针：故意硬编码 hex，必须被「computed == 变量解析值」这道门判失败 */}
      <span
        data-testid="hardcoded-probe"
        style={{
          display: "inline-block",
          color: "#059669",
          backgroundColor: "#ECFDF5",
          border: "1.5px solid #A7F3D0",
        }}
      />
    </div>
  );
}

let root: Root | null = null;
function render(): void {
  const host = document.getElementById("root");
  if (!host) throw new Error("role-theme harness: #root not found");
  if (!root) root = createRoot(host);
  root.render(<App />);
}

(window as unknown as { __roleTheme: { render: () => void } }).__roleTheme = { render };
`;

let harnessBundle: Promise<string> | null = null;

/** 用已安装的 esbuild-wasm 把测试缝入口打包成浏览器可执行 IIFE（不落盘、不新增依赖）。 */
function buildHarness(): Promise<string> {
  if (!harnessBundle) {
    harnessBundle = (async () => {
      const esbuild = await import("esbuild-wasm");
      const result = await esbuild.build({
        stdin: {
          contents: HARNESS_SOURCE,
          loader: "tsx",
          resolveDir: WEB_ROOT,
          sourcefile: "role-theme-harness.tsx",
        },
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "es2020",
        jsx: "automatic",
        charset: "utf8",
        define: {
          "process.env.NODE_ENV": '"production"',
          "process.env.NEXT_PUBLIC_API_BASE_URL": "undefined",
        },
        tsconfig: path.join(WEB_ROOT, "tsconfig.json"),
        logLevel: "silent",
      });
      const files = result.outputFiles ?? [];
      if (files.length === 0) throw new Error("role-theme harness: esbuild 无输出");
      return Buffer.from(files[0].contents).toString("utf8");
    })();
  }
  return harnessBundle;
}

async function mountHarness(page: Page): Promise<void> {
  const script = await buildHarness();
  const css = readFileSync(GLOBALS_CSS_PATH, "utf8");
  await page.setContent('<div id="root"></div><div id="probe-host"></div>');
  // 真实 globals.css：@import 不在样式表首位会被浏览器忽略（不会发请求），
  // 本测试只依赖其中的 :root/.dark 自定义属性。
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
    const api = (window as unknown as { __roleTheme?: { render: () => void } }).__roleTheme;
    if (!api) throw new Error("role-theme harness 未挂载");
    api.render();
  });
  await expect(page.locator('[data-fixture-role="product"] [data-testid="agent-avatar"]')).toHaveCount(1);
}

/** 用 html.dark 切主题（与应用 theme-store 写入同一位置）。 */
async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate((dark) => {
    const html = document.documentElement;
    if (dark) html.classList.add("dark");
    else html.classList.remove("dark");
  }, theme === "dark");
  await expect(page.locator("html")).toHaveClass(
    theme === "dark" ? /dark/ : /^(?!.*dark).*$/,
    { timeout: 5_000 },
  );
}

/**
 * 把 `var(--…)` 之类的 CSS 值解析成当前主题下的计算值。
 * 父元素放一个哨兵色：变量未定义/值非法时 color 会继承哨兵色，不会伪装成成功。
 */
async function resolveValue(page: Page, property: string, value: string): Promise<string> {
  return page.evaluate(
    (input: { property: string; value: string }) => {
      const host = document.createElement("div");
      host.style.color = "rgb(1, 2, 3)";
      const probe = document.createElement("div");
      probe.style.setProperty(input.property, input.value);
      host.appendChild(probe);
      document.body.appendChild(host);
      const out = window.getComputedStyle(probe).getPropertyValue(input.property);
      host.remove();
      return out;
    },
    { property, value },
  );
}

interface Measured {
  identityColor: string;
  avatarBg: string;
  avatarBorder: string;
}

async function measure(page: Page, fixtureRole: string): Promise<Measured> {
  const scope = page.locator(`[data-fixture-role="${fixtureRole}"]`);
  const identityColor = await scope
    .locator('[data-testid="chat-bubble-author"]')
    .evaluate((el) => window.getComputedStyle(el).color);
  const avatar = await scope.locator('[data-testid="agent-avatar"]').evaluate((el) => {
    const cs = window.getComputedStyle(el);
    return { bg: cs.backgroundColor, border: cs.borderTopColor };
  });
  return { identityColor, avatarBg: avatar.bg, avatarBorder: avatar.border };
}

interface Expected {
  color: string;
  bg: string;
  border: string;
}

async function expectedFor(page: Page, role: string): Promise<Expected> {
  return {
    color: await resolveValue(page, "color", expectedVar(role, "color")),
    bg: await resolveValue(page, "background-color", expectedVar(role, "bg")),
    border: await resolveValue(page, "border-top-color", expectedVar(role, "border")),
  };
}

/** B10 的核心门：计算值必须等于当前主题下变量的解析值。 */
function expectFollowsVariable(
  computed: string,
  resolved: string,
  label: string,
): void {
  expect(computed, `${label}: computed=${computed}  variable=${resolved}`).toBe(resolved);
}

const report: Array<Record<string, string>> = [];

test.afterAll(() => {
  if (report.length > 0) {
    console.log(`ROLE_THEME_VALUES ${JSON.stringify(report)}`);
  }
});

/* ------------------------------------------------------------------ *
 * 1) 源契约
 * ------------------------------------------------------------------ */
test("B10 源契约：roles/roleText 零硬编码 hex 且逐项引用 --color-role-* 变量", () => {
  const source = readFileSync(TOKENS_PATH, "utf8");
  const rolesSlice = tableSlice(source, "roles");
  const roleTextSlice = tableSlice(source, "roleText");

  // failing-first：改动前两张表各 6 个硬编码 hex → 此处红
  expect(rolesSlice, "roles 表不得含硬编码 hex").not.toMatch(HEX_RE);
  expect(roleTextSlice, "roleText 表不得含硬编码 hex").not.toMatch(HEX_RE);

  // 键序/条目数/标签不变
  expect([...ROLE_KEYS]).toEqual([...EXPECTED_ROLE_KEYS]);

  for (const role of EXPECTED_ROLE_KEYS) {
    expect(roles[role].label, `${role} label 不变`).toBe(EXPECTED_LABELS[role]);
    expect(roles[role].color, `${role}.color`).toBe(expectedVar(role, "color"));
    expect(roles[role].bg, `${role}.bg`).toBe(expectedVar(role, "bg"));
    expect(roles[role].border, `${role}.border`).toBe(expectedVar(role, "border"));
    expect(roleText[role], `${role} roleText`).toBe(expectedVar(role, "color"));
  }

  // 引用的变量必须在 globals.css 的 :root 与 .dark 双侧都存在（单一角色色源，不新增第二套）
  const css = readFileSync(GLOBALS_CSS_PATH, "utf8");
  const rootBlock = cssBlocks(css, ":root").join("\n");
  const darkBlock = cssBlocks(css, ".dark").join("\n");
  for (const role of EXPECTED_ROLE_KEYS) {
    for (const part of ["color", "bg", "border"] as const) {
      const name = `--color-role-${role.replace(/_/g, "-")}-${part}`;
      expect(rootBlock, `:root 缺 ${name}`).toContain(`${name}:`);
      expect(darkBlock, `.dark 缺 ${name}`).toContain(`${name}:`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 2) 计算值契约：light + dark 双主题
 * ------------------------------------------------------------------ */
test("B10 计算值：身份文字/头像底色/边框在 light 与 dark 均等于变量解析值", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await mountHarness(page);

  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    for (const role of EXPECTED_ROLE_KEYS) {
      const expected = await expectedFor(page, role);
      const actual = await measure(page, role);

      report.push({
        theme,
        role,
        identityColor: actual.identityColor,
        avatarBg: actual.avatarBg,
        avatarBorder: actual.avatarBorder,
        varColor: expected.color,
        varBg: expected.bg,
        varBorder: expected.border,
      });

      expectFollowsVariable(actual.identityColor, expected.color, `${theme}/${role} 身份文字`);
      expectFollowsVariable(actual.avatarBg, expected.bg, `${theme}/${role} 头像底色`);
      expectFollowsVariable(actual.avatarBorder, expected.border, `${theme}/${role} 头像边框`);
    }
  }

  // 主题真的切换了：每个角色三组解析值在 light/dark 下都必须不同
  for (const role of EXPECTED_ROLE_KEYS) {
    const light = await (async () => {
      await setTheme(page, "light");
      return expectedFor(page, role);
    })();
    const dark = await (async () => {
      await setTheme(page, "dark");
      return expectedFor(page, role);
    })();
    expect(dark.color, `${role} color 随主题变化`).not.toBe(light.color);
    expect(dark.bg, `${role} bg 随主题变化`).not.toBe(light.bg);
    expect(dark.border, `${role} border 随主题变化`).not.toBe(light.border);
  }
});

/* ------------------------------------------------------------------ *
 * 3) 未知角色回落 + 徽标保持
 * ------------------------------------------------------------------ */
test("B10 未知角色安全回落 developer，external/mention 徽标保持", async ({ page }) => {
  test.setTimeout(120_000);
  await mountHarness(page);

  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    const developer = await expectedFor(page, "developer");

    // 头像：developer 变量（未知 key 不渲染 undefined/透明）
    const unknownAvatar = page.locator('[data-fixture-role="__unknown_role__"] [data-testid="agent-avatar"]');
    await expect(unknownAvatar).toHaveCount(1);
    const unknown = await measure(page, "__unknown_role__");
    expectFollowsVariable(unknown.avatarBg, developer.bg, `${theme}/未知角色头像底色`);
    expectFollowsVariable(unknown.avatarBorder, developer.border, `${theme}/未知角色头像边框`);

    // 角色标签回落「开发者」，身份文字仍是已定义的主题色（不为 undefined/继承）
    await expect(
      page.locator('[data-fixture-role="__unknown_role__"] [data-testid="message-identity-role"]'),
    ).toContainText(EXPECTED_LABELS.developer);
    expect(unknown.identityColor).toMatch(/^(rgb|rgba)\(/);

    // external 徽标仍在，且背景跟随中性变量
    await expect(page.locator('[data-fixture-role="external"] [data-testid="external-channel-badge"]')).toHaveCount(1);
    const externalBg = await page
      .locator('[data-fixture-role="external"] [data-testid="external-channel-badge"]')
      .evaluate((el) => window.getComputedStyle(el).backgroundColor);
    expectFollowsVariable(
      externalBg,
      await resolveValue(page, "background-color", "var(--color-neutral-100)"),
      `${theme}/external 徽标背景`,
    );

    // mention(@你) 徽标仍在，且三色跟随 mention 变量
    const mention = page.locator('[data-fixture-role="mention"] [data-testid="mention-me-badge"]');
    await expect(mention).toHaveCount(1);
    const mentionStyles = await mention.evaluate((el) => {
      const cs = window.getComputedStyle(el);
      return { color: cs.color, bg: cs.backgroundColor, border: cs.borderTopColor };
    });
    expectFollowsVariable(
      mentionStyles.color,
      await resolveValue(page, "color", "var(--color-mention-text)"),
      `${theme}/mention 文字`,
    );
    expectFollowsVariable(
      mentionStyles.bg,
      await resolveValue(page, "background-color", "var(--color-mention-bg)"),
      `${theme}/mention 背景`,
    );
    expectFollowsVariable(
      mentionStyles.border,
      await resolveValue(page, "border-top-color", "var(--color-mention-border)"),
      `${theme}/mention 边框`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * 4) 回归：故意硬编码 hex 必须被判失败（门要有牙）
 * ------------------------------------------------------------------ */
test("B10 回归：硬编码 hex 无法通过 computed == 变量解析值", async ({ page }) => {
  test.setTimeout(120_000);
  await mountHarness(page);
  await setTheme(page, "dark");

  const probe = page.locator('[data-testid="hardcoded-probe"]');
  await expect(probe).toHaveCount(1);
  const probeStyles = await probe.evaluate((el) => {
    const cs = window.getComputedStyle(el);
    return { color: cs.color, bg: cs.backgroundColor, border: cs.borderTopColor };
  });

  // 探针确实渲染成了改动前的浅色硬编码 hex
  expect(probeStyles.color).toBe("rgb(5, 150, 105)"); // #059669
  expect(probeStyles.bg).toBe("rgb(236, 253, 245)"); // #ECFDF5

  const developer = await expectedFor(page, "developer");
  // 与 dark 变量解析值不同 → 必须被核心门判失败
  expect(probeStyles.color).not.toBe(developer.color);
  expect(() => expectFollowsVariable(probeStyles.color, developer.color, "回归探针文字")).toThrow();
  expect(() => expectFollowsVariable(probeStyles.bg, developer.bg, "回归探针底色")).toThrow();
  expect(() => expectFollowsVariable(probeStyles.border, developer.border, "回归探针边框")).toThrow();
});
