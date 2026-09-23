# Controller Tool Socket Resource Bounds

## Goal

Bound the number and lifetime of idle Unix-socket clients accepted by the
Controller tool gateway, matching the established Primary tool gateway security
model without changing the Controller MCP protocol.

## Current problem

The Controller gateway limits each request to 64 KiB and tracks sockets for
shutdown, but accepts an unlimited number of clients and waits indefinitely for
the first newline. A buggy or hostile same-user process can therefore retain an
unbounded number of file descriptors and per-connection buffers. The socket's
`0600` mode restricts access to the service user but does not protect against
another process running as that user.

## Chosen behavior

Add optional gateway policy values with production defaults of 64 concurrent
connections and a 30-second idle timeout. Before adding a socket to the active
set, reject it when the configured limit has been reached. For an accepted
socket, start an unreferenced idle timer and destroy the connection if no complete
request arrives. Clear the timer as soon as the first complete request is
accepted and again during close cleanup.

Each connection continues to execute at most one request. Existing request-size,
capability, generation, Controller-runtime, JSON schema, and socket-permission
checks remain unchanged. Rejected excess and timed-out idle connections receive
no protocol response because no authenticated request was accepted.

## Lifecycle and errors

The gateway explicitly tracks whether it is accepting clients. Startup enables
acceptance only after the socket is listening and permissions are set. Shutdown
disables acceptance first, closes the server, destroys all accepted sockets, and
removes the socket path. Socket-level client errors are consumed so expected
resets cannot become unhandled events or warning-log noise.

This change does not add request retries, execute tools twice, or affect durable
Controller jobs.

## Verification

Tests use a real temporary Unix socket and small policy values to prove that an
idle accepted client is closed, a connection beyond the active limit is rejected,
and a new client is accepted after the prior client closes. Existing capability
and typed-result tests continue to pass. Full typecheck, build, audit, and Vitest
validation follow because the gateway participates in service lifecycle.
