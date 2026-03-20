# GitHub Copilot CLI Auth in the Pippin Sandbox

How `copilot` (the GitHub Copilot CLI) works inside the pippin sandbox
without macOS keychain access.

## The Problem

The GitHub Copilot CLI checks credentials in this priority order:

1. `COPILOT_GITHUB_TOKEN` environment variable
2. `GH_TOKEN` environment variable
3. `GITHUB_TOKEN` environment variable
4. OAuth token from the OS keychain (stored via `copilot login`)
5. GitHub CLI fallback (`gh auth token`)

Inside the pippin sandbox (a Docker container running Linux), the macOS
keychain is inaccessible, so method 4 does not work. Method 5 also
fails because `gh` inside the container may not be authenticated.

## How We Solve It

The approach mirrors the `gh` tool recipe: extract the token on the host
(where the keychain is accessible) and inject it as an environment
variable at the highest priority level.

1. **Resolve `COPILOT_GITHUB_TOKEN` dynamically** -- If
   `COPILOT_GITHUB_TOKEN` is not already set in the host environment,
   pippin runs `gh auth token` on the host at sandbox start. This reads
   the GitHub token from the macOS keychain (or whatever credential
   store `gh` is configured to use) and injects it as
   `COPILOT_GITHUB_TOKEN` -- the highest-priority env var that Copilot
   CLI checks.

2. **Forward existing tokens** -- If the user already has
   `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` set in their
   shell environment, those values are forwarded directly. The
   `envResolver` for `COPILOT_GITHUB_TOKEN` only runs when the variable
   is absent.

3. **Mount `~/.copilot/config.json`** (readonly) -- The Copilot CLI
   config file (trusted folders, settings) is mounted so the tool
   inside the container uses the same preferences. On headless systems
   where no keychain is available, this file may also contain a
   plaintext token fallback.

When Copilot CLI starts inside the container, it finds
`COPILOT_GITHUB_TOKEN` in the environment (highest priority) and
authenticates using the injected token -- no keychain or `gh` CLI
fallback needed.

## Why We Use `gh auth token`

Copilot CLI's own `copilot login` stores tokens in the OS keychain
(service name: `copilot-cli`), and there is no `copilot auth token`
command to extract them programmatically. However, Copilot CLI accepts
any valid GitHub token with the right scopes, and most users who have
Copilot also have `gh` installed and authenticated. Running `gh auth
token` on the host extracts a working GitHub token from the `gh`
credential store and injects it at Copilot CLI's highest-priority env
var.

This means:

- Users authenticated via `gh auth login` get seamless Copilot auth
  inside the sandbox.
- Users who prefer a PAT (personal access token) can set
  `COPILOT_GITHUB_TOKEN` or `GH_TOKEN` in their environment.
- The `gh` tool recipe and `copilot` recipe can coexist. If both are
  enabled, `GH_TOKEN` is resolved by the `gh` recipe and
  `COPILOT_GITHUB_TOKEN` by the `copilot` recipe -- both from
  `gh auth token`, but assigned to different env var names, so each
  tool picks up its preferred variable.

## Token Requirements

Copilot CLI requires a GitHub token with Copilot access. The following
token types are supported:

| Type | Prefix | Supported |
|------|--------|-----------|
| OAuth (device flow) | `gho_` | Yes |
| Fine-grained PAT | `github_pat_` | Yes (requires "Copilot Requests" permission) |
| GitHub App user-to-server | `ghu_` | Yes |
| Classic PAT | `ghp_` | No |

The token from `gh auth token` is typically an OAuth token (`gho_`) and
works with Copilot CLI.

## GitHub Copilot Coding Agent

The GitHub Copilot coding agent (triggered by assigning issues to
`@copilot` or mentioning it in PR comments) runs **server-side** on
GitHub Actions with auto-provisioned tokens. It does not run locally and
does not need a pippin tool recipe. This recipe is only for the local
Copilot CLI tool.

## Token Expiry

The token resolved via `gh auth token` has the same lifetime as the
host's `gh` login session. If the user runs `gh auth logout` or the
token is revoked on GitHub, Copilot commands inside the container will
fail.

Recovery: run `gh auth login` on the host, then restart the sandbox
with `pippin restart`.

## Reference

| Property | Value |
|---|---|
| Mounted file | `~/.copilot/config.json` (readonly) |
| Env vars forwarded | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` |
| Env resolver | `gh auth token` -> `COPILOT_GITHUB_TOKEN` (runs only if `COPILOT_GITHUB_TOKEN` is unset) |
| Auth mechanism in container | Environment variable (`COPILOT_GITHUB_TOKEN`) |

## Relevant Source Locations

**Pippin:**
- `src/cli/tools.ts` -- `copilot` recipe definition
- `src/cli/sandbox.ts` -- Environment variable forwarding into the container
