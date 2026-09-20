# Maintainer Documentation Gardening Implementation Plan

## Goal

Turn the repository documentation into a maintainer-oriented current surface
with an explicit historical archive, without changing runtime behavior or
deleting engineering records.

## Batch 1: Current documentation map

- Add `docs/README.md` as the task-oriented maintainer entry point.
- Add `docs/domain/README.md` as the bounded-context index.
- Link the documentation map from the repository README.
- Update the Superpowers index so its active list is derived from the records
  that remain in the active tree.

Validation: manually follow every current route from the repository README.

## Batch 2: Historical archive

- Move completed specifications and plans into the existing Superpowers archive.
- Keep this design and implementation plan active until the gardening work is
  complete.
- Move completed standalone designs and audits into matching archive folders.
- Move duplicate architecture variants and visual-check outputs into an
  architecture-artifact archive.
- Retain the current SVG, interactive HTML, and its source JSON beside the
  current documentation.

Validation: no archived source remains in the active tree, no tracked file is
deleted, and the Superpowers archive audit passes.

## Batch 3: Documentation audit

- Add a repository documentation audit for relative Markdown file and heading
  links.
- Require the maintainer entry points and reject archived documents as authority
  from current entry points.
- Verify that the Superpowers index matches the active specifications and plans.
- Keep the existing Superpowers archive audit as part of `npm run docs:audit`.
- Add focused Vitest coverage for valid links, missing files, missing headings,
  required entry points, and active-record drift.

Validation: focused tests and `npm run docs:audit`.

## Batch 4: Final synchronization and verification

- Correct current guide wording where it has drifted from the deployed
  Controller, explicit mention routing, no-replay recovery, and standalone
  lifecycle behavior.
- Cold-read the README and documentation map as a new maintainer.
- Run `git diff --check`, the focused documentation tests, `npm run docs:audit`,
  `npm run typecheck`, `npm run build`, and `npm run architecture:check`.
- Review the final diff to confirm it contains documentation tooling and moves
  only, with no runtime source changes.
