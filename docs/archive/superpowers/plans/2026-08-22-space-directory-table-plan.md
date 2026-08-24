# `/herdr spaces` table implementation plan

1. Replace the Markdown list renderer with reusable `column_set` header and row
   builders. Use stable weighted columns for Pane, state, foreground process, and
   the row-local action.
2. Display only the short Pane suffix while retaining the full Pane/workspace
   identifiers in callback payloads. Keep readable Space names and directories
   outside the row grid.
3. Paginate by a conservative maximum row count and serialized card-size budget,
   repeating the Space heading and table header for split groups.
4. Represent empty and failed Spaces with explicit rows, and preserve open/claim
   eligibility and all existing callback semantics.
5. Add unit coverage for schema shape, ordering, short IDs, full action payloads,
   row association, pagination, empty/error states, and forbidden close actions.
6. Run focused and full verification, commit the renderer, rebuild, restart the
   PM2 service, and inspect one genuine `/herdr spaces` response.
