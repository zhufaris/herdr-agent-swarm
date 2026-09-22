# SQLite Outbox Generation and Retention Plan

## Objective

Make outbound lane construction constant-cost with respect to Answer size and
make retention recovery exclusions independently indexable.

## Work packages

1. Add a failing lane-equivalence test covering an explicit generation hint and
   prompt scalar fallback.
2. Extend the SQLite-internal enqueue input, pass the hint from Answer snapshot
   reservation, and replace the full Run Card view lookup with a scalar query.
3. Add failing retention tests for active failed/replacement recovery references
   and a query-plan characterization.
4. Split the recovery `OR` into two `NOT EXISTS` clauses without changing the
   retained set.
5. Update architecture documentation, run all verification gates, review against
   this design and repository standards, archive these records, and commit.
