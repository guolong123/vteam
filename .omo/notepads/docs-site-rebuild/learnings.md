# Learnings — docs-site-rebuild

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---
## 2026-08-20 Visual Overhaul — tokens 迁移
- 文档站曾用 Tailwind slate 硬编码浅色类（`text-slate-700`/`bg-slate-50`/`border-slate-200`/`bg-white`），导致"全面的丑，和当前其它功能完全不搭"。其余 UI 用 `src/theme/tokens.ts` + `globals.css` CSS 变量（`--color-neutral-*`/`--color-surface`/`--color-bg`/`--color-border`）随 `.dark` 自动反转。视觉一致性 = 全部用 tokens inline-style。
- ⚠️ 关键坑：React inline `style` 对象**不支持** `"@media (min-width: …)"` 键——会被静默忽略。响应式必须用 Tailwind 类（`hidden lg:flex`/`md:flex-row`/`sm:grid-cols-2 lg:grid-cols-3`），颜色才走 tokens。
- 品牌蓝 accent：`ACCENT="#2563EB"`、`ACCENT_BG="rgba(37,99,235,0.10)"`、`ACCENT_BORDER="rgba(37,99,235,0.22)"`（对齐 roleText.product，双主题可读）。
- `mermaid-block.tsx` 是全应用唯一原本就 tokens 一致的文件，可作参考基准。
- 深色验证方法：Playwright evaluate 手动 `root.classList.add('dark')` + `getComputedStyle` 断言（无需改 localStorage）。
