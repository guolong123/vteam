# F2 Code quality review
Date: 2026-09-03
- `as any`/`@ts-ignore`: zero in all new/moved web code (precise casts + typed queries; TeamDto/TeamQueueDto/TaskApiStatus/PlanWithTasks used). tsc clean.
- No feat flags/legacy branches/commented code (sweep clean).
- No empty catch; error paths log with ids or surface UI copy.
- Shared components extracted (TeamMembersPanel/ResizeHandle/TeamRightPanel/TaskInfoEditModal/PlanSection/ReviewDialog/task-detail-types) - tasks page + team session reuse, no duplication.
- Conventions: design tokens, data-testids, absolute-position overlays (T15), Chinese UI copy consistent.
- Left as-is (pre-existing, out of scope): task-status-actions eslint-disables, messages/* legacy surface copy, TaskPanel hidden legacy in tasks page, pages.spec unused imports.
Verdict: APPROVE.
