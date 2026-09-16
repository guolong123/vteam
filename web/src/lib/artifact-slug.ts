/**
 * 产出物 slug 规范源（web 侧唯一定义）。
 *
 * - 从 `web/src/components/tasks/task-detail-types.ts` 原样搬移
 *  （`toDocSlug`/`docIdFor`，算法逐字符一致，深链 `?doc=` 兼容）。
 *   `task-detail-types.ts` 仅保留纯透传重导出，逻辑以此文件为准。
 * - Server 镜像：`server/src/artifacts/artifact-slug.ts`
 *  （`toSlug`/`docIdFor`，双实现 + 互指注释，跨端一致性由两侧单测 +
 *   grep 单定义门保证，不建共享包）。
 */

/** 标题 → ASCII slug（对齐 `server/src/artifacts/artifact-slug.ts` 的 `toSlug`）。 */
export function toDocSlug(title: string): string {
  return (
    String(title ?? "doc")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "doc"
  );
}

/** 产出物 → 文档站 doc id（对齐 server DocsMirrorService.docIdFor + buildRegistry 去重）：
 *  base = ASCII slug；纯中文/空 → 'doc' 追加 artifact id 末 8 位；
 *  同名多文档按 artifact id 序，已占用 → 追加 -<artId末8位>。 */
export function docIdFor(title: string, artifactId: string, all?: { id: string; title: string }[]): string {
  const toBase = (t: string, id: string): string => {
    const slug = toDocSlug(t);
    if (slug !== "doc") return slug;
    const suffix = String(id).replace(/[^a-z0-9]/gi, "").slice(-8);
    return suffix ? `doc-${suffix}` : "doc";
  };
  const base = toBase(title, artifactId);
  if (!all || all.length <= 1) return base;
  const seen = new Set<string>();
  const ordered = [...all].sort((a, b) => a.id.localeCompare(b.id));
  for (const a of ordered) {
    const b = toBase(a.title, a.id);
    if (a.id === artifactId) {
      if (!seen.has(b)) return b;
      const suffix = String(artifactId).replace(/[^a-z0-9]/gi, "").slice(-8);
      let cand = suffix ? `${b}-${suffix}` : b;
      let cnt = 1;
      while (seen.has(cand)) {
        cnt += 1;
        cand = `${b}-${suffix}-${cnt}`;
      }
      return cand;
    }
    seen.add(b);
  }
  return base;
}
