# Security Policy

## Supported versions

Security fixes are applied to the latest release on the default branch. Earlier
versions should be upgraded before reporting an issue.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, credential exposure,
or authorization bypass. Contact the maintainers through GitHub's private
security advisory flow for this repository. Include a minimal reproduction,
affected version or commit, impact, and any mitigation you have already applied.

We will acknowledge a report within seven days, coordinate a fix privately when
needed, and publish credit only with the reporter's permission.

## Deployment boundary

Herdr Agent Swarm accepts approved Lark messages as instructions to a local
Agent. It is not designed for public or untrusted chats. Run it under a
least-privilege account in an isolated environment, keep `LARK_ALLOWED_OPEN_IDS`
and `LARK_ADMIN_OPEN_IDS` deliberately narrow, and never commit runtime
configuration, databases, logs, or credentials.
