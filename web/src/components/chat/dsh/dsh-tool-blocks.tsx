/**
 * DshToolBlocks：工具专用视图（read / grep / bash / 编辑）+ 文案
 * =============================================
 * 复用 `@deepseek-ai/dsh-client-ui-primitives` 里 DSH 自己用的四个视图组件
 * （`ReadBlock` / `SearchBlock` / `TerminalBlock` / `DiffBlock`），把 vteam 的
 * 工具 I/O 解析成它们的 props —— 与 DSH 的观感逐像素一致，而不是自己画。
 *
 * ## 解析的是**实测**到的真实格式（不是猜的）
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
 * `bash`：入参 `{command, description}`、输出是裸 stdout。
 *
 * 编辑类（write/edit）没有可观察的输出格式，但**入参本身就带全部信息**
 * （`file_path` + `old_string`/`new_string` 或 `content`），故 diff 从入参构造。
 *
 * 任何解析失败都回退到文本代码块 —— 不因为格式变动就丢内容。
 *
 * @module components/chat/dsh/dsh-tool-blocks
 */
"use client";

import {
  CodeBlock,
  DiffBlock,
  ReadBlock,
  SearchBlock,
  TerminalBlock,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  CodeToolbarLabels,
  DiffBlockLabels,
  DiffHunk,
  ReadBlockLabels,
  ReadBlockLine,
  SearchBlockLabels,
  SearchFileGroup,
  TerminalBlockLabels,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { DSH_COMMON_ZH } from "./dsh-labels";
import {
  commandOf,
  diffOfInput,
  langOfPath,
  parseGrepOutput,
  parseReadOutput,
  unwrapContent,
  viewKindOf,
} from "./dsh-tool-parse";

/** 代码卡的通用工具条文案（语言名兜底 / 自动换行）。 */
export const CODE_TOOLBAR_LABELS: CodeToolbarLabels = {
  codeLabel: DSH_COMMON_ZH.codeBlockTitle,
  wrapLabel: DSH_COMMON_ZH.codeBlockWrap,
  unwrapLabel: DSH_COMMON_ZH.codeBlockUnwrap,
};

/** 折叠/展开的一组文案（四个块共用同一措辞，取自 DSH zh 字典）。 */
const collapseLabels = {
  collapseAria: "收起",
  collapse: "收起",
} as const;

/** `read` 视图文案（DSH `read.*`）。 */
export const READ_LABELS: ReadBlockLabels = {
  ...CODE_TOOLBAR_LABELS,
  ...collapseLabels,
  copy: DSH_COMMON_ZH.copy,
  copied: DSH_COMMON_ZH.copied,
  window: (shown, total) => `显示 ${shown} / ${total} 行`,
  expandAria: (hidden) => `展开其余 ${hidden} 行`,
  expand: (hidden) => `… 其余 ${hidden} 行`,
};

/** `diff` 视图文案（DSH `diff.*`）。 */
export const DIFF_LABELS: DiffBlockLabels = {
  ...CODE_TOOLBAR_LABELS,
  ...collapseLabels,
  copy: DSH_COMMON_ZH.copy,
  copied: DSH_COMMON_ZH.copied,
  expandAria: (hidden) => `展开其余 ${hidden} 行差异`,
  expand: (hidden) => `… 其余 ${hidden} 行`,
};

/** `search` 视图文案（DSH `search.*`）。 */
export const SEARCH_LABELS: SearchBlockLabels = {
  ...collapseLabels,
  copy: DSH_COMMON_ZH.copy,
  copied: DSH_COMMON_ZH.copied,
  noResults: "无结果",
  pathsSummary: (shown) => `${shown} 个路径`,
  matchesSummary: (shown, _total, files) => `${shown} 处匹配 · ${files} 个文件`,
  expandAria: (hidden) => `展开其余 ${hidden} 行结果`,
  expand: (hidden) => `… 其余 ${hidden} 行`,
};

/** 终端视图文案（DSH `terminal.*`）。 */
export const TERMINAL_LABELS: TerminalBlockLabels = {
  ...collapseLabels,
  copy: DSH_COMMON_ZH.copy,
  copied: DSH_COMMON_ZH.copied,
  commandLine: (n) => `命令第 ${n} 行`,
  exitCode: (code) => `退出码 ${code}`,
  signal: (signal) => `信号 ${signal}`,
  noExitCode: "未正常退出",
  running: "运行中",
  failed: "失败",
  done: "已完成",
  noOutput: "无输出",
  expandAria: (hidden) => `展开其余 ${hidden} 行输出`,
  expand: (hidden) => `… 其余 ${hidden} 行`,
};

// 解析层被抽到 dsh-tool-parse.ts（无 React 依赖，可单测）；这里再导出一次，
// 让调用方只依赖渲染模块即可。
export {
  commandOf,
  diffOfInput,
  langOfPath,
  parseGrepOutput,
  parseReadOutput,
  unwrapContent,
  viewKindOf,
} from "./dsh-tool-parse";

export interface DshToolBlocksProps {
  /** 工具名（`vteam_*` / `read` / `bash` …）。 */
  name: string;
  input: string;
  output: string;
}

/**
 * 工具输出的专用视图。
 *
 * 解析不出来就退回 `CodeBlock`（与改造前一致，绝不丢内容）。
 */
export function DshToolBlocks({ name, input, output }: DshToolBlocksProps) {
  const kind = viewKindOf(name, output);

  if (kind === "terminal") {
    const command = commandOf(input);
    if (command !== null) {
      return (
        <TerminalBlock
          command={command}
          output={output}
          labels={TERMINAL_LABELS}
        />
      );
    }
  }

  if (kind === "read") {
    const parsed = parseReadOutput(output);
    if (parsed !== null) {
      return (
        <ReadBlock
          label={parsed.path}
          lines={parsed.lines}
          totalLines={parsed.totalLines}
          lang={langOfPath(parsed.path)}
          labels={READ_LABELS}
        />
      );
    }
  }

  if (kind === "search") {
    const parsed = parseGrepOutput(output);
    if (parsed !== null) {
      return (
        <SearchBlock
          kind="matches"
          files={parsed.files}
          total={parsed.total}
          truncated={parsed.truncated}
          labels={SEARCH_LABELS}
        />
      );
    }
  }

  if (kind === "diff") {
    const diffs = diffOfInput(input);
    if (diffs !== null) {
      return <DiffBlock diffs={diffs} labels={DIFF_LABELS} />;
    }
  }

  if (output.length === 0) return null;
  return (
    <CodeBlock
      code={unwrapContent(output).slice(0, 2000)}
      showHeader={false}
      copyLabel={DSH_COMMON_ZH.copy}
      copiedLabel={DSH_COMMON_ZH.copied}
    />
  );
}
