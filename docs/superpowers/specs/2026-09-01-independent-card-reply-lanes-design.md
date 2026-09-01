# Independent Card Reply Lanes Design

## Problem

The outbox currently assigns every non-Answer reply for the same Lark root
message to one `message:<rootMessageId>` lane. A permanent failure in one
independent `card_reply` therefore quarantines later replies to the same topic,
even though each reply creates a different Lark message and has no ordering
dependency on the failed card.

This occurred after an older `/instance reviewer` detail card used the
unsupported CardKit V2 `action` element. Its failed `card_reply` quarantined the
topic lane. Later corrected `/instance reviewer` replies remained `pending` with
`attempt_count = 0`, so the user saw no response even though command handling
completed successfully.

## Goals

- Isolate independent `card_reply` and `text` deliveries so one bad reply cannot
  block later replies to the same root message.
- Preserve strict ordering for updates to the same card and for Answer streams.
- Converge existing databases that contain pending replies blocked behind a
  legacy shared immutable lane.
- Retain failed delivery records for audit and never replay a TraeX or Worker
  task as part of delivery recovery.

## Lane Model

New outbox rows use these lane identities:

- Answer operations with a `card_role` and `prompt_id`: `answer:<promptId>`.
- Other stream content and finish operations: `stream:<rootMessageId>`.
- `card_update`: `message:<rootMessageId>`, because updates target one existing
  Lark message and must remain ordered.
- Independent `card_reply` and `text`: `reply:<outboundReplyId>`. Each creates a
  separate message and therefore has no cross-reply ordering requirement.

The lane is derived from durable outbox identity, not an in-memory sequence or
timestamp. Idempotency remains governed by `idempotency_key`.

## Existing Database Migration

A new idempotent schema migration rewrites only `card_reply` and `text` rows
from legacy `message:<rootMessageId>` lanes to `reply:<id>` lanes. It does not
change Answer or card-update lanes.

For an active quarantine whose failed reply is migrated:

- preserve the failed reply and its error metadata;
- move the quarantine to the failed reply's new isolated lane;
- keep that quarantine active, so the failed payload is not retried
  automatically;
- rebuild lane heads after all rewrites.

Pending successor replies receive their own unquarantined lanes and become
eligible for normal publisher delivery. This recovers current production state
without deleting audit history or repeating agent execution.

## Failure and Recovery Semantics

A failed independent reply quarantines only its own lane. Operator retry and
dismiss retain their existing semantics for rows that can be authorized through
a binding or project selection. This change does not broaden operator authority
or introduce direct production-database editing as a supported workflow.

The current production legacy quarantine will be converged by the migration on
service startup. Its invalid card remains a dead letter, while the corrected
pending detail cards become independently deliverable.

## Verification

Tests must prove all of the following:

1. Two independent replies to the same root message receive different lanes.
2. Permanently failing the first reply does not hide the second lane head.
3. Updates to the same target card still share a lane and preserve ordering.
4. Reopening a legacy database migrates the failed reply, its quarantine, and
   pending successors without losing the dead-letter audit record.
5. The focused SQLite and outbox-dispatcher tests, typecheck, build, and full
   test suite pass before installation.
6. After installation and restart, production shows the corrected pending
   `/instance reviewer` reply as delivered or records a new concrete Lark error.

## Deployment Safety

Commit the implementation before installation. Use `./install.sh` and the
supported `npm run swarm:restart` lifecycle. Before restart, inspect durable
prompt and outbox state; if the normal safety gate blocks because of existing
detached observers or queued work, preserve those records and use only the
already-established forced restart procedure. Verify the deployed commit, build
identity, lease ownership, readiness, migrated quarantine, and target reply
state after startup.
