import { describe, it, expect } from "vitest";

/**
 * Regression tests for the .default CJS interop fix in prebundle-extensions.ts.
 *
 * Bun's CJS bundler generates `import_node_path.default.join(...)` instead of
 * `import_node_path.join(...)`. We fix this with a targeted regex that ONLY
 * matches `import_*` prefixed variables (preserved by identifiers:false minify).
 *
 * Test fixtures are extracted from a real feishu extension bundle to ensure
 * the regex handles all patterns found in production.
 */

/** Current targeted regex — only matches import_* variables */
function applyTargetedRegex(code: string): string {
  return code.replace(/\b(import_\w+)\.default\./g, "$1.");
}

// ---------------------------------------------------------------------------
// Fixtures extracted from a real feishu extension bundle (identifiers:false)
// ---------------------------------------------------------------------------

/** CJS interop patterns that MUST be fixed (import_*.default.prop) */
const CJS_INTEROP_FIXTURES = [
  // Node built-ins
  "import_node_os.default.homedir()",
  "import_node_path.default.resolve(B)",
  "import_node_os2.default.homedir()",
  "import_node_path2.default.join(A(),Q)",
  "import_node_fs.default.existsSync($)",
  "import_node_path2.default.resolve(process.cwd())",
  "import_node_process.default.argv",
  "import_node_process.default.platform",
  "import_node_os3.default.release().split('.')",
  "import_node_tty.default.isatty(1)",
  "import_node_fs2.default.accessSync",
  "import_node_fs2.default.chmodSync",
  "import_node_fs2.default.lstatSync",
  "import_node_fs2.default.mkdirSync",
  "import_node_os4.default.tmpdir",
  // Third-party modules
  "import_json5.default.parse(Q)",
  "import_zod.default.object({a:import_zod.default.string()})",
];

/** Standalone .default without trailing dot — must NOT be changed */
const STANDALONE_DEFAULT_FIXTURES = [
  // import_* standalone (used in destructuring like ({env}=import_node_process.default))
  "({env}=import_node_process.default)",
  "import_node_fs7.default,",
  "import_node_stream.default,",
  // Non-import variables
  "accounts.default",
  "exports2.default",
  "exports.default",
  "extend_1.default",
  "createDebug.default",
  "o.default",
  "debug_1.default",
  "assert_1.default",
];

/** Non-import_ .default. chains — legitimate usage, must NOT be changed */
const LEGITIMATE_DEFAULT_CHAIN_FIXTURES = [
  "util_cjs_1.default.pkg",
  "this.default.bind",
  "names_1.default.vErrors",
  "names_1.default.errors",
  "names_1.default.instancePath",
  "names_1.default.data",
  "names_1.default.parentData",
  "names_1.default.rootData",
  "names_1.default.dynamicAnchors",
  "names_1.default.scope",
  "additionalProperties_1.default.code",
];

/** this.default patterns — must NOT be changed */
const THIS_DEFAULT_FIXTURES = [
  "this.default=A",
  "this.default.toString()",
  "this.default(M)",
  "this.default}",
  "this.default&&typeof this[this.default]",
  "return this.default]",
];

/** exports.default patterns — must NOT be changed */
const EXPORTS_DEFAULT_FIXTURES = ["exports.default=plugin", "exports.default:foo"];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("targeted regex — fixes CJS interop (import_*.default.prop)", () => {
  for (const fixture of CJS_INTEROP_FIXTURES) {
    it(`fixes: ${fixture.slice(0, 60)}`, () => {
      const result = applyTargetedRegex(fixture);
      // .default. should be removed
      expect(result).not.toContain(".default.");
      // The import_* prefix should still be there
      expect(result).toMatch(/^import_\w+\./);
    });
  }
});

describe("targeted regex — preserves standalone .default (no trailing dot)", () => {
  for (const fixture of STANDALONE_DEFAULT_FIXTURES) {
    it(`preserves: ${fixture.slice(0, 60)}`, () => {
      expect(applyTargetedRegex(fixture)).toBe(fixture);
    });
  }
});

describe("targeted regex — preserves non-import .default. chains", () => {
  for (const fixture of LEGITIMATE_DEFAULT_CHAIN_FIXTURES) {
    it(`preserves: ${fixture}`, () => {
      expect(applyTargetedRegex(fixture)).toBe(fixture);
    });
  }
});

describe("targeted regex — preserves this.default patterns", () => {
  for (const fixture of THIS_DEFAULT_FIXTURES) {
    it(`preserves: ${fixture.slice(0, 50)}`, () => {
      expect(applyTargetedRegex(fixture)).toBe(fixture);
    });
  }
});

describe("targeted regex — preserves exports.default patterns", () => {
  for (const fixture of EXPORTS_DEFAULT_FIXTURES) {
    it(`preserves: ${fixture}`, () => {
      expect(applyTargetedRegex(fixture)).toBe(fixture);
    });
  }
});

describe("regression: old broad regex failures on real bundle patterns", () => {
  /** Old broad regex — caused ParseError + runtime corruption */
  function applyBroadRegex(code: string): string {
    return code
      .replace(/\b(?!exports)(\w+)\.default\./g, "$1.")
      .replace(/\b(?!exports)(\w+)\.default\b/g, "$1");
  }

  it("old regex corrupts this.default=A → this=A (ParseError in class)", () => {
    const broken = applyBroadRegex("class Foo{constructor(A){this.default=A}}");
    expect(broken).toBe("class Foo{constructor(A){this=A}}");
    // eslint-disable-next-line no-implied-eval
    expect(() => new Function(broken)).toThrow();
  });

  it("old regex corrupts names_1.default.vErrors → names_1.vErrors", () => {
    // This is an ajv validation variable, NOT CJS interop
    const input = "names_1.default.vErrors";
    expect(applyBroadRegex(input)).toBe("names_1.vErrors");
    // Targeted regex leaves it intact
    expect(applyTargetedRegex(input)).toBe(input);
  });

  it("old regex corrupts util_cjs_1.default.pkg → util_cjs_1.pkg", () => {
    const input = "util_cjs_1.default.pkg";
    expect(applyBroadRegex(input)).toBe("util_cjs_1.pkg");
    expect(applyTargetedRegex(input)).toBe(input);
  });

  it("old regex corrupts standalone accounts.default → accounts", () => {
    const input = "accounts.default";
    expect(applyBroadRegex(input)).toBe("accounts");
    expect(applyTargetedRegex(input)).toBe(input);
  });

  it("old regex corrupts ({env}=import_node_process.default) → ({env}=import_node_process)", () => {
    const input = "({env}=import_node_process.default)";
    expect(applyBroadRegex(input)).toBe("({env}=import_node_process)");
    // Targeted regex preserves it (no trailing dot)
    expect(applyTargetedRegex(input)).toBe(input);
  });
});
