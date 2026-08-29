# Standalone Install Dependency Boundary Design

## Status

Approved for implementation. The user authorized the recommended approach to proceed without per-batch confirmation.

## Problem

`install.sh --standalone` does not invoke the Herdr plugin CLI, but the script checks for `herdr` before branching into standalone mode. A host that can run the standalone bridge against a remote or separately managed Herdr server is therefore rejected for a command it never uses.

## Selected design

Validate `node` and `npm` before the mode branch because both installation modes build the project. Execute the existing standalone build and service installation path unchanged. Validate `herdr` only after the standalone early return, immediately before plugin build/link operations.

The script remains fail-fast and retains the existing missing-command message. A static contract test verifies that the common dependency loop excludes `herdr` and that an explicit Herdr check exists after the standalone branch. This avoids running package installation or systemd mutation in unit tests.

## Alternatives rejected

- Require Herdr because the service eventually talks to a Herdr server: the standalone installer does not need the local CLI at install time.
- Add a test mode to `install.sh`: unnecessary production complexity for a simple control-flow contract.
- Remove all command validation: would replace a clear error with a later shell failure.

## Tests and acceptance

- The standalone branch is reachable after checking only `node` and `npm`.
- Plugin installation still fails early when `herdr` is unavailable.
- Existing plugin manifest tests, shell syntax validation, typecheck, build, and repository tests pass.

## Non-goals

- Changing standalone runtime requirements or service configuration.
- Optimizing `npm ci` or production dependency packaging.
- Deploying the service.
