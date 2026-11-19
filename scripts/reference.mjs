// Reference implementation of can() and the link / relation rules, used only to prove the
// vectors are self-consistent. SDKs and the check service implement the same rules
// (README.md, MANIFEST.md) in their own language.
export const SPEC_VERSION = "2.0.0";

// Grammars (MANIFEST.md "Naming rules"). Keep in sync with the doc.
const PERM = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const BRAND = /^[a-z0-9][a-z0-9-]{0,62}$/;
const APP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TYPE = /^[a-z][a-z0-9_]{0,31}$/;
const OID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RELATION = /^[a-z][a-z0-9_]{0,31}$/;

const str = (re, v) => typeof v === "string" && re.test(v) && !v.includes("..");
export const validBrand = (v) => str(BRAND, v);
export const validApp = (v) => str(APP, v);
export const validType = (v) => str(TYPE, v);
export const validId = (v) => str(OID, v);

// Parses "<brand>/<app>/<type>/<id>"; null unless exactly 4 valid segments.
export function parseObject(s) {
  if (typeof s !== "string") return null;
  const p = s.split("/");
  if (p.length !== 4) return null;
  const [brand, app, type, id] = p;
  return validBrand(brand) && validApp(app) && validType(type) && validId(id) ? { brand, app, type, id } : null;
}

// Declared resource types, or null when the manifest declares none (any well-formed type is accepted).
export function declaredTypes(manifest) {
  const r = manifest.resources;
  if (Array.isArray(r)) return r;
  if (r && typeof r === "object") return Object.keys(r);
  return null;
}

// Link rules for a Resource tuple: `object` is the Keto object, `app` the id of the App:<app> it
// links via #app, `parent` the optional Resource it links via #parent. Everything stays in one brand/app.
export function checkLinks({ object, app, parent }) {
  const o = parseObject(object);
  if (!o) return { valid: false, reason: "invalid_object" };
  if (app !== o.app) return { valid: false, reason: "app_mismatch" };
  if (parent !== undefined) {
    const p = parseObject(parent);
    if (!p) return { valid: false, reason: "invalid_parent" };
    if (p.brand !== o.brand || p.app !== o.app) return { valid: false, reason: "parent_mismatch" };
  }
  return { valid: true, reason: "ok" };
}

// Object relation map used by POST /v1/check for object-level checks (MANIFEST.md "Object relation map").
const DEFAULT_ACTIONS = { view: "view", edit: "edit", delete: "delete" };
export function objectRelation({ manifest, permission, objectType }) {
  if (typeof permission !== "string" || permission.length > 64 || !PERM.test(permission)) return { allowed: false, reason: "invalid_request" };
  if (!validType(objectType)) return { allowed: false, reason: "invalid_object" };
  const declared = declaredTypes(manifest);
  if (declared && !declared.includes(objectType)) return { allowed: false, reason: "invalid_object" };
  const action = permission.split(".")[1];
  if (Object.hasOwn(DEFAULT_ACTIONS, action)) return { allowed: true, relation: DEFAULT_ACTIONS[action] };
  const mapped = manifest.resources && !Array.isArray(manifest.resources) ? manifest.resources[objectType]?.actions : undefined;
  if (mapped && Object.hasOwn(mapped, action) && typeof mapped[action] === "string" && RELATION.test(mapped[action])) {
    return { allowed: true, relation: mapped[action] };
  }
  return { allowed: false, reason: "unmapped_action" };
}

export function can({ config, manifest, claims, request, live }) {
  const calls = [];
  const out = (allowed, reason) => ({ allowed, reason, liveCalls: calls });
  if (claims.iss !== config.issuer) return out(false, "invalid_issuer");
  if (claims.tenant_id !== config.tenant_id) return out(false, "invalid_tenant");
  if (typeof claims.sub !== "string" || claims.sub === "") return out(false, "invalid_subject");
  if (!Number.isInteger(claims.exp) || claims.exp <= config.now) return out(false, "token_expired");

  // brand/app come from trusted configuration but are still validated: they build the Keto object.
  if (!validBrand(config.brand) || !validApp(config.app)) return out(false, "invalid_config");

  const { permission, object } = request;
  if (typeof permission !== "string" || permission.length > 64 || !PERM.test(permission)) return out(false, "invalid_request");
  if (object !== undefined) {
    const declared = declaredTypes(manifest);
    const ok = validType(object.type) && validId(object.id) && (!declared || declared.includes(object.type));
    if (!ok) return out(false, "invalid_object");
  }

  if (!Array.isArray(claims.permissions) || !claims.permissions.includes(permission)) return out(false, "permission_not_in_claim");

  const step = (kind, call, denyReason) => {
    calls.push(call);
    const r = live(kind);
    if (r === "allow") return null;
    if (r === "deny") return out(false, denyReason);
    if (r === "timeout") return out(false, "check_timeout");
    return out(false, "check_error"); // error, not_called, or anything unknown: fail closed
  };

  if (!manifest.reads.includes(permission)) {
    const d = step("role", { permission }, "denied");
    if (d) return d;
  }
  if (object !== undefined) {
    const keto_object = `${config.brand}/${config.app}/${object.type}/${object.id}`;
    const d = step("object", { permission, object: { type: object.type, id: object.id }, keto_object }, "object_denied");
    if (d) return d;
  }
  return out(true, calls.length ? "allowed_live" : "allowed_claim");
}
