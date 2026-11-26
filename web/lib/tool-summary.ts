const SUMMARY_KEYS = [
  "command",
  "cmd",
  "file_path",
  "filePath",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "title",
] as const;

/** 工具名 → 紧凑过程行标题；未命中时保留原名，信息不丢。 */
const TOOL_TITLE_RULES: ReadonlyArray<{ match: RegExp; title: string }> = [
  { match: /(^|_)(bash|shell|run_command|exec_command|execute_command)$/i, title: "运行命令" },
  { match: /(^|_)read(_image)?$/i, title: "读取" },
  { match: /(^|_)write$|(^|_)edit$|str_replace/i, title: "编辑" },
  { match: /grep|(^|_)search$/i, title: "搜索" },
  { match: /(^|_)glob$|(^|_)find$|(^|_)ls$/i, title: "查找文件" },
  { match: /web_fetch|(^|_)fetch$/i, title: "网页获取" },
  { match: /web_search/i, title: "网页搜索" },
  { match: /todo/i, title: "待办" },
];

/** 判断是否为群聊发布工具；兼容 DSH Code Mode 的 execute 包装。 */
export function isGroupPostTool(name: string, input = ""): boolean {
  return (
    /(^|_)group_post$/i.test(name) ||
    (/(^|_)execute$/i.test(name) && /\bgroup_post\s*\(/.test(input))
  );
}

export function toolTitleOf(name: string, input = ""): string {
  // MCP 工具名保留可识别的「server.tool」形态，和 opencode 的执行行一致。
  const mcp = /^mcp__([^_]+)__(.+)$/i.exec(name);
  if (mcp) return `${mcp[1]}.${mcp[2]}`;
  // Code Mode 的 execute 是包装层；标题显示实际调用的 MCP 工具，而不是 execute。
  if (/(^|_)execute$/i.test(name)) {
    const wrapped = /\btools\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*\(/.exec(input);
    if (wrapped) return `${wrapped[1]}.${wrapped[2]}`;
  }
  if (/^vteam_(group_post|notify_agent)$/i.test(name)) {
    return `vteam.${name.slice("vteam_".length)}`;
  }
  for (const rule of TOOL_TITLE_RULES) {
    if (rule.match.test(name)) return rule.title;
  }
  return name;
}

/** 从工具调用输出中提取「已在群聊落成消息」的 messageId，用于过滤成员历史里的重复投影。 */
export function toolProducedMessageIds(
  items: Array<{ content?: { parts?: unknown[] } | null }>,
): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    const parts = item.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const raw of parts) {
      if (!raw || typeof raw !== "object") continue;
      const part = raw as Record<string, unknown>;
      if (part.type !== "tool") continue;
      const state =
        part.state && typeof part.state === "object"
          ? (part.state as Record<string, unknown>)
          : {};
      const name =
        typeof part.tool === "string"
          ? part.tool
          : typeof part.name === "string"
            ? part.name
            : "";
      const input = state.input ?? part.input;
      const inputText =
        typeof input === "string" ? input : JSON.stringify(input ?? "");
      let output: unknown = state.output ?? part.output;
      if (typeof output === "string") {
        try {
          output = JSON.parse(output);
        } catch {
          continue;
        }
      }
      if (!output || typeof output !== "object") continue;
      const result = output as {
        messageId?: unknown;
        targetInstanceId?: unknown;
        channelId?: unknown;
        attachment?: unknown;
      };
      const messageId = result.messageId;
      const isProjectionTool =
        /(^|[._])(group_post|notify_agent)$/i.test(name) ||
        (/(^|_)execute$/i.test(name) &&
          (/\b(?:group_post|notify_agent)\s*\(/.test(inputText) ||
            (typeof messageId === "string" &&
              (result.targetInstanceId !== undefined ||
                ("channelId" in result && "attachment" in result)))));
      if (!isProjectionTool || typeof messageId !== "string" || !messageId)
        continue;
      ids.add(messageId);
    }
  }
  return ids;
}

function pickFromJson(raw: string): string | null {
  const text = raw.trim();
  if (!(text.startsWith("{") && text.endsWith("}")) && !(text.startsWith("[") && text.endsWith("]"))) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return null;
    if (Array.isArray(parsed)) {
      return parsed.length > 0 ? parsed.map(String).join(" ") : "";
    }
    const object = parsed as Record<string, unknown>;
    for (const key of SUMMARY_KEYS) {
      const value = object[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
      if (Array.isArray(value) && value.length > 0) return value.map(String).join(" ");
    }
    for (const value of Object.values(object)) {
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
    return Object.keys(object).length === 0 ? "" : null;
  } catch {
    // 非 JSON：按原始首行展示
  }
  return null;
}

/** 折叠行只显示最能说明调用意图的一小段参数，不展示整段 JSON。 */
export function summarizeToolInput(input: string, maxChars = 96): string {
  if (input.trim().length === 0) return "";
  const picked = pickFromJson(input) ?? input.split("\n")[0] ?? "";
  const line = picked.replace(/\s+/g, " ").trim();
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

/** opencode 风格的工具输出摘要：有输出时只显示实际行数。 */
export function toolOutputLineCount(output: string): number {
  const text = output.trim();
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

/**
 * 没有输入摘要时，从输出里提炼一行关键结果。
 * 优先取最后一条汇总/成功/失败/错误语义行，否则取第一条非空行。
 */
export function summarizeToolOutput(output: string, maxChars = 96): string {
  let text = output.trim();
  if (text.length === 0) return "";
  const content = /<content>([\s\S]*?)<\/content>/i.exec(text);
  if (content?.[1]) text = content[1].trim();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (lines.length === 0) return "";

  const hint = /(汇总|总结|summary|result|passed|failed|failure|error|成功|失败|完成|通过|pass|fail)/i;
  const hinted = lines.some((line) => hint.test(line));
  // 超长单行纯载荷没有可读语义时仍只显示行数，避免把 3000 字符前缀塞回过程行。
  if (!hinted && lines.length === 1 && lines[0].length > maxChars * 3) return "";
  let picked = lines[0];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (hint.test(lines[index])) {
      picked = lines[index];
      break;
    }
  }
  return picked.length > maxChars ? `${picked.slice(0, maxChars)}…` : picked;
}
