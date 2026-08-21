export const EMBED_PREFIX = "@@PROTO_EMBED_";
export const LIST_PREFIX = "@@PROTO_LIST_";
export const INLINE_PREFIX = "@@PROTO_INLINE_";

import type { ParsedPrd, PrototypeEmbedSpec, PrototypeListSpec } from "./types";

let seq = 0;
const nextSeq = () => `${++seq}_${Math.random().toString(36).slice(2, 8)}`;

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

export function parsePrdMarkdown(src: string): ParsedPrd {
  const embeds = new Map<string, PrototypeEmbedSpec>();
  const lists = new Map<string, PrototypeListSpec>();
  const inlineRefs = new Map<string, string>();
  const lines = src.split("\n");
  const outLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
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
      outLines.push(line);
      i += 1;
      continue;
    }
    if (fence) {
      const kind = fence[2] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
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
    if (line.includes("@prototype[")) {
      let replaced = "";
      let last = 0;
      const re = /`[^`]*`|@prototype\[([\w-]+)\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (m[0].startsWith("`")) {
          replaced += line.slice(last, m.index) + m[0];
        } else {
          replaced += line.slice(last, m.index);
          const id = m[1];
          const placeholder = `${INLINE_PREFIX}${nextSeq()}`;
          inlineRefs.set(placeholder, id);
          replaced += placeholder;
        }
        last = m.index + m[0].length;
      }
      replaced += line.slice(last);
      outLines.push(replaced);
    } else {
      outLines.push(line);
    }
    i += 1;
  }
  return { markdown: outLines.join("\n"), embeds, lists, inlineRefs };
}

export function isPlaceholderLine(line: string): boolean {
  return line.startsWith(EMBED_PREFIX) || line.startsWith(LIST_PREFIX) || line.startsWith(INLINE_PREFIX);
}
