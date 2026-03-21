/**
 * Generators for native module embedding in Bun compiled binaries.
 *
 * These produce whole-file replacement contents — no AST manipulation needed.
 */

export function generatePtyUtilsContents(ptyNodePath: string): string {
  const safePath = ptyNodePath.replace(/\\/g, "/");
  return `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadNativeModule = exports.assign = void 0;
function assign(target) {
  var sources = [];
  for (var i = 1; i < arguments.length; i++) sources[i - 1] = arguments[i];
  sources.forEach(function (s) { return Object.keys(s).forEach(function (k) { return target[k] = s[k]; }); });
  return target;
}
exports.assign = assign;
function loadNativeModule(name) {
  return { dir: "embedded", module: require("${safePath}") };
}
exports.loadNativeModule = loadNativeModule;
`;
}

export function generateSharpLibContents(sharpNodePath: string): string {
  const safePath = sharpNodePath.replace(/\\/g, "/");
  return `module.exports = require("${safePath}");\n`;
}

/**
 * ESM replacement for sharp/lib/index.js.
 *
 * Two issues with bundling sharp's CJS index.js in Bun compiled binaries:
 * 1. Bun wraps CJS module.exports as { default: ... } when transpiling to ESM,
 *    breaking require() chains (same as protobufjs Long fix).
 * 2. sharp/lib/utility.js calls detect-libc at module level, but detect-libc
 *    is stubbed as an optional external on non-macOS — causing a throw that
 *    prevents module.exports = Sharp from being reached.
 *
 * Fix: ESM imports (Bun handles correctly), skip utility.js (detect-libc
 * throws) and colour.js (@img/colour may be unresolvable). These provide
 * concurrency tuning and colour-space transforms — not needed for our
 * resize/rotate/metadata/jpeg/png pipeline.
 */
export function generateSharpIndexESM(): string {
  return `
import Sharp from './constructor.js';
import input from './input.js';
import resize from './resize.js';
import composite from './composite.js';
import operation from './operation.js';
import channel from './channel.js';
import output from './output.js';
input(Sharp);
resize(Sharp);
composite(Sharp);
operation(Sharp);
channel(Sharp);
output(Sharp);
export default Sharp;
`;
}

export function generateSqliteVecRuntime(
  extSuffix: string,
  format: "cjs" | "esm",
): string {
  const extractRuntime = `
let __extractedPath = null;
function getLoadablePath() {
  if (__extractedPath) {
    const fs = require("node:fs");
    if (fs.statSync(__extractedPath, { throwIfNoEntry: false })) return __extractedPath;
  }
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const bunfsPath = globalThis.__vec0BunfsPath;
  if (bunfsPath) {
    const content = fs.readFileSync(bunfsPath);
    const tmpDir = path.join(os.tmpdir(), "openclaw-native");
    fs.mkdirSync(tmpDir, { recursive: true });
    const target = path.join(tmpDir, "vec0.${extSuffix}");
    fs.writeFileSync(target, content, { mode: 0o755 });
    __extractedPath = target;
    return target;
  }
  const dir = path.dirname(process.execPath);
  const candidates = [path.join(dir, "lib", "vec0.${extSuffix}"), path.join(dir, "vec0.${extSuffix}")];
  for (const p of candidates) { if (fs.statSync(p, { throwIfNoEntry: false })) return p; }
  throw new Error("sqlite-vec extension not found.");
}
`;

  if (format === "cjs") {
    return `${extractRuntime}
function load(db) { db.loadExtension(getLoadablePath()); }
module.exports = { getLoadablePath, load };
`;
  }
  return `${extractRuntime}
function load(db) { db.loadExtension(getLoadablePath()); }
export { getLoadablePath, load };
`;
}

export function generateOptionalStub(packageName: string): string {
  return `
const name = ${JSON.stringify(packageName)};
const handler = { get(_, prop) {
  if (prop === "__esModule") return true;
  if (prop === "default") return new Proxy({}, handler);
  if (typeof prop === "symbol") return undefined;
  return function() { throw new Error(name + " is not bundled in this binary. Install it separately if needed."); };
}};
module.exports = new Proxy({}, handler);
`;
}
