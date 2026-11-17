#!/usr/bin/env node
// A differential check of the API: the OpenAPI document on the base branch is
// the oracle, and the one in this change must still serve a client built
// against it. The iOS and Mac apps update on their own schedule, so a server
// release meets clients from the release before.
//
//   node scripts/openapi-diff.mjs <base.json> <head.json> [--approved <file>]
//
// It prints every breaking change and exits 1 when one is not approved. A
// deliberate break goes in the approved file (by default
// openapi-approved-changes.json beside the head document) with its reason:
//
//   [{ "change": "removed operation GET /api/v1/templates", "reason": "..." }]
//
// What counts as breaking for a client of the old document:
//   - an operation it could call is gone
//   - a request needs something it did not send (a new required parameter or
//     body field), or no longer accepts a value it sent (a narrower enum or
//     another type)
//   - a response loses a field it read, or a field changes type
// Additions (operations, optional inputs, response fields) are not breaking.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
const MAX_DEPTH = 6;

function resolve(doc, schema, seen = new Set()) {
  let current = schema;
  while (current && typeof current.$ref === 'string') {
    if (seen.has(current.$ref)) return null;
    seen.add(current.$ref);
    current = current.$ref
      .replace(/^#\//, '')
      .split('/')
      .reduce((node, key) => node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], doc);
  }
  return current ?? null;
}

/** `string`, `string|null`, `array`... in one comparable form. */
function typeOf(schema) {
  if (!schema) return 'any';
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return 'union';
  const type = schema.type ?? (schema.properties ? 'object' : schema.enum ? 'enum' : 'any');
  return Array.isArray(type) ? [...type].sort().join('|') : String(type);
}

/** Type names the old client could have relied on that the new schema no longer covers. */
function typeBroken(before, after, direction) {
  const a = typeOf(before).split('|');
  const b = typeOf(after).split('|');
  if (a.includes('any') || b.includes('any') || a.includes('union') || b.includes('union')) {
    return false;
  }
  // A response may only produce what the old client expected; a request must
  // still accept everything the old client could send.
  const [from, into] = direction === 'response' ? [b, a] : [a, b];
  return from.some(
    (type) => !into.includes(type) && !(type === 'integer' && into.includes('number')),
  );
}

function compareSchema(ctx, where, beforeRaw, afterRaw, direction, depth = 0) {
  const before = resolve(ctx.base, beforeRaw);
  const after = resolve(ctx.head, afterRaw);
  if (!before || !after || depth > MAX_DEPTH) return;

  if (typeBroken(before, after, direction)) {
    ctx.report(`${where}: type changed from ${typeOf(before)} to ${typeOf(after)}`);
    return;
  }
  if (Array.isArray(before.enum) && Array.isArray(after.enum)) {
    // Sent values must stay accepted; received values must stay known.
    const [from, into] =
      direction === 'response' ? [after.enum, before.enum] : [before.enum, after.enum];
    const lost = from.filter((value) => !into.includes(value));
    if (lost.length) {
      const verb = direction === 'response' ? 'can now be' : 'no longer accepts';
      ctx.report(`${where}: ${verb} ${lost.map((v) => JSON.stringify(v)).join(', ')}`);
    }
  }
  if (before.items && after.items) {
    compareSchema(ctx, `${where}[]`, before.items, after.items, direction, depth + 1);
  }
  const beforeProps = before.properties ?? {};
  const afterProps = after.properties ?? {};
  if (direction === 'request') {
    const wasRequired = new Set(before.required ?? []);
    for (const name of after.required ?? []) {
      if (!wasRequired.has(name)) ctx.report(`${where}: now requires ${name}`);
    }
  }
  for (const [name, schema] of Object.entries(beforeProps)) {
    if (!(name in afterProps)) {
      // A request field that is gone is ignored unless the schema is strict.
      if (direction === 'response') ctx.report(`${where}: no longer returns ${name}`);
      else if (after.additionalProperties === false)
        ctx.report(`${where}: no longer accepts ${name}`);
      continue;
    }
    compareSchema(ctx, `${where}.${name}`, schema, afterProps[name], direction, depth + 1);
  }
}

const jsonSchema = (body) => body?.content?.['application/json']?.schema;
const paramKey = (param) => `${param.in} parameter ${param.name}`;

/** Every breaking change from `base` to `head`, as stable one-line strings. */
export function breakingChanges(base, head) {
  const changes = [];
  const ctx = { base, head, report: (change) => changes.push(change) };
  for (const [path, beforeItem] of Object.entries(base.paths ?? {})) {
    const afterItem = head.paths?.[path];
    for (const method of METHODS) {
      const before = beforeItem[method];
      if (!before) continue;
      const name = `${method.toUpperCase()} ${path}`;
      const after = afterItem?.[method];
      if (!after) {
        changes.push(`removed operation ${name}`);
        continue;
      }
      const params = (item, op, doc) =>
        [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => resolve(doc, p));
      const beforeParams = new Map(params(beforeItem, before, base).map((p) => [paramKey(p), p]));
      for (const param of params(afterItem, after, head)) {
        const old = beforeParams.get(paramKey(param));
        if (param.required && !old?.required)
          changes.push(`${name}: now requires ${paramKey(param)}`);
        if (old) {
          compareSchema(ctx, `${name} ${paramKey(param)}`, old.schema, param.schema, 'request');
        }
      }
      const beforeBody = resolve(base, before.requestBody);
      const afterBody = resolve(head, after.requestBody);
      if (afterBody?.required && !beforeBody) changes.push(`${name}: now requires a request body`);
      compareSchema(
        ctx,
        `${name} request`,
        jsonSchema(beforeBody),
        jsonSchema(afterBody),
        'request',
      );

      for (const [status, response] of Object.entries(before.responses ?? {})) {
        if (!/^2/.test(status)) continue;
        const next = after.responses?.[status];
        if (!next) {
          changes.push(`${name}: no longer answers ${status}`);
          continue;
        }
        compareSchema(
          ctx,
          `${name} ${status} response`,
          jsonSchema(resolve(base, response)),
          jsonSchema(resolve(head, next)),
          'response',
        );
      }
    }
  }
  return [...new Set(changes)];
}

/** Splits changes by whether the approved list covers them, and finds approvals nothing uses. */
export function judge(changes, approved = []) {
  const reasons = new Map(approved.map((entry) => [entry.change, entry.reason]));
  return {
    approved: changes.filter((change) => reasons.get(change)),
    unapproved: changes.filter((change) => !reasons.get(change)),
    stale: approved.filter((entry) => !changes.includes(entry.change)).map((entry) => entry.change),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--approved');
  const approvedArg = flag === -1 ? null : args.splice(flag, 2)[1];
  const [basePath, headPath] = args;
  if (!basePath || !headPath) {
    console.error(
      'usage: node scripts/openapi-diff.mjs <base.json> <head.json> [--approved <file>]',
    );
    process.exit(2);
  }
  const approvedPath = approvedArg ?? join(dirname(headPath), 'openapi-approved-changes.json');
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const approved = existsSync(approvedPath) ? read(approvedPath) : [];
  const result = judge(breakingChanges(read(basePath), read(headPath)), approved);

  for (const change of result.approved) console.log(`approved: ${change}`);
  for (const change of result.stale) {
    console.log(
      `note: "${change}" in ${approvedPath} matches nothing now; remove it once it has merged`,
    );
  }
  if (result.unapproved.length) {
    console.error(
      `\n${result.unapproved.length} breaking API change(s) a released app would meet:\n`,
    );
    for (const change of result.unapproved) console.error(`  ${change}`);
    console.error(
      `\nKeep the old shape working, or record each as deliberate in ${approvedPath}:\n` +
        '  [{ "change": "<the line above>", "reason": "<why no released client is affected>" }]',
    );
    process.exit(1);
  }
  console.log('No unapproved breaking API change.');
}
