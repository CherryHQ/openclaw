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

  it("uses bundled createPluginRuntime seam in compiled binary", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    expect(result).toContain("__bundledCreatePluginRuntime");
    expect(result).toContain("createPluginRuntimeFactory = __bundledCreatePluginRuntime");
    expect(result).not.toContain("getJiti(runtimeModulePath)(runtimeModulePath)");
  });

  it("strips jiti import and getJiti function to prevent babel.cjs resolution failure", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    // Static import must be removed (jiti tries to find babel.cjs at init in $bunfs)
    expect(result).not.toContain('from "jiti"');
    // Lazy loader function must be removed
    expect(result).not.toContain("createJiti(import.meta.url");
    expect(result).not.toContain("jitiLoaders");
    expect(result).not.toContain("let jitiLoader");
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
    expect(result).not.toContain("getJiti(safeSource)(safeSource)");
    expect(result).not.toContain("getJiti()(safeSource)");
  });

  // --- Regression: pattern 3 must tolerate upstream intermediate vars ---
  it("handles loadSource intermediate variable between pluginRoot and openBoundaryFileSync", () => {
    // Simulates the upstream code that inserts a loadSource variable
    const sourceWithLoadSource = `
    const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
    const loadSource =
      (registrationMode === "setup-only" || registrationMode === "setup-runtime") &&
      manifestRecord.setupSource
        ? manifestRecord.setupSource
        : candidate.source;
    const opened = openBoundaryFileSync({
      absolutePath: loadSource,
      rootPath: pluginRoot,
      boundaryLabel: "plugin root",
      rejectHardlinks: candidate.origin !== "bundled",
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
      continue;
    }
    const safeSource = opened.path;
    fs.closeSync(opened.fd);

    let mod = null;
    mod = getJiti()(safeSource) as OpenClawPluginModule;
    `;
    const result = patchLoaderTs(sourceWithLoadSource, minimalCtx);
    // VFS bypass injected via origin check (works on all platforms)
    expect(result).toContain('candidate.origin === "bundled"');
    expect(result).toContain("let safeSource: string;");
    // loadSource intermediate block preserved
    expect(result).toContain("loadSource");
    expect(result).toContain("registrationMode");
    // Uses the upstream absolutePath variable (loadSource), not hardcoded candidate.source
    expect(result).toContain("absolutePath: loadSource,");
    // jiti replaced
    expect(result).not.toContain("getJiti()(safeSource)");
  });

  it("handles original code without loadSource intermediate variable", () => {
    const sourceWithoutLoadSource = `
    const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
    const opened = openBoundaryFileSync({
      absolutePath: candidate.source,
      rootPath: pluginRoot,
      boundaryLabel: "plugin root",
      rejectHardlinks: candidate.origin !== "bundled",
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
      continue;
    }
    const safeSource = opened.path;
    fs.closeSync(opened.fd);

    let mod = null;
    mod = getJiti()(safeSource) as OpenClawPluginModule;
    `;
    const result = patchLoaderTs(sourceWithoutLoadSource, minimalCtx);
    expect(result).toContain('candidate.origin === "bundled"');
    expect(result).toContain("let safeSource: string;");
    expect(result).toContain("absolutePath: candidate.source,");
    expect(result).not.toContain("getJiti()(safeSource)");
  });

  // --- Snapshot: full patched output for regression detection ---
  it("snapshot: patched loader.ts boundary bypass region", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    // Extract the patched region around the boundary bypass
    const bypassStart = result.indexOf("let safeSource: string;");
    const bypassEnd = result.indexOf("let mod:", bypassStart);
    expect(bypassStart).toBeGreaterThan(-1);
    expect(bypassEnd).toBeGreaterThan(bypassStart);
    const region = result.slice(bypassStart, bypassEnd).trim();
    expect(region).toMatchSnapshot("loader-boundary-bypass");
  });

  it("snapshot: patched loader.ts jiti replacement region", () => {
    const source = readFileSync(resolve("src/plugins/loader.ts"), "utf-8");
    const result = patchLoaderTs(source, minimalCtx);
    // Extract the region from $bunfs check through the external plugin bundler
    const jitiStart = result.indexOf('if (safeSource.includes("$bunfs")');
    const jitiEnd = result.indexOf("} catch (err) {", jitiStart);
    expect(jitiStart).toBeGreaterThan(-1);
    expect(jitiEnd).toBeGreaterThan(jitiStart);
    const region = result.slice(jitiStart, jitiEnd).trim();
    expect(region).toMatchSnapshot("loader-jiti-replacement");
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
