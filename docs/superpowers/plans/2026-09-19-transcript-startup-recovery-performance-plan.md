# Transcript Startup Recovery Performance Plan

1. Add a failing test proving concurrent different-session discovery shares one scan.
2. Add a bounded, short-lived path index while preserving per-path validation.
3. Filter baseline records before UTF-8 decoding and JSON parsing; enlarge only the I/O chunk, not the recovery window.
4. Run focused transcript tests, typecheck, build, and the full suite.
5. Install through the supported lifecycle, restart without force after safety checks, and verify the production startup phase is below two seconds.
6. Benchmark bounded concurrency against production-sized transcripts; retain the existing cap unless measurements justify a change.
7. Replace cold active-turn baseline recovery with a bounded reverse scan, test completed, foreign-terminal, and chunk-boundary cases, and remove the unused per-session discovery implementation.
