# Live Message Card Design

## Goal

Make an active Herdr turn visibly progress in Feishu even when its structured
task plan does not change. Preserve the distinct responsibility of each card
and update existing cards in place rather than appending new cards.

## Card responsibilities

The project main card is the compact overview for one Pane. It shows at most the
three newest structured activity items and one latest concise message. The
message is derived from the newest non-empty paragraph in the visible TraeX
answer. If no visible answer exists, it falls back to the newest structured
activity item. It never renders the full answer or the complete task plan.
Tool activity uses a consistent `🛠️` prefix so it is visually distinct from
ordinary prose and plan-state icons.

The Request card remains the durable request-and-plan view. It shows the
original request, structured execution plan, phase-aware status, warnings, and
elapsed duration. It does not repeat intermediate answer prose.

The Answer card is the live narrative view. While a turn runs, it renders the
accumulated visible answer using the existing newest-tail window and updates the
same Feishu card in place. It therefore keeps useful continuity instead of only
showing the last sentence. When the turn completes, the final answer replaces
the live snapshot and remains on the same card.

## Filtering and fallback

Both the project preview and Answer card use the same render-only filtering for
recognized native TraeX status headers and todo frames. Structured plan rows stay
on the Request card. Ordinary prose before or after a recognized status frame is
preserved. Existing Markdown normalization, unsafe-output filtering, and length
bounds remain unchanged.

The Answer card uses the existing 12,000-character newest-tail window. When no
visible prose remains during execution, it falls back to structured completion
such as `TraeX 正在执行 · 6/8`, then to `正在生成…` when no plan exists.

The project main card uses a smaller bounded preview suitable for group scanning.
Its latest message contains only the newest non-empty paragraph, normalized to
remove terminal-width wrapping. The existing latest-tail behavior remains the
fallback for terminal notices and final answers that do not contain separable
paragraphs.

## Data flow and updates

No persistence schema or event contract changes are required.
`TurnOutputObserved.answerSnapshot` already contains the accumulated visible
answer, and `progressEvents` already contains structured activity and plan data.
The topic and request views continue to be reduced and persisted as today. Only
the render projection changes.

Every output observation continues through the existing card-update scheduler.
The project card and Answer card are updated in place, preserving current
deduplication and throttling. The Request card changes only when its structured
plan, status, warning, or timing data changes through the existing projection
path. No additional Feishu messages are created.

## Failure and compatibility behavior

Blocked and failed notices keep priority over a normal project-card preview. An
empty or fully filtered answer never produces an empty card; the documented
fallbacks are used. Unknown output is preserved rather than discarded.
Cross-group action protection, queue ordering, steering, final-answer
persistence, credential filtering, and topic routing are unchanged.

## Verification

Renderer tests cover the public CardKit JSON boundary and verify that:

1. the project main card shows only the three newest structured activities;
2. its latest message is the newest visible answer paragraph;
3. it falls back to the newest activity when answer prose is absent;
4. the Request card does not contain intermediate answer prose;
5. the Answer card keeps accumulated prose in its bounded newest-tail window;
6. native status/todo frames are filtered without dropping surrounding prose;
7. blocked and failed notices still override the project preview; and
8. existing integration, persistence, update-in-place, typecheck, and build
   checks remain green.
