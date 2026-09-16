# Issues — docs-artifacts-merge

Problems and gotchas encountered during work on this plan.

---

## T3 gotcha (2026-09-16)
- 初版 spec 把 `prototypeSlug('t', 'art_1', '/uploads/.tsx')`
  误期望为 `proto-art1`；old/new 双跑证明实际为 `'t'`（强标题 slug 路径），
  已修正并锁定。教训：弱名回退只在 `slug===''||slug==='doc'` 时触发，
  非空强标题直接返回，不看文件名是否为空。
