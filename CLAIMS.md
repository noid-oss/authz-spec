# Token claims

Access tokens are issued by the brand's Hydra. Source of truth for the existing claims: `lib/consent.ts` `accessTokenClaims()` in noid-webapp.

| Claim | Type | Status | Notes |
|---|---|---|---|
| `iss` | string | standard | Per-brand issuer URL. Verifiers match it exactly against configuration. A token from another brand's issuer is rejected even if its signature is valid for that brand. |
| `sub` | string | standard | Kratos identity id. Shared across brands (one account). Used as the Keto subject. |
| `exp` | integer (Unix s) | standard | Required. `exp <= now` is expired. |
| `tenant_id` | string | emitted today | Tenant slug (`client.metadata.tenant`), same grammar as the manifest brand (`^[a-z0-9][a-z0-9-]{0,62}$`). Only a non-empty string is emitted; there is no fallback. Verifiers match it against the app's configured tenant. |
| `acr` | `"aal1"` or `"aal2"` | emitted today | `aal2` only when the consenting Kratos session finished a second factor. Defaults to `aal1`. |
| `amr` | string[] | emitted today, optional | Kratos authentication methods of that session (deduplicated), e.g. `["password","totp"]`. Omitted when unknown. |
| `auth_time` | integer (Unix s) | emitted today, optional | When that session last authenticated. Only set when the Kratos session belongs to the consenting subject; otherwise `acr=aal1` and no `auth_time`. Hydra keeps it on refresh, so it does not advance. Step-up checks must treat a missing `auth_time` as never satisfied. |
| `email` | string | emitted today, optional | Only when the `email` scope was granted. Audit only, never authorization. |
| `roles` | string[] | planned | Role names from the app manifest the subject holds, as of issue time. Informational. |
| `permissions` | string[] | planned | Permission names (`resource.action`) the subject held at issue time. **Hint only**, see below. |

`roles` and `permissions` are not emitted by noid-webapp yet; this spec defines them.

## Where custom claims live

Hydra puts consent-time session claims under `ext` in introspection responses and merges them to the top level of JWT access tokens. Verifiers read standard claims (`iss`, `sub`, `exp`, `aud`, `scope`) only from the top level. Custom claims (`tenant_id`, `roles`, `permissions`, `acr`, `amr`, `auth_time`, `email`) are read from the top level, falling back to `ext`. A custom claim must never override a standard one.

## `permissions` is a hint

- It can only deny early (absent means deny without a network call) or allow reads.
- It never allows a write: writes (anything not in the manifest's `reads`) are always checked live via `POST /v1/check`.
- It can be stale until the token expires. Revocations in Keto do not reach existing tokens. Keep access token TTL short.
- Non-array values, wildcards and unknown names are treated as absent / non-matching.
- Size: emit only the permissions of the app the token is for.
