# Loopback Health Host Design

## Context

The health server exposes readiness and sanitized operational diagnostics. The
architecture defines it as a loopback-only operator surface, but configuration
currently accepts any non-empty `BRIDGE_HTTP_HOST`, including `0.0.0.0` and
public or private network addresses. A deployment typo can therefore expose the
diagnostic endpoint outside the host.

## Decision

Validate `BRIDGE_HTTP_HOST` at the configuration boundary and accept only the
explicit loopback values `127.0.0.1`, `localhost`, and `::1`. Preserve
`127.0.0.1` as the default. Reject wildcard addresses, non-loopback IPs, and
arbitrary hostnames during startup and config validation.

An externally reachable health surface would require a separate design for
authentication, disclosure, rate limiting, and deployment topology; it is not
enabled by a permissive string setting.

## Test Strategy

Use `loadConfig()` as the boundary. Verify all three supported loopback values
map unchanged into `config.http.host`, and verify `0.0.0.0`, `::`, a private IP,
and a hostname are rejected. Run config tests, typecheck, the full suite, and
the production build before committing.
