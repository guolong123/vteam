import { test, expect } from "@playwright/test";
import { authorRoleDisplay } from "./author-role-display";

/**
 * author-role-display · B5 author 与角色并列纯逻辑门（lib-unit）
 * =============================================
 * chat-ux-hierarchy-and-streaming 复选框 7 的展示侧契约：
 * 已解析 author 与角色标签并列、同值去重、未解析时只回落角色标签。
 *
 * 运行：`npx playwright test lib/author-role-display.spec.ts --project=lib-unit`
 * 失败语义：改动前身份行只有 `author ?? roleLabel` 二选一 → 本模块不存在，在此红。
 */

test("B5 已解析 author 且与角色标签不同：主文本 author + 并列角色标签", () => {
  expect(authorRoleDisplay("Dev-1", "开发者")).toEqual({ primary: "Dev-1", roleLabel: "开发者" });
  expect(authorRoleDisplay("Test-1", "测试")).toEqual({ primary: "Test-1", roleLabel: "测试" });
  expect(authorRoleDisplay("  Arch-1 ", "架构师")).toEqual({ primary: "Arch-1", roleLabel: "架构师" });
});

test("B5 author 与角色标签同值：去重，只展示一次", () => {
  expect(authorRoleDisplay("开发者", "开发者")).toEqual({ primary: "开发者", roleLabel: null });
  expect(authorRoleDisplay("测试", "测试")).toEqual({ primary: "测试", roleLabel: null });
  // 两侧空白差异按 trim 后比较，不产生第二份标签
  expect(authorRoleDisplay(" 开发者 ", "开发者")).toEqual({ primary: "开发者", roleLabel: null });
});

test("B5 author 未解析：回落角色标签且不并列第二份", () => {
  expect(authorRoleDisplay(undefined, "计划员")).toEqual({ primary: "计划员", roleLabel: null });
  expect(authorRoleDisplay("", "开发者")).toEqual({ primary: "开发者", roleLabel: null });
  expect(authorRoleDisplay("   ", "开发者")).toEqual({ primary: "开发者", roleLabel: null });
  // 空角色标签是坏数据：不得并列出空串，主文本保持 author
  expect(authorRoleDisplay("Dev-1", "")).toEqual({ primary: "Dev-1", roleLabel: null });
});
