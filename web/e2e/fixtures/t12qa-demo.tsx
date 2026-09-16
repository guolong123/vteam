/**
 * T12 docs-unified.spec.ts 原型 fixture 源码（docs-artifacts-merge）。
 * 部署：将此文件拷入 server 容器 `/app/uploads/t12qa-demo.tsx`
 * （`docker cp web/e2e/fixtures/t12qa-demo.tsx aiagents-compose-server:/app/uploads/`），
 * 再经 `POST /tasks/:id/artifacts {type:'file', fileRef:'/uploads/t12qa-demo.tsx'}`
 * 注册（tsx 不在 uploads 白名单，不可经 /uploads 上传）。
 * contentRef 文件名决定原型 id（`t12qa-demo`）与 file（`t12qa-demo/index.tsx`）。
 */
export const meta = { id: "t12qa-demo", name: "t12qa-demo" };

export default function T12Demo() {
  return "t12qa demo prototype";
}
