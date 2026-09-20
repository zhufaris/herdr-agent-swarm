# Maintainer Documentation Gardening

## Goal

Make the repository documentation navigable for a maintainer or contributor
arriving without prior project context. Starting from the repository README,
the reader should be able to find the current system boundaries, module map,
local validation workflow, deployment and diagnosis guidance, and historical
engineering records without mistaking old designs for current behavior.

## Scope

This change reorganizes documentation and corrects descriptions that have
drifted from the current implementation. It does not change runtime behavior,
delete historical engineering records, or reinterpret architectural decisions.

The gardening pass will:

- add a maintainer-oriented documentation map under `docs/`;
- keep the repository README as the concise project and contributor entry point;
- identify the architecture guide, architecture reference, Feishu group guide,
  release guide, and domain context documents as current authority;
- move completed or superseded designs, plans, audits, and duplicate generated
  architecture artifacts under `docs/archive/`;
- retain one current architecture diagram and its interactive form on the main
  documentation surface;
- make the Superpowers index agree with the records that actually remain active;
- add automated checks for internal Markdown links, required documentation
  entry points, and the existing Superpowers archive contract.

Historical files are moved, not deleted. Generated visual-check artifacts remain
available from the archive but do not appear as current documentation.

## Readers and post-read action

The primary reader is a maintainer or contributor who knows TypeScript, Node.js,
SQLite, and ordinary service operations but does not know this repository. After
reading the documentation map, they should be able to choose the correct current
document for a change or incident and distinguish behavioral authority from
historical design evidence.

Operators remain supported through direct links to setup, lifecycle, Feishu
usage, and troubleshooting guidance, but operator-first restructuring is outside
this pass.

## Information architecture

The current documentation surface has five layers:

1. The repository README introduces the product, safety model, development
   prerequisites, quick validation, and the documentation map.
2. The documentation map explains which document is authoritative for each
   maintainer task and labels historical material explicitly.
3. Current guides describe architecture and recovery semantics, the module map,
   Feishu interaction, and releases and operations.
4. Domain context documents record bounded-context vocabulary and ownership.
5. The archive retains completed specifications, plans, audits, old diagrams, and
   superseded designs as evidence rather than behavioral authority.

The map must favor reader tasks over a raw file listing. A fresh reader should
not need to know a filename before deciding where to go.

## Authority and archive rules

Current behavior is established by the implementation and tests, then explained
by the architecture guide and user or operator guides. Domain context documents
define ownership and vocabulary at their bounded-context seams.

Specifications and plans describe decisions at a point in time. A record remains
active only while design or implementation work is genuinely open. Completed or
superseded records move to the existing Superpowers archive and are registered by
the archive contract. Historical records must not be linked as the primary answer
from the README or documentation map.

Standalone audits and narrowly scoped design notes that describe completed work
also move under the archive. A document stays on the current surface only when a
maintainer must use it to operate, modify, or reason about the present system.

For generated architecture assets, the main surface retains the current SVG used
by the README and one interactive HTML representation. Source metadata required
to regenerate that view may remain beside it. Old variants and visual-check
outputs move to an architecture-artifact archive. No generated asset is deleted.

## README and guide changes

The README will become a shorter contributor entry point without losing safe
installation or readiness checks. Detailed explanations that already have an
authoritative guide will be summarized and linked rather than duplicated.

The documentation map will provide these routes:

| Maintainer task | Current authority |
| --- | --- |
| Understand durability, recovery, and request flow | Architecture guide |
| Locate modules and composition seams | Architecture reference |
| Understand bounded contexts and ownership | Domain context index |
| Operate commands from Feishu | Feishu group guide |
| Build, release, install, or recover the service | Release and operations guide |
| Inspect past decisions | Explicitly labeled archive index |

Descriptions will be checked against current Controller interpretation, explicit
bot-mention routing, standalone systemd ownership, no-replay behavior, and the
supported `npm run swarm:*` operator surface. This is a synchronization pass, not
an opportunity to add undocumented behavior.

## Automated validation

The existing Superpowers archive audit remains authoritative for its manifest. A
small repository documentation audit will additionally fail when:

- a tracked Markdown link points to a missing repository file or heading;
- one of the required current entry points is missing;
- a current entry point directs readers to an archived record as authority; or
- the Superpowers index claims an active set that differs from the files present.

Generated assets and external URLs are excluded from heading validation. The
audit will be deterministic, local, and runnable through an npm script so it can
join normal repository validation without network access. Focused tests will
cover missing files, missing headings, and valid relative links.

## Migration sequence

1. Inventory current links and classify root-level documents and generated
   assets as current or historical.
2. Add the documentation map and wire it from the README.
3. Move historical records and generated variants while updating incoming links
   and the Superpowers archive contract.
4. Synchronize current guide descriptions with the implementation.
5. Add the documentation audit and tests.
6. Run the focused audit tests, TypeScript checks, build, architecture check, and
   a cold-read from the README through each maintainer route.

Moves should be performed in coherent batches so review can distinguish content
changes from path changes.

## Success criteria

- A new maintainer can reach every current guide from the README through one
  documentation map.
- Current and historical material are visibly separated.
- No historical record or generated visual-check artifact is deleted.
- The Superpowers index matches its active directories and archive contract.
- Current documentation describes the deployed Controller, mention-routing,
  durability, and standalone lifecycle behavior accurately.
- Internal links and required entry points pass a deterministic local audit.
- Runtime source and runtime behavior remain unchanged.
