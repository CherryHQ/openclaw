import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { patchLoaderTs, patchManifestTs, patchDiscoveryTs } from "../patches/plugin-system.js";
import type { PatchContext } from "../types.js";

const minimalCtx: Pick<
  PatchContext,
  "sdkImportLines" | "sdkMapExpr" | "jitiBabelCjs" | "sdkFiles"
> = {
  sdkFiles: [{ fullPath: "/tmp/sdk/index.js", basename: "index.js" }],
  sdkImportLines: ['import __sdk0 from "/tmp/sdk/index.js" with { type: "file" };'],
  sdkMapExpr: '{ "index.js": __sdk0 }',
  jitiBabelCjs: "/path/to/babel.cjs",
};

describe("patchLoaderTs", () => {
  it("injects sdk preamble at top", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    expect(result).toContain("__extractPluginSdk");
    expect(result).toContain("__extractJitiBabel");
  });

  it("replaces modulePath with process.execPath", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    expect(result).toContain("process.execPath");
    expect(result).not.toContain("fileURLToPath(import.meta.url)");
  });

  it("adds extracted sdk check before cursor walk", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    expect(result).toContain("__sdkRoot");
    expect(result).toContain("__extractPluginSdk()");
  });

  it("injects $bunfs VFS bypass for openBoundaryFileSync", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    expect(result).toContain('includes("$bunfs")');
  });

  it("injects custom createRequire monkey-patch", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    expect(result).toContain("__bunCreateRequire");
    expect(result).toContain("tryNative: false");
    expect(result).toContain("fsCache: false");
  });

  it("injects custom transform for jiti", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    expect(result).toContain("transform(opts");
    expect(result).toContain("__extractJitiBabel");
  });

  it("injects Error.captureStackTrace patch", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    expect(result).toContain("Error.captureStackTrace");
    expect(result).toContain("__origCST");
  });

  it("bypasses jiti for $bunfs extensions with manual CJS evaluation", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    // Should detect $bunfs / __extensions__ paths
    expect(result).toContain('includes("$bunfs")');
    expect(result).toContain('includes("__extensions__")');
    expect(result).toContain("__vfsResolve");
    // Should read code and evaluate with CJS wrapper
    expect(result).toContain("readFileSync(__realPath");
    expect(result).toContain("__cjsModule");
    expect(result).toContain("new Function");
    expect(result).toContain("__bunCreateRequireForVfs");
    // Should still use jiti for non-$bunfs paths
    expect(result).toContain("getJiti()(safeSource)");
  });
});

describe("patchManifestTs", () => {
  it("adds VFS bypass before openBoundaryFileSync", () => {
    const source = readFileSync(resolve("src/plugins/manifest.ts"), "utf-8");
    const result = patchManifestTs(source);
    expect(result).toContain("__vfsResolve");
    expect(result).toContain("loadPluginManifest");
  });
});

describe("patchDiscoveryTs", () => {
  it("adds VFS bypass to readPackageManifest", () => {
    const source = readFileSync(resolve("src/plugins/discovery.ts"), "utf-8");
    const result = patchDiscoveryTs(source);
    expect(result).toContain("__vfsResolve");
    expect(result).toContain("readPackageManifest");
  });

  it("adds VFS bypass to resolvePackageEntrySource", () => {
    const source = readFileSync(resolve("src/plugins/discovery.ts"), "utf-8");
    const result = patchDiscoveryTs(source);
    expect(result).toContain("resolvePackageEntrySource");
  });
});
