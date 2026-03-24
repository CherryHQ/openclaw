import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { buildExternals } from "./externals.js";
import { patchSdkIndexReExports } from "./patches/compat-fixes.js";
import { generateOptionalStub } from "./patches/native-embeds.js";
import type { TargetPlatform } from "./types.js";

/**
 * Bun.build plugin that stubs native-only packages whose CJS code triggers
 * a Bun bundler bug when inlined into ESM chunks with splitting: true.
 * (Specifically, packages like @snazzah/davey that reassign `require` at
 * module scope — the bundler maps the local `require` to an imported chunk
 * binding, which is immutable in ESM and throws at runtime.)
 */
function createNativeStubPlugin(): BunPlugin {
  const stubs = ["@snazzah/davey"];
  const escaped = stubs.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const filter = new RegExp(`^(${escaped.join("|")})$`);
  return {
    name: "sdk-native-stub",
    setup(build) {
      build.onResolve({ filter }, (args) => ({
        path: args.path,
        namespace: "sdk-native-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "sdk-native-stub" }, (args) => ({
        contents: generateOptionalStub(args.path),
        loader: "js",
      }));
    },
  };
}

export async function bundlePluginSdk(
  platform: TargetPlatform,
  outdir: string,
  targetDir?: string,
): Promise<void> {
  const sdkOutDir = targetDir ?? join(outdir, "dist", "plugin-sdk");
  mkdirSync(sdkOutDir, { recursive: true });

  // Scoped entries from loader.ts (e.g. "openclaw/plugin-sdk/core" → core.ts → core.js)
  const scopedEntries = new Bun.Glob("*.ts").scanSync({
    cwd: resolve("src/plugin-sdk"),
    absolute: true,
  });
  const entrypoints: string[] = [];
  for (const entry of scopedEntries) {
    if (entry.endsWith(".test.ts")) {
      continue;
    }
    entrypoints.push(entry);
  }

  const sdkExternals = buildExternals(platform);

  // Plugin to patch index.ts with backward-compat re-exports for external plugins,
  // and rewrite dynamic require("ajv") to static import so the bundler inlines it
  // (splitting: true + CJS require leaves it as an external call otherwise).
  const sdkPatchPlugin: BunPlugin = {
    name: "sdk-patches",
    setup(build) {
      build.onLoad({ filter: /plugin-sdk[/\\]index\.ts$/ }, (args) => ({
        contents: patchSdkIndexReExports(readFileSync(args.path, "utf-8")),
        loader: "ts",
      }));
      // Rewrite dynamic require("ajv") to static import so splitting inlines it
      build.onLoad({ filter: /plugins[/\\]schema-validator\.ts$/ }, (args) => {
        let src = readFileSync(args.path, "utf-8");
        // Add static import at top, replace dynamic require with the imported binding
        src = `import __ajvPkg from "ajv";\n` + src;
        src = src.replace(
          /const ajvModule = require\("ajv"\)[^;]*;/,
          `const ajvModule = { default: __ajvPkg } as { default?: new (opts?: object) => AjvLike };`,
        );
        return { contents: src, loader: "ts" };
      });
    },
  };

  const sdkResult = await Bun.build({
    entrypoints,
    outdir: sdkOutDir,
    root: resolve("src/plugin-sdk"),
    target: "bun",
    format: "esm",
    // Minification disabled: Bun's bundler with splitting + minify generates
    // invalid ESM chunks ("Exported binding 'x' needs to refer to a top-level
    // declared variable"). SDK is embedded in VFS so minification is unnecessary.
    minify: false,
    splitting: true,
    external: sdkExternals,
    plugins: [createNativeStubPlugin(), sdkPatchPlugin],
  });

  if (!sdkResult.success) {
    console.error("[bun-compile] Plugin SDK bundle failed:");
    for (const log of sdkResult.logs) {
      console.error("  ", log.message || log);
    }
    process.exit(1);
  }

  // Generate a jiti-free root-alias.cjs for the compiled binary.
  {
    const rootAliasCjs = join(sdkOutDir, "root-alias.cjs");
    writeFileSync(rootAliasCjs, `"use strict";\nmodule.exports = require("./index.js");\n`);
  }

  const entryCount = sdkResult.outputs.filter((o) => o.kind === "entry-point").length;
  console.log(`[bun-compile] Bundled ${entryCount} plugin-sdk entries → dist/plugin-sdk/`);
}
