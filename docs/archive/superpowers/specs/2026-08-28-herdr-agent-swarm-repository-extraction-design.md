# Herdr Agent Swarm Repository Extraction Design

## Objective

Create an independent repository named `herdr-agent-swarm` from the completed
`solo-app` branch. Preserve the complete reachable Git history and use the
current `solo-app` head as the new repository's starting branch, while removing
the source repository as a remote and excluding all private runtime state.

The resulting repository lives at:

```text
/data00/home/feiyu.zhu/work/herdr-agent-swarm
```

## Chosen approach

Clone the source repository locally with the `solo-app` branch checked out,
then detach it from the source repository by removing the generated `origin`.
This retains commit ancestry, tags, and objects reachable through cloned refs,
but makes the destination an independently managed repository. Rename the
checked-out branch from `solo-app` to `main` so a product-development branch
name does not become the permanent default branch.

Alternatives rejected:

- Copying the working tree and running `git init` would provide a clean history,
  but the user explicitly chose to preserve history.
- Keeping the repository as a Git worktree would leave its metadata and lifetime
  coupled to `herdr-lark-bridge`, so it would not be an independent repository.
- Keeping the local source path as `origin` would make accidental pushes or
  fetches target the old repository and obscure ownership.

No hosted remote is created and nothing is pushed as part of this extraction.

## Naming and compatibility boundary

The new product identity is **Herdr Agent Swarm**. Current user-facing and
operational identifiers are renamed where doing so does not break durable or
command compatibility:

- npm package name: `herdr-agent-swarm`;
- standalone service: `herdr-agent-swarm.service`;
- default XDG config/state directories: `herdr-agent-swarm`;
- documentation headings and active product prose: `Herdr Agent Swarm`;
- generated service description and standalone script messages: the new name.

Existing `/swarm` commands remain unchanged. Durable database keys, migration
identifiers, historical documents, compatibility event names, and code symbols
whose renaming would create migration risk remain unchanged unless they are
purely presentational. The optional legacy Herdr plugin surface remains
available during extraction; its compatibility plugin ID is not silently
changed because existing installations address it by ID. Documentation labels
it as a compatibility operator surface rather than the product identity.

## Repository contents and safety

The repository contains the tracked source, tests, current documentation,
installation scripts, example configuration, and historical design records from
the `solo-app` head. It must not contain or import live configuration or state:

- no real `.env` or credentials;
- no live `projects.json`;
- no SQLite database, WAL, or SHM files;
- no logs, generated runtime state, or temporary smoke repositories;
- no `node_modules` or generated `dist` content in Git.

The extraction preserves `.gitignore`. A tracked-file scan and Git status check
are required before completion.

## Installation and runtime behavior

Runtime architecture and product behavior do not change. Herdr remains the
headless execution host; TraeX remains the live-verified Primary and Worker
runtime; Codex, Claude Code, and Pi retain their existing adapter contracts.
Multi-project routing, explicit instance creation, Primary-to-existing-Worker
calls, approval boundaries, durable SQLite state, Feishu gateway behavior, and
worktree retention rules remain as specified by the Solo Agent product design.

The standalone installation commands become the primary documented path. They
initialize private files below `~/.config/herdr-agent-swarm` and state below
`~/.local/state/herdr-agent-swarm`, install the renamed user unit, and preserve
configuration/state on uninstall. Existing installations are not automatically
migrated; migration requires an explicit copy of private configuration and, if
needed, the complete SQLite database with its WAL/SHM companions while stopped.

## Implementation sequence

1. Commit this extraction specification on `solo-app`.
2. Clone the repository into the target directory with full history and
   `solo-app` checked out.
3. Remove the clone's `origin` and rename the branch to `main`.
4. Update current product/package/service/default-path naming, preserving the
   compatibility boundaries above.
5. Update active installation and operation documentation.
6. Install locked dependencies and run configuration-safe validation.
7. Run the full test suite, typecheck, and production build.
8. Scan tracked files for secrets and runtime artifacts, verify no remote is
   configured, and commit the extraction changes in the new repository.

## Verification and completion criteria

The extraction is complete only when all of the following are true:

- the destination is an independent Git repository at the agreed path;
- `git log` contains the source history and the pre-extraction `solo-app` head;
- the checked-out branch is `main`;
- `git remote -v` is empty;
- active product and standalone operational naming use Herdr Agent Swarm;
- `/swarm` and durable compatibility identifiers remain intact;
- configuration validation succeeds using sanitized example-derived data;
- all tests, TypeScript typecheck, and production build pass;
- no secret or runtime artifact is tracked;
- the final worktree is clean after a local commit;
- no remote repository is created and no commit is pushed.

## Non-goals

- Publishing to GitHub, GitLab, or another hosting service.
- Rewriting historical commits or retroactively renaming historical documents.
- Migrating or restarting the currently installed bridge service.
- Changing agent orchestration semantics or adding autonomous worker creation.
- Removing the legacy plugin compatibility surface in this extraction.
