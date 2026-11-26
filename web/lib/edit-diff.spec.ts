import { test, expect } from "@playwright/test";
import {
  buildEditDiffGroups,
  diffOfInput,
  editDiffTotals,
  isEditToolName,
} from "./edit-diff";

test("编辑类工具识别与 Diff 视图分类一致", () => {
  expect(isEditToolName("edit")).toBe(true);
  expect(isEditToolName("mcp__opencode__edit")).toBe(true);
  expect(isEditToolName("write")).toBe(true);
  expect(isEditToolName("str_replace")).toBe(true);
  expect(isEditToolName("bash")).toBe(false);
  expect(isEditToolName("group_post")).toBe(false);
});

test.describe("diffOfInput", () => {
  test("兼容 OpenCode path + oldString/newString", () => {
    expect(
      diffOfInput(
        JSON.stringify({
          path: "web/src/app/page.tsx",
          oldString: "const value = 1;",
          newString: "const value = 2;",
          replaceAll: false,
        }),
      ),
    ).toEqual([
      {
        path: "web/src/app/page.tsx",
        oldText: "const value = 1;",
        newText: "const value = 2;",
      },
    ]);
  });

  test("兼容 DSH file_path + old_string/new_string 与多编辑", () => {
    expect(
      diffOfInput(
        JSON.stringify({
          file_path: "/a.ts",
          edits: [
            { old_string: "a", new_string: "b" },
            { old_string: "c", new_string: "d" },
          ],
        }),
      ),
    ).toEqual([
      { path: "/a.ts", oldText: "a", newText: "b" },
      { path: "/a.ts", oldText: "c", newText: "d" },
    ]);
  });

  test("write 新文件没有旧内容", () => {
    expect(diffOfInput('{"filePath":"/a.ts","content":"hello"}')).toEqual([
      { path: "/a.ts", oldText: null, newText: "hello" },
    ]);
  });

  test("非编辑 JSON 不误报", () => {
    expect(diffOfInput('{"q":"群消息正文"}')).toBeNull();
    expect(diffOfInput("not json")).toBeNull();
  });
});

test.describe("buildEditDiffGroups", () => {
  test("替换生成上下文、删除、新增行与本地行号", () => {
    const groups = buildEditDiffGroups([
      { path: "a.ts", oldText: "one\ntwo\nthree", newText: "one\nTWO\nthree\nfour" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toEqual([
      { kind: "context", text: "one", lineNumber: 1, oldLine: 1, newLine: 1 },
      { kind: "remove", text: "two", lineNumber: 2, oldLine: 2, newLine: null },
      { kind: "add", text: "TWO", lineNumber: 2, oldLine: null, newLine: 2 },
      { kind: "context", text: "three", lineNumber: 3, oldLine: 3, newLine: 3 },
      { kind: "add", text: "four", lineNumber: 4, oldLine: null, newLine: 4 },
    ]);
    expect(editDiffTotals(groups)).toEqual({ added: 2, removed: 1 });
  });

  test("新增文件按新增行计数，尾部换行不产生空行", () => {
    const groups = buildEditDiffGroups([{ path: "a.ts", oldText: null, newText: "a\nb\n" }]);
    expect(groups[0].rows.map((row) => row.text)).toEqual(["a", "b"]);
    expect(editDiffTotals(groups)).toEqual({ added: 2, removed: 0 });
  });
});
