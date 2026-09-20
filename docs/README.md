# Maintainer Documentation

Use this page to choose the current document for a change or incident. The
implementation and tests remain the final authority; these guides explain the
current supported behavior and its boundaries.

## Choose by task

| What you need to do | Start here |
| --- | --- |
| Understand request flow, authority, durability, recovery, and no-replay rules | [Architecture](architecture.md) |
| Find the owning module, port, adapter, or composition seam | [Architecture reference](architecture-reference.md) |
| Learn the domain language and ownership boundaries | [Domain contexts](domain/README.md) |
| Use the service from a configured Feishu group | [Feishu group usage](feishu-group-usage.md) |
| Prepare or inspect a published release | [Releases](releases.md) |
| Install, update, diagnose, or restart the standalone service | [README operations guide](../README.md#install-from-source) |
| Inspect an earlier decision or completed implementation plan | [Historical documentation](archive/README.md) |

The [interactive architecture diagram](herdr-agent-swarm-architecture.html) is a
visual companion to the architecture guide. The static diagram appears in the
repository README.

## Current authority

Herdr owns live pane and Agent identity. SQLite owns durable workflow state and
delivery intent. Feishu owns only the visible cards and messages. User systemd
owns the service process. Start with the architecture guide whenever a change
touches more than one of those authorities.

The Superpowers directory contains only work that is still being designed or
implemented. Its [active engineering records](superpowers/README.md) are useful
for the change in progress, but they do not override the current guides or code.

## Validate a documentation change

Run the local documentation audit before handing off any documentation change:

~~~bash
npm run docs:audit
~~~

For a change that also affects source code, run the focused tests plus the
repository validation described in the root README and Agent guide.
