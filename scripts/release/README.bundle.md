# Herdr Agent Swarm Private Offline Bundle

This private Linux x86-64 archive contains Herdr 0.7.5 and the compiled Herdr
Agent Swarm runtime. It does not contain Node.js, TraeX, credentials, project
configuration, databases, logs, sessions, or optional Worker runtimes.

The target requires Node.js 22.12 or newer, TraeX, and a working user-systemd
session. Verify the adjacent archive checksum before extraction, then run:

```bash
./scripts/swarmctl verify
```

Installation and lifecycle commands are documented as they become available in
this private release series. Installation never starts services implicitly.
