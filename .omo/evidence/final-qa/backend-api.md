# F3 Manual QA — A. Backend API Results

Date: 2026-08-07 | Server: http://localhost:3000 | Login: admin/admin123

| # | Scenario | Result | Evidence |
|---|----------|--------|----------|
| A1 | GET /agents?type=template → 4 items with skillIds/toolEffects/permissionScope | PASS | a1_agents_template.json: 4 items (a_product, a_architect, a_developer, a_tester), each with skillIds + toolEffects + permissionScope fields |
| A2 | POST /agents/a_product/clone → baseAgentId=a_product; PATCH template → 403 | PASS | clone HTTP 201, id=a_0000000002, type=clone, baseAgentId=a_product; PATCH a_product → 403 PERMISSION_AGENT_READONLY |
| A3 | POST /tasks/:id/artifacts v1 → archived; same content → duplicate; new content → v2 | PASS | art_0000000006: POST v1 → {status:archived, currentVersion:1}; same content → {status:duplicate, currentVersion:1}; new content → currentVersion:2 |
| A4 | Acceptance chain: mark-pending-review → accept → acceptedFlag=true → append new → 409 | PASS | t_0000000004: start 201 → mark-pending-review 201 → accept 201 (status=completed); GET artifacts shows art_0000000006 acceptedFlag=true; POST same-title new content → 409 ARTIFACT_ACCEPTED_IMMUTABLE (v2 locked) |
| A5 | Filters type=doc / accepted=true; GET /artifacts/:id; GET /artifacts/:id/versions/:version | PASS | t_0000000002 type=doc → 1 (art_0000000005 doc); accepted=true on t_4 → 2 (both acceptedFlag=true); GET detail returns versions[]; GET versions/2 returns sha256 + acceptedFlag:true |
| A6 | GET /roles → admin/member; PATCH builtin → 403 | PASS | r_admin (builtin:True), r_member (builtin:True); PATCH r_admin → 403 FORBIDDEN_BUILTIN_ROLE |
| A7 | Invalid artifact type:'bogus' → 400 | PASS | HTTP 400 "type must be one of the following values: text, doc, file" |

**A Summary: 7/7 PASS**

Notes:
- A4 requires state machine: pending → start → in_progress → mark-pending-review → pending_review → accept → completed
- 409 immutable check is per-artifact (matched by title/content bucket): appending a NEW title after accept creates a new artifact (by design); appending to the SAME accepted artifact returns 409
