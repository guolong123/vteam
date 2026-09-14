# vteam-plan-skills-rewrite learnings

## 2026-09-14 plan skills 正文重写（Todo 1）
- seed.ts 内 skill content 是反引号模板字符串：正文里写 `[假设]` 这类行内 code span 时，反引号必须转义（\`），否则模板提前闭合，tsc 报"not callable / Cannot find name"。教训：凡在 seed content 里加行内代码，一律逐个转义，改完先跑 tsc。
- jest 没有 `toSatisfy`（那是 vitest 的）：新断言里的"或"条件用 `expect(a || b).toBe(true)`，别发明 matcher。
- 角色关键词各异断言要用全串（如"排期真实性"而非"排期"），避免子串误伤；统一骨架措辞里别夹带任何角色视角词，否则"仅出现一次"断言会炸。
- 输出节旧句替换时保留 VERDICT 双值字符串，聚合正则 `/VERDICT:\s*(APPROVE|REJECT)/i` 契约不动；把"第一行必须是"写进正文，断言可直接覆盖。
- 本次纯文本改动也触发生态约束：模板 Agent prompt 里的 `skill(plan-review-<role>)` 点名与无交叉污染断言不受影响，因为没改名；frontmatter/allowed-tools 冻结，spec 的精确匹配断言即回归网。
