import { test, expect } from "@playwright/test";
import {
  buildSecretReply,
  canSubmitSecret,
  secretReasonOf,
  secretTemplateOf,
  secretVariablesOf,
} from "./secret-question";

/**
 * secret-question · sensitive-command-tool todo 7 纯逻辑门（lib-unit）
 * =============================================
 * 弹窗（src/components/chat/question-modal.tsx）只做渲染，全部判定走本模块：
 * 变量元数据归一、必填门控、确认/取消提交体。这里锁三类对抗面：
 *   - malformed_input：变量元数据缺失/非数组/无 name/重名/坏 secret 类型不炸、不多造字段；
 *   - misleading_success_output：断言**提交体本身**（不是「按钮可见」）；
 *   - secrets：取消路径即使已填值也只发 `{secrets:null}`，确认只带已声明 key 的原样值。
 *
 * 运行：`npx playwright test lib/secret-question.spec.ts --project=lib-unit`
 * 失败语义：本模块为 todo 7 新增 → 改动前 import 即红（Cannot find module './secret-question'）。
 */

const CONTENT = {
  source: "secret_input",
  template: "mysql -h db.internal -u root -p\"{{DB_PASSWORD}}\" < backup.sql",
  variables: [
    { name: "DB_PASSWORD", secret: true },
    { name: "REGION", secret: false },
  ],
  reason: "夜间备份需要数据库口令",
};

test("变量清单按声明顺序归一，secret 标记透传", () => {
  expect(secretVariablesOf(CONTENT)).toEqual([
    { name: "DB_PASSWORD", secret: true },
    { name: "REGION", secret: false },
  ]);
});

test("malformed：content/variables 缺失或形态错误 → 空清单且不抛错", () => {
  expect(secretVariablesOf(undefined)).toEqual([]);
  expect(secretVariablesOf(null)).toEqual([]);
  expect(secretVariablesOf("secret_input")).toEqual([]);
  expect(secretVariablesOf({})).toEqual([]);
  expect(secretVariablesOf({ variables: null })).toEqual([]);
  expect(secretVariablesOf({ variables: "DB_PASSWORD" })).toEqual([]);
  expect(secretVariablesOf({ variables: { name: "DB_PASSWORD" } })).toEqual([]);
});

test("malformed：无 name / name 非字符串 / 空白 name 的条目被丢弃（server 同口径只认字符串 name）", () => {
  expect(
    secretVariablesOf({
      variables: [null, "DB_PASSWORD", 42, {}, { secret: true }, { name: "" }, { name: "   " }],
    }),
  ).toEqual([]);
});

test("malformed：重名保留首条，secret 非布尔按敏感处理（默认遮蔽）", () => {
  expect(
    secretVariablesOf({
      variables: [
        { name: "TOKEN", secret: false },
        { name: "TOKEN", secret: true },
        { name: "PLAIN", secret: "yes" },
        { name: "GAP", secret: undefined },
      ],
    }),
  ).toEqual([
    { name: "TOKEN", secret: false },
    { name: "PLAIN", secret: true },
    { name: "GAP", secret: true },
  ]);
});

test("模板与原因提取：非字符串/空串归一为 空串 / null（UI 不渲染原因行）", () => {
  expect(secretTemplateOf(CONTENT)).toContain("{{DB_PASSWORD}}");
  expect(secretTemplateOf({ template: 42 })).toBe("");
  expect(secretTemplateOf({})).toBe("");
  expect(secretTemplateOf(null)).toBe("");
  expect(secretReasonOf(CONTENT)).toBe("夜间备份需要数据库口令");
  expect(secretReasonOf({ reason: "" })).toBeNull();
  expect(secretReasonOf({ reason: "   " })).toBeNull();
  expect(secretReasonOf({ reason: 7 })).toBeNull();
  expect(secretReasonOf(undefined)).toBeNull();
});

test("必填门控：任一已声明变量未填/全空白 → 禁止提交；全填 → 放行", () => {
  const fields = secretVariablesOf(CONTENT);
  expect(canSubmitSecret(fields, {})).toBe(false);
  expect(canSubmitSecret(fields, { DB_PASSWORD: "s3cr3t-A9f" })).toBe(false);
  expect(canSubmitSecret(fields, { DB_PASSWORD: "s3cr3t-A9f", REGION: "  " })).toBe(false);
  expect(canSubmitSecret(fields, { DB_PASSWORD: "s3cr3t-A9f", REGION: "cn-north" })).toBe(true);
});

test("必填门控：无变量元数据（畸形/空）→ 放行（提交 `{secrets:{}}` 对 server 合法）", () => {
  expect(canSubmitSecret([], {})).toBe(true);
  expect(canSubmitSecret(secretVariablesOf({}), {})).toBe(true);
});

test("确认提交体：只带已声明 key 的原样值，未声明 key 被裁掉，值不 trim", () => {
  const fields = secretVariablesOf(CONTENT);
  expect(
    buildSecretReply("submit", fields, {
      DB_PASSWORD: "s3cr3t-A9f",
      REGION: " cn-north ",
      INJECTED: "not-declared",
    }),
  ).toEqual({
    secrets: { DB_PASSWORD: "s3cr3t-A9f", REGION: " cn-north " },
  });
});

test("确认提交体：无已声明变量 → `{secrets:{}}`（不是 null，null 会被 server 当取消）", () => {
  expect(buildSecretReply("submit", [], {})).toEqual({ secrets: {} });
});

test("取消提交体：恒为 `{secrets:null}`，已填值绝不外带", () => {
  const fields = secretVariablesOf(CONTENT);
  expect(buildSecretReply("cancel", fields, { DB_PASSWORD: "s3cr3t-A9f", REGION: "cn" })).toEqual({
    secrets: null,
  });
  expect(buildSecretReply("cancel", [], {})).toEqual({ secrets: null });
});

test("取消提交体序列化后不含 sentinel（不进 URL / body / 日志的前置证明）", () => {
  const fields = secretVariablesOf(CONTENT);
  const cancel = buildSecretReply("cancel", fields, { DB_PASSWORD: "s3cr3t-A9f" });
  expect(JSON.stringify(cancel)).not.toContain("s3cr3t-A9f");
  expect(cancel.secrets).toBeNull();
});
