import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { patchSchemaValidator, patchPiCodingAgentSkills } from "../patches/compat-fixes.js";

describe("patchSchemaValidator", () => {
  it("replaces createRequire+require(ajv) with static import", () => {
    const source = readFileSync(resolve("src/plugins/schema-validator.ts"), "utf-8");
    const result = patchSchemaValidator(source);
    expect(result).toContain('from "ajv"');
    expect(result).not.toContain("createRequire");
    expect(result).not.toContain('require("ajv")');
  });
});

describe("patchPiCodingAgentSkills", () => {
  it("replaces destructured fs imports with property-access wrappers", () => {
    // Use a minimal fixture since the real file is in dist
    const source = `import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
export function foo() { return existsSync("/tmp"); }`;
    const result = patchPiCodingAgentSkills(source);
    expect(result).toContain("__piFs.existsSync");
    expect(result).toContain("__piFs.readdirSync");
    expect(result).toContain("__piFs.readFileSync");
    expect(result).toContain("__piFs.realpathSync");
    expect(result).toContain("__piFs.statSync");
    expect(result).not.toMatch(/import\s*\{.*existsSync.*\}\s*from\s*["']fs["']/);
  });
});
