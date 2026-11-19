#!/usr/bin/env node
// Validates vectors.json against vectors.schema.json (tiny built-in validator, no deps),
// then replays every vector through the reference can(). Exit 1 on any failure.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { can, checkLinks, objectRelation, SPEC_VERSION } from "./reference.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(root, "vectors.schema.json"), "utf8"));
const data = JSON.parse(readFileSync(join(root, "vectors.json"), "utf8"));

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const matches = (t, v) => typeOf(v) === t || (t === "number" && typeof v === "number");

function validate(s, v, path, errs) {
  if (s.$ref) {
    const target = s.$ref.replace("#/", "").split("/").reduce((o, k) => o[k], schema);
    return validate(target, v, path, errs);
  }
  if ("const" in s && !isDeepStrictEqual(s.const, v)) errs.push(`${path}: must equal ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some((e) => isDeepStrictEqual(e, v))) errs.push(`${path}: ${JSON.stringify(v)} not in enum`);
  if (s.type && !matches(s.type, v)) return void errs.push(`${path}: expected ${s.type}, got ${typeOf(v)}`);
  if (typeof v === "string" && s.pattern && !new RegExp(s.pattern).test(v)) errs.push(`${path}: does not match ${s.pattern}`);
  if (typeof v === "string" && s.minLength && v.length < s.minLength) errs.push(`${path}: too short`);
  if (Array.isArray(v)) {
    if (s.minItems && v.length < s.minItems) errs.push(`${path}: needs >= ${s.minItems} items`);
    if (s.items) v.forEach((x, i) => validate(s.items, x, `${path}[${i}]`, errs));
  }
  if (typeOf(v) === "object") {
    for (const k of s.required ?? []) if (!(k in v)) errs.push(`${path}: missing "${k}"`);
    for (const [k, x] of Object.entries(v)) {
      if (s.properties?.[k]) validate(s.properties[k], x, `${path}.${k}`, errs);
      else if (s.additionalProperties === false) errs.push(`${path}: unexpected "${k}"`);
    }
  }
}

const errs = [];
validate(schema, data, "$", errs);
const names = new Set();
for (const v of [...(data.vectors ?? []), ...(data.linkVectors ?? []), ...(data.relationVectors ?? [])]) {
  if (names.has(v.name)) errs.push(`duplicate vector name: ${v.name}`);
  names.add(v.name);
}
if (data.specVersion !== SPEC_VERSION) errs.push(`specVersion ${data.specVersion} != reference ${SPEC_VERSION}`);
if (errs.length) {
  console.error(`schema: ${errs.length} error(s)\n` + errs.map((e) => "  " + e).join("\n"));
  process.exit(1);
}
console.log(`schema: ok (${data.vectors.length} vectors)`);

let failed = 0;
for (const v of data.vectors) {
  const config = { ...data.config, ...(v.config ?? {}) };
  const live = (kind) => v.liveCheck[kind] ?? "not_called";
  const got = can({ config, manifest: v.manifest, claims: v.claims, request: v.request, live });
  const want = v.expect;
  const ok = got.allowed === want.allowed && got.reason === want.reason && isDeepStrictEqual(got.liveCalls, want.liveCalls);
  if (!ok) {
    failed++;
    console.error(`FAIL ${v.name}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
  }
}
for (const v of data.linkVectors ?? []) {
  const got = checkLinks(v.input);
  if (got.valid !== v.expect.valid || got.reason !== v.expect.reason) {
    failed++;
    console.error(`FAIL link ${v.name}\n  want ${JSON.stringify(v.expect)}\n  got  ${JSON.stringify(got)}`);
  }
}
for (const v of data.relationVectors ?? []) {
  const got = objectRelation(v.input);
  if (!isDeepStrictEqual(got, v.expect)) {
    failed++;
    console.error(`FAIL relation ${v.name}\n  want ${JSON.stringify(v.expect)}\n  got  ${JSON.stringify(got)}`);
  }
}
const total = data.vectors.length + (data.linkVectors?.length ?? 0) + (data.relationVectors?.length ?? 0);
if (failed) {
  console.error(`replay: ${failed} of ${total} failed`);
  process.exit(1);
}
console.log(`replay: ok (${total}/${total}: ${data.vectors.length} can, ${data.linkVectors?.length ?? 0} link, ${data.relationVectors?.length ?? 0} relation)`);
