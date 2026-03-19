# Snowflake Auth in the Pippin Sandbox

How `snow sql` works inside the pippin sandbox without a browser login.

## The Problem

The Snowflake CLI (`snow`) uses `externalbrowser` authentication: it opens a
browser, the user logs in via SSO, and the connector receives an ID token.
On macOS, this token is cached in the system keychain so subsequent commands
skip the browser. Inside the pippin sandbox (a Docker container running
Linux), there is no browser and no keychain. Without intervention, every
`snow` invocation would fail or hang trying to open a browser.

## How We Solve It

At sandbox start time, pippin's `snowflake` tool recipe (`prepareSnowflake`
in `src/cli/tools.ts`) bridges the macOS keychain to the Linux file-based
credential cache:

1. **Parse config** -- Read `~/.snowflake/config.toml` to find the default
   connection's `account`, `user`, and `authenticator`. Only proceed if the
   authenticator is `externalbrowser`.

2. **Extract the cached ID token from the macOS keychain** -- Use the Python
   `keyring` module from `snow`'s own Python environment (found via the
   `snow` binary's shebang). This is necessary because the macOS keychain
   ACL only grants access to the application that stored the item. The
   `security find-generic-password` CLI triggers an authorization dialog
   that hangs in non-interactive contexts, but `snow`'s Python shares the
   app identity that wrote the token and reads it without prompting.

3. **Compute the hash key** -- The Snowflake Python connector's
   `FileTokenCache` indexes tokens by `SHA-256(string_key)` where
   `string_key = "USER:HOST:ID_TOKEN"` (all uppercased). Pippin computes
   the same hash so the connector finds the token in the cache file.

4. **Generate a modified config.toml** -- Inject
   `client_store_temporary_credential = true` into each `[connections.*]`
   section. On Linux the connector defaults this to `false`, so without it
   the file cache is never consulted.

5. **Pass env vars to the container** -- `SNOWFLAKE_ID_TOKEN` (the raw
   token) and `SNOWFLAKE_TOKEN_HASH_KEY` (the SHA-256 hex) are set in the
   container environment. The modified config.toml is bind-mounted in place
   of the original.

6. **Container bootstrap creates the cache file** -- The entrypoint script
   in `sandbox.ts` writes
   `~/.cache/snowflake/credential_cache_v1.json` with the format
   `{"tokens":{"<hash>":"<token>"}}`, directory permissions 0700, file
   permissions 0600.

When `snow sql` runs inside the container, the connector's
`read_temporary_credentials()` finds the ID token in the file cache and
uses `AuthByIdToken` -- no browser needed.

## Why `security find-generic-password` Doesn't Work

The macOS keychain stores per-item access control lists (ACLs). When the
Snowflake connector (via Python's `keyring`) stores a token, the ACL is
scoped to the Python binary that wrote it. Running `security` (a different
binary at `/usr/bin/security`) triggers a system authorization dialog
asking the user to grant access. In a non-interactive context (like
`spawnSync` inside pippin), this dialog can't be answered, so the call
hangs until it times out.

The fix is to use the same Python that `snow` uses. We find it by reading
the shebang line of the `snow` binary (e.g.
`/opt/homebrew/Cellar/snowflake-cli/3.15.0/libexec/bin/python`). This
Python has `keyring` installed and its process identity matches the one
that stored the credential, so macOS grants access silently.

## The TokenKey Arg-Swap Bug in the Connector

The Snowflake connector's `TokenKey` dataclass is defined as:

```python
@dataclass(frozen=True)
class TokenKey:
    user: str
    host: str
    tokenType: TokenType
```

But `_auth.py` constructs it with swapped positional arguments:

```python
TokenKey(host, user, cred_type)  # host goes into self.user, user goes into self.host
```

So `string_key()`, which returns `f"{self.host}:{self.user}:{type}"`,
actually produces `USER:HOST:ID_TOKEN` at runtime (not `HOST:USER:ID_TOKEN`
as the field names suggest). The keychain service name and the file cache
hash key both use this swapped format. Our code must match it.

## File Cache Details

| Property | Value |
|---|---|
| Cache path | `$HOME/.cache/snowflake/credential_cache_v1.json` |
| Lookup order | `SF_TEMPORARY_CREDENTIAL_CACHE_DIR` > `XDG_CACHE_HOME/snowflake/` > `$HOME/.cache/snowflake/` |
| File format | `{"tokens": {"<sha256_hex>": "<token_value>"}}` |
| Hash input | `"USER:HOST:ID_TOKEN"` (uppercased), SHA-256, hex-encoded |
| Dir permissions | 0700 |
| File permissions | 0600 |
| Owner | Must match euid |

## Keychain Entry Format (macOS)

| Field | Value |
|---|---|
| Service | `USER:HOST:ID_TOKEN` (e.g. `MLAPORTE@COVEO.COM:COVEODEV.US-EAST-1.PRIVATELINK.SNOWFLAKECOMPUTING.COM:ID_TOKEN`) |
| Account | `HOST` (e.g. `COVEODEV.US-EAST-1.PRIVATELINK.SNOWFLAKECOMPUTING.COM`) |
| Keychain | `~/Library/Keychains/login.keychain-db` |

## Host Derivation

The `account` field in config.toml (e.g. `coveodev.us-east-1.privatelink`)
is converted to a host by appending `.SNOWFLAKECOMPUTING.COM` and
uppercasing, unless it already contains that suffix.

## `client_store_temporary_credential` on Linux

On macOS and Windows, the connector forces this to `true` regardless of
config. On Linux, it defaults to `false` (see `connection.py`):

```python
self._session_parameters[PARAMETER_CLIENT_STORE_TEMPORARY_CREDENTIAL] = (
    self._client_store_temporary_credential if IS_LINUX else True
)
```

This is why we inject the setting into config.toml -- without it, the
connector never calls `read_temporary_credentials()` and skips the file
cache entirely.

## Token Expiry

If the cached ID token expires, the connector falls back to
`AuthByWebBrowser` via `reauthenticate()`, which will fail in the headless
container. The user must re-authenticate on the host first (run
`snow sql --query 'SELECT 1'` on macOS to refresh the keychain token),
then restart the sandbox.

## Relevant Source Locations

**Pippin:**
- `src/cli/tools.ts` -- `prepareSnowflake()`, `readKeychainViaSnowPython()`, `parseSimpleToml()`, `injectCredentialCacheSetting()`
- `src/cli/sandbox.ts` -- Container bootstrap script that creates the credential cache file (around line 686)

**Snowflake connector** (in the container's Python packages):
- `snowflake/connector/auth/_auth.py` -- `read_temporary_credentials()`, `TokenKey` construction
- `snowflake/connector/token_cache.py` -- `FileTokenCache`, `TokenKey` dataclass, hash computation
- `snowflake/connector/connection.py` -- `__open_connection()`, authenticator selection, `client_store_temporary_credential` default
- `snowflake/connector/auth/idtoken.py` -- `AuthByIdToken` (uses cached token)
- `snowflake/connector/auth/webbrowser.py` -- `AuthByWebBrowser` (opens browser)

**Snowflake CLI:**
- `snowflake/cli/_app/snow_connector.py` -- Assembles connection params, calls `connector.connect()`
- `snowflake/cli/api/config.py` -- Config parsing, `get_connection_dict()`
