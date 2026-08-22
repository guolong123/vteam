# Decisions — docs-site-rebuild

Architectural choices and rationales discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---
## 2026-08-20 Visual Overhaul — tokens inline-style 决策
- 决策：docs-site 全部渲染面改用 tokens inline-style（`neutral[500]`/`surface`/`border`/`radius`/`space`/`fontSize`）+ Tailwind 仅用于响应式布局类。理由：与全应用主题机制（`.dark` class + CSS 变量）同构，双主题免费。
- 决策：保持 markdown 语义组件（table/thead/th/td/code/pre/blockquote 等）内联在 docs-markdown.tsx，不引入 shiki/prism 高亮（避免新依赖）；代码块仅加语言标签头。
- 决策：e2e testid 契约（`docs-shell`/`docs-tab-protos`/`proto-frame` 等）视为 API 冻结，重写时必须保留。
- 决策：`@media` 键在 inline style 中不可用的规避——所有响应式断点改用 Tailwind 类，颜色仍走 tokens（避免手写 `window.matchMedia` 状态）。
