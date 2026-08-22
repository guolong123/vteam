# Plan: Agent DM Tabs (Scheme C) — Inline Tabs on Task Page

## Context
- Current private chat is heavy: `tasks/[id]` → `POST /dm-channels` + `router.push(/messages/:id)` → full page `messages/[id]` reloads 4 queries, loses task scroll/state.
- User selected Scheme C (Tabs): stay on current task page, switch MessageList data source via tabs `群聊 | 私聊: <alias>` with same component.

## Scope
- Only `web/app/(main)/tasks/[id]/page.tsx` and related chat components; no new routes.
- Reuse `fetchChannelMessages` + `mergeSnapshotWithLive` for private; no new API.
- Keep `POST /dm-channels` idempotent.

## Todos
- [x] 1. Add Tabs UI state and channel resolution in tasks page
- [x] 2. Fetch private channel messages per-tab with separate react-query keys
- [x] 3. Wire realtime scope to include active private channel
- [x] 4. Route MessageInput send target to active tab channel
- [x] 5. Style tabs and handle overflow / unread indicators

## Final verification wave
- [x] F1. Verify group tab still loads 50 messages and private tab loads session-history with mergeSnapshotWithLive
- [x] F2. Verify tab switch does not refetch group messages (cache hit) and private messages are cached per channel
- [x] F3. Verify realtime messages arrive on correct tab (group vs private) without cross-talk
- [x] F4. Verify sending in private tab posts to private channel and appears in both tabs' histories coherently

## Implementation Details

### 1. Add Tabs UI state
- File: `web/app/(main)/tasks/[id]/page.tsx`
- Add `const [activeTab, setActiveTab] = useState<'group' | string>('group')` where string is `private:${channelId}`
- Add `const [privateChannelMap, setPrivateChannelMap] = useState<Map<string,string>>(new Map())` instanceId -> channelId
- On private click: `const ch = await api.post('/dm-channels', {taskId, agentId}); setPrivateChannelMap(prev=>new Map(prev).set(instanceId, ch.id)); setActiveTab(`private:${ch.id}`)`
- Render Tabs bar above MessageList: map `instances` to tab buttons, plus group tab. Use `neutral`/`radius` tokens, `data-testid="dm-tabs"`, `data-active`.

### 2. Fetch per-tab
- Keep existing `channelId` (group) query as is.
- Add `privateMessagesQuery = useQuery({ queryKey: ["channel", privateId, "messages"], queryFn: () => fetchChannelMessages(privateId, 'private'), enabled: !!privateId && activeTab===`private:${privateId}` })`
- For group tab, use `messagesQuery.data`; for private, use `privateMessagesQuery.data`.

### 3. Realtime
- Change `scope` from `channel:${groupId},task:${taskId}` to ``channel:${groupId},task:${taskId}${privateId ? `,channel:${privateId}` : ''}``
- Ensure `onMessage` correctly appends to the right query cache: check `payload.message.channelId` to decide which cache to update.

### 4. Input target
- `handleSend` currently posts to `channelId` (group). Change to `targetChannelId = activeTab==='group' ? groupId : privateId` and `mentions` handling: private auto-mention mainAgent if private tab, group keeps @ logic.

### 5. Style
- Tabs: `display:flex; gap:8px; overflow-x:auto; borderBottom: 1px solid neutral[200]` ; active tab `borderBottom: 2px solid #2563EB; color: #2563EB; fontWeight:600`
- Unread dot: `lastReadAt` vs `lastMessage.createdAt` per channel.

## Must-NOT-Have
- No new route, no `router.push` to `/messages`, no extra design tokens, no backend change.

## References
- `web/app/(main)/tasks/[id]/page.tsx:2736 channelId`, `2747 messagesQuery`, `2875 scope`
- `web/app/(main)/messages/[id]/page.tsx:101 fetchChannelMessages`, `120 mergeSnapshotWithLive`
- `server/src/chat/chat.service.ts: POST /dm-channels` idempotent

## QA
- Manual QA: open task with 2 instances, click private tab, send message, verify appears, switch back to group, verify group history intact, check realtime via second browser.
- Automated: `npm run build` passes, `npm run test -- tasks.service.spec` no regression.

## Commit
- `feat(tasks): inline private chat tabs (Scheme C) on task page`
