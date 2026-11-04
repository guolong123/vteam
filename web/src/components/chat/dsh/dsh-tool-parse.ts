/**
 * dsh-tool-parse：工具 I/O 的**纯解析层**（无 React、无副作用）
 * =============================================
 * 从 `dsh-tool-blocks.tsx` 抽出来，目的有二：
 * 1. 解析逻辑可以**单独单测**（引 React 组件的模块在 node 里跑不起来）；
 * 2. 渲染层只负责「选组件 + 传 props」，解析口径集中在一处。
 *
 * 解析的是 **vteam 实测到的真实格式**，不是按文档猜的。样本：
 *
 * `read` 文本文件：
 * ```
 * <path>/data/…/pelican-bike.html</path>
 * <type>file</type>
 * <content>
 * 1: <!DOCTYPE html>
 * 2: <html lang="zh-CN">
 * </content>
 * ```
 *
 * `grep`：
 * ```
 * Found 4 matches
 *
 * teams/tm_0000000002/pelican-carry-bike.html
 * Line 236:       <g id="pelicanBody">
 * ```
 *
 * `bash` 入参：`{"description":"…","command":"ls -la /data/…"}`，输出是裸 stdout。
 *
 * @module components/chat/dsh/dsh-tool-parse
 */

/** read 视图的一行（与 primitives 的 `ReadBlockLine` 结构兼容）。 */
export interface ParsedReadLine {
  /** 文件里的 1-based 行号。 */
  number: number;
  /** 该行文本（已去掉 `N: ` 前缀）。 */
  text: string;
}

/** read 文本回执的解析结果。 */
export interface ParsedRead {
  path: string;
  lines: ParsedReadLine[];
  /** 已知总行数（DSH 不给精确值，用可见的最大行号兜底）。 */
  totalLines: number;
}

/** 一个文件的命中行（与 primitives 的 `SearchBlockLineMatch` 兼容）。 */
export interface ParsedSearchMatch {
  lineNumber: number;
  line: string;
}

/** 一个文件的命中分组（与 primitives 的 `SearchFileGroup` 兼容）。 */
export interface ParsedSearchFile {
  path: string;
  matches: ParsedSearchMatch[];
}

/** grep 回执的解析结果。 */
export interface ParsedSearch {
  files: ParsedSearchFile[];
  /** 工具报的总命中数（`Found N matches`）。 */
  total: number;
  truncated: boolean;
}

/** 一个文件改动（与 primitives 的 `DiffHunk` 结构兼容）。 */
export interface ParsedDiffHunk {
  path: string;
  oldText: string | null;
  newText: string;
}

/** 扩展名 → shiki 语言 id。 */
const LANG_BY_EXT: Record<string, string> = {
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  md: 'markdown',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  sh: 'shellscript',
  bash: 'shellscript',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
};

/** 路径 → 语言 id（认不出返回 undefined = 纯文本）。 */
export function langOfPath(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return LANG_BY_EXT[ext];
}

/**
 * 解析 DSH `read` 的**文本**回执。
 *
 * 只认 `<type>file</type>`；`<type>image</type>` 由上层走缩略图，不在这里。
 * 行内容本身可能含 `<content>` 字样，故按**外壳位置**切：第一个 `<content>`
 * 到最后一个 `</content>` 之间才是正文。
 */
export function parseReadOutput(output: string): ParsedRead | null {
  const typeHit = /<type>\s*([\s\S]*?)\s*<\/type>/i.exec(output);
  if (typeHit === null) return null;
  if (!(typeHit[1] ?? '').toLowerCase().includes('file')) return null;

  const pathHit = /<path>\s*([\s\S]*?)\s*<\/path>/i.exec(output);
  const open = output.search(/<content>/i);
  const close = output.lastIndexOf('</content>');
  if (open === -1 || close === -1 || close <= open) return null;

  const body = output.slice(open + '<content>'.length, close);
  const lines: ParsedReadLine[] = [];
  for (const rawLine of body.split('\n')) {
    const hit = /^\s*(\d+):\s?(.*)$/.exec(rawLine);
    if (hit === null) continue;
    lines.push({ number: Number(hit[1]), text: hit[2] ?? '' });
  }
  if (lines.length === 0) return null;
  const maxNumber = lines.reduce((max, l) => (l.number > max ? l.number : max), 0);
  return {
    path: pathHit === null ? '' : (pathHit[1] ?? '').trim(),
    lines,
    totalLines: maxNumber,
  };
}

/**
 * 解析 `grep` 回执：
 * ```
 * Found 4 matches
 *
 * <file path>
 * Line 236: <text>
 * ```
 */
export function parseGrepOutput(output: string): ParsedSearch | null {
  const headHit = /^\s*Found\s+(\d+)\s+match/i.exec(output);
  if (headHit === null) return null;
  const total = Number(headHit[1]);
  const files: ParsedSearchFile[] = [];
  let current: ParsedSearchFile | null = null;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '') continue;
    if (/^\s*Found\s+\d+\s+match/i.test(line)) continue;
    const matchHit = /^\s*Line\s+(\d+):\s?(.*)$/i.exec(line);
    if (matchHit !== null) {
      if (current === null) continue;
      current.matches.push({ lineNumber: Number(matchHit[1]), line: matchHit[2] ?? '' });
      continue;
    }
    // 非 Line 行 = 新的文件分组标题
    current = { path: line.trim(), matches: [] };
    files.push(current);
  }
  const kept = files.filter((f) => f.matches.length > 0);
  if (kept.length === 0) return null;
  const shown = kept.reduce((n, f) => n + f.matches.length, 0);
  return { files: kept, total, truncated: total > shown };
}

/**
 * 解包 DSH 读文件回执里的 `<content>` 正文。
 *
 * ⚠️ **必须由解析层自己做**：`parseReadOutput` 依赖 `<type>file</type>` 外壳判断
 * "这是 read 回执"，调用方若先解包再传进来，它认不出、会退化成纯文本（实测踩过）。
 */
export function unwrapContent(output: string): string {
  const open = output.search(/<content>/i);
  const close = output.lastIndexOf('</content>');
  if (open === -1 || close === -1 || close <= open) return output;
  return output.slice(open + '<content>'.length, close).replace(/^\n+|\n+$/g, '');
}

/** 把入参字符串解析成对象（非 JSON 对象返回 null）。 */
function asJsonObject(input: string): Record<string, unknown> | null {
  const t = input.trim();
  if (!t.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(t);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 入参里的 shell 命令（bash/pwsh 等）；没有返回 null。 */
export function commandOf(input: string): string | null {
  const obj = asJsonObject(input);
  if (obj === null) return null;
  const cmd = obj.command ?? obj.cmd;
  return typeof cmd === 'string' && cmd.trim().length > 0 ? cmd : null;
}

/**
 * 编辑类工具的 diff（**从入参构造**，不依赖输出格式）。
 *
 * - `edit` / `str_replace`：`file_path` + `old_string` / `new_string`；
 * - `write`：`file_path` + `content`（无旧内容 → oldText=null）；
 * - 多编辑：`edits: [{old_string,new_string}]` 逐条成 hunk。
 */
export function diffOfInput(input: string): ParsedDiffHunk[] | null {
  const obj = asJsonObject(input);
  if (obj === null) return null;
  const path =
    typeof obj.file_path === 'string'
      ? obj.file_path
      : typeof obj.path === 'string'
        ? obj.path
        : '';

  const edits = obj.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    const hunks: ParsedDiffHunk[] = [];
    for (const e of edits) {
      if (e === null || typeof e !== 'object') continue;
      const rec = e as Record<string, unknown>;
      const oldText = typeof rec.old_string === 'string' ? rec.old_string : null;
      const newText = typeof rec.new_string === 'string' ? rec.new_string : '';
      if (oldText === null && newText === '') continue;
      hunks.push({ path, oldText, newText });
    }
    return hunks.length > 0 ? hunks : null;
  }

  const oldString = typeof obj.old_string === 'string' ? obj.old_string : null;
  const newString = typeof obj.new_string === 'string' ? obj.new_string : null;
  if (oldString !== null || newString !== null) {
    return [{ path, oldText: oldString, newText: newString ?? '' }];
  }
  const content = typeof obj.content === 'string' ? obj.content : null;
  if (content !== null) return [{ path, oldText: null, newText: content }];
  return null;
}

/** 工具名分类（决定用哪个专用视图）。 */
export type ToolViewKind = 'terminal' | 'read' | 'search' | 'diff' | 'text';

/**
 * 工具名 + 输出 → 视图类型。
 *
 * 只做「按名字分类」；能否真正解析由各解析器决定（解析失败一律回退文本）。
 */
export function viewKindOf(name: string, output: string): ToolViewKind {
  const n = name.toLowerCase();
  if (/(^|_)(bash|pwsh|shell|run_command)$/.test(n)) return 'terminal';
  if (/(^|_)(grep|search|glob|find)$/.test(n)) return 'search';
  if (/(^|_)(write|edit)$/.test(n) || n.includes('str_replace')) return 'diff';
  if (/(^|_)(read|read_image|cat)$/.test(n)) {
    return parseReadOutput(output) !== null ? 'read' : 'text';
  }
  // 名字认不出时按输出形态兜底
  if (parseReadOutput(output) !== null) return 'read';
  if (parseGrepOutput(output) !== null) return 'search';
  return 'text';
}
