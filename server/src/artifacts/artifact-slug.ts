/**
 * 产出物 slug 规范源（server 侧唯一定义）。
 *
 * - 从已退役的磁盘镜像层原样搬移（T3 搬移 `toSlug`/`docIdFor`/
 *   `prototypeSlug`/`prototypeFileName`，算法逐字符一致，深链 `?doc=` 兼容）。
 *   本文件为唯一逻辑源（T11 起无旧包装残留）。
 * - Web 镜像：`web/src/lib/artifact-slug.ts`（`toDocSlug`/`docIdFor`，双实现 + 互指注释，
 *   跨端一致性由两侧单测 + grep 单定义门保证，不建共享包）。
 *
 * 规则速览：标题 → 小写 ASCII slug（非 `[a-z0-9]` → `-`，收尾 `-` 裁剪，空回退 `'doc'`）；
 * 弱 slug（纯中文/空/纯符号 → `'doc'`）追加 artifact id 末 8 位字母数字防冲突。
 */

/** 标题 → ASCII slug（文件名/文档 id；规避中文 id hash 路由 bug）。 */
export const toSlug = (title: string): string => {
  const base = String(title ?? 'doc')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'doc';
};

/** 文档 id：标题 slug；弱 slug（纯中文/空 → doc）追加 artifact id 防多文档冲突。 */
export const docIdFor = (title: string, artifactId: string): string => {
  const slug = toSlug(title);
  if (slug === 'doc' && artifactId) {
    const suffix = String(artifactId)
      .replace(/[^a-z0-9]/gi, '')
      .slice(-8);
    return suffix ? `doc-${suffix}` : 'doc';
  }
  return slug;
};

/**
 * TSX 原型目录名（白名单 [a-z0-9_-]）：
 * 优先取产出物文件名去 `.tsx` 后缀，不可用时从标题派生；标题弱名追加 artifact 后缀防冲突。
 */
export const prototypeSlug = (
  title: string,
  artifactId: string,
  contentRef: string,
): string => {
  const base = String(contentRef).split('/').pop() ?? '';
  let slug = base
    .replace(/\.tsx$/i, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    slug = toSlug(title);
  }
  if (!slug || slug === 'doc') {
    const suffix = String(artifactId)
      .replace(/[^a-z0-9]/gi, '')
      .slice(-8);
    slug = suffix ? `proto-${suffix}` : 'proto';
  }
  return slug;
};

/**
 * 旧 DSL 原型镜像文件名（白名单 [a-z0-9_-].json）：
 * 优先取产出物文件名去 `.prototype.json`（my-proto.prototype.json → my-proto.json），
 * 文件名不可用（中文/空）时从标题派生；标题弱名（doc 兜底）追加 artifact 后缀防冲突。
 */
export const prototypeFileName = (
  title: string,
  artifactId: string,
  contentRef: string,
): string => {
  const base = String(contentRef).split('/').pop() ?? '';
  let slug = base
    .replace(/\.prototype\.json$/i, '')
    .replace(/\.json$/i, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    slug = toSlug(title);
  }
  if (!slug || slug === 'doc') {
    const suffix = String(artifactId)
      .replace(/[^a-z0-9]/gi, '')
      .slice(-8);
    slug = suffix ? `proto-${suffix}` : 'proto';
  }
  return `${slug}.json`;
};
