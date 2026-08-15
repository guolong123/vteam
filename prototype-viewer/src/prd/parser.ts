/**
 * PRD 原型标记解析器
 * =====================================================
 * 在 PRD Markdown 源文本中识别三类原型标记，并替换为占位符，
 * 使 react-markdown 渲染时跳过原型代码块，由文档阅读器（DocExplorer）在渲染
 * 结果中定位占位符并替换为可交互原型组件。
 *
 * 标记规范（与 docs/requirements.md 4.11.1 节一致）：
 *  1. 块级标记：
 *     ```prototype
 *     id: flow-editor
 *     title: 流程编排画布   # 可选
 *     device: desktop       # 可选，desktop|mobile，默认 desktop
 *     height: 520           # 可选，内嵌高度 px，默认 640
 *     ```
 *  2. 清单标记：```prototype-list``` → 渲染本 PRD 引用的全部原型
 *  3. 内联标记：@prototype[agent-list] → 引用样式
 */

export interface PrototypeEmbedSpec {
  /** 原型注册 id（registry meta.id） */
  id: string;
  /** 可选覆盖标题 */
  title?: string;
  /** 设备类型，默认 desktop */
  device?: "desktop" | "mobile";
  /** 内嵌高度 px（最大高度，默认 640） */
  height?: number;
}

export interface PrototypeListSpec {
  /** 是否内嵌渲染所有原型（而非仅链接） */
  embed?: boolean;
}

/** 解析结果：占位符 -> 原始 spec */
export interface ParsedPrd {
  /** 处理后的 markdown（原型代码块被替换为占位符行） */
  markdown: string;
  /** 块级原型嵌入占位 -> spec */
  embeds: Map<string, PrototypeEmbedSpec>;
  /** 清单占位 -> spec */
  lists: Map<string, PrototypeListSpec>;
  /** 内联引用占位 -> 原型 id */
  inlineRefs: Map<string, string>;
}

export const EMBED_PREFIX = "@@PROTO_EMBED_";
export const LIST_PREFIX = "@@PROTO_LIST_";
export const INLINE_PREFIX = "@@PROTO_INLINE_";

let seq = 0;
const nextSeq = () => `${++seq}_${Math.random().toString(36).slice(2, 8)}`;

/** 解析块级 prototype 代码块内的 key: value 行（支持 # 行内注释与引号） */
function parseYamlLines(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const cleaned = line.replace(/#.*$/, "").trim();
    if (!cleaned) continue;
    const m = cleaned.match(/^([\w-]+)\s*:\s*(.+)$/);
    if (m) out[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * 解析 PRD markdown 源文本。
 * @param src PRD markdown 原文
 * @returns 处理后的 markdown 与占位映射
 */
export function parsePrdMarkdown(src: string): ParsedPrd {
  const embeds = new Map<string, PrototypeEmbedSpec>();
  const lists = new Map<string, PrototypeListSpec>();
  const inlineRefs = new Map<string, string>();

  // 1) 块级标记：```prototype ... ``` 与 ```prototype-list```
  //    - 4+ 反引号围栏（````prototype）用于文档内展示"标记规范示例"，跳过；
  //    - ````markdown ```` 围栏内的所有内容为文档示例，整体跳过（其中嵌有 3 反引号 prototype 示例）。
  const lines = src.split("\n");
  const outLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 跳过 ````markdown ... ```` 围栏（文档示例区）
    if (/^\s*(`{4,}|~{4,})\s*markdown\s*$/.test(line)) {
      outLines.push(line);
      i += 1;
      while (i < lines.length && !/^\s*(`{4,}|~{4,})\s*$/.test(lines[i])) {
        outLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        outLines.push(lines[i]);
        i += 1;
      }
      continue;
    }

    const fence = line.match(/^\s*(```|~~~)\s*prototype(-\w+)?\s*$/);
    const heavierFence = line.match(/^\s*(`{4,}|~{4,})\s*prototype/);
    if (heavierFence) {
      // 4+ 反引号围栏：文档内展示用示例，原样保留（作为代码块渲染）
      outLines.push(line);
      i += 1;
      continue;
    }
    if (fence) {
      const kind = fence[2] ?? ""; // "" | "-list"
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      // 跳过闭合围栏
      if (i < lines.length) i += 1;

      if (kind === "-list") {
        const kv = parseYamlLines(body);
        const placeholder = `${LIST_PREFIX}${nextSeq()}`;
        lists.set(placeholder, { embed: kv.embed === "true" });
        outLines.push(placeholder);
      } else {
        const kv = parseYamlLines(body);
        const id = (kv.id ?? "").trim();
        if (!id) {
          // 无法解析的 prototype 块：保留原文（以代码块形式展示，便于排查）
          outLines.push("```prototype", ...body, "```");
        } else {
          const placeholder = `${EMBED_PREFIX}${nextSeq()}`;
          embeds.set(placeholder, {
            id,
            title: kv.title?.trim(),
            device: kv.device === "mobile" ? "mobile" : "desktop",
            height: kv.height ? Number.parseInt(kv.height, 10) || 640 : 640,
          });
          outLines.push(placeholder);
        }
      }
      continue;
    }

    // 2) 内联标记：@prototype[agent-list]
    if (line.includes("@prototype[")) {
      const replaced = line.replace(/@prototype\[([\w-]+)\]/g, (_, id: string) => {
        const placeholder = `${INLINE_PREFIX}${nextSeq()}`;
        inlineRefs.set(placeholder, id);
        return placeholder;
      });
      outLines.push(replaced);
    } else {
      outLines.push(line);
    }
    i += 1;
  }

  return { markdown: outLines.join("\n"), embeds, lists, inlineRefs };
}

/** 判断某行是否为原型占位符 */
export function isPlaceholderLine(line: string): boolean {
  return (
    line.startsWith(EMBED_PREFIX) || line.startsWith(LIST_PREFIX) || line.startsWith(INLINE_PREFIX)
  );
}
