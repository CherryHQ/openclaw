import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildExternals } from "./externals.js";
import type { TargetPlatform } from "./types.js";

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

  const sdkResult = await Bun.build({
    entrypoints,
    outdir: sdkOutDir,
    root: resolve("src/plugin-sdk"),
    target: "bun",
    format: "esm",
    minify: true,
    splitting: true,
    external: sdkExternals,
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
