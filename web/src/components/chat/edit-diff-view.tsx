"use client";

import { useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  buildEditDiffGroups,
  editDiffTotals,
  type EditDiffGroup,
  type EditDiffHunk,
} from "@/lib/edit-diff";
import { fontFamily } from "@/src/theme/tokens";

const COLORS = {
  surface: "#0d1117",
  header: "#161b22",
  border: "#30363d",
  text: "#c9d1d9",
  muted: "#8b949e",
  lineNumber: "#6e7681",
  addBg: "rgba(46, 160, 67, 0.18)",
  addText: "#7ee787",
  removeBg: "rgba(248, 81, 73, 0.16)",
  removeText: "#ffa198",
  keyword: "#d2a8ff",
  string: "#a5d6ff",
  number: "#79c0ff",
  function: "#7ee787",
  tag: "#7ee787",
  comment: "#8b949e",
} as const;

const TOKEN_RE =
  /(\/\/.*$|\/\*.*?(?:\*\/|$)|<!--.*?(?:-->|$))|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:import|from|export|default|const|let|var|function|return|if|else|for|while|new|class|extends|async|await|type|interface|enum|public|private|protected|readonly|as|in|of|try|catch|finally|throw|switch|case|break|continue|do|yield|static|true|false|null|undefined|this)\b)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*(?=\s*\())/g;

/** 轻量语法着色：只生成 React span，不注入 HTML；未知语言/文本保持原样。 */
function highlightLine(line: string): ReactNode {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("<!--")) {
    return <span style={{ color: COLORS.comment }}>{line}</span>;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(line)) !== null) {
    if (match.index > cursor) nodes.push(line.slice(cursor, match.index));
    const token = match[0];
    const color = match[1]
      ? COLORS.comment
      : match[2]
        ? COLORS.string
        : match[3]
          ? COLORS.keyword
          : match[4]
            ? COLORS.number
            : COLORS.function;
    nodes.push(
      <span key={`${match.index}-${token}`} style={{ color }}>
        {token}
      </span>,
    );
    cursor = match.index + token.length;
  }
  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes.length > 0 ? nodes : line;
}

function FileIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M4 1.75h5.25L12 4.5v9.75H4V1.75Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M9.25 1.75V4.5H12" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      style={{ transform: expanded ? "none" : "rotate(-90deg)", transition: "transform 120ms ease" }}
    >
      <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GroupRows({ group, index, groupCount }: { group: EditDiffGroup; index: number; groupCount: number }) {
  return (
    <div data-testid="edit-diff-group" data-path={group.path}>
      {groupCount > 1 ? (
        <div
          data-testid="edit-diff-group-path"
          style={{
            padding: "6px 12px",
            borderBottom: `1px solid ${COLORS.border}`,
            color: COLORS.muted,
            fontFamily: fontFamily.mono,
            fontSize: 11,
          }}
        >
          {group.path || `片段 ${index + 1}`}
        </div>
      ) : null}
      {group.rows.map((row, rowIndex) => {
        const added = row.kind === "add";
        const removed = row.kind === "remove";
        return (
          <div
            key={`${index}-${rowIndex}-${row.kind}-${row.lineNumber}`}
            data-testid="edit-diff-line"
            data-kind={row.kind}
            data-line={row.lineNumber}
            style={{
              display: "flex",
              minWidth: "100%",
              width: "max-content",
              minHeight: 20,
              backgroundColor: added ? COLORS.addBg : removed ? COLORS.removeBg : "transparent",
              color: COLORS.text,
              fontFamily: fontFamily.mono,
              fontSize: 12,
              lineHeight: "20px",
            }}
          >
            <span
              aria-hidden
              title="片段内行号"
              style={{
                flex: "0 0 48px",
                width: 48,
                padding: "0 10px 0 6px",
                textAlign: "right",
                color: added ? COLORS.addText : removed ? COLORS.removeText : COLORS.lineNumber,
                userSelect: "none",
              }}
            >
              {row.lineNumber}
            </span>
            <span style={{ display: "block", flex: "1 0 auto", padding: "0 12px 0 4px", whiteSpace: "pre" }}>
              {highlightLine(row.text)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export interface EditDiffViewProps {
  hunks: EditDiffHunk[];
  style?: CSSProperties;
  className?: string;
}

/** 聊天工具卡里的文件编辑 Diff：文件头 + 增删统计 + 本地行号 + 新增/删除高亮。 */
export function EditDiffView({ hunks, style, className }: EditDiffViewProps) {
  const [expanded, setExpanded] = useState(true);
  const groups = useMemo(() => buildEditDiffGroups(hunks), [hunks]);
  const totals = useMemo(() => editDiffTotals(groups), [groups]);
  const paths = useMemo(() => new Set(groups.map((group) => group.path)), [groups]);
  const title = paths.size === 1 ? groups[0]?.path || "未命名文件" : `${paths.size} 个文件`;

  if (groups.length === 0 || groups.every((group) => group.rows.length === 0)) return null;

  return (
    <div
      data-testid="edit-diff-view"
      data-collapsed={expanded ? undefined : "true"}
      className={className}
      style={{
        width: "100%",
        minWidth: 0,
        overflow: "hidden",
        border: `1px solid ${COLORS.border}`,
        borderRadius: 8,
        background: COLORS.surface,
        color: COLORS.text,
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minHeight: 36,
          padding: "0 10px 0 12px",
          background: COLORS.header,
          borderBottom: expanded ? `1px solid ${COLORS.border}` : undefined,
        }}
      >
        <span style={{ display: "inline-flex", color: COLORS.muted, flexShrink: 0 }}>
          <FileIcon />
        </span>
        <span
          data-testid="edit-diff-path"
          title={title}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: fontFamily.mono,
            fontSize: 12,
          }}
        >
          {title}
        </span>
        <span
          data-testid="edit-diff-totals"
          aria-label={`新增 ${totals.added} 行，删除 ${totals.removed} 行`}
          style={{ display: "inline-flex", gap: 8, flexShrink: 0, fontFamily: fontFamily.mono, fontSize: 11 }}
        >
          <span data-testid="edit-diff-added" style={{ color: COLORS.addText }}>
            +{totals.added}
          </span>
          <span data-testid="edit-diff-removed" style={{ color: COLORS.removeText }}>
            -{totals.removed}
          </span>
        </span>
        <button
          type="button"
          data-testid="edit-diff-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? "收起文件差异" : "展开文件差异"}
          onClick={() => setExpanded((value) => !value)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            padding: 0,
            border: "none",
            borderRadius: 4,
            background: "transparent",
            color: COLORS.muted,
            cursor: "pointer",
          }}
        >
          <Chevron expanded={expanded} />
        </button>
      </div>
      {expanded ? (
        <div
          data-testid="edit-diff-body"
          role="region"
          aria-label={`${title} 的文件差异`}
          style={{ maxHeight: 360, overflow: "auto" }}
        >
          {groups.map((group, index) => (
            <GroupRows key={`${group.path}-${index}`} group={group} index={index} groupCount={groups.length} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
