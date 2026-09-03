# Contributing

Thanks for contributing. Please discuss non-trivial behavioral changes in an
issue before starting implementation. Never include credentials, live project
registries, databases, logs, or generated runtime state in a pull request.

Before opening a pull request, run:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Keep changes focused, add tests beside the affected boundary, and update the
operator documentation when configuration or lifecycle behavior changes.

Report security concerns privately as described in [SECURITY.md](SECURITY.md),
not in public issues or pull requests.
