# README Source Installation Design

## Goal

Make the repository README sufficient for an engineer arriving with a fresh
checkout to install, configure, start, and verify Herdr Agent Swarm from source
without reconstructing the sequence from scattered operational sections.

## Reader and Outcome

The reader is an internal Linux engineer who has access to the repository and a
configured Lark application, but has not previously operated this service. After
reading the section, they can complete a first source installation and recognize
the boundary between setup, installation, startup, verification, and upgrade.

## README Structure

Add a discoverable `Install from source` section immediately after the
prerequisites and Lark application setup. It becomes the canonical first-install
sequence and contains:

1. Tool and version checks for Linux, Node.js, npm, Herdr, and TraeX.
2. Checkout entry, locked dependency installation, and TypeScript build.
3. Confirmation that the Herdr server is running.
4. Guided private configuration through the setup wizard.
5. Immutable release installation, explicit service start, and supported status
   checks.
6. A loopback `/ready` verification with the expected `ready` result.
7. A short explanation of generated configuration/state locations and private
   file permissions.
8. The source-update flow: pull or switch to the intended commit, rebuild and
   reinstall, inspect workload state, then use the safe restart.
9. The forced-restart boundary: it is an explicit detached-observer handoff, not
   a general way to bypass workload safety.

## Consolidation Rules

The existing standalone-service section remains the detailed operator reference
for setup behavior, non-interactive configuration, lifecycle semantics, TraeX
shim installation, recovery, and troubleshooting. Repeated first-install command
blocks are replaced with links or concise explanations so the README has one
canonical source-install sequence. Non-interactive setup remains a clearly
labelled alternative, not part of the default path.

All commands must match the current package scripts and installer behavior:
`npm ci`, `npm run build`, `npm run swarm:setup`, `./install.sh`,
`npm run swarm:start`, and `npm run swarm:status`. The documentation must state
that installation enables but does not start the user unit.

## Reader Test

Cold-read the resulting README in order and verify that a new operator can answer
all of these questions without searching the repository:

- What must already be installed?
- Which command creates private configuration?
- Which command builds and stages the immutable release?
- Does installation start the service?
- How is readiness verified?
- How is a source update deployed safely?
- When is `restart -- --force` appropriate?

The README change is complete only when all seven answers are explicit and no
conflicting first-install sequence remains.
