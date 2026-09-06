# F4 Scope fidelity
Date: 2026-09-03
Must NOT checks:
- No dual chat: /tasks/:id has zero send/message/subscribe paths (grep verified); only outbound link is migration banner -> team session. PASS
- No task create/edit form inside team session: 创建任务 navigates to /tasks/new?teamId=; edit opens TaskInfoEditModal for current task only. PASS
- No concurrent multi-task in team: queue/FIFO untouched; single currentTaskId drives right side. PASS
- No compat/fallback branches for removed features: sweep zero; private-message fallback is transport-level (session-history->messages), not feature compat. PASS
- No out-of-scope backend changes: zero server files touched (git status). PASS
Verdict: APPROVE.
