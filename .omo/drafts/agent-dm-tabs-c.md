# Draft: Agent DM Tabs (Scheme C) — Inline Tabs on Task Page

## Meta
- slug: agent-dm-tabs-c
- intent: clear
- review_required: false
- created: 2026-08-21
- status: awaiting-approval

## Context
- Current: private chat is full-page route `/messages/[id]` (DmChatPage). Task page `tasks/[id]` shows group chat only; clicking private does `POST /dm-channels` + `router.push(/messages/:id)`, losing task context, requiring 4 refetches.
- User selected Scheme C (Tabs): stay on current task page, reuse same MessageList, switch data source via tabs `群聊 | 私聊: <alias>`.

## Decisions (defaults adopted)
- Reuse existing `fetchChannelMessages` + `mergeSnapshotWithLive` for private session-history; no new API.
- Tab state is local `activeTab: 'group' | `private:${channelId}` `, not URL-synced (keeps back button simple; URL sync optional later).
- Keep `POST /dm-channels` idempotent creation on first click, cache `channelId` by `instanceId`.
- Reuse `DmMessageList`/`ChatBubble` styling; no new design tokens.
- Keep `group` tab as default; private tabs up to N (team size, max 10) with overflow scroll.

## Open Forks (owner decisions) — ASK
1. **Tab scope**: Should tabs show **all team private channels** (one tab per instance) or **only the clicked one** (single private tab that updates on click)? Default: all instances as tabs (discoverable).
2. **URL sync**: Should active tab reflect in URL (`?tab=group|private:ta_xxx`) for deep-link/share, or pure local state? Default: local state only (simpler, no route change).
3. **Unread / loading indicators**: Show per-tab unread dot / loading spinner (needs per-channel `nextCursor` & `loadingMore` state)? Default: per-tab dot via `lastReadAt` comparison, minimal.

## Research Grounding
- `web/app/(main)/tasks/[id]/page.tsx:2736 channelId = channel?.id`, `2747 messagesQuery: ["channel", channelId, "messages"]`, `2875 scope=channel:${channelId},task:${taskId}` — group-only today.
- `web/app/(main)/messages/[id]/page.tsx:101 fetchChannelMessages` + `120 mergeSnapshotWithLive` — private needs session-history, already implemented.
- `server/src/chat/chat.service.ts` private `POST /dm-channels` idempotent via `uk_channels_task_agent`.
- `web/src/components/chat/msg-parts.tsx` already private-aware; reusable.

## Plan Outline (for approval)
- Implement `activePrivateId` state + `privateChannels` map in `tasks/[id]/page.tsx`.
- Add `Tabs` UI above `MessageList` (reuse `neutral`/`radius` tokens, `data-testid="dm-tabs"`).
- On tab click: if private tab not yet fetched, `POST /dm-channels` then `fetchChannelMessages(channelId, 'private')` with separate `queryKey ["channel", privateId, "messages"]`.
- `MessageList` now receives `activeChannelId` / `activeType` and switches `messages`, `nextCursor`, `loadingMore`, `onLoadMore`, `onSend` target.
- `useRealtimeEvents` scope becomes `channel:${groupId},channel:${activePrivateId},task:${taskId}` (comma-joined, as in DmChatPage).
- Input: `MessageInput` `mentionable` empty for private (auto-mention), group keeps @.
- Keep group message list mounted but hidden (or keep per-tab cache via react-query) to avoid refetch on switch.

## Approval Gate
- Status: awaiting-approval
- Next: after your OK, run scaffold to create `.omo/plans/agent-dm-tabs-c.md` with full Todos (5-6 tasks, each with references + acceptance + QA).
- Questions above need your pick (or accept defaults) before plan finalization.

## Ledgers
- Explore: task page chat routing, private page data, channel APIs
- Decisions: as above
- Risks: per-tab query cache growth (bounded by team size), realtime scope fan-out (3 channels max, acceptable)
