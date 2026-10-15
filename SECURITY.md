# Security policy

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability**. Do not open a public issue, pull request, or
discussion for it.

Include:

- the affected version (a release tag or a commit);
- what an attacker needs: local access, a token scope, a crafted website page, or
  a crafted model answer;
- the steps to reproduce, and what they expose or change.

Never include a real credential, session cookie, TOTP secret, or account state in
a report. If one leaked, say which kind it was and rotate it.

## Supported versions

Only the latest release gets fixes. Before the first release, only the `main`
branch does. The supported Node range is part of each release
([ADR-0026](docs/decisions/adr/0026-versioned-releases-with-provenance.md)).

## Scope

The trust boundaries, assets, and accepted risks are in the
[threat model](docs/security/threat-model.md). Reports are most useful for:

- the credential vault, the account state, and remote login;
- the control credentials and their scopes (MCP server, gateways, Web UI);
- egress checks on what leaves for a Worker;
- the confinement of agent Workers;
- authority taken from model or website text instead of a trusted envelope.

Website providers' own terms, and the risk to an account that automates a website,
are accepted risks of the design, not vulnerabilities in `system`.

## Verifying a release

Each release lists SHA-256 checksums and carries a build provenance attestation
for every package tarball and SBOM. See [releasing](docs/engineering/releasing.md#verifying-a-release).
