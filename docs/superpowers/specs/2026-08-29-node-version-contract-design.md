# Node Version Contract Design

## Status

Approved for implementation under the operator's standing instruction to use
the recommended design without another confirmation gate.

## Problem

The project declares and checks Node.js 22.5+, while the locked Vite toolchain
requires Node.js 22.12+ on the Node 22 line. A host can therefore pass the
project's explicit check and then fail or warn during the locked dependency
installation. The standalone installer has no explicit version check at all.

## Design

Raise the supported floor to Node.js 22.12 and make one ESM script the executable
version check for both plugin and standalone installation. The checker compares
numeric major/minor components from `process.versions.node`, accepts later major
versions, and exits non-zero with the actual version when the floor is not met.

`package.json` and its lockfile remain the package-manager contract. `install.sh`
and `plugin/build.sh` invoke the shared checker before dependency installation.
The active operator documentation in README and AGENTS uses the same minimum.
Historical design records retain their original context.

## Testing

Export a pure `supportsNodeVersion(version)` helper and guard CLI execution so
tests can verify the 22.11 rejection, 22.12 acceptance, later Node acceptance,
and malformed-version rejection without changing the running interpreter.
Manifest tests verify both installation paths call the shared checker.

## Deployment

This changes installation/build admission only. Existing Node 24 deployments are
unaffected. Do not restart production while unrelated runtime source remains
uncommitted.
