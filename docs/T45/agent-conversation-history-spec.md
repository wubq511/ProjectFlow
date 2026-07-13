# T45 私人 Agent 多会话与历史管理 Spec

## Problem Statement

ProjectFlow 当前把一个项目映射到唯一一条 AgentConversation。用户无法主动开启新的上下文，也无法从历史列表进入之前的对话。随着消息增长，所有问题共享同一历史，既增加上下文成本，也让不同目标互相干扰。

当前结构还存在更重要的边界问题：对话读取接口没有一致地要求 viewer 身份；GET 会隐式创建数据；完整历史最多一次返回 200 条；共享对话可能存储由 `subject_and_owner` ProjectMemory 推导出的回复，导致其他成员直接或间接推断私人约束。简单增加历史列表会把这些问题扩大。

用户需要的是项目内可切换、可恢复、彼此隔离的 Agent 会话。新会话应默认私人，历史列表应轻量，切换应可深链且不能把正在流式输出的回答写入错误会话。会话历史是运行上下文，不是 Primary Project State，也不是 ProjectMemory。

## Solution

把 AgentConversation 从“项目单例”升级为“项目下的成员会话集合”。新会话由当前成员拥有并默认私人；既有项目单例会话迁移为团队遗留会话以保留历史。私人会话只允许创建者读取，团队会话允许项目成员读取，但团队会话的 Agent 上下文只能使用 team-visible ProjectMemory，从源头避免私人事实进入共享回复。

提供显式的 list/create/read/message API，所有路径统一验证 viewer。列表只返回摘要；消息使用 cursor pagination；GET 不创建数据。前端在 Agent 侧栏顶部提供“新对话”和“历史会话”，选中会话写入 URL。新对话采用本地空白草稿态，第一条消息发送时才持久化，避免空会话堆积。

## Implementation Status (2026-07-13)

Implemented in two bounded batches:

- `6027885`: removed the project-level unique-conversation invariant; added creator/title/visibility fields, safe SQLite table-copy migration, foreign-key enforcement, private/team access control, non-mutating compatibility GET, list/create/read/message/stream APIs, deterministic previews and `(created_at, id)` pagination. Team conversations filter ProjectMemory at the source to team-visible records.
- `435f489`: added Agent sidebar “新对话” and history Sheet, private/team labels, active selection, deterministic previews, latest-page/older-page loading, URL `conversation` state, project/viewer reset, local unsaved draft and create-on-first-send behavior. Switching is locked during streaming and conflicting browser navigation is reverted to the active conversation.

Validation baseline: backend conversation/migration/privacy coverage is included in `824 passed / 4 skipped`; frontend conversation history and stream-hook coverage is included in `147 passed`. Frontend lint/build and backend Ruff pass.

Deferred by design: manual rename, deletion/archive, sharing a private conversation, background streaming, mixed-visibility messages, cross-project conversations and automatic conversation-to-ProjectMemory conversion.

## User Stories

1. As a project member, I want to start a new Agent conversation, so that a new topic does not inherit irrelevant history.
2. As a project member, I want to see my prior conversations for the current project, so that I can return to earlier work.
3. As a project member, I want to open a prior conversation by clicking its title, so that I do not need to search the project timeline manually.
4. As a project member, I want the selected conversation represented in the URL, so that browser navigation restores the same context.
5. As a project member, I want changing projects to clear an incompatible conversation selection, so that one project's history cannot appear in another.
6. As a project member, I want a new conversation to remain unsaved until I send the first message, so that accidental clicks do not create empty history.
7. As a project member, I want the first message to produce a useful deterministic title, so that history remains recognizable without another model call.
8. As a project member, I want history sorted by recent activity, so that the conversation I just used is easy to find.
9. As a project member, I want the active conversation visibly highlighted, so that I know where new messages will be stored.
10. As a project member, I want only the latest message page loaded initially, so that opening a long history stays fast.
11. As a project member, I want to load older messages without duplicates or gaps, so that the full record remains available.
12. As a project member, I want starter prompts in a blank conversation, so that starting a new context remains easy.
13. As a project member, I want conversation switching disabled during a live response, so that streamed output cannot land in the wrong history.
14. As a project member, I want a clear path to stop the current response before switching, so that the disabled state is actionable.
15. As a project member, I want failed history loading to preserve the current conversation, so that a transient error does not erase visible work.
16. As a project member, I want retryable loading errors shown in Chinese, so that I know what action to take.
17. As a project member, I want my new conversations private by default, so that other team members cannot read my exploratory questions.
18. As a project member, I want the project owner unable to read my private conversation solely because they own the project, so that memory authority does not become transcript authority.
19. As a project member, I want legacy shared history preserved after migration, so that existing work is not lost.
20. As a project member, I want legacy shared conversations marked as team history, so that their visibility is not ambiguous.
21. As a project owner, I want team-visible conversations to exclude private ProjectMemory from Agent context, so that shared replies cannot reveal private constraints.
22. As a project owner, I want every conversation API to validate project membership, so that knowing an identifier is not sufficient for access.
23. As a project owner, I want private conversation APIs to validate the creator, so that cross-member access fails closed.
24. As a project owner, I want cross-project conversation access rejected as not found, so that authorization does not disclose existence.
25. As a project owner, I want GET requests to be read-only, so that browsing history never creates database rows.
26. As a developer, I want current conversation ID passed explicitly to internal conversation tools, so that tools do not guess the project's latest thread.
27. As a developer, I want AgentRun, event, checkpoint and proposal links to retain their original conversation IDs, so that observability remains traceable.
28. As a developer, I want a tested SQLite migration that preserves existing conversations, messages and run foreign keys, so that demo data survives upgrades.
29. As a developer, I want list responses separated from message payloads, so that history UI does not accidentally load every transcript.
30. As a developer, I want cursor pagination based on stable ordering, so that concurrent new messages do not reorder older pages unpredictably.
31. As a project member, I want conversation history to remain separate from ProjectMemory, so that model-generated chat text never becomes project truth automatically.
32. As a project member, I want project proposals created in one conversation to remain project-level reviewable artifacts, so that opening another conversation does not hide pending decisions.
33. As a project member, I want a consistent Agent sidebar on loading, empty, success and error states, so that history management does not disrupt project work.
34. As a keyboard user, I want history controls and entries reachable with visible focus, so that the feature is accessible without a mouse.
35. As a reduced-motion user, I want conversation switching to work without required animation, so that motion preferences are respected.

## Implementation Decisions

- Remove the project-level unique-conversation invariant and replace it with indexed project/member/history queries.
- Add conversation creator, title and visibility fields. Supported visibility values are `private` and `team`.
- New conversations default to `private` and belong to the validated current viewer.
- Existing conversations migrate to `team` with a deterministic legacy title so no transcript or foreign-key linkage is discarded.
- Private conversations are readable and writable only by their creator after project membership validation. Project ownership does not override private transcript ownership.
- Team conversations are readable by project members. Team conversation context may include only team-visible ProjectMemory. Private memory is filtered before request construction, not from generated text afterward.
- Messages inherit conversation visibility. This version does not support mixed-visibility messages inside one conversation.
- Conversation titles are derived from the first normalized user message with a fixed character limit and fallback title. No LLM title-generation call is added.
- A new-conversation UI state is initially client-side. The conversation is created immediately before the first streamed message or dashboard action that explicitly chooses to join the conversation.
- Expose separate list summary and conversation detail schemas. List items include identifier, title, visibility, status, creator, message count or last-message preview where safe, and timestamps; they do not include full messages.
- Use cursor pagination for messages with deterministic created-time and identifier ordering. Initial conversation detail returns the latest page and a cursor for older messages.
- Require viewer identity on list, create, read, message-page and stream endpoints. Reuse the existing membership validation predicate and return not-found semantics for unauthorized cross-member or cross-project access.
- Stop creating conversations from GET. The compatibility singular endpoint may return the latest accessible conversation during migration but must not mutate state.
- Internal conversation tools must receive the run's explicit conversation identifier and viewer identity. They must not select the newest project conversation implicitly.
- Keep AgentConversation separate from ProjectMemory and Primary Project State. Conversation summaries, titles and model replies never become Memory Source Events by themselves.
- Preserve project-level proposals, risks and action cards across conversation switches. A conversation is an interaction context, not an ownership container for project artifacts.
- Store the selected conversation in the existing workspace URL query alongside project and view state. Validate it after project load and remove it when the project changes or access fails.
- Place “新对话” and “历史会话” controls in the Agent sidebar header. Use an accessible portal-based popover on normal widths and a sheet-like presentation where space requires it; do not add a permanently nested sidebar.
- Disable new/switch controls while a response is actively streaming and provide an actionable stop control. Background conversation execution is not added in this version.
- Preserve the current conversation on list/detail loading failure and show retry guidance.
- Do not introduce delete, archive, search, rename or sharing controls in this version. Existing status remains available for future archive behavior.
- Keep UI language Chinese and reuse existing shadcn components, spacing, color tokens and reduced-motion behavior.

## Testing Decisions

- The primary test seam is the public conversation lifecycle: list, create, stream a message, list again, open history and load older messages.
- Exercise the public HTTP/SSE path with a real database and deterministic sidecar fixture wherever possible.
- Add authorization scenarios for project non-member, private-conversation non-owner, team conversation member and cross-project identifier use.
- Add a privacy scenario proving a team conversation cannot receive `subject_and_owner` ProjectMemory even when the requesting member can personally view that memory elsewhere.
- Add isolation scenarios proving two conversations under one project have different recent histories and the selected thread alone is sent to the sidecar.
- Add a payload-capture assertion proving current user content appears once and only messages from the selected conversation enter recent history.
- Add SQLite legacy-migration tests starting from the prior unique schema. Verify conversation IDs, message rows, AgentRun links and timestamps survive, and multiple new conversations can then be inserted.
- Add cursor tests covering equal timestamps, forward activity updates, empty pages, no duplicates and no missing messages.
- Add frontend component tests for history loading, current selection, new draft, first-send creation, URL synchronization, streaming lock, empty state and error retry.
- Add accessibility assertions for button names, list selection state, focus visibility and keyboard activation.
- Re-run existing conversation SSE parser, stream hook, AgentSidebar and public scenario tests to prevent behavioral regressions.

## Out of Scope

- Conversation deletion.
- Conversation archiving UI.
- Manual conversation renaming.
- Full-text history search.
- Sharing a new private conversation with the team.
- Mixed message visibility inside one conversation.
- Background streaming while viewing another conversation.
- Cross-project conversations.
- Automatic conversion of conversation summaries into ProjectMemory.
- Replacing request-scoped viewer identity with full authentication.
- Migrating dashboard actions to the public conversation stream unless required to keep a selected conversation identifier truthful.

## Further Notes

- The SQLite migration is a high-risk implementation area because removing a unique constraint requires table reconstruction. It must be completed and tested before frontend history is exposed.
- Privacy is enforced by conversation ownership plus context-source filtering. Word filtering and post-generation redaction are not accepted as primary controls.
- Delivery uses separate fresh Claude Code sessions for backend schema/API/privacy, frontend state/UI, and final integration scenarios. Each session receives only the current spec section, actionable findings, constraints and acceptance checks.
