# T9 — 渲染矩阵扩展（text→md / 预览 / 下载卡）证据

## 1. 变更文件（本次提交，仅 6 项）

- `server/src/uploads/uploads.constants.ts` — allowlist 加 `webp/svg/json`（15 项），10MB 不动。
- `server/src/uploads/uploads.service.spec.ts` — 允许用例从 8 扩展到 15（全矩阵）；非法用例不变。
- `web/src/features/docs-site/docs-markdown.tsx` — 加可选 `urlTransform?: UrlTransform | null` 透传（3 行；缺省 `undefined` → react-markdown 默认行为，旧调用零影响）。
- `web/src/features/docs-site/file-preview.tsx` — 新建，唯一导出 `FilePreview({ version, type, title })`。
- `web/app/(main)/docs/page.tsx` — import swap：`+import { FilePreview }`，`<DocContentView>` → `<FilePreview>`（同 props）；删内联 `DocContentView` + 其专用 helpers（`formatBytes/extractExtFromUrl/isAccessibleFileRef`，已在 file-preview 内 minimal duplicate）；其余零改动。
- 本证据 + 截图 `img/t9-{xss,md,txt,csv,json,png,webp,svg,pdf,docx,unknown,ghost}.png`（12 张，gitignored 本地留存）。

## 2. 矩阵实现对照（Appendix B）

| 输入 | 实现 | data-render |
| --- | --- | --- |
| `type=text` | `DocsMarkdown` + 显式 `safeUrlTransform`（仅 `http/https/mailto`，其余 → `null`） | `text-md`（新；旧 `text-fallback` 的 `<pre>` 路径随 text→md 退役） |
| `md/markdown` 文件 | `fetch(fileUrl)` 文本 → `DocsMarkdown`；失败 → 下载卡 | `md-file` |
| `txt/csv/json` | `fetch` → `<pre>` + `slice(0, 256*1024)` + 超限提示 + 下载链接；失败 → 下载卡 | `text-preview` |
| `png/jpg/jpeg/gif/webp` | `<img loading="lazy">` | `image` |
| `svg` | `<img>` only（无 innerHTML/object/embed） | `image` |
| `pdf` | `<iframe sandbox="allow-same-origin" onError + 15s 超时 → 下载卡>` | `pdf` |
| `doc/docx/xls/xlsx`/未知 | 下载卡（复用接缝 markup + testids） | `file-card`（保留） |
| `/uploads` + `fileSize==null` | 不可访问降级（P2 判定原文复用） | `inaccessible`（保留） |

IMAGE_EXTS 与 doc-explorer `FileContentCard` 同集合（含 webp/svg）。零预览依赖、无 HTML 注入渲染、无 rehype 插件。

## 3. 命令 + 结果

- `npm test --prefix server -- --runInBand src/uploads` → 2 suites / 44 tests 全绿。
- `npx tsc --noEmit -p tsconfig.json`（web/）→ 退出 0。
- `npx eslint`（3 个 web 文件）→ 0 errors；1 warning（docs-markdown `useMemo` 缺 `taskId` 依赖，改前已存在，非本 todo 引入）。
- `npx eslint`（2 个 server 文件）→ clean。
- 门：`grep -q "'webp'" && grep -q "'svg'" && grep -q "'json'" uploads.constants.ts` → 命中；`FILE_SIZE_LIMIT` 未动（10MB）。
- 门：`grep -rn "mammoth\|docx-preview\|pdfjs\|react-pdf" web/package.json web/src` → 0；`dangerouslySetInnerHTML\|rehype-raw` 在本 todo 文件 + package.json → 0（唯一命中是 `mermaid-block.tsx` 的既有 mermaid 自渲染，与本矩阵无关）。
- `grep -n "DocContentView" web/app/\(main\)/docs/page.tsx` → 0（头注释 1 处文字提及已改写为 FilePreview，无代码引用）。

## 4. Live 收据（compose 镜像早于 T9 → 400，T4 既定先例：贴收据 + jest/代码路径证明，T12 重验）

```text
webp -> 400 {"code":"UPLOAD_FILE_TYPE_NOT_ALLOWED","message":"文件类型不允许：仅支持 pdf/doc/docx/xls/xlsx/csv/png/jpg/jpeg/gif/md/txt"}
svg  -> 400 （同上）
json -> 400 （同上）
```

- 400 消息列出的旧 allowlist（无 webp/svg/json）反证线上 dist 早于本 todo；等价代码路径证明：multer `fileFilter` → `FileStorageService.assertAllowed` → 同一 `ALLOWED_EXTENSIONS`（`uploads.service.ts:94-99,125`），jest 已覆盖新三项放行 + 非法六项仍 400（含 `fileFilter` cb 语义用例）。
- T12 重验：live 逐个上传 webp/svg/json 断言 200（正式镜像重建后）。

## 5. Playwright 矩阵 QA（临时 spec，跑后已删；8/8 绿）

- Fixture：`t_0000000004` 上 12 行（`t9qa-xss-text` v3 含 `<script>alert(1)</script>` + `[x](javascript:alert(1))`；11 个 file 行指向容器 `/app/uploads/t9-sample.*` 真实字节；`t9qa-ghost` 指向不存在路径）。
- 断言：text→`text-md`（heading 渲染 + 正文）；`script` 0 个；`a[href]` 0 个（`javascript:` 链接退化为无 href 锚点/纯文本）；dialog 0；pageerror 0。md→`md-file`（标题 + `https://example.com` 安全链接保留）。txt/csv/json→`text-preview`（`<pre>` 含预期文本 + 下载链接）。png/webp/svg→`image`（`img[src*=/uploads/]`）。pdf→`pdf`（`sandbox === "allow-same-origin"`，outerHTML 无 `allow-scripts`）。docx/unknown→`file-card` 且 `iframe` 0 个。ghost→`inaccessible`。
- Console：XSS 用例 `pageerror` 空 + dialog 未触发；其余用例无断言外报错。
- 截图：`img/t9-*.png` 12 张（`ls` 可验，均 100KB+ 非空）。经查 `t9-xss.png` 中 `<script>` 以字面文本展示，`t9-pdf.png` 为 iframe 预览容器（headless 下 PDF 插件呈破碎图标，但 `data-render=pdf` 断言证明走 iframe 分支而非回退卡）。

## 6. 清理收据

- Fixture 行：12 个 artifact（art_45/46/67–76）经 `DELETE /artifacts/:id` 全部 200；复查 `total: 0`；中途 P2 误写 UUID 孤儿文件 20 个已按名精确 `rm`（见 §7）。
- 容器 `/app/uploads/t9-sample.*` 10 个已删（`ls | grep t9-` → 0）；`t9-ghost-missing.pdf` 从未落盘。
- 临时文件：`web/e2e/t9-qa.spec.ts`、`web/e2e/t9-qa.config.ts`、`web/test-results/` 已删；host dev `:3001` 已停；`/tmp/t9*` 全删。
- 注意：`web/.auth/` 被 setup project 刷新后随 `test-results` 一并删除（gitignored 登录态，下次 setup 重建）；`.omo/evidence/phase5-t9-playwright.json` 本次未被改写（临时 config 只用 list reporter）。

## 7. 风险与交接

- `DocsMarkdown` 加可选 `urlTransform` 透传：对 T9 的 MUST DO（显式传参）是必需的（否则 prop 无法到达 react-markdown v10 的 `urlTransform`）；缺省 `undefined` 时走 `defaultUrlTransform`，旧调用行为不变。T10 不碰本文件。
- Fixture 教训：`POST /tasks/:id/artifacts` 对 doc/file 若带非空 `content` 会触发 P2 落盘（UUID 文件覆盖 fileRef 引用）；fixture 必须用纯空白 `content`（sha 互异但 `trim()` 为空 → 跳过 P2，保留 fileRef 原引用）。ghost 降级依赖 `describeFileRef` 磁盘 stat 失败 → `size: null`。
- `text-fallback` 的 `data-render` 值随旧 `<pre>` 路径退役（text→md 即本 todo 核心变更）；`file-card/inaccessible` 在回退路径保留原值。
- 风险低：server 改动仅 allowlist 常量 + spec；web 改动集中在新文件 + 接缝替换；全门绿；live 上传 200 留 T12。
