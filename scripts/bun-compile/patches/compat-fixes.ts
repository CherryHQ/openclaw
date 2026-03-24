/**
 * Compatibility-fix patchers for Bun compiled binary.
 *
 * patchSchemaValidator: replaces createRequire + require("ajv") with a static import.
 * patchPiCodingAgentSkills: replaces destructured fs imports with property-access wrappers
 *   so monkey-patched fs methods take effect at call time.
 */

export function patchSchemaValidator(source: string): string {
  return source
    .replace(
      /import\s*\{\s*createRequire\s*\}\s*from\s*["']node:module["'];?/,
      `import _ajvPkg from "ajv";`,
    )
    .replace(/const\s+require\s*=\s*createRequire\([^)]+\);?\n?/, "")
    .replace(
      /const\s+ajvModule\s*=\s*require\(["']ajv["']\)\s*as\s*[^;]+;/,
      `const ajvModule = _ajvPkg as unknown as { default?: new (opts?: object) => AjvLike };`,
    );
}

export function patchFileTypeCoreDefaultExport(source: string): string {
  // @jimp/core uses `import fileType from "file-type/core.js"` but file-type
  // has no default export (only named exports). Bun's bundler rejects this
  // at the static validation phase (before onLoad can fix the importer).
  // Fix: append a synthetic default export that re-exports all named exports.
  if (source.includes("export default")) return source;
  return source + `\nexport default { fileTypeFromStream, fileTypeFromBuffer, fileTypeFromBlob, fileTypeFromTokenizer, fileTypeStream, FileTypeParser, supportedExtensions, supportedMimeTypes };\n`;
}

/**
 * Pre-patch file-type/core.js on disk to add a synthetic default export.
 * Bun validates ESM imports/exports at the static analysis level BEFORE
 * any bundler plugins (onResolve/onLoad) fire, so we must patch the actual
 * file. Returns a restore function to undo the patch after build.
 */
export function patchFileTypeCoreOnDisk(): () => void {
  const { readFileSync, writeFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
  const { resolve } = require("node:path") as typeof import("node:path");

  const filePath = resolve("node_modules/file-type/core.js");
  if (!existsSync(filePath)) return () => {};

  const original = readFileSync(filePath, "utf-8");
  if (original.includes("export default")) return () => {};

  const patched = patchFileTypeCoreDefaultExport(original);
  writeFileSync(filePath, patched);

  return () => {
    writeFileSync(filePath, original);
  };
}

/**
 * Patch plugin-sdk index.ts to re-export symbols that were moved to subpaths
 * in v2026.3.22 but are still imported from the root by external plugins.
 * This maintains backward compat for `from "openclaw/plugin-sdk"` imports.
 */
export function patchSdkIndexReExports(source: string): string {
  const reExports = [
    `export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";`,
    `export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";`,
    `export { formatDocsLink } from "../terminal/links.js";`,
    `export { stripMarkdown } from "./text-runtime.js";`,
    `export { withFileLock } from "./file-lock.js";`,
    `export { createTypingCallbacks } from "../channels/typing.js";`,
    `export { resolveDirectDmAuthorizationOutcome, resolveSenderCommandAuthorizationWithRuntime } from "./command-auth.js";`,
    `export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";`,
  ];
  // Only add re-exports that aren't already present
  const missing = reExports.filter((line) => {
    const match = line.match(/export \{([^}]+)\}/);
    if (!match) return false;
    const names = match[1].split(",").map((n) => n.trim());
    return names.some((name) => !source.includes(`export { ${name}`) && !source.includes(`, ${name}`) && !source.includes(`${name},`));
  });
  if (missing.length === 0) return source;
  return source + "\n// Backward-compat re-exports for external plugins\n" + missing.join("\n") + "\n";
}

/**
 * Patch entry.respawn.ts to skip the --disable-warning=ExperimentalWarning
 * respawn when running as a Bun compiled binary (Bun doesn't recognize this
 * Node.js flag).
 */
export function patchEntryRespawn(source: string): string {
  return source.replace(
    "!hasExperimentalWarningSuppressed({ env, execArgv })",
    "!hasExperimentalWarningSuppressed({ env, execArgv }) && !(globalThis as any).Bun",
  );
}

/**
 * Pre-patch playwright-core imports on disk. Bun's bundler generates both
 * static and lazy (__esm) copies; onLoad plugins only affect the lazy copy.
 * We must patch the actual files so the static copy also gets the fix.
 * Returns a restore function.
 */

export function patchPiCodingAgentSkills(source: string): string {
  return source.replace(
    /import\s*\{\s*existsSync\s*,\s*readdirSync\s*,\s*readFileSync\s*,\s*realpathSync\s*,\s*statSync\s*\}\s*from\s*["']fs["'];?/,
    [
      `import __piFs from "fs";`,
      `const existsSync = (p) => __piFs.existsSync(p);`,
      `const readdirSync = (p, o) => __piFs.readdirSync(p, o);`,
      `const readFileSync = (p, o) => __piFs.readFileSync(p, o);`,
      `const realpathSync = (p) => __piFs.realpathSync(p);`,
      `const statSync = (p) => __piFs.statSync(p);`,
    ].join("\n"),
  );
}
