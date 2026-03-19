# AWS CLI Auth in the Pippin Sandbox

How `aws` commands work inside the pippin sandbox without SSO browser
login or writable credential caches.

## The Problem

The AWS CLI supports many credential sources: static IAM keys, SSO
sessions, assumed roles, instance profiles, and more. Most modern setups
use AWS IAM Identity Center (SSO), which stores short-lived session
tokens in `~/.aws/sso/cache/` and resolved credentials in
`~/.aws/cli/cache/`. These cache directories must be **writable** — the
CLI updates them on every credential refresh.

This creates a dilemma inside the pippin sandbox:

- **Mount `~/.aws/` read-only**: The CLI can read `config` and discover
  profiles, but the SSO credential provider fails when it tries to write
  to the cache directories.
- **Mount `~/.aws/` read-write**: The container can modify the host's
  credential caches, SSO cache, and even `~/.aws/credentials`. This
  breaks sandbox isolation.
- **Don't mount anything**: The CLI has no profile configuration and no
  credentials at all.

Additionally, SSO authentication requires a browser login that cannot
happen inside a headless container.

## How We Solve It

At sandbox start time, pippin's `aws` tool recipe sidesteps the cache
problem entirely by resolving credentials to plain environment variables:

1. **Mount only `~/.aws/config`** (readonly) — This file contains
   profile definitions, default region, SSO session configuration, and
   role-chaining settings. It is never written to by the CLI.

2. **Do not mount `~/.aws/credentials` or cache directories** — Avoids
   the read-only-vs-writable conflict. The container has no access to
   `~/.aws/sso/cache/`, `~/.aws/cli/cache/`, or `~/.aws/credentials`.

3. **Resolve credentials via `envMultiResolver`** — At sandbox start,
   pippin runs `aws configure export-credentials --format env-no-export`
   on the host. This command resolves the active profile's credentials
   through the full provider chain (SSO, assume-role, static keys,
   credential process, etc.) and outputs them as `KEY=VALUE` lines:

   ```
   AWS_ACCESS_KEY_ID=ASIA...
   AWS_SECRET_ACCESS_KEY=abc123...
   AWS_SESSION_TOKEN=FwoG...
   AWS_CREDENTIAL_EXPIRATION=2025-03-19T18:30:00Z
   ```

   Pippin parses all lines and injects them as environment variables in
   the container.

4. **Forward profile and region** — `AWS_PROFILE` and
   `AWS_DEFAULT_REGION` are forwarded from the host environment if set,
   so the mounted `~/.aws/config` resolves to the correct profile
   inside the container.

When any AWS SDK or CLI runs inside the container, it finds
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in the environment and
uses them directly — no SSO provider, no cache files, no browser.

## Why `export-credentials` Instead of Mounting Cache Files

The `aws configure export-credentials` command is the linchpin of this
approach. Its advantages over mounting cache files:

- **Universal**: It resolves credentials regardless of the source. SSO,
  assume-role chains, credential-process scripts, static keys — all
  produce the same `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
  `AWS_SESSION_TOKEN` output. The container doesn't need to understand
  the host's credential provider chain.

- **Read-only**: The command only *reads* the host's credential state.
  It doesn't write to any cache file, so there's no side-effect.

- **SDK-native**: Every AWS SDK (boto3, JS SDK, Go SDK, CLI) checks
  environment variables as the highest-priority credential source. No
  SDK-specific configuration is needed inside the container.

- **No writable mounts**: Since credentials arrive as env vars, the
  container doesn't need write access to any AWS directory.

## TLS and the MITM CA

The pippin sandbox routes traffic through a leash MITM proxy for Cedar
policy enforcement. This proxy terminates TLS, so the AWS CLI (and any
SDK) must trust the proxy's CA certificate.

At container start, the bootstrap script creates a combined CA bundle:

```sh
cat /etc/ssl/certs/ca-certificates.crt /leash/ca-cert.pem > /tmp/combined-ca.pem
```

and sets `AWS_CA_BUNDLE=/tmp/combined-ca.pem`. Without this, every AWS
API call fails with a certificate verification error. The same bundle
is also set as `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, and
`NODE_EXTRA_CA_CERTS` so that Python, Node.js, and other runtimes also
trust the proxy.

## Credential Expiry

The credentials injected at sandbox start are a point-in-time snapshot.
For SSO-based profiles, these are temporary STS credentials with a TTL
(typically 1–12 hours, depending on the IAM Identity Center session
duration configuration).

When the credentials expire, AWS commands inside the container fail with
`ExpiredTokenException`. The container has no way to refresh them — it
doesn't have access to the SSO cache or browser.

Recovery:

1. Re-authenticate on the host: `aws sso login`
2. Restart the sandbox — pippin re-runs `export-credentials` and injects
   fresh temporary credentials.

The `AWS_CREDENTIAL_EXPIRATION` variable is forwarded into the container,
so tools can detect approaching expiry programmatically.

## Reference

| Property | Value |
|---|---|
| Mounted file | `~/.aws/config` (readonly) |
| Excluded paths | `~/.aws/credentials`, `~/.aws/sso/cache/`, `~/.aws/cli/cache/` |
| Env vars forwarded | `AWS_PROFILE`, `AWS_DEFAULT_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_CREDENTIAL_EXPIRATION` |
| Multi-resolver command | `aws configure export-credentials --format env-no-export` |
| CA bundle env var | `AWS_CA_BUNDLE=/tmp/combined-ca.pem` |
| Auth mechanism in container | Environment variables (STS temporary credentials) |

## Relevant Source Locations

**Pippin:**
- `src/cli/tools.ts` — `aws` recipe definition (line 385), `envMultiResolver` for credential export
- `src/cli/sandbox.ts` — CA bundle creation in the container bootstrap script (line 674), environment variable forwarding (line 620)

**AWS CLI:**
- `awscli/customizations/configure/exportcreds.py` — `aws configure export-credentials` implementation
- `botocore/credentials.py` — Credential provider chain (env vars are checked first)
- `botocore/session.py` — Profile resolution from `AWS_PROFILE` + config file
