## Cleanup receipt (2026-09-17)

- container probes removed: /tmp/fixprobe, /tmp/fixprobe2, /tmp/{container-probe,force-error,e2e-extract,e2e2}.mjs, /tmp/{probe-serve,probe-stdout,p.out,p.err}.log
- host probes removed: /tmp/{adversarial-check,live-probe,buffer-proof,stale-qa,container-probe,force-error,e2e-extract,e2e2}.mjs, /tmp/{oc.log,fix.diff,tc.out,test.out,b.log,t.log...}
- NO config changes (docker-compose.yml, Dockerfile, .env untouched)
- NO DB rows/temp SQL created (live proof used a throwaway opencode session, no platform rows)
- NO probe process left (docker compose build canceled; serve probes stopped via server.stop())
- Working tree: only worker/src/** (+ specs) and the two .omo evidence/notepad dirs are newly changed by this task.

### git status --short delta vs baseline (44 -> 60)
New-by-this-task:
  M worker/src/runtime/opencode-server.ts (+ new serve-log.ts, port-probe.ts)
  M worker/src/runtime/opencode-server.spec.ts
  M worker/src/driver/prompt-await.ts / prompt-await.spec.ts
  M worker/src/exec/exec-server.ts / exec-server.spec.ts
  M worker/src/index.ts
  ?? .omo/evidence/trigger-failure-recording/
  ?? .omo/notepads/trigger-failure-recording/
NOT mine (sibling task / pre-existing WIP): server/** , web/** , worker/src/resources/**, worker/src/role-guard/**, .omo/{boulder,ledger,evidence/*}
