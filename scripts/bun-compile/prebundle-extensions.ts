import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { buildExternals } from "./externals.js";
import type { TargetPlatform } from "./types.js";

export interface BundledExtensionInfo {
  name: string;
  dir: string;
  entryJs: string;
}

export async function bundleExtensions(
  platform: TargetPlatform,
  extTempDir: string,
): Promise<BundledExtensionInfo[]> {
  mkdirSync(extTempDir, { recursive: true });

  const extensionsDir = resolve("extensions");
  if (!existsSync(extensionsDir)) {
    console.warn("[bun-compile] No extensions/ directory found, skipping");
    return [];
  }

  // Collect extension dirs that have openclaw.plugin.json
  const extDirs: { name: string; dir: string; entry: string }[] = [];
  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const extDir = join(extensionsDir, entry.name);
    const manifestFile = join(extDir, "openclaw.plugin.json");
    if (!existsSync(manifestFile)) {
      continue;
    }

    const pkgPath = join(extDir, "package.json");
    let entryFile = "";
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const exts = pkg?.openclaw?.extensions;
        if (Array.isArray(exts) && exts.length > 0) {
          entryFile = resolve(extDir, exts[0]);
        }
      } catch {
        // fall through
      }
    }
    if (!entryFile) {
      for (const candidate of ["index.ts", "index.js", "index.mjs"]) {
        const p = join(extDir, candidate);
        if (existsSync(p)) {
          entryFile = p;
          break;
        }
      }
    }
    if (!entryFile || !existsSync(entryFile)) {
      console.warn(`[bun-compile] Extension ${entry.name}: no entry point found, skipping`);
      continue;
    }

    extDirs.push({ name: entry.name, dir: extDir, entry: entryFile });
  }

  console.log(`[bun-compile] Bundling ${extDirs.length} extensions...`);

  const extExternals = [...buildExternals(platform)];

  const results: BundledExtensionInfo[] = [];
  const failures: string[] = [];

  for (const ext of extDirs) {
    const outDir = join(extTempDir, ext.name);
    mkdirSync(outDir, { recursive: true });

    const bundleResult = await Bun.build({
      entrypoints: [ext.entry],
      outdir: outDir,
      target: "node",
      format: "cjs",
      minify: true,
      external: extExternals,
    });

    if (!bundleResult.success) {
      console.warn(`[bun-compile] Extension ${ext.name}: bundle failed`);
      for (const log of bundleResult.logs) {
        console.warn(`  ${log.message || log}`);
      }
      failures.push(ext.name);
      cpSync(ext.dir, outDir, { recursive: true });
      continue;
    }

    const entryOutput = bundleResult.outputs.find((o) => o.kind === "entry-point");
    const entryJsName = entryOutput ? entryOutput.path.split("/").pop()! : "index.js";

    // Fix Bun CJS bundler bug: default imports generate `x.default.prop`
    const entryJsPath = join(outDir, entryJsName);
    if (existsSync(entryJsPath)) {
      const code = readFileSync(entryJsPath, "utf-8");
      const patched = code
        .replace(/\b(?!exports)(\w+)\.default\./g, "$1.")
        .replace(/\b(?!exports)(\w+)\.default\b/g, "$1");
      if (patched !== code) {
        writeFileSync(entryJsPath, patched);
      }
    }

    // Copy package.json (with openclaw.extensions pointing to bundled .js)
    if (existsSync(join(ext.dir, "package.json"))) {
      try {
        const pkg = JSON.parse(readFileSync(join(ext.dir, "package.json"), "utf-8"));
        if (pkg.openclaw?.extensions) {
          pkg.openclaw.extensions = [`./${entryJsName}`];
        }
        delete pkg.dependencies;
        writeFileSync(join(outDir, "package.json"), JSON.stringify(pkg, null, 2));
      } catch {
        copyFileSync(join(ext.dir, "package.json"), join(outDir, "package.json"));
      }
    }

    // Copy openclaw.plugin.json
    copyFileSync(join(ext.dir, "openclaw.plugin.json"), join(outDir, "openclaw.plugin.json"));

    // Copy non-TS assets
    for (const assetDir of ["assets", "skills"]) {
      const src = join(ext.dir, assetDir);
      if (existsSync(src)) {
        cpSync(src, join(outDir, assetDir), { recursive: true });
      }
    }

    results.push({
      name: ext.name,
      dir: outDir,
      entryJs: join(outDir, entryJsName),
    });
  }

  if (failures.length > 0) {
    console.warn(
      `[bun-compile] ${failures.length} extensions failed to bundle: ${failures.join(", ")}`,
    );
  }
  console.log(`[bun-compile] Bundled ${results.length}/${extDirs.length} extensions successfully`);
  return results;
}
