import { diffLines } from "diff";

/** 编辑入参需要完整 JSON 才能解析；服务端已将每个 old/new 字符串限制到约 2KB。 */
export const EDIT_DIFF_INPUT_MAX_CHARS = 32 * 1024;

/** 工具名是否为编辑/新建文件类（与 Diff 视图分类口径一致）。 */
export function isEditToolName(name: string): boolean {
  return /(^|_)(write|edit)$/i.test(name) || /str_replace/i.test(name);
}

/** 一次编辑 hunks（与 DSH DiffBlock 的结构兼容）。 */
export interface EditDiffHunk {
  path: string;
  /** 旧片段；null 表示新建文件，没有旧内容。 */
  oldText: string | null;
  /** 新片段。 */
  newText: string;
}

export type EditDiffRowKind = "context" | "add" | "remove";

export interface EditDiffRow {
  kind: EditDiffRowKind;
  text: string;
  /** 片段内行号：删除取旧行，新增/上下文取新行。 */
  lineNumber: number;
  oldLine: number | null;
  newLine: number | null;
}

export interface EditDiffGroup {
  path: string;
  rows: EditDiffRow[];
  added: number;
  removed: number;
}

function asJsonObject(input: string): Record<string, unknown> | null {
  const text = input.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * 从编辑类工具入参构造 diff。
 *
 * 同时兼容两套真实字段：
 * - vteam / DSH：`file_path` + `old_string` / `new_string`
 * - OpenCode：`filePath` + `oldString` / `newString`
 */
export function diffOfInput(input: string): EditDiffHunk[] | null {
  const obj = asJsonObject(input);
  if (obj === null) return null;
  const path = stringField(obj, "file_path", "filePath", "path") ?? "";

  const edits = obj.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    const hunks: EditDiffHunk[] = [];
    for (const value of edits) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const edit = value as Record<string, unknown>;
      const oldText = stringField(edit, "old_string", "oldString");
      const newText = stringField(edit, "new_string", "newString") ?? "";
      if (oldText === null && newText === "") continue;
      hunks.push({ path, oldText, newText });
    }
    return hunks.length > 0 ? hunks : null;
  }

  const oldText = stringField(obj, "old_string", "oldString");
  const newText = stringField(obj, "new_string", "newString");
  if (oldText !== null || newText !== null) {
    return [{ path, oldText, newText: newText ?? "" }];
  }

  const content = stringField(obj, "content");
  if (content !== null) return [{ path, oldText: null, newText: content }];
  return null;
}

/** 尾部换行是行终止符，不额外产生一行；中间空行保留。 */
function contentLines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** diff 算法需要稳定的行终止符；空文本仍保持零行。 */
function withLineTerminator(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

/** 把旧/新片段转成带本地行号的上下文、删除、新增行。 */
export function buildEditDiffGroups(hunks: EditDiffHunk[]): EditDiffGroup[] {
  return hunks.map((hunk) => {
    const rows: EditDiffRow[] = [];
    let oldLine = 1;
    let newLine = 1;
    let added = 0;
    let removed = 0;

    for (const change of diffLines(
      withLineTerminator(hunk.oldText ?? ""),
      withLineTerminator(hunk.newText),
    )) {
      const lines = contentLines(change.value);
      if (change.removed) {
        for (const text of lines) {
          rows.push({
            kind: "remove",
            text,
            lineNumber: oldLine,
            oldLine,
            newLine: null,
          });
          oldLine += 1;
          removed += 1;
        }
        continue;
      }
      if (change.added) {
        for (const text of lines) {
          rows.push({
            kind: "add",
            text,
            lineNumber: newLine,
            oldLine: null,
            newLine,
          });
          newLine += 1;
          added += 1;
        }
        continue;
      }
      for (const text of lines) {
        rows.push({
          kind: "context",
          text,
          lineNumber: newLine,
          oldLine,
          newLine,
        });
        oldLine += 1;
        newLine += 1;
      }
    }

    return { path: hunk.path, rows, added, removed };
  });
}

export function editDiffTotals(groups: EditDiffGroup[]): { added: number; removed: number } {
  return groups.reduce(
    (total, group) => ({
      added: total.added + group.added,
      removed: total.removed + group.removed,
    }),
    { added: 0, removed: 0 },
  );
}
