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
