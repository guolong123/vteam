# 计划：重写计划编制/评审 skills（引进 OmO 提示词机制）

## TL;DR (For humans)

6 个 skills（`plan-creation` + 5 个 `plan-review-*`）正文太薄——只写了"做什么"没写"怎么做才算好"。按 OmO 原文（Prometheus/Momus/Oracle）的具体机制重写正文：编制侧补波次结构+证据要求+假设清单+反模式；评审侧统一植入 Momus 骨架（目的句+APPROVAL BIAS+PASS/FAIL 线+反模式+VERDICT 上限+输出格式）+ Oracle 篇幅上限与范围纪律，各角色只保留差异化的检查清单。

## 决策来源（用户确认）

- 用户原话：「技能描述过于简单了，先看看当前omo的计划和评审的提示词怎么写的」→ 对照后确认重写；「动手」批准执行。
- 沿用约束：只换 seed 文本，不碰 dispatch/guard/MCP/worker；保持代码干净。

## 已确认事实（本会话）

- OmO 原文：Momus（目的界定+APPROVAL BIAS+4 具化检查+反模式✅❌+裁决框架+输出格式）、Oracle（务实极简决策框架+三档输出+篇幅硬上限+不确定性处理+范围纪律）、Prometheus（explore-first+并行波次+审批门+决策完备计划）。
- 现状：`plan-creation` 约 1400 字（7 步骤标题各 1-2 句）；各 `plan-review-*` 约 700 字（"风格参照 momus"仅一句话，无具体机制）。
- Skill 名/frontmatter/`allowed-tools` 不变；只换 `content` 正文。
- Seed upsert 按 name 幂等覆盖；worker 注入读 DB content，无需改注入器。

## 冻结设计（改写提纲，唯一事实源）

### D1 `plan-creation` 新增（保留现有 7 步骨架，逐项加厚）
1. **波次结构**（Prometheus）：第 1 波拿任务+成员清单；第 2 波并行读关键文件/产出物；第 N 波收敛；每波只回答本波问题、不臆测、不提前下结论。
2. **证据要求**：每项附证据（文件路径/成员输入/群聊结论），无证据项标假设。
3. **假设清单段**：所有"按最佳实践直接决策"的项集中列出，供评审重点质疑。
4. **反模式**：不虚构并行度（已有一句，保留并加例）；不臆测成员能力（以 task_context 为准）；不写无验收项；一次只出一份计划。
5. **送审预判**：评审者按 APPROVAL BIAS 判定（存疑放行、只拦真阻塞），编制时对"能开工"负责、不对"完美"负责。

### D2 五个 `plan-review-*` 统一骨架（Momus 机制，各角色只换检查清单）
每个 skill 必须含（措辞按角色微调，结构一致）：
1. **目的句**：只回答"计划能否不卡住地执行"，存疑时 APPROVE（APPROVAL BIAS）。
2. **检查项 + PASS/FAIL 线**：沿用各角色现有 3 条视角，但每条补"什么算过/什么不算"（如开发-可执行性：PASS=至少知道从哪下手；FAIL=零上下文无法开工）。
3. **反模式**：明确非 blocker 清单（"可以更清楚"不是 blocker；引用的文件不存在才是），REJECT 上限 3 条，每条须具体（章节+改什么）。
4. **输出格式**：`VERDICT: APPROVE/REJECT` 首行 + 依据（Oracle 篇幅上限：每条 ≤2 句；总量封顶）。
5. **范围纪律**（Oracle）：不 redesign、不扩面；拿不准则显式声明假设或只问 1 个精确问题。
6. **禁令保留**：只读评审、不改文件、不执行（已有，保留）。

### D3 联动与一致性
- `plan-creation` 步骤 7 注明评审尺度（APPROVAL BIAS），编制者预判。
- 6 个 skill 互相 cross-ref（已有一处，保持）。
- `allowed-tools`/frontmatter/`description` 不变。

## Todos

- [x] 1. [seed] 重写 6 个 skills 正文 + 断言补强
  References: `server/prisma/seed.ts`（BUILTIN_SKILLS 内 6 段 content）、`server/src/prisma/seed.spec.ts`
  Acceptance: `plan-creation` 含 D1 五要素（波次/证据/假设清单/反模式/送审预判）；5 个 review skill 含 D2 六要素且检查清单各异；`allowed-tools`/frontmatter 不变；spec 新增断言覆盖新机制关键词（如 APPROVAL/APPROVE BIAS/最多 3 条/篇幅上限/范围纪律）与旧约束（禁改文件、VERDICT 格式）仍在。
  QA: happy - seed 后 DB content 含新机制段落；`npx jest src/prisma/seed.spec.ts` 全绿。failure - 任一要素缺失即失败。Evidence: `.omo/evidence/plan-skills-rewrite/content-diff.txt`。
  Commit: `feat(seed): flesh out plan skills with OmO review doctrine`
  Recommended task executor category: writing

- [x] 2. [e2e] 重 seed + 注入验证 + 一次真实评审回归
  References: `scripts/e2e-plan-skills.sh`（范式）
  Acceptance: 重跑 seed 后 workdir 6 份 SKILL.md 为新版（含 APPROVAL BIAS/反模式关键词抽查）；一次真实单评审者 live smoke 仍产出可解析 VERDICT（措辞/长度符合新篇幅纪律可定性观察，不做硬断言）；旧 e2e 全步骤仍 PASS。
  QA: happy - 注入验证 + smoke 通过；failure - 任一失败即失败。Evidence: `.omo/evidence/plan-skills-rewrite/e2e.txt`。
  Commit: `test(e2e): rewritten plan skills`
  Recommended task executor category: unspecified-high

## Final verification wave

- [x] F1. 计划合规审计 — Todos 全合入；D1/D2 要素逐项有落点；References 真实存在。Evidence: `.omo/evidence/plan-skills-rewrite/F1-plan-audit.txt`。
  Recommended task executor category: unspecified-high
- [x] F2. 代码质量 review — 无 `as any`/`@ts-ignore`/stub；文本改动无机制回归；无 AB 双轨/退役说明。Evidence: `.omo/evidence/plan-skills-rewrite/F2-code-quality.txt`。
  Recommended task executor category: unspecified-high
- [x] F3. 真实手工 QA — DB/注入内容抽查 + 一次真实评审（VERDICT 可解析；定性确认新纪律生效，如 REJECT 条数受控、篇幅收敛）。Evidence: `.omo/evidence/plan-skills-rewrite/F3-manual-qa.txt`。
  Recommended task executor category: unspecified-high
- [x] F4. 范围保真 — 仅 seed 文本 + spec；dispatch/guard/MCP/worker/web 零改动。Evidence: `.omo/evidence/plan-skills-rewrite/F4-scope-fidelity.txt`。
  Recommended task executor category: unspecified-high

## Success criteria

- `cd server && npx tsc -p tsconfig.json --noEmit` exit 0；`seed.spec` 全绿。
- 6 份 SKILL.md 为新版并注入 workdir。
- 一次真实评审 VERDICT 可解析。
