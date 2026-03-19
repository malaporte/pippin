# GitHub CLI Auth in the Pippin Sandbox

How `gh` works inside the pippin sandbox without browser-based OAuth.

## The Problem

The GitHub CLI (`gh`) stores authentication in `~/.config/gh/hosts.yml`.
On macOS, this file typically contains a `user:` field and an empty
`oauth_token:` field — the empty token signals `gh` to look up the real
token from the macOS keychain. Inside the pippin sandbox (a Docker
container running Linux), the keychain is inaccessible, so `gh` would
fail trying to read the token.

A naive fix would be to mount the entire `~/.config/gh/` directory into
the container and set `GH_TOKEN` as a fallback. This doesn't work: `gh`
checks `hosts.yml` *before* consulting environment variables. If it finds
a hosts entry for `github.com`, it uses that entry — and when the
keychain-backed `oauth_token` is empty, it fails without ever looking at
`GH_TOKEN`.

## How We Solve It

At sandbox start time, pippin's `gh` tool recipe avoids the hosts.yml
trap entirely and injects a token via the environment:

1. **Mount only `config.yml`** — Bind-mount `~/.config/gh/config.yml`
   (readonly) into the container. This file contains user preferences
   like aliases, editor, protocol, and pager settings — nothing
   auth-related.

2. **Do not mount `hosts.yml`** — By excluding `hosts.yml` (and the
   rest of the `~/.config/gh/` directory), `gh` inside the container
   sees no configured hosts. This forces it to fall back to environment
   variable authentication.

3. **Resolve `GH_TOKEN` dynamically** — If `GH_TOKEN` is not already
   set in the host environment, pippin runs `gh auth token` on the host
   at sandbox start. This command reads the token from the macOS
   keychain (or whatever credential store `gh` is configured to use) and
   prints it to stdout. Pippin captures the output and injects it as the
   `GH_TOKEN` environment variable in the container.

4. **Forward existing tokens** — If the user already has `GH_TOKEN` or
   `GITHUB_TOKEN` set in their shell environment, those values are
   forwarded directly. The `envResolver` for `GH_TOKEN` only runs when
   the variable is absent.

When `gh` starts inside the container, it finds no `hosts.yml`, checks
for `GH_TOKEN` in the environment, and authenticates using the injected
token — no browser or keychain needed.

## Why Not Mount `hosts.yml`

The `gh` CLI has a strict authentication precedence order:

1. `hosts.yml` entries matching the target host
2. `GH_TOKEN` / `GITHUB_TOKEN` environment variables
3. Interactive `gh auth login` prompt

When `hosts.yml` exists and contains an entry for `github.com`, step 1
wins unconditionally. On macOS, the entry typically looks like:

```yaml
github.com:
  user: your-username
  oauth_token:        # empty — triggers keychain lookup
  git_protocol: ssh
```

The empty `oauth_token` causes `gh` to invoke the macOS keychain API
(via go-keyring) to retrieve the real token. Inside a Linux container,
this API doesn't exist. The result is a hard authentication failure that
`GH_TOKEN` cannot rescue because `gh` never reaches step 2.

The cleanest fix is to not mount the file at all. With no `hosts.yml`,
`gh` falls through to step 2 and uses `GH_TOKEN` from the environment.

## Token Scope

The token resolved via `gh auth token` has whatever scopes were granted
during `gh auth login` on the host. The default login flow requests
`repo` and `read:org`. If your workflow needs additional scopes (e.g.
`admin:org`, `delete_repo`), you must re-authenticate on the host with
`gh auth login --scopes <scope1>,<scope2>`.

## Token Expiry

The `gh auth token` command reads from the host's active `gh` login
session. If the user runs `gh auth logout` on the host or the token is
revoked on GitHub, the sandbox will start with no valid token. `gh`
commands inside the container will fail with a 401.

Recovery: run `gh auth login` on the host, then restart the sandbox.

## Reference

| Property | Value |
|---|---|
| Mounted file | `~/.config/gh/config.yml` (readonly) |
| Excluded file | `~/.config/gh/hosts.yml` |
| Env vars forwarded | `GH_TOKEN`, `GITHUB_TOKEN` |
| Env resolver | `gh auth token` → `GH_TOKEN` (runs only if `GH_TOKEN` is unset) |
| Auth mechanism in container | Environment variable (`GH_TOKEN`) |

## Relevant Source Locations

**Pippin:**
- `src/cli/tools.ts` — `gh` recipe definition (line 372)
- `src/cli/sandbox.ts` — Environment variable forwarding into the container (line 620)

**GitHub CLI:**
- `internal/authflow/` — OAuth device flow (used by `gh auth login`)
- `pkg/cmd/auth/token/` — `gh auth token` command (reads from credential store)
- `internal/config/` — Config file loading, hosts.yml parsing, auth precedence
