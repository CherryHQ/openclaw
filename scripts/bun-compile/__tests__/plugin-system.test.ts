import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { patchLoaderTs, patchManifestTs, patchDiscoveryTs } from "../patches/plugin-system.js";
import type { PatchContext } from "../types.js";

const minimalCtx: Pick<PatchContext, "sdkImportLines" | "sdkMapExpr" | "sdkFiles"> = {
  sdkFiles: [{ fullPath: "/tmp/sdk/index.js", basename: "index.js" }],
  sdkImportLines: ['import __sdk0 from "/tmp/sdk/index.js" with { type: "file" };'],
  sdkMapExpr: '{ "index.js": __sdk0 }',
};

describe("patchLoaderTs", () => {
  it("injects sdk preamble at top", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    expect(result).toContain("__extractPluginSdk");
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

  it("bypasses openBoundaryFileSync for bundled plugins via origin check", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    expect(result).toContain('candidate.origin === "bundled"');
  });

  it("injects Error.captureStackTrace patch", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    expect(result).toContain("Error.captureStackTrace");
    expect(result).toContain("__origCST");
  });

  it("uses new Function() CJS wrapper for $bunfs extensions", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    // Should detect $bunfs / __extensions__ paths
    expect(result).toContain('includes("$bunfs")');
    expect(result).toContain('includes("__extensions__")');
    // CJS wrapper for embedded extensions
    expect(result).toContain("new Function");
    expect(result).toContain("__cjsModule");
    expect(result).toContain("__bunCreateRequire");
  });

  it("bundles external plugins at load time (replaces jiti)", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    // Spawns self in bundler mode (no external bun needed)
    expect(result).toContain("__OPENCLAW_BUNDLE_MODE");
    expect(result).toContain("process.execPath");
    expect(result).toContain("bun build failed");
    // Post-processes bundle to rewrite openclaw/plugin-sdk
    expect(result).toContain("openclaw/plugin-sdk");
    expect(result).toContain("__bundleCode");
    // Loads the bundled output
    expect(result).toContain("require(__bundleOut)");
    // Should NOT use jiti for any path in compiled binary
    expect(result).not.toContain("getJiti()(safeSource)");
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
