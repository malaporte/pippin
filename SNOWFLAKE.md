# Snowflake Tool Recipe — Investigation Notes

## Goal

Make `snow sql` work inside the Pippin sandbox with `externalbrowser` auth,
without requiring a browser login each time. On macOS the Snowflake connector
caches an ID token in the keychain; on Linux (container) it uses a file-based
cache. We need to bridge the two.

## What We Built

The `snowflake` recipe in `src/cli/tools.ts` (`prepareSnowflake`):

1. Parses `~/.snowflake/config.toml` to find the default connection's
   account, user, and authenticator.
2. Reads the cached ID token from the macOS keychain via
   `security find-generic-password`.
3. Computes the SHA-256 hash key for the `FileTokenCache`.
4. Generates a modified `config.toml` with
   `client_store_temporary_credential = true` injected into each connection
   section (required on Linux for the connector to read the file cache).
5. Passes `SNOWFLAKE_ID_TOKEN` and `SNOWFLAKE_TOKEN_HASH_KEY` env vars to
   the container entrypoint, which creates
   `~/.cache/snowflake/credential_cache_v1.json`.

## Current Status

**Everything is correctly wired up inside the container**, but `snow` still
prompts for browser login. We haven't identified the exact remaining issue.

### What's Verified Working

- **Config mount**: `/root/.snowflake/config.toml` contains the modified config
  with `client_store_temporary_credential = true` (parsed correctly by
  `tomllib` as Python `bool True`).
- **Credential cache file**: `/root/.cache/snowflake/credential_cache_v1.json`
  exists with correct hash key, permissions (0600), dir permissions (0700),
  owner uid 0, euid 0.
- **Hash key match**: Our computed hash matches `TokenKey.hash_key()` when
  called with the correct arg order.
- **FileTokenCache.retrieve()**: Successfully returns the token (371 chars)
  when called directly from Python inside the container.
- **Env vars**: `SNOWFLAKE_ID_TOKEN` and `SNOWFLAKE_TOKEN_HASH_KEY` are set.
- **Token validity**: The token is not expired (works on the host).

### Remaining Mystery

Despite `FileTokenCache.retrieve()` returning the token when called directly,
`snow sql` still falls through to browser auth. Possible causes to investigate:

1. **The `snow` CLI may pass the connection dict to `snowflake.connector.connect()`
   in a way that bypasses the connector's own `read_temporary_credentials()`.**
   The CLI uses `get_connection_dict()` → `connect(**connection_parameters)`.
   The connector's `__open_connection()` calls `auth.read_temporary_credentials()`
   which checks `CLIENT_STORE_TEMPORARY_CREDENTIAL` in session_parameters. Need
   to verify the parameter actually flows through to the session_parameters dict.

2. **The `host` value the connector computes internally may differ from our
   account-based computation.** The connector resolves `host` from `account`
   via its own logic (adding `.snowflakecomputing.com`, handling privatelink,
   etc.). If the internal `self.host` differs from what we use for the hash
   key, the cache lookup succeeds in our test but fails in the real flow.
   This is the most likely cause — need to check what `connection.host`
   resolves to.

3. **TLS/proxy issues**: Leash does TLS MITM. We set `REQUESTS_CA_BUNDLE` and
   `SSL_CERT_FILE`, but the connector's `ssl_wrap_socket.py` silently
   swallows CA bundle load errors. A TLS failure would be a hard crash though,
   not a browser prompt.

4. **Token format/encoding**: The token passes through shell `printf` in the
   entrypoint. Characters like `+`, `/`, `=` in the base64 token could
   theoretically be mangled, but our debug showed the token length matches.

## Key Technical Details

### Snowflake Connector Token Cache (Linux)

- **Source**: `snowflake/connector/token_cache.py` (in the connector package)
- **Cache path**: `$HOME/.cache/snowflake/credential_cache_v1.json`
  - Lookup order: `SF_TEMPORARY_CREDENTIAL_CACHE_DIR` → `XDG_CACHE_HOME/snowflake/` → `HOME/.cache/snowflake/`
- **Format**: `{"tokens": {"<sha256_hex>": "<token_value>"}}`
- **Hash key**: SHA-256 of `"HOST:USER:ID_TOKEN"` (all uppercased)
  - `TokenKey` dataclass: fields are `user, host, tokenType` (in that order)
  - `string_key()` returns `f"{self.host.upper()}:{self.user.upper()}:{self.tokenType.value}"`
- **Security**: Dir must be 0700, file must be 0600, both owned by euid
- **Lock file**: `credential_cache_v1.json.lck` (directory-based lock, not a file)

### Keychain Entry Format

- **Service**: `USER:HOST:ID_TOKEN` (e.g. `MLAPORTE@COVEO.COM:COVEODEV.US-EAST-1.PRIVATELINK.SNOWFLAKECOMPUTING.COM:ID_TOKEN`)
- **Account**: `HOST` (e.g. `COVEODEV.US-EAST-1.PRIVATELINK.SNOWFLAKECOMPUTING.COM`)
- Read via: `security find-generic-password -s <service> -w`

### Host Derivation

Our code builds the host from the `account` field:
```
account = "coveodev.us-east-1.privatelink"
→ host = "COVEODEV.US-EAST-1.PRIVATELINK.SNOWFLAKECOMPUTING.COM"
```

The connector's internal host resolution may differ — this is the most
likely source of the mismatch. Check `connection.py` `_account_to_host()`
or similar.

### `client_store_temporary_credential` on Linux

On Linux, the connector defaults this to `False` (line 253 of
`connection.py`). On macOS/Windows it's forced to `True` regardless. Must be
explicitly set for file-based caching to work:

```python
# connection.py line 1224-1227
self._session_parameters[PARAMETER_CLIENT_STORE_TEMPORARY_CREDENTIAL] = (
    self._client_store_temporary_credential if IS_LINUX else True
)
```

### `snow` CLI Config Flow

1. `snow sql` → `connect_to_snowflake()` in `snow_connector.py`
2. `get_connection_dict(connection_name)` reads from `CONFIG_MANAGER`
   (which reads `~/.snowflake/config.toml`)
3. Connection dict passed as `**kwargs` to `snowflake.connector.connect()`
4. Connector does NOT re-read config.toml — it uses the kwargs directly
5. `SNOWFLAKE_CLIENT_STORE_TEMPORARY_CREDENTIAL` env var is a fallback
   (only used if key not in connection dict)

### Relevant Source Files (in container's pipx venv)

All under `/root/.local/share/pipx/venvs/snowflake-cli-labs/lib/python3.13/site-packages/`:

| File | Role |
|------|------|
| `snowflake/cli/_app/snow_connector.py` | Assembles connection params, calls `connector.connect()` |
| `snowflake/cli/api/config.py` | Config parsing, `get_connection_dict()` |
| `snowflake/connector/connection.py` | `__open_connection()`, authenticator selection |
| `snowflake/connector/auth/_auth.py` | `read_temporary_credentials()`, `get_token_cache()` |
| `snowflake/connector/auth/webbrowser.py` | `AuthByWebBrowser` — opens browser |
| `snowflake/connector/auth/idtoken.py` | `AuthByIdToken` — uses cached token |
| `snowflake/connector/token_cache.py` | `FileTokenCache`, `TokenKey`, hash computation |
| `snowflake/connector/sf_dirs.py` | Config/cache directory resolution |

### Next Steps

1. **Check host resolution**: Run `snow` with debug logging to see what
   `self.host` resolves to inside the connector. Compare with our hash key
   computation. This is the most likely issue.
   ```
   pippin run "SNOWFLAKE_LOG_LEVEL=DEBUG snow sql --query 'SELECT 1' 2>&1 | grep -i 'host\|token\|cache\|credential\|id_token'"
   ```

2. **Alternative approach**: Instead of pre-populating the file cache, inject
   the token via `SNOWFLAKE_TOKEN` env var and set
   `SNOWFLAKE_AUTHENTICATOR=oauth` (or similar). This bypasses the cache
   entirely but changes the auth flow.

3. **Monkey-patch approach**: Write a tiny Python wrapper that patches
   `Auth.read_temporary_credentials` to inject the token directly, then
   delegates to `snow`. Heavy-handed but guaranteed to work.
