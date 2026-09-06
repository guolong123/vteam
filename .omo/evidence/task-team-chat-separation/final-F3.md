# F3 Real manual QA (live browser, agent-executed)
Date: 2026-09-03
Boot: throwaway mysql:8 docker (vteam-qa-db:3306) + prisma migrate deploy + seed + nest backend:3000 (MODEL_CREDENTIAL_KEY generated) + next dev:3001. All removed after QA (receipts below).

Live Playwright results (real backend + seeded + fixture data):
- setup (seed-admin login): PASS
- 4b/17 board-drawer (NEW): PASS - card click opens task-detail-drawer, URL stays /board, enter-team-session-drawer visible, Esc closes
- 7/17 task-detail (rewritten, self-provisioning API fixture): PASS - header/meta/toolbar visible, chat-message-list count 0
- 7b/17 team-session (NEW): PASS - root/members/dm-tabs/group-tab/message-list visible; private tab switches (data-active=true, placeholder names member); right tabs status/config/output switch
- Full pages+guard+login: 34 passed, 4 failed in UNTOUCHED pages (3/17 task-create agent-option, 12/17 skills, 17/18 workers, 18/18 models) - pre-existing seed/backend drift, unrelated files, not fixed per scope rule

Bug found & fixed live: private-tab DM cited task-instance id (ta_*) -> 404 团队成员不存在; fixed instance->team-member mapping (agentId+seq, tmm_ passthrough) in handlePrivateTab; re-verified PASS + screenshot.

Artifacts: screens/board-drawer.png, task-detail.png, team-session.png, team-private.png (all visually inspected PASS).

Adversarial probes:
- stale_state: group->private->group tab switches keep correct lists (7b) - PASS
- dirty_worktree: QA fixtures lived only in throwaway docker DB (removed); repo tree: only plan todo files changed - PASS
- misleading_success_output: screenshots inspected, not just assertions - PASS
- flaky: suite re-ran green 3x (7/7b/4b set) - PASS
- hung/cancel/interrupt: N/A (no long flows)

Cleanup receipts: nest procs 0, next-server procs 0, vteam-qa-db container removed (docker ps 0). /tmp logs + test-results remain (gitignored).
