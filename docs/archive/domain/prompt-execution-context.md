# Retired Prompt Execution Context

This document records the removed Swarm-managed Primary Prompt FIFO model. It is historical and is not a current domain context.

The former model admitted Prompt Inputs, formed Native Input Batches, claimed one Ordinary Execution Slot per Binding, and held later work behind detached or uncertain execution. New human input no longer enters that model. Dormant tables and recovery code may remain temporarily so unresolved possible-effect evidence is not discarded or replayed.

Current behavior is defined by [Agent Input](../../domain/agent-input/CONTEXT.md): each input is independently submitted through Herdr Core, and Core JSONL alone establishes final conversation order.
