# Worker Limit Stale Provisioning Plan

1. Add a failing reconciler test for an absent recorded pending pane.
2. Reuse the fenced Worker-session termination transaction at the full-snapshot reconciliation boundary.
3. Preserve fail-closed behavior for present but unverifiable pending panes.
4. Run focused and full validation.
5. Install and restart through the normal safety gate, then verify stale sessions are terminated and Worker quota is available.
