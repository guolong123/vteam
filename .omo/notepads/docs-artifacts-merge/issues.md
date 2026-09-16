# Issues — docs-artifacts-merge

Problems and gotchas encountered during work on this plan.

---

## T3 gotcha (2026-09-16)
- 初版 spec 把 `prototypeSlug('t', 'art_1', '/uploads/.tsx')`
  误期望为 `proto-art1`；old/new 双跑证明实际为 `'t'`（强标题 slug 路径），
  已修正并锁定。教训：弱名回退只在 `slug===''||slug==='doc'` 时触发，
  非空强标题直接返回，不看文件名是否为空。

## T11 gotcha (2026-09-16)
- 注入属性 `prototypes` 与控制器方法 `prototypes()` 同名 → TS2341 属性遮蔽，
  suite 级编译失败（93 tests pass 但 1 suite fail 的形态）。教训：Nest 控制器里
  注入服务若与路由方法同名必须另名属性；CI 门应同时看 suite 数与 test 数。
- `docker cp` overlay 不删文件：首次进容器构建后 `src/docs-site/` 新旧并存，
  须容器内手动 `rm` 两个镜像文件再 `nest build`。教训：overlay 后先 `ls` 对
  名单再构建。
