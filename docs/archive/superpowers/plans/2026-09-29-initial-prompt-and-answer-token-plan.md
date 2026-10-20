# Initial TraeX Prompt and Answer Token Implementation Plan

1. Add a failing dispatcher test for an idle TraeX pane with matching terminal
   identity and no native session.
2. Make ordinary native prompt submission accept an optional session fence and
   omit it only for the verified first-session case.
3. Add a failing projection test for a run card whose pane token becomes known
   after prompt admission.
4. Extend runtime convergence persistence so token changes update actionable
   run cards and enqueue Answer Card refreshes.
5. Run focused tests, type checking, architecture checks, full tests, and the
   public release audit.
