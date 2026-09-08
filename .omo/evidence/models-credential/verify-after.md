# models-credential verify-after (2026-09-08) — NO redesign, in-flight change completed

## In-flight diff disposition (reviewed, kept whole — no half-written hunks)

- `server/src/workers/workers.service.ts` (+10): register() best-effort `syncLiveModels()`
  after capability merge, warn-only on failure. THE healer for stale-state class.
- `server/src/models/models.service.ts` (+helper, 4 tails): `resyncAfterCredentialChange()`
  in setCredential (both branches) + revokeCredential + revokeCredentialByProvider.
  Complementary trigger (new configuredSet recompute). Both triggers best-effort.
- Specs: 4 models-credential guards (all RED pre-fix, verified) + 2 register guards
  (RED pre-fix via revert-check, log kept) + shared mock `syncLiveModels` field.
- Prior closures untouched: snapshot enabled:false, sync visibility authority,
  executableModels union + legacy fallback, orphan credential/local skips.

## Root cause (user symptom, DB-timestamp proven, secrets redacted)

- opencode-go key created 06:13:15Z; 8 opencode-go rows disabled 03:19Z/04:05Z (correct
  THEN — no credential); 27 enabled rows re-enabled 06:13:41Z by the user's MANUAL sync.
- Defect = no automatic visibility recompute: setCredential only dispatched to workers;
  UI save only invalidated queries; re-register restored availability but never enabled.
  Manual POST /sync was the only healer.

## Live proof (zero manual /sync during proof window; values redacted throughout)

1. Residue cleanup: aborted-run dummy zhipuai credential revoked via API → pruned.
   Baseline: zhipuai 15/15 disabled, dropdown 34 (27 go + 7 oc).
2. Worker `restart` (Started 06:32:31Z) → re-register → auto-sync → dropdown still 34,
   bogus 0 (reregister-converge.txt). No manual sync called.
3. Dummy-key end-to-end (test key only, fingerprint masked by server, value never logged):
   save → 15s → zhipuai 15/15 visible, avail 49 (dummy-appeared.txt); worker reported
   executableModels 49 (34+15). Revoke → avail back to 34, zhipuai 0 (dummy-revoked.txt).
4. Worker restart again (Started 06:34:28Z) → replay dropped dummy from auth.json →
   report back to 34 → auto-sync pruned zhipuai to 15/15 disabled (catalog-final.txt).
   Final: opencode 7/5, opencode-go 27/8, zhipuai 0/15; dropdown==CLI-exact 34/34.
5. :13001 Playwright: 34 options incl. 27 opencode-go + nemotron-3.5-lightning-free,
   0/5 bogus (playwright.log). teams total 5 — user data intact.
6. Images: server 0e793ca35735 (build no-op — already contained change, dist-grep proven
   5×resync + 1×register-trigger in RUNNING container); worker/init/web untouched.
   Containers: server Started 06:26:42Z; worker restarted 2× (recorded); db/web untouched.
7. No manual DB edits, no reseed, no down -v. Dummy credential revoked (audit row kept
   revoked by design); user opencode-go key untouched (revoked_at NULL throughout).

## Verification

- jest models+agents 82/82; workers register 16/16 (full workers file: 5 pre-existing
  git-creds foreign reds, untouched files, recorded in models-sync learnings).
- tsc clean (0B), eslint 0 errors (1 pre-existing broadcastSpy warning, foreign region).
- Logs: jest-happy, jest-workers, jest-failingfirst (4 models guards),
  jest-failingfirst-register (2 register guards), tsc-server, eslint-server, rebuild,
  playwright, sync-*.json, *-converge.txt, catalog-final.txt.
