# vteam-plan-skills-rewrite learnings

## 2026-09-14 plan skills 正文重写（Todo 1）
- seed.ts 内 skill content 是反引号模板字符串：正文里写 `[假设]` 这类行内 code span 时，反引号必须转义（\`），否则模板提前闭合，tsc 报"not callable / Cannot find name"。教训：凡在 seed content 里加行内代码，一律逐个转义，改完先跑 tsc。
- jest 没有 `toSatisfy`（那是 vitest 的）：新断言里的"或"条件用 `expect(a || b).toBe(true)`，别发明 matcher。
- 角色关键词各异断言要用全串（如"排期真实性"而非"排期"），避免子串误伤；统一骨架措辞里别夹带任何角色视角词，否则"仅出现一次"断言会炸。
- 输出节旧句替换时保留 VERDICT 双值字符串，聚合正则 `/VERDICT:\s*(APPROVE|REJECT)/i` 契约不动；把"第一行必须是"写进正文，断言可直接覆盖。
- 本次纯文本改动也触发生态约束：模板 Agent prompt 里的 `skill(plan-review-<role>)` 点名与无交叉污染断言不受影响，因为没改名；frontmatter/allowed-tools 冻结，spec 的精确匹配断言即回归网。

## 2026-09-14 重 seed + 注入验证 + 真实评审回归（Todo 2）
- `init` 与 `server` 是两个独立镜像（同 Dockerfile 不同 image）：只 `build server` 会留下陈旧 init，seed 跑的是旧 dist——现象是 DB 里中文 doctrine 标记全 0。教训：改 seed.ts 后必须 `build init`（或全量 build）再 `compose run --rm init`。
- MySQL 客户端默认 `character_set_client=latin1`，中文 `LIKE '%存疑放行%'` 会静默返回 0。教训：凡查 CJK content 一律 `--default-character-set=utf8mb4`，否则误判 seed 失败。
- worker 注入只在启动时跑：re-seed 后必须 `up -d --force-recreate worker`；注入证明要用 workdir SKILL.md 的内容 grep（各标记文件数应与 DB 分布一致：APPROVAL BIAS 6/存疑放行 6/最多 3 条·篇幅上限·不 redesign·VERDICT 5/假设清单 2），不能只看文件存在。
- live smoke 两次均为 live-llm 路径（17s 级、APPROVE 可解析；findings 3-4 条短 bullets、总量 300 字级，新篇幅纪律定性生效）。response 只保留服务端解析后的结构化 verdict，不保留评审原文——"VERDICT 首行"只能靠解析成功间接证明，直接观察原文需另找日志。
- 全量 `e2e-plan-skills.sh` 0-6 步一次全绿，纯文本改动无回归。
