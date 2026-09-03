# Product Context Naming Boundary Design

## Goal

Prevent agents and users from interpreting the historical name `Herdr Lark Bridge` as the identity of the current repository. The current product name is `Herdr Agent Swarm`.

## Problem

The repository and production service have moved to the standalone multi-agent product, but active agent-facing documentation still opens with `Herdr Lark Bridge`. TraeX loads repository instructions from `AGENTS.md`, so that wording becomes part of the task context and can cause responses to describe the wrong project.

At the same time, `herdr-lark-bridge` remains a real compatibility identifier for the Herdr plugin, legacy systemd unit, build identity, configuration paths, and socket request identifiers. Renaming those identifiers as a documentation cleanup would risk breaking installed deployments.

## Naming rule

- Use **Herdr Agent Swarm** for the repository, standalone service, current architecture, multi-agent product, and agent-facing project identity.
- Use **Herdr Lark Bridge** only when discussing the compatibility bridge mode or its historical design.
- Preserve the literal identifier `herdr-lark-bridge` wherever it names a plugin, systemd unit, configuration/state directory, stable service identity, command target, or protocol/request identifier.
- Preserve historical documents under `docs/archive/` unchanged.

## Changes

### Agent instructions

Rename the title and opening overview in `AGENTS.md` to identify the repository as Herdr Agent Swarm. Describe the one-topic/one-TraeX bridge as a compatibility workflow within the product. Keep operational commands that target the `herdr-lark-bridge` plugin unchanged and label them as compatibility plugin commands.

### Active documentation

Update the title and introductory identity statements in `docs/architecture-reference.md` to Herdr Agent Swarm. Where the document describes the original bridge workflow specifically, retain the bridge term with an explicit compatibility qualifier.

Clarify the compatibility sentence in `docs/feishu-group-usage.md` so it cannot be read as the repository's current product name.

README references that are already attached to explicit compatibility setup, service, plugin, or migration instructions remain unchanged.

## Non-goals

- No runtime identifier migration.
- No plugin rename.
- No systemd unit rename.
- No database, configuration, routing, prompt, CardKit, or instance behavior changes.
- No rewrite of archived design history.
- No work on the separately tracked Feishu `创建实例` callback failure.

## Verification

1. Search active agent and user documentation for both names. Every remaining `Herdr Lark Bridge` occurrence must be explicitly historical or compatibility-scoped.
2. Search runtime and operator commands to confirm every literal `herdr-lark-bridge` compatibility identifier is unchanged.
3. Run `git diff --check`. Documentation-only changes do not require service restart.

## Acceptance criteria

- A newly started agent reading `AGENTS.md` identifies the current project as Herdr Agent Swarm.
- Active architecture and usage introductions use the current product name consistently.
- Compatibility commands and stable runtime identifiers remain byte-for-byte unchanged.
- Archived documents remain untouched.
