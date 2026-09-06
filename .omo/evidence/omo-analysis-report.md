# OMO (oh-my-openagent) 实现机制分析报告

**分析日期**: 2026-08-23
**分析目标**: 理解 OMO 的 agent 约束、提示词策略、计划模式，为强化 vteam agent 提供参考

---

## 一、OMO 核心架构概览

OMO 是一个**多 agent 协作操作系统**，核心组件包括：

| 组件 | 包名 | 功能 |
|------|------|------|
| **Prompts Core** | `prompts-core` | 系统提示词管理，支持多模型变体 |
| **Rules Engine** | `rules-engine` | 动态规则加载和匹配引擎 |
| **Team Core** | `team-core` | 团队协作模式，多 agent 通信 |
| **Skills Loader** | `skills-loader-core` | 技能加载和匹配 |
| **Config Core** | `omo-config-core` | 配置 schema 和管理 |

---

## 二、Agent 约束机制分析

### 2.1 规则引擎 (Rules Engine)

OMO 的规则引擎是其核心约束机制：

**规则来源优先级** (从高到低)：
```
.omo/rules          -> 优先级 0 (最高)
.claude/rules       -> 优先级 1
.cursor/rules       -> 优先级 2
.github/instructions -> 优先级 3
.sisyphus/rules     -> 优先级 5
~/.omo/rules        -> 优先级 100 (全局)
~/.opencode/rules   -> 优先级 101
~/.claude/rules     -> 优先级 102
```

**规则文件格式** (Frontmatter + Body)：
```markdown
---
description: 规则描述 (用于去重)
globs:           # 文件匹配模式
  - "**/*.test.ts"
  - "src/**/*.ts"
paths:           # 路径匹配
  - "src/modules/**"
applyTo:         # 应用目标
alwaysApply: true/false  # 是否始终应用
---

# 规则内容 (Markdown)

具体的约束指令...
```

**规则匹配机制**：
- 静态规则：项目启动时加载，基于 `globs`/`paths` 匹配
- 动态规则：编辑文件时实时匹配，基于当前操作的文件路径
- 规则截断：防止规则过长，有 `maxRuleChars` 和 `maxResultChars` 限制

**示例规则** (`.omo/rules/test-discipline.md`)：
```markdown
---
description: Test discipline - fires when reading or editing any test file
globs:
  - "**/*.test.ts"
  - "**/*.test.tsx"
---

# Test Discipline (NON-NEGOTIABLE)

**Every test in this repo MUST pass `bun test` in one process, in one go...**
```

### 2.2 Agent 资格注册表 (Agent Eligibility Registry)

OMO 定义了严格的 agent 资格检查：

```typescript
const AGENT_ELIGIBILITY_REGISTRY = {
  sisyphus: { verdict: "eligible" },           // 主 agent，可参与团队
  atlas: { verdict: "eligible" },              // 可参与团队
  "sisyphus-junior": { verdict: "eligible" },  // 可参与团队
  
  oracle: {
    verdict: "hard-reject",                    // 禁止参与团队
    rejectionMessage: "Agent 'oracle' is read-only..."
  },
  librarian: { verdict: "hard-reject" },       // 只读，禁止
  explore: { verdict: "hard-reject" },         // 只读，禁止
  prometheus: {
    verdict: "hard-reject",                    // 只能在 plan 模式
    rejectionMessage: "Agent 'prometheus' is plan-mode-only..."
  },
}
```

### 2.3 团队模式约束 (Team Mode Constraints)

团队模式有严格的运行时约束：

```typescript
const RuntimeBoundsSchema = z.object({
  maxMembers: z.number().int().default(8),           // 最大成员数
  maxParallelMembers: z.number().int().default(4),   // 最大并行成员
  maxMessagesPerRun: z.number().int().default(10000), // 最大消息数
  maxWallClockMinutes: z.number().int().default(120), // 最大运行时间
  maxMemberTurns: z.number().int().default(500),      // 最大轮次
})
```

---

## 三、提示词策略分析

### 3.1 Ultrawork 模式 (核心工作模式)

**关键约束**：

1. **确定性要求** (MANDATORY CERTAINTY PROTOCOL)：
   ```
   YOU MUST NOT START ANY IMPLEMENTATION UNTIL YOU ARE 100% CERTAIN.
   
   BEFORE YOU WRITE A SINGLE LINE OF CODE, YOU MUST:
   - FULLY UNDERSTAND what the user ACTUALLY wants
   - EXPLORE the codebase to understand existing patterns
   - HAVE A CRYSTAL CLEAR WORK PLAN
   - RESOLVE ALL AMBIGUITY
   ```

2. **零容忍失败** (ZERO TOLERANCE FAILURES)：
   ```
   | VIOLATION | CONSEQUENCE |
   |-----------|-------------|
   | "I couldn't because..." | UNACCEPTABLE. Find a way or ask for help. |
   | "This is a simplified version..." | UNACCEPTABLE. Deliver the FULL implementation. |
   | "You can extend this later..." | UNACCEPTABLE. Finish it NOW. |
   | "Due to limitations..." | UNACCEPTABLE. Use agents, tools, whatever it takes. |
   | "I made some assumptions..." | UNACCEPTABLE. You should have asked FIRST. |
   ```

3. **计划代理强制调用** (MANDATORY PLAN AGENT INVOCATION)：
   ```
   YOU MUST ALWAYS INVOKE THE PLAN AGENT FOR ANY NON-TRIVIAL TASK.
   
   | Condition | Action |
   |-----------|--------|
   | Task has 2+ steps | MUST call plan agent |
   | Task scope unclear | MUST call plan agent |
   | Implementation required | MUST call plan agent |
   | Architecture decision needed | MUST call plan agent |
   ```

4. **验证保证** (VERIFICATION GUARANTEE)：
   ```
   NOTHING is "done" without PROOF it works.
   
   每个场景需要 TWO captured artifacts:
   - RED→GREEN proof (测试失败→通过)
   - Real-surface artifact (实际用户界面)
   ```

5. **TDD 工作流** (MANDATORY)：
   ```
   Test-first is not optional for code.
   1. RED: Write the failing test FIRST
   2. GREEN: Write the SMALLEST change that flips RED→GREEN
   3. SURFACE: Exercise the real user-facing surface
   4. REFACTOR: Optional, only if needed
   5. REGRESSION: Re-run the FULL scenario list
   ```

### 3.2 Prometheus 模式 (计划模式)

**核心约束**：
```
You are Prometheus, a planning consultant. Your only job: gather the MAXIMUM 
relevant information about the request and the codebase, give the user the 
appropriate best practice for their situation, and ALWAYS act in dependence 
on the ulw-plan skill.

You are a PLANNER. You read, search, and write only plan artifacts under 
`.omo/`; you never implement - not directly and not by proxy.
```

**计划输出格式**：
- 计划存储在 `.omo/*.md`
- 不直接实现，只输出计划
- 计划需要用户通过 `/start-work` 启动执行

### 3.3 团队模式提示词

```
[team-mode]
Team-mode reference detected. Orchestrate via team_* tools (team_create -> 
team_task_create + team_send_message); NEVER substitute with delegate_task — 
it is not equivalent.

After every team_task_update that completes or fails a task, re-check 
team_task_list: if every task is terminal, run the closure sequence 
(team_shutdown_request + team_approve_shutdown per active member, then 
team_delete) in the same turn.

Closing the team is the lead's responsibility, not the user's.
```

---

## 四、计划模式分析

### 4.1 Hyperplan (对抗性多 Agent 计划)

**7 阶段工作流**：

| 阶段 | 名称 | 描述 |
|------|------|------|
| Phase 0 | Acknowledge | 确认请求，创建 todo |
| Phase 1 | Spawn Team | 创建 5 人对抗团队 |
| Phase 2 | Round 1 | 独立分析，每个成员产生 findings |
| Phase 3 | Round 2 | 交叉攻击，互相攻击 findings |
| Phase 4 | Round 3 | 防御、改进或放弃 |
| Phase 5 | Distillation | 蒸馏出可辩护的洞察 |
| Phase 6 | Plan Handoff | **强制**交给 plan agent 制定计划 |
| Phase 7 | Cleanup | 清理团队资源 |

**5 个对抗角色**：

| 角色 | 分类 | 攻击向量 |
|------|------|----------|
| **Skeptic** | unspecified-low | 过度工程、复杂性 |
| **Validator** | unspecified-high | 边缘情况、集成问题 |
| **Researcher** | deep | 假设、缺乏证据 |
| **Architect** | ultrabrain | 架构问题、耦合 |
| **Creative** | artistry | 传统思维、缺乏想象力 |

**关键约束**：
```
CRITICAL SEPARATION: You (the Lead) distill the surviving insights in Phase 5, 
but you DO NOT write the work plan. The work plan is produced by the plan agent 
in Phase 6 — this handoff is mandatory, not optional.
```

### 4.2 计划代理 (Plan Agent)

**输入**：
- Hyperplan 蒸馏的洞察包
- 包含：硬约束、决策、风险、开放问题

**输出**：
- 并行任务图 (waves + dependencies)
- 结构化 TODO 列表
- 每个任务的 category + skills
- 成功标准

---

## 五、当前 vteam Agent 的不足

### 5.1 缺少规则引擎

**现状**：vteam 没有 `.omo/rules` 目录，没有定义任何规则

**影响**：
- Agent 行为没有约束
- 没有文件匹配规则
- 没有动态规则加载

### 5.2 缺少系统提示词

**现状**：vteam 只有简单的 `AGENTS.md` (Next.js 自动生成)

**影响**：
- 没有确定性要求
- 没有零容忍约束
- 没有 TDD 工作流
- 没有验证保证

### 5.3 缺少计划模式

**现状**：vteam 没有计划模式配置

**影响**：
- 任务没有分解
- 没有依赖分析
- 没有并行优化

### 5.4 缺少团队模式

**现状**：vteam 没有团队协作配置

**影响**：
- 无法多 agent 协作
- 没有角色分工
- 没有对抗性审查

### 5.5 缺少技能系统

**现状**：vteam 没有定义技能

**影响**：
- 无法复用最佳实践
- 没有标准化工作流

---

## 六、强化建议方案

### 6.1 创建规则引擎

**目录结构**：
```
vteam/
├── .omo/
│   ├── rules/
│   │   ├── code-quality.md          # 代码质量规则
│   │   ├── test-discipline.md       # 测试纪律规则
│   │   ├── commit-convention.md     # 提交规范
│   │   ├── api-design.md            # API 设计规则
│   │   └── security.md              # 安全规则
│   ├── evidence/                    # 已有
│   └── drafts/                      # 已有
```

**示例规则文件** (`.omo/rules/code-quality.md`)：
```markdown
---
description: Code quality rules for vteam project
globs:
  - "server/src/**/*.ts"
  - "web/src/**/*.{ts,tsx}"
alwaysApply: false
---

# Code Quality Rules (NON-NEGOTIABLE)

## TypeScript 严格模式
- 禁止使用 `any` 类型
- 所有函数必须有返回类型
- 使用 `interface` 而不是 `type` (除非需要 union/intersection)

## 错误处理
- 所有 async 函数必须有 try-catch
- 错误必须包含上下文信息
- 使用自定义错误类

## 命名规范
- 变量/函数：camelCase
- 类/接口：PascalCase
- 常量：UPPER_SNAKE_CASE
- 文件名：kebab-case
```

### 6.2 创建系统提示词

**文件**：`.omo/prompts/ultrawork.md`

```markdown
<vteam-ultrawork-mode>

**MANDATORY**: You MUST say "VTEAM WORK MODE ENABLED!" to the user as your first response.

[CODE RED] Maximum precision required. Ultrathink before acting.

## ABSOLUTE CERTAINTY REQUIRED

**YOU MUST NOT START ANY IMPLEMENTATION UNTIL YOU ARE 100% CERTAIN.**

| BEFORE YOU WRITE A SINGLE LINE OF CODE, YOU MUST: |
|---------------------------------------------------|
| FULLY UNDERSTAND what the user ACTUALLY wants |
| EXPLORE the codebase to understand existing patterns |
| HAVE A CRYSTAL CLEAR WORK PLAN |
| RESOLVE ALL AMBIGUITY |

## ZERO TOLERANCE FAILURES

| VIOLATION | CONSEQUENCE |
|-----------|-------------|
| "I couldn't because..." | UNACCEPTABLE. Find a way or ask for help. |
| "This is a simplified version..." | UNACCEPTABLE. Deliver the FULL implementation. |
| "You can extend this later..." | UNACCEPTABLE. Finish it NOW. |
| "I made some assumptions..." | UNACCEPTABLE. You should have asked FIRST. |

## MANDATORY: PLAN AGENT INVOCATION

**YOU MUST ALWAYS INVOKE THE PLAN AGENT FOR ANY NON-TRIVIAL TASK.**

| Condition | Action |
|-----------|--------|
| Task has 2+ steps | MUST call plan agent |
| Task scope unclear | MUST call plan agent |
| Implementation required | MUST call plan agent |

## TDD WORKFLOW (MANDATORY)

Test-first is not optional for code:
1. **RED**: Write the failing test FIRST
2. **GREEN**: Write the SMALLEST change that flips RED→GREEN
3. **SURFACE**: Exercise the real user-facing surface
4. **REFACTOR**: Optional, only if needed
5. **REGRESSION**: Re-run the FULL scenario list

## VERIFICATION GUARANTEE

**NOTHING is "done" without PROOF it works.**

Every scenario requires TWO captured artifacts:
- RED→GREEN proof (测试失败→通过)
- Real-surface artifact (实际用户界面)

**CLAIM NOTHING WITHOUT PROOF. EXECUTE. VERIFY. SHOW EVIDENCE.**

</vteam-ultrawork-mode>
```

### 6.3 创建计划模式配置

**文件**：`.omo/prompts/plan-mode.md`

```markdown
<plan-mode>

You are a planning consultant. Your only job: gather the MAXIMUM relevant 
information about the request and the codebase, give the user the appropriate 
best practice for their situation.

You are a PLANNER. You read, search, and write only plan artifacts under 
`.omo/plans/`; you never implement - not directly and not by proxy.

## PLAN OUTPUT FORMAT

```markdown
# Plan: [Task Title]

## Overview
[一句话描述]

## Scenarios
| # | Scenario | Pass Condition | Evidence |
|---|----------|----------------|----------|
| S1 | Happy path | [具体条件] | [证据类型] |
| S2 | Edge case | [具体条件] | [证据类型] |

## Task Breakdown (Parallel Waves)

### Wave 1 (Independent)
- [ ] T1: [Task description] — verify by [check]
- [ ] T2: [Task description] — verify by [check]

### Wave 2 (After Wave 1)
- [ ] T3: [Task description] — verify by [check]

## Dependencies
- T3 depends on T1, T2

## Success Criteria
- [ ] All scenarios PASS
- [ ] All artifacts captured
- [ ] Code review approved
```

## CONSTRAINTS

- Every task MUST have explicit success criteria
- Every dependency MUST be documented
- Every scenario MUST have pass condition as binary observable
- NEVER implement, only plan

</plan-mode>
```

### 6.4 创建技能系统

**目录结构**：
```
vteam/
├── .omo/
│   ├── skills/
│   │   ├── api-development/
│   │   │   ├── SKILL.md
│   │   │   └── scripts/
│   │   ├── frontend-dev/
│   │   │   ├── SKILL.md
│   │   │   └── references/
│   │   ├── testing/
│   │   │   ├── SKILL.md
│   │   │   └── scripts/
│   │   └── deployment/
│   │       ├── SKILL.md
│   │       └── scripts/
```

**示例技能** (`.omo/skills/api-development/SKILL.md`)：
```markdown
---
name: api-development
description: "NestJS API development skill with validation, error handling, and testing"
---

# API Development Skill

## WHEN TO USE
- Creating new API endpoints
- Modifying existing endpoints
- Adding validation
- Implementing error handling

## WORKFLOW

### 1. Design First
- Define request/response schema
- Document error cases
- Plan test scenarios

### 2. Implement
- Create DTO with validation
- Implement service logic
- Add error handling
- Write controller

### 3. Test
- Unit tests (service)
- Integration tests (endpoint)
- E2E tests (full flow)

### 4. Verify
- Run all tests
- Check lint
- Verify types

## CONSTRAINTS
- All endpoints MUST have validation
- All errors MUST be handled
- All functions MUST have tests
- All APIs MUST be documented
```

### 6.5 创建团队模式配置

**文件**：`.omo/teams/dev-team.json`

```json
{
  "version": 1,
  "name": "vteam-dev",
  "description": "VTeam development team",
  "leadAgentId": "lead",
  "members": [
    {
      "name": "lead",
      "kind": "subagent_type",
      "subagent_type": "sisyphus",
      "prompt": "You are the team lead. Orchestrate and delegate tasks."
    },
    {
      "name": "backend",
      "kind": "category",
      "category": "ultrabrain",
      "prompt": "You are a backend specialist. Focus on NestJS, TypeScript, and API design."
    },
    {
      "name": "frontend",
      "kind": "category",
      "category": "visual-engineering",
      "prompt": "You are a frontend specialist. Focus on React, Next.js, and UI/UX."
    },
    {
      "name": "tester",
      "kind": "category",
      "category": "unspecified-high",
      "prompt": "You are a QA specialist. Focus on testing, edge cases, and quality assurance."
    }
  ],
  "teamAllowedPaths": ["server/**", "web/**"],
  "sessionPermission": "write"
}
```

### 6.6 创建配置文件

**文件**：`.omo/config.json`

```json
{
  "$schema": "https://omo.dev/schema/config.json",
  "categories": {
    "ultrabrain": {
      "description": "High-reasoning model for complex tasks",
      "model": "gpt-5.6-sol",
      "reasoning": "high"
    },
    "visual-engineering": {
      "description": "Frontend and UI specialist",
      "model": "claude-opus-5",
      "reasoning": "medium"
    },
    "unspecified-high": {
      "description": "General high-quality model",
      "model": "kimi-k3",
      "reasoning": "high"
    }
  },
  "agents": {
    "sisyphus": {
      "description": "Main orchestrator agent",
      "tools": {
        "team_create": true,
        "team_send_message": true,
        "task": true
      }
    }
  },
  "teams": {
    "dev-team": "./teams/dev-team.json"
  },
  "skills": {
    "sources": [".omo/skills"],
    "enable": ["api-development", "frontend-dev", "testing", "deployment"]
  }
}
```

---

## 七、实施优先级

| 优先级 | 任务 | 工作量 | 影响 |
|--------|------|--------|------|
| **P0** | 创建 `.omo/rules/` 目录和规则 | 2-3 小时 | 高 - 立即约束 agent 行为 |
| **P0** | 创建系统提示词 | 1-2 小时 | 高 - 强制执行纪律 |
| **P1** | 创建计划模式 | 2-3 小时 | 高 - 结构化任务分解 |
| **P1** | 创建技能系统 | 3-4 小时 | 中 - 复用最佳实践 |
| **P2** | 创建团队模式 | 2-3 小时 | 中 - 多 agent 协作 |
| **P2** | 创建配置文件 | 1 小时 | 中 - 统一配置管理 |

---

## 八、预期效果

### 8.1 约束 Agent 行为
- ✅ 通过规则引擎动态加载约束
- ✅ 通过系统提示词强制执行纪律
- ✅ 通过 TDD 工作流保证质量

### 8.2 改进计划模式
- ✅ 结构化任务分解
- ✅ 并行优化
- ✅ 依赖分析
- ✅ 明确的成功标准

### 8.3 提升代码质量
- ✅ 强制测试覆盖
- ✅ 验证保证
- ✅ 零容忍失败

### 8.4 支持团队协作
- ✅ 角色分工
- ✅ 对抗性审查
- ✅ 知识共享

---

## 九、总结

OMO 的核心价值在于：

1. **约束机制**：通过规则引擎和系统提示词强制 agent 行为
2. **计划模式**：通过结构化计划保证任务分解和执行质量
3. **团队协作**：通过多 agent 协作提升复杂任务的处理能力
4. **技能复用**：通过技能系统沉淀最佳实践

vteam 应该借鉴 OMO 的这些机制，建立自己的约束和协作体系，以解决当前 agent 行为不受约束、计划简陋的问题。

---

**下一步行动**：
1. 立即创建 `.omo/rules/` 目录和基础规则
2. 创建系统提示词文件
3. 创建计划模式配置
4. 逐步建立技能系统和团队模式
