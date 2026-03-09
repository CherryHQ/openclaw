#!/usr/bin/env bun
import { execSync } from "node:child_process";
/**
 * Build openclaw as a standalone binary using Bun's JS API with `compile`.
 *
 * Native .node addons (node-pty, sharp) are embedded into the binary via
 * a bundler plugin that intercepts dynamic require() calls and redirects
 * them to static paths — no file patching needed.
 *
 * Non-embeddable shared libraries (libvips, sqlite-vec) are copied to lib/.
 *
 * Usage:
 *   bun scripts/build-bun-compile.ts                        # current platform
 *   bun scripts/build-bun-compile.ts --target bun-linux-x64 # cross-compile
 *   bun scripts/build-bun-compile.ts --skip-native          # skip native embedding
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { BunPlugin } from "bun";
import { buildExternals } from "./bun-compile/externals.js";
// --- Module imports ---
import { detectPlatform, findInPnpm, jsPath } from "./bun-compile/helpers.js";
// Patches
import {
  patchVersionTs,
  patchGitCommit,
  patchOpenClawRoot,
  patchPluginRuntimeVersion,
} from "./bun-compile/patches/build-info.js";
import {
  patchSchemaValidator,
  patchPiCodingAgentSkills,
} from "./bun-compile/patches/compat-fixes.js";
import {
  generatePtyUtilsContents,
  generateSharpLibContents,
  generateSqliteVecRuntime,
  generateOptionalStub,
} from "./bun-compile/patches/native-embeds.js";
import {
  patchLoaderTs,
  patchManifestTs,
  patchDiscoveryTs,
} from "./bun-compile/patches/plugin-system.js";
import { patchEntryTs, patchControlUiAssets } from "./bun-compile/patches/vfs-overlay.js";
import { bundleExtensions } from "./bun-compile/prebundle-extensions.js";
import { bundlePluginSdk } from "./bun-compile/prebundle-sdk.js";
import { scanExtensionsForEmbedding } from "./bun-compile/scan-extensions.js";
import { scanSkillsForEmbedding } from "./bun-compile/scan-skills.js";
import { copySidecarLibs } from "./bun-compile/sidecar.js";
import type { PatchContext } from "./bun-compile/types.js";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    target: { type: "string" },
    outdir: { type: "string", default: "dist-bun" },
    "skip-native": { type: "boolean", default: false },
  },
});

const outdir = values.outdir;
const bunTarget = values.target;
const platform = detectPlatform(bunTarget);

console.log(`[bun-compile] Building openclaw binary...`);
console.log(`[bun-compile] outdir: ${outdir}`);
console.log(
  `[bun-compile] platform: ${platform.os}-${platform.arch}${platform.isCross ? " (cross)" : ""}`,
);

// ---------------------------------------------------------------------------
// Read package metadata
// ---------------------------------------------------------------------------

const pkgJson = JSON.parse(readFileSync("package.json", "utf-8")) as {
  name: string;
  version: string;
};

let gitHead: string | null = null;
try {
  gitHead = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim().slice(0, 7);
} catch {}

// ---------------------------------------------------------------------------
// Create native embed plugin
// ---------------------------------------------------------------------------

function createNativeEmbedPlugin(ctx: PatchContext): BunPlugin {
  const { os, arch } = ctx.platform;

  // --- Resolve native paths ---
  if (ctx.ptyNodeFile && existsSync(ctx.ptyNodeFile)) {
    console.log(`[bun-compile] Will embed node-pty: ${ctx.ptyNodeFile}`);
  }
  if (ctx.sharpNodeFile) {
    console.log(`[bun-compile] Will embed sharp: ${ctx.sharpNodeFile}`);
    if (os === "darwin") {
      try {
        const sharpPlatform = `${os}-${arch}`;
        const patched = `/tmp/sharp-${sharpPlatform}-patched.node`;
        copyFileSync(ctx.sharpNodeFile, patched);
        Bun.spawnSync(["install_name_tool", "-add_rpath", "@executable_path/lib", patched]);
      } catch {
        // best-effort
      }
    }
  }

  return {
    name: "native-embed",
    setup(build) {
      // --- node-pty: redirect @lydell/node-pty → platform-specific package ---
      const ptyPlatformPkg = `@lydell/node-pty-${os}-${arch}`;
      const ptyPkgDir = ctx.embedNative ? findInPnpm(ptyPlatformPkg, "@lydell/node-pty") : null;

      if (ptyPkgDir) {
        build.onResolve({ filter: /^@lydell\/node-pty$/ }, () => {
          return { path: resolve(ptyPkgDir, "lib/index.js") };
        });
      }

      // Replace utils.js loadNativeModule with static require of pty.node
      if (ctx.ptyNodeFile && existsSync(ctx.ptyNodeFile)) {
        const utilsPattern = new RegExp(
          `node-pty-${os}-${arch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[/\\\\]lib[/\\\\]utils\\.js$`,
        );
        build.onLoad({ filter: utilsPattern }, () => ({
          contents: generatePtyUtilsContents(jsPath(ctx.ptyNodeFile!)),
          loader: "js",
        }));
      }

      // --- sharp: redirect sharp/lib/sharp.js → static require of .node ---
      if (ctx.sharpNodeFile) {
        build.onLoad({ filter: /sharp[/\\]lib[/\\]sharp\.js$/ }, () => ({
          contents: generateSharpLibContents(jsPath(ctx.sharpNodeFile!)),
          loader: "js",
        }));
      }

      // --- optional-externals: provide lazy stubs ---
      {
        const optionalExternals = [
          "playwright-core",
          "opusscript",
          "@discordjs/opus",
          "node-llama-cpp",
          "ffmpeg-static",
          "electron",
          "chromium-bidi",
          "authenticate-pam",
          "@napi-rs/canvas",
          "@matrix-org/matrix-sdk-crypto-nodejs",
          "koffi",
          "detect-libc",
        ];
        if (os === "darwin") {
          optionalExternals.push("sharp");
        }
        const escaped = optionalExternals.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        const stubFilter = new RegExp(`^(${escaped.join("|")})$`);
        build.onResolve({ filter: stubFilter }, (args) => {
          return { path: args.path, namespace: "optional-stub" };
        });
        build.onLoad({ filter: /.*/, namespace: "optional-stub" }, (args) => ({
          contents: generateOptionalStub(args.path),
          loader: "js",
        }));
      }

      // --- package.json: return hardcoded values ---
      {
        const rootPkgJsonPath = resolve("package.json");
        build.onLoad({ filter: /package\.json$/ }, (args: { path: string }) => {
          if (resolve(args.path) !== rootPkgJsonPath) {
            return undefined;
          }
          return {
            contents: `module.exports = ${JSON.stringify({ name: ctx.pkgJson.name, version: ctx.pkgJson.version })};`,
            loader: "js",
          };
        });
      }

      // --- sqlite-vec: runtime code ---
      build.onLoad({ filter: /sqlite-vec[/\\]index\.cjs$/ }, () => ({
        contents: generateSqliteVecRuntime(ctx.vecExtSuffix, "cjs"),
        loader: "js",
      }));
      build.onLoad({ filter: /sqlite-vec[/\\]index\.mjs$/ }, () => ({
        contents: generateSqliteVecRuntime(ctx.vecExtSuffix, "esm"),
        loader: "js",
      }));

      if (ctx.vecFile && existsSync(ctx.vecFile)) {
        console.log(
          `[bun-compile] Plugin: sqlite-vec → embedding vec0.${ctx.vecExtSuffix} into binary`,
        );
      } else {
        console.log(
          `[bun-compile] Plugin: sqlite-vec → fallback to sidecar lib/vec0.${ctx.vecExtSuffix}`,
        );
      }

      // --- plugin-sdk embedding info ---
      if (ctx.sdkFiles.length > 0) {
        console.log(
          `[bun-compile] Plugin: plugin-sdk → embedding ${ctx.sdkFiles.length} files into binary`,
        );
      }

      // --- Build-info patchers ---
      build.onLoad({ filter: /[/\\]version\.ts$/ }, (args) => {
        if (!args.path.includes("src/version.ts") && !args.path.includes("src\\version.ts")) {
          return undefined;
        }
        return { contents: patchVersionTs(readFileSync(args.path, "utf-8"), ctx), loader: "ts" };
      });
      build.onLoad({ filter: /infra[/\\]git-commit\.ts$/ }, (args) => ({
        contents: patchGitCommit(readFileSync(args.path, "utf-8"), ctx),
        loader: "ts",
      }));
      build.onLoad({ filter: /infra[/\\]openclaw-root\.ts$/ }, (args) => ({
        contents: patchOpenClawRoot(readFileSync(args.path, "utf-8")),
        loader: "ts",
      }));
      build.onLoad({ filter: /infra[/\\]package-json\.ts$/ }, () => ({
        contents: `
export async function readPackageVersion(_root) { return ${JSON.stringify(ctx.pkgJson.version ?? null)}; }
export async function readPackageName(_root) { return ${JSON.stringify(ctx.pkgJson.name ?? null)}; }
`,
        loader: "js",
      }));
      build.onLoad({ filter: /plugins[/\\]runtime[/\\]index\.ts$/ }, (args) => ({
        contents: patchPluginRuntimeVersion(readFileSync(args.path, "utf-8"), ctx),
        loader: "ts",
      }));

      // --- Plugin system patchers ---
      build.onLoad({ filter: /plugins[/\\]loader\.ts$/ }, (args) => ({
        contents: patchLoaderTs(readFileSync(args.path, "utf-8"), ctx),
        loader: "ts",
      }));
      build.onLoad({ filter: /plugins[/\\]manifest\.ts$/ }, (args) => ({
        contents: patchManifestTs(readFileSync(args.path, "utf-8")),
        loader: "ts",
      }));
      build.onLoad({ filter: /plugins[/\\]discovery\.ts$/ }, (args) => ({
        contents: patchDiscoveryTs(readFileSync(args.path, "utf-8")),
        loader: "ts",
      }));

      // --- Compat-fixes patchers ---
      build.onLoad({ filter: /plugins[/\\]schema-validator\.ts$/ }, (args) => ({
        contents: patchSchemaValidator(readFileSync(args.path, "utf-8")),
        loader: "ts",
      }));
      build.onLoad({ filter: /pi-coding-agent[/\\]dist[/\\]core[/\\]skills\.js$/ }, (args) => ({
        contents: patchPiCodingAgentSkills(readFileSync(args.path, "utf-8")),
        loader: "js",
      }));

      // --- VFS overlay (entry.ts) ---
      if (ctx.embeddedSkills.files.length > 0 || ctx.embeddedExtensions.files.length > 0) {
        build.onLoad({ filter: /[/\\]entry\.ts$/ }, (args) => ({
          contents: patchEntryTs(readFileSync(args.path, "utf-8"), ctx, ctx.vecFile),
          loader: "ts",
        }));

        if (ctx.embeddedSkills.files.length > 0) {
          console.log(
            `[bun-compile] Plugin: skills → embedding ${ctx.embeddedSkills.files.length} files with virtual FS overlay`,
          );
        }
        if (ctx.embeddedExtensions.files.length > 0) {
          console.log(
            `[bun-compile] Plugin: extensions → embedding ${ctx.embeddedExtensions.files.length} files with virtual FS overlay`,
          );
        }
      }

      // --- Control UI ---
      if (ctx.controlUiFiles.length > 0) {
        build.onLoad({ filter: /infra[/\\]control-ui-assets\.ts$/ }, (args) => ({
          contents: patchControlUiAssets(readFileSync(args.path, "utf-8"), ctx.controlUiFiles),
          loader: "ts",
        }));
        console.log(
          `[bun-compile] Plugin: control-ui → embedding ${ctx.controlUiFiles.length} files into binary`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

// Pre-bundle plugin-sdk before Bun.build() so files can be embedded into $bunfs
const sdkTempDir = join(outdir, ".plugin-sdk-prebuild");
await bundlePluginSdk(platform, outdir, sdkTempDir);

// Pre-bundle extensions before Bun.build() so they can be embedded into $bunfs
const extTempDir = join(outdir, ".ext-prebuild");
await bundleExtensions(platform, extTempDir);

// Scan skills directory for embedding into binary
const embeddedSkills = scanSkillsForEmbedding();

// Scan pre-bundled extensions for embedding
const embeddedExtensions = scanExtensionsForEmbedding(extTempDir);

// --- Resolve native module paths ---
const embedNative = !values["skip-native"] && !platform.isCross;
const { os, arch } = platform;

const ptyPlatformPkg = `@lydell/node-pty-${os}-${arch}`;
const ptyPkgDir = embedNative ? findInPnpm(ptyPlatformPkg, "@lydell/node-pty") : null;
const ptyNodeDir = os === "win32" ? "build/Release" : `prebuilds/${os}-${arch}`;
const ptyNodeFile = ptyPkgDir ? resolve(ptyPkgDir, ptyNodeDir, "pty.node") : null;

const sharpPlatform = os === "win32" ? `win32-${arch}` : `${os}-${arch}`;
const sharpPkgDir =
  embedNative && os !== "darwin" ? findInPnpm(`@img/sharp-${sharpPlatform}`) : null;
const sharpNodeFile =
  sharpPkgDir && existsSync(resolve(sharpPkgDir, `lib/sharp-${sharpPlatform}.node`))
    ? resolve(sharpPkgDir, `lib/sharp-${sharpPlatform}.node`)
    : null;

const vecExtSuffix = os === "win32" ? "dll" : os === "darwin" ? "dylib" : "so";
const sqliteVecOs = os === "win32" ? "windows" : os === "darwin" ? "darwin" : "linux";
const vecPkg = embedNative ? findInPnpm(`sqlite-vec-${sqliteVecOs}-${arch}`, "sqlite-vec") : null;
const vecFile = vecPkg ? resolve(vecPkg, `vec0.${vecExtSuffix}`) : null;

// --- Resolve plugin-sdk files for embedding ---
const sdkFiles: { fullPath: string; basename: string }[] = [];
const sdkImportLines: string[] = [];
if (existsSync(sdkTempDir)) {
  for (const f of readdirSync(sdkTempDir)) {
    if (f.endsWith(".js") || f.endsWith(".cjs")) {
      const fullPath = resolve(sdkTempDir, f);
      const idx = sdkFiles.length;
      sdkFiles.push({ fullPath, basename: f });
      sdkImportLines.push(
        `import __sdk${idx} from ${JSON.stringify(fullPath)} with { type: "file" };`,
      );
    }
  }
}
const sdkMapEntries = sdkFiles.map((f, i) => `${JSON.stringify(f.basename)}: __sdk${i}`);
const sdkMapExpr = sdkFiles.length > 0 ? `{ ${sdkMapEntries.join(", ")} }` : "{}";
const jitiBabelCjs = resolve("node_modules/jiti/dist/babel.cjs");

// --- Resolve control-ui files ---
const controlUiFiles: { absPath: string; relPath: string }[] = [];
if (existsSync(resolve("dist/control-ui/index.html"))) {
  const controlUiDir = resolve("dist/control-ui");
  const scanDir = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else {
        const rel = fullPath.slice(controlUiDir.length + 1).replace(/\\/g, "/");
        controlUiFiles.push({ absPath: fullPath, relPath: rel });
      }
    }
  };
  scanDir(controlUiDir);
}

// --- Build PatchContext ---
const ctx: PatchContext = {
  platform,
  pkgJson,
  gitHead,
  embedNative,
  ptyNodeFile,
  sharpNodeFile,
  vecFile: vecFile && existsSync(vecFile) ? vecFile : null,
  vecExtSuffix,
  sdkFiles,
  sdkImportLines,
  sdkMapExpr,
  jitiBabelCjs,
  controlUiFiles,
  embeddedSkills,
  embeddedExtensions,
};

const plugin = createNativeEmbedPlugin(ctx);
const externals = buildExternals(platform);
const outfile = join(outdir, platform.os === "win32" ? "openclaw.exe" : "openclaw");

// Build compile options
const compileOptions: Record<string, unknown> = { outfile };
if (bunTarget) {
  compileOptions.target = bunTarget;
}

console.log(`[bun-compile] Building with Bun.build() JS API...`);

const result = await Bun.build({
  entrypoints: ["./src/entry.ts"],
  compile: compileOptions as { outfile: string; target?: string },
  plugins: [plugin],
  external: externals,
  minify: true,
  env: "OPENCLAW_NO_RESPAWN*",
});

if (!result.success) {
  console.error("[bun-compile] Build failed:");
  for (const log of result.logs) {
    console.error("  ", log.message || log);
  }
  process.exit(1);
}

console.log("[bun-compile] Build succeeded.");
console.log(
  `[bun-compile] Binary: ${outfile} (${((result.outputs[0]?.size ?? 0) / 1024 / 1024) | 0}MB)`,
);

// Copy sidecar files
console.log("[bun-compile] Copying sidecar files...");

if (embeddedExtensions.files.length === 0) {
  cpSync("extensions", join(outdir, "extensions"), { recursive: true });
  console.log("[bun-compile] Extensions not embedded, copied as sidecar fallback.");
}

if (embeddedSkills.files.length === 0) {
  cpSync("skills", join(outdir, "skills"), { recursive: true });
  console.log("[bun-compile] Skills not embedded, copied as sidecar fallback.");
}

// Clean up pre-build temp dirs (already embedded in binary)
rmSync(sdkTempDir, { recursive: true, force: true });
rmSync(extTempDir, { recursive: true, force: true });

if (!existsSync("dist/control-ui")) {
  console.warn("[bun-compile] Warning: dist/control-ui not found. Run `pnpm ui:build` first.");
  console.warn("[bun-compile] Control UI will not be available in the binary.");
}

// Copy native shared libraries that can't be embedded
if (!values["skip-native"]) {
  copySidecarLibs(platform, outdir);
}

console.log("[bun-compile] Done.");
