# App manifest: `permissions.yaml`

Spec version: **2.1.0** (also `specVersion` in `vectors.json` and `info.version` in `openapi.yaml`). 2.1.0 tightens the object relation map (the object type must equal the resource part of the permission). 2.0.0 was breaking: new brand/app grammars, `app` is the OAuth `client_id`, linked-resource rules, object relation map.

Each app ships one manifest next to its code. It is the source for the Keto model the check service provisions and for the SDK's read/write split.

```yaml
app: 3f2b8c1e-9a4d-4e57-b6a0-1c2d3e4f5a6b   # the OAuth client_id of the app (Hydra default is a UUID)
permissions:
  - invoice.view
  - invoice.print
  - invoice.void
roles:
  viewer:  [invoice.view]
  cashier: [invoice.view, invoice.print]
  admin:   [invoice.view, invoice.print, invoice.void]
reads:                       # subset of permissions decidable from the token claim alone
  - invoice.view
resources:                   # optional: object types that can be passed to can()
  - invoice
# optional/future map form, see "Object relation map":
# resources: { invoice: { actions: { print: viewer } } }
```

## Fields

| Field | Required | Rules |
|---|---|---|
| `app` | yes | Equals the app's OAuth `client_id`. Same grammar as the object `app` segment: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, no `..`. Unique per brand. |
| `permissions` | yes | Non-empty list, unique, each matching the permission grammar. |
| `roles` | yes | Map of role name to list of permissions. Role names `^[a-z][a-z0-9_-]{0,31}$`. Every listed permission must be declared in `permissions`. |
| `reads` | yes (may be `[]`) | Subset of `permissions`. |
| `resources` | no | Either a list of object types, or (optional/future) a map of type to `{ actions: { <action>: <relation> } }`. Each type matches the type grammar. When present, `object.type` must equal a declared type: otherwise the SDK denies with `invalid_object` and the check service answers 400 `invalid_request`. If absent, any well-formed type is accepted. |

## Naming rules

All grammars are ASCII, anchored, and none of them may contain `..` or `/`.

- Permission: `<resource>.<action>`, exactly two segments, each `[a-z][a-z0-9_]*`. Regex: `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`. Max 64 chars.
- Brand: the tenant slug, `^[a-z0-9][a-z0-9-]{0,62}$` (1 to 63 chars, may start with a digit). Same as `TENANT_SLUG` in noid-console `lib/guardrails/metadata.ts`.
- App: the OAuth `client_id`, `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (1 to 128 chars, uppercase allowed, so a Hydra UUID fits), no `..`.
- Object type: `^[a-z][a-z0-9_]{0,31}$` (1 to 32 chars).
- Object id (caller-supplied, opaque): `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and must not contain `..`. This excludes `/`, `\`, `%`, whitespace, control characters, and non-ASCII, so an id can never add or remove a path segment.
- Keto object: exactly four segments `<brand>/<app>/<type>/<id>`, each valid under its own grammar above, no other `/`. Anything else is invalid.

`brand` and `app` in `config` are validated against their grammars too, because they build the Keto object. An invalid value denies with `invalid_config` before any call.

## Deny by default

- A permission **not listed in `reads` is a write**, including permissions not in the manifest at all, typos, and anything added later without being classified. Writes are always decided live.
- Read classification is opt-in. Adding to `reads` is a security decision: the token may be stale for up to its TTL.
- Permissions not in the token's `permissions` claim are denied before any live call (see README).

## Object id namespacing

Keto objects are global, so the check service builds the Keto object as

```
<brand>/<app>/<type>/<id>        e.g. idbi/billing/invoice/inv-001
```

`brand` and `app` come from the authenticated request context (`config`), never from `type` or `id`. SDKs and the service validate all four segments against the grammars above and reject (deny) anything else, so none of `/`, `..`, encoded separators can reach another brand's or app's objects.

## Link rules

Resource tuples must not cross a brand/app boundary. Wherever tuples are validated (check service, migration and prune scripts, console):

- The object must parse as a valid Keto object (four valid segments).
- `#app` must be `App:<app>` where `<app>` is exactly the `app` segment of the object (case-sensitive). Otherwise `app_mismatch`.
- `#parent`, when present, must be a valid Keto object whose `brand` and `app` segments equal the object's. A malformed parent is `invalid_parent`, a parent in another brand or app is `parent_mismatch`.

Checked in order: object, `#app`, `#parent`. Conformance: `linkVectors` in `vectors.json`.

## Object relation map

Normative for `POST /v1/check` when `object` is present. The check service first requires `object.type` to equal the **resource part** of the permission (the part before the dot): `invoice.view` can be checked on an `invoice` object, never on a `project` object. A mismatch is rejected with reason `invalid_object` (the service answers 400 `invalid_request`) before anything is looked up. Then it maps the permission's **action suffix** (the part after the dot) to the relation it checks on the object:

| Action suffix | Relation checked on the object |
|---|---|
| `view` | `view` |
| `edit` | `edit` |
| `delete` | `delete` |
| anything else | **denied** (`allowed:false`, `denied`) unless the manifest maps it |

- `object.type` must equal a declared resource type when the manifest declares `resources`.
- **Optional/future** mapping: `resources: { invoice: { actions: { print: viewer } } }` maps action `print` on type `invoice` to relation `viewer` (relation names `^[a-z][a-z0-9_]{0,31}$`). A mapping may add actions but never remap `view`, `edit` or `delete`; those keep the defaults. Implementations that do not support the map treat those actions as unmapped (denied). Vectors for it carry `optional: true`.
- Conformance: `relationVectors` in `vectors.json`. Reasons there: `invalid_request` (bad permission), `invalid_object` (bad or undeclared type), `unmapped_action`.
