# Evidence — Task 11: 前端设置页 + external 消息徽章

## Files Created/Modified
- `web/app/(main)/integrations/page.tsx` (new, 1230 lines) — channel settings page mirroring skills MCP block pattern, page-local tokens, React Query + mutations, admin-gated actions, delivery drawer
- `web/src/components/ui/chat-bubble.tsx` (modified) — added `senderType` prop + `external-channel-badge` ("外部渠道") next to author/time when senderType==='external', neutral token style
- `web/app/(main)/tasks/[id]/page.tsx` (modified) — MessageList external branch renders ChatBubble with senderType external before agent/system paths
- `web/hooks/use-realtime.ts` (modified) — RealtimeSenderType union extended with `external`

## Functionality
- Page renders 3 states: loading, empty (dashed card with "暂无渠道"), list (ChannelCard per channel)
- Cards: name, type badge (generic_webhook=blue, wecom_aibot=teal), direction badge (in/out/inout), enabled toggle (admin button vs read-only badge), endpoint summary (webhook masked targetUrl via URL parsing, wecom bound taskId or "未绑定"), actions view/edit/delete/test-send + delivery log
- Create modal: type radio default generic_webhook, conditional fields per type, direction selector, secret password inputs, taskId free-text, events checkboxes defaults ['task.status_changed','agent.question'], placeholder "•••••••• (保持不变)" on edit, filtered empty secrets before send
- Delivery drawer: GET /integrations/channels/:id/deliveries with cursor pagination, lists time/direction/status/error/externalId
- Badge: data-testid="external-channel-badge" only when senderType==='external', does not alter user/agent/system styles

## Verification
- `grep -r "data-testid=\"integration-channel-item\""` → web/app/(main)/integrations/page.tsx:195 found
- `grep -r "create-integration-channel-button"` → page.tsx:1093 found
- `grep -r "integration-delivery-drawer"` → page.tsx:819 found
- `grep "external-channel-badge"` → chat-bubble.tsx:165 and tasks page external branch found
- `grep "•••••••• (保持不变)"` → two inputs (webhook secret + wecom secret) found
- `cd web && npm run build` → Compiled successfully, page /integrations 10.1 kB, First Load 174 kB, no TS errors, only pre-existing warnings
- `npx tsc --noEmit` → clean
