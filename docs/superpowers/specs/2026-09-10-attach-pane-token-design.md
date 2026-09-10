# Attach Pane Token Design

## Goal

Allow operators to attach a Pane using the four-character token visible in a
canonical Herdr Pane label, for example `/swarm attach <space> cum7` for a Pane
labeled `task-cum7`.

## Resolution rules

Resolution remains scoped to the selected project's configured Herdr workspace
and uses this precedence:

1. exact stable Pane ID;
2. exact Pane label;
3. exact four-character canonical token extracted from a label shaped as
   `<token>`, `lark_<token>`, `lark_task-<token>`, or `task-<token>`.

Token comparison is case-insensitive and stores only the resolved stable Pane
ID. A token that matches multiple Panes is rejected with the candidate Pane IDs.
The deterministic hash fallback used for internal Worker naming is not accepted
for attach because it is not visible in noncanonical Pane labels. Existing
eligibility, project, TraeX, binding-ownership, and no-replay checks are unchanged.

## Verification

Unit tests will separate canonical token extraction from hash fallback behavior.
Attach integration tests will cover a unique token, compatibility labels, exact
ID and label precedence, ambiguous tokens, and noncanonical labels. Documentation
will show the short-token form while retaining full Pane ID and label support.
