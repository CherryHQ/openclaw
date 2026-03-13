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
