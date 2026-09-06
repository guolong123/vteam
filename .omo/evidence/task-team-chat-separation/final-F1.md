# F1 Plan compliance audit
Date: 2026-09-03
- T1 drawer skeleton: board onOpen opens TaskDetailDrawer, no /tasks/:id push (grep: only /tasks/new remains), drawer has 进入团队会话 -> team session. PASS
- T2 drawer data: 5 queries (task/artifacts/issues/plans/team), empty states, queue hint, TaskStatusActions, no chat refs. PASS
- T3 strip chat: MessageList/MentionHint/MessageInput/ChatHeader/private-tabs/send/DM/channel code removed (4525->~1720 lines incl extractions); detail center + MembersPanel + right panel + modals + task-scoped SSE kept. tsc+eslint clean. PASS
- T4 members+private: shared TeamMembersPanel (chip/enable/reset/add/menu) + private tabs teamMember dimension + auth guard + instance->member mapping (live-verified). PASS
- T5 panels+modals: resizable L/R + ResizeHandle, Question/IssueDetail/TaskEdit/Review dialogs + PlanSection, realtime team:+channel:(+task/global). PASS
- T6 right tabs: TaskRightTabs currentTaskId-driven + queue/memory/plan cards + empty state + deep-edit chip. PASS
- T7 cleanup: zero empty catch, zero legacy/flag remnants, all catches log, build PASS. PASS
- T8 nav/docs: entries unified, old copy zero, e2e updated, docs+README updated, build PASS, jest pre-existing fails itemized. PASS
Success criteria (4 bullets): all met and live-verified (F3).
Deviations: subagent spawn blocked (harness lineage error) -> orchestrator implemented directly, recorded in task-1..8 logs; shared-component extraction (beyond plan letter) to avoid duplication; send DTO `text` fix (pre-existing `content` bug); e2e fixture pattern (fixed ids absent from seed).
Verdict: APPROVE.
