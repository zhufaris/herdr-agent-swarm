# Release Procedure

Herdr Agent Swarm publishes prebuilt Linux x64 archives through GitHub Releases.
It does not publish an npm package and the release workflow never deploys or
restarts a service.

## Prepare a release

1. Update `version` in both `package.json` and `package-lock.json`. Use a semantic
   version such as `0.4.0` or `0.4.0-rc.1`.
2. Run `npm ci`, `npm test`, `npm run typecheck`, and `npm run build`.
3. Merge the version change only after the `CI` workflow passes on the final
   commit.
4. Create an annotated tag whose name is exactly `v` plus the package version:

   ```bash
   git tag -a v0.4.0 -m "Release v0.4.0"
   git push origin v0.4.0
   ```

The `Release` workflow rejects a tag that does not exactly match the committed
package version. It repeats the locked install, tests, typecheck, build,
production dependency audit, and credential scan before constructing assets.

## Published assets

Each successful workflow creates or updates the GitHub Release for the tag and
uploads:

- `herdr-agent-swarm-<version>-linux-x64.tar.gz`;
- `SHA256SUMS`.

Versions containing a prerelease suffix are marked as prereleases. GitHub
generates release notes from repository history. The archive contains compiled
output, production dependencies, lifecycle scripts, example configuration, and
operator documentation. It excludes credentials, live configuration, databases,
logs, caches, and repository metadata.

Repository Actions settings must allow workflows to create releases with the
built-in `GITHUB_TOKEN`. The workflow declares only `contents: write`; no package,
deployment, or identity-token permission is required.

## Local packaging check

After building, maintainers can reproduce the artifact without creating a tag or
GitHub Release:

```bash
release_dir="$(mktemp -d)"
npm run release:package -- --output "$release_dir" --tag v0.3.0
(cd "$release_dir" && sha256sum --check SHA256SUMS)
```

Use the current `package.json` version in place of `v0.3.0`. This command writes
only to the explicit output directory and does not install or restart the service.
