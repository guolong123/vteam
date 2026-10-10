# doc-pdf-export-fix
# doc-pdf-export-fix - Work Plan

## TL;DR (For humans)

**What you'll get:** 文档站 PDF 导出修复。当前暗色模式下导出的 PDF 几乎不可读：文字浅灰印在白底上；深色块（代码/提示块/表头）又在白纸上形成明暗撕裂；页面无页边距、跨页硬切断。

**Why this approach:** 根因已定位——`doc-export.ts` 的「强制浅色」只设了克隆根节点两行 style，未切断 `html.dark` 的 CSS 变量作用域，凡靠 CSS 类上色的元素（几乎全部）仍解析暗色变量。修复=宿主级浅色变量覆盖（治本）+ 导出作用域样式适配 + 版面收尾。

**What it will NOT do:** 不改文档正常阅读渲染；不引入新依赖；不做文本层 PDF（位图切片固有，另议）；不动 mermaid 源配置（仅导出期颜色归一）；不劣化浅色模式导出。

**Effort:** Small-Medium（3 个实现任务，全部在 web/ 导出链路）
**Risk:** Low（纯导出路径，不触碰文档渲染与阅读体验）

## Scope
### Must have
1. **pdf-light-scope**：离屏宿主内联覆盖全套浅色 `--color-*` 变量（从 `globals.css` `:root` 块复制，字段一致），切断 `.dark` 作用域；移除只改根节点 `background/color` 的无效 hack 并注释根因。
2. **pdf-block-adapt**：导出作用域（宿主类名，如 `pdf-export`）为深色孤岛做浅色适配——代码块 / inline code / 引用与提示块 / 表格头 / mermaid 容器；mermaid 栅格化前将图内文字与连线颜色归一为深色（当前白底浅字低对比）。
3. **pdf-layout**：A4 页边距（约 12mm，内容宽度随之收窄）；切片断页点向最近「白行」吸附，避免从表格/代码块中间硬切。
4. **pdf-verify**：Chromium 冒烟——暗色主题下执行真实导出，采样画布像素断言文字区域为深色（非浅灰）、深色块已转浅；证据落档。

### Must NOT have (guardrails)
- 不改文档正常阅读渲染（改动限导出作用域/导出函数）；不引入新依赖
- 不做文本层 PDF（位图切片固有限制，需换架构，另议）
- 不动 mermaid 源渲染配置（仅导出期颜色归一）；不改 Markdown 渲染语义
- 不劣化浅色模式导出（保持同等或更好）

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- 导出链含 DOM/canvas/html2canvas，单元测试不可行；以 **Chromium 冒烟**为准（先例：token 统计 UI smoke 的 esbuild + 真实 Chromium 打包断言）。
- 冒烟需可测缝：如 `exportNodeToPdf` 增加可选回调/返回值暴露中间 canvas（供断言），或测试内直接驱动同等步骤——执行者选最小侵入方案并注释理由。
- 证据：.omo/evidence/task-<N>-doc-pdf-export-fix.txt（含像素断言输出、截图路径、命令）。

## Execution strategy
### Parallel execution waves
> 三个 todo 都落在 `web/src/features/docs-site/doc-export.ts`（同文件）→ 强制串行，避免并行写冲突；每波 1 个 todo。
- **Wave 1**：Todo 1（pdf-light-scope，含移除无效 hack）
- **Wave 2**：Todo 2（pdf-block-adapt，依赖 Todo 1 的宿主作用域机制）
- **Wave 3**：Todo 3（pdf-layout，jsPDF 切片段）
- **Wave 4**：Todo 4（pdf-verify，端到端冒烟 + 证据）
- **Final verification wave**：F1-F4

### Dependency matrix
| Todo | Depends on | Blocks | Parallelizable with |
| --- | --- | --- | --- |
| 1. light-scope | - | 2, 4 | - |
| 2. block-adapt | 1 | 4 | - |
| 3. layout | - | 4 | 2（不同代码区，若冲突则顺延串行） |
| 4. verify | 1-3 | F 波 | - |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [ ] 1. pdf-light-scope：宿主级浅色变量覆盖
  What to do / Must NOT do:
  - `web/src/features/docs-site/doc-export.ts`：删除克隆根节点的 `clone.style.background/color` 两行（无效：被类样式覆盖）；改为在**离屏宿主**（:128-138 的 `host`）内联写全套浅色变量——从 `web/app/globals.css` 的 `:root` 块逐字段复制 `--color-*`（neutral 10 阶 / surface / bg / border / text / text-muted / mention-* / warning-* / role-* / segment-* 等），使宿主子树内 `var(--color-*)` 全部解析为浅色，切断 `html.dark` 影响
  - 变量清单与 `:root` 保持同步的防漂移措施（二选一：运行时从 `document.documentElement` 计算值读取并内联 / 或复制常量并注释来源+守护断言）；选型与理由写进注释与报告
  - 注释记录根因（根节点 color 被类样式覆盖 + 宿主仍处 .dark 作用域）
  - Must NOT：不改 `:root` 本体；不改正常阅读渲染；不动 SVG 栅格化与分页逻辑（Todo 2/3）；不引入新依赖
  Parallelization: Wave 1 | Blocked by: - | Blocks: 2, 4
  References: web/src/features/docs-site/doc-export.ts:96-140（克隆/宿主段）、:142-151（html2canvas 调用）；web/app/globals.css:124-227（:root 与 .dark 变量对，浅色表从前者复制）；web/src/features/docs-site/docs-markdown.tsx（正文样式来源）
  Acceptance criteria (agent-executable): `cd web && npx tsc --noEmit` + `npm run lint`（0 err / 729 基线）+ `npm run build` 全过；导出宿主 style 含全部浅色变量（冒烟内断言）
  QA scenarios (name the exact tool + invocation): happy——暗色下导出，正文/标题区域像素为深色（Todo 4 冒烟断言）；failure——禁用内联变量后同断言变红（验证承重）。Evidence .omo/evidence/task-1-doc-pdf-export-fix.txt
  Commit: Y | fix(docs): PDF 导出宿主级浅色变量覆盖

- [ ] 2. pdf-block-adapt：深色孤岛导出作用域浅色适配
  What to do / Must NOT do:
  - 宿主加导出作用域类（如 `pdf-export`）；在导出管线内注入一段 scope 样式（宿主内 `<style>` 或行内覆盖），对以下深色元素做浅色适配：代码块（浅灰底 + 深字）、inline code 芯片、引用/提示块（admonition）、表格头（浅底深字）、mermaid 容器
  - mermaid：栅格化前（`svgToDataUrl` 调用点 :115-128）将图内文字/连线颜色归一为深色（当前白底 + 浅色图元低对比）；失败路径保持既有兜底（foreignObject 保留内联 SVG）
  - 目标：白纸上不再出现深色斑块；浅色模式导出保持同等或更好
  - Must NOT：不改正常阅读渲染（全部改动限定导出作用域）；不改 mermaid 源渲染配置；不引入新依赖；不动分页/页边距（Todo 3）
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 4
  References: web/src/features/docs-site/doc-export.ts:96-140（宿主/克隆）、:60（栅格化白底）、:115-128（SVG 替换循环）；web/src/features/docs-site/docs-markdown.tsx（代码块/admonition/表格样式来源与类名）；web/app/globals.css（.dark 下对应色值，用于推导浅色对）
  Acceptance criteria (agent-executable): web tsc/lint/build 全过；冒烟断言代码块区域浅底
  QA scenarios: happy——暗色导出代码块/表头为浅色系（Todo 4 采样断言）；failure——不改 scope 时断言红。Evidence .omo/evidence/task-2-doc-pdf-export-fix.txt
  Commit: Y | fix(docs): PDF 导出深色孤岛浅色适配

- [ ] 3. pdf-layout：页边距 + 白行吸附断页
  What to do / Must NOT do:
  - A4 页边距：`addImage` 改为留边（约 12mm），内容宽度 = 210 - 2×margin，页面高度同步收窄；首页顶部留白一致
  - 断页：切片边界向最近「近白行」吸附（在页高附近上下扫描一行像素亮度，命中则把切点移过去），避免从表格/代码块中间硬切；扫描范围有界（如 ±15% 页高），找不到白行则维持原位
  - Must NOT：不引入新依赖；不改栅格化倍率/DPI；不改内容渲染；不改上游 DOM 段（Todo 1/2 域）
  Parallelization: Wave 3 | Blocked by: - | Blocks: 4（若与 Todo 2 同文件不同区域可并行，冲突则顺延）
  References: web/src/features/docs-site/doc-export.ts:153-193（jsPDF 切片分页段、addImage 参数）；:14-18（A4 常量）
  Acceptance criteria (agent-executable): web tsc/lint/build 全过；冒烟断言页边距 > 0（首页非满幅）与断点非块中（采样）
  QA scenarios: happy——导出 PDF 四周留白、无明显块中切断；failure——回归旧参数时断言红。Evidence .omo/evidence/task-3-doc-pdf-export-fix.txt
  Commit: Y | fix(docs): PDF 导出页边距与白行吸附断页

- [ ] 4. pdf-verify：Chromium 暗色导出冒烟 + 证据
  What to do / Must NOT do:
  - Chromium（真实浏览器）内：构造示例文档（标题/段落/表格/代码块/提示块/mermaid），`html.dark` 生效，执行真实导出链；采样画布像素断言：① 正文文字区域为深色（非浅灰）② 代码块/表头为浅底 ③ 首页有页边距 ④ 无整行浅灰文字
  - 若导出函数需可测缝（暴露 canvas/回调），按最小侵入添加并注释
  - 证据：.omo/evidence/task-4-doc-pdf-export-fix.txt（断言输出 + 截图路径）
  - Must NOT：不为冒烟改业务语义；不留测试脏数据；不用 mock 替代真实导出链（本 todo 的价值就在真实链路）
  Parallelization: Wave 4 | Blocked by: 1-3 | Blocks: F 波
  References: Todo 1-3 证据；token 统计 UI smoke 先例（esbuild + Chromium）— grep 前特性 evidence 获取做法
  Acceptance criteria (agent-executable): 四项像素断言全绿并落档
  QA scenarios: happy——暗色导出全断言过；failure——任一断言红即失败。Evidence .omo/evidence/task-4-doc-pdf-export-fix.txt
  Commit: N（证据并入 F 波）

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit：Must have 四条 / Must NOT 逐条（重点：改动限导出域、无新依赖、浅色模式不劣化、无文本层假设）
- [ ] F2. Code quality review：web tsc/lint(0err/729)/build；无 `as any`/空 catch；变量覆盖清单与 `:root` 对齐（防漂移措施有效）
- [ ] F3. Real manual QA：暗色真实导出即所修场景——可读性对照（修复前后）、块中切断检查、浅色模式回归
- [ ] F4. Scope fidelity：git diff 限 web/src/features/docs-site/**（+ 必要的 globals.css 读取不改写）；package.json 零 diff

## Commit strategy
- 每 todo 单 commit：`fix(docs): <subject>`；小改 amend 合并
- 提交前 `cd web && npx tsc --noEmit && npm run lint && npm run build`
- 分支：在当前 `feat/worker-self-update` 基线之上新建 `fix/doc-pdf-export`（或按用户指示）；推送/PR 按既有流程

## Success criteria
- 暗色模式下导出的 PDF：正文/标题/表格文字为深色可读；无深色孤岛斑块；四周有页边距；无块中硬切断
- 浅色模式导出不劣化
- web 三门全绿；F1-F4 全 APPROVE
