import { describe, it, expect } from "vitest";
import {
  generatePtyUtilsContents,
  generateSharpLibContents,
  generateSharpIndexESM,
  generateSqliteVecRuntime,
  generateOptionalStub,
} from "../patches/native-embeds.js";

describe("generatePtyUtilsContents", () => {
  it("emits CJS with static require of .node file", () => {
    const result = generatePtyUtilsContents("/path/to/pty.node");
    expect(result).toContain('require("/path/to/pty.node")');
    expect(result).toContain("exports.loadNativeModule");
    expect(result).toContain("exports.assign");
  });
});

describe("generateSharpLibContents", () => {
  it("emits CJS module.exports with require", () => {
    const result = generateSharpLibContents("/path/to/sharp.node");
    expect(result).toContain('require("/path/to/sharp.node")');
    expect(result).toContain("module.exports");
  });
});

describe("generateSharpIndexESM", () => {
  it("uses ESM imports for core sharp sub-modules", () => {
    const result = generateSharpIndexESM();
    expect(result).toContain("import Sharp from './constructor.js'");
    expect(result).toContain("import input from './input.js'");
    expect(result).toContain("import output from './output.js'");
    expect(result).toContain("export default Sharp");
    expect(result).not.toContain("require(");
    expect(result).not.toContain("module.exports");
  });

  it("skips utility.js and colour.js (fragile runtime deps)", () => {
    const result = generateSharpIndexESM();
    expect(result).not.toContain("utility");
    expect(result).not.toContain("colour");
  });
});

describe("generateSqliteVecRuntime", () => {
  it("generates CJS with getLoadablePath and load", () => {
    const cjs = generateSqliteVecRuntime("dylib", "cjs");
    expect(cjs).toContain("vec0.dylib");
    expect(cjs).toContain("module.exports");
    expect(cjs).toContain("getLoadablePath");
    expect(cjs).toContain("loadExtension");
  });

  it("generates ESM with export", () => {
    const esm = generateSqliteVecRuntime("so", "esm");
    expect(esm).toContain("vec0.so");
    expect(esm).toContain("export {");
  });
});

describe("generateOptionalStub", () => {
  it("generates lazy proxy that throws on use", () => {
    const result = generateOptionalStub("playwright-core");
    expect(result).toContain("playwright-core");
    expect(result).toContain("Proxy");
    expect(result).toContain("not bundled");
  });
});
