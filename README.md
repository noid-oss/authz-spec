# authz-spec

Spec version 2.1.0. Language-neutral contract for authorization across brands. SDKs (any language) and the check service implement against this repo. Nothing here runs in production.

## Model

- One account across brands. Each brand has its own Kratos + Hydra; Kratos instances share one identity DB. Each brand has its own token issuer (`iss`).
- Keto is the permission store. Apps never call keto-read directly; they call `POST /v1/check` ([openapi.yaml](openapi.yaml)) on the check service.
- Access tokens carry a `permissions` claim as a **hint only** ([CLAIMS.md](CLAIMS.md)).
- Each app declares a `permissions.yaml` ([MANIFEST.md](MANIFEST.md)). A permission listed under `reads` may be decided from the token claim alone. **Every other permission is a write** and is always checked live. Fail closed.

## The helper

```
perms.can(user, permission, object?)   // e.g. can(user, "invoice.print", {type:"invoice", id:"inv-001"})
```

`user` is an already-verified token (signature, `aud`, etc. are the SDK's job and out of scope here; `can()` receives the claims). Steps, in order. The first failing step denies and stops:

1. Token checks: `iss` equals `config.issuer` (exact string match), `tenant_id` equals `config.tenant_id`, `sub` is a non-empty string, `exp` is an integer greater than `config.now`. Reasons: `invalid_issuer`, `invalid_tenant`, `invalid_subject`, `token_expired`.
2. Request checks: `config.brand` and `config.app` match their grammars (`invalid_config`); permission name and object `type`/`id` match the grammars in [MANIFEST.md](MANIFEST.md), and `type` is a declared resource type when the manifest declares `resources`. Reason: `invalid_request` (bad permission name) or `invalid_object` (bad or undeclared object). No network call is made on invalid input.
3. Claim hint: `claims.permissions` must be an array containing `permission` exactly (no wildcards). Missing, non-array, or absent entry means deny, reason `permission_not_in_claim`. No live call.
4. Live permission check: only if `permission` is NOT in `manifest.reads`. One `POST /v1/check` without `object`. `allowed=true` continues; `allowed=false` is `denied`.
5. Live object check: only if an object was given, whether or not the permission is a read. One `POST /v1/check` with `object:{type,id}`. `allowed=false` is `object_denied`.
6. Any error (network, non-200, malformed body, `allowed` not literally `true`) is deny: `check_error`. A timeout is deny: `check_timeout`. Steps 4 and 5 run in that order and stop at the first non-allow.
7. Allowed: `allowed_claim` if no live call was made, else `allowed_live`.

`brand`, `app` and `subject` of every live call come from `config.brand`, `config.app` and `claims.sub`, never from the caller. `config.app` is the app's OAuth `client_id`, so it may be a UUID or contain uppercase letters.

Known and accepted: a read permission revoked in Keto stays allowed until the token expires (stale claim). Reads that touch a specific object still get a live object check.

## Files

| File | What |
|---|---|
| `openapi.yaml` | `POST /v1/check` |
| `CLAIMS.md` | Token claims |
| `MANIFEST.md` | `permissions.yaml`, naming rules, object id namespacing, link rules, object relation map |
| `vectors.json` | Conformance vectors for `can()` (`vectors`), resource link rules (`linkVectors`) and the object relation map (`relationVectors`) |
| `vectors.schema.json` | JSON Schema for `vectors.json` |
| `scripts/validate.mjs` | Validates the vectors against the schema and replays them through `scripts/reference.mjs` |

## Conformance

An SDK passes if, for every vector, feeding `config` (file default merged with the vector's `config`), `manifest`, `claims`, `request` and a stub for the live service driven by `liveCheck` yields exactly `expect.allowed`, `expect.reason`, and the ordered `expect.liveCalls` (compare `permission` and `object`; `keto_object` is for service implementers). Implementations that validate Resource tuples or serve `/v1/check` also pass `linkVectors` and `relationVectors` (vectors marked `optional` cover the future manifest action mapping).

```
node scripts/validate.mjs
```
