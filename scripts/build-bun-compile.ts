#!/usr/bin/env bun
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
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
import type { BunPlugin } from "bun";

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
const bunTarget = values.target; // e.g. "bun-linux-x64"

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

type TargetPlatform = {
  os: string;
  arch: string;
  isCross: boolean;
};

function detectPlatform(target?: string): TargetPlatform {
  if (!target) {
    return { os: process.platform, arch: process.arch, isCross: false };
  }
  const parts = target.split("-");
  const os = parts[1] === "windows" ? "win32" : parts[1];
  const arch = parts[2];
  const isCross = os !== process.platform || arch !== process.arch;
  return { os, arch, isCross };
}

const platform = detectPlatform(bunTarget);

console.log(`[bun-compile] Building openclaw binary...`);
console.log(`[bun-compile] outdir: ${outdir}`);
console.log(
  `[bun-compile] platform: ${platform.os}-${platform.arch}${platform.isCross ? " (cross)" : ""}`,
);

// ---------------------------------------------------------------------------
// pnpm package resolver
// ---------------------------------------------------------------------------

function findInPnpm(packageName: string, parentPackage?: string): string | null {
  // Strategy 1: resolve via parent package's pnpm symlink
  if (parentPackage) {
    const parentHoisted = resolve(`node_modules/${parentPackage}`);
    if (existsSync(parentHoisted)) {
      try {
        const parentReal = realpathSync(parentHoisted).replace(/\\/g, "/");
        const lastNmIdx = parentReal.lastIndexOf("/node_modules/");
        if (lastNmIdx !== -1) {
          const nodeModulesDir = parentReal.slice(0, lastNmIdx + "/node_modules".length);
          const candidate = resolve(nodeModulesDir, packageName);
          if (existsSync(candidate)) {
            return candidate;
          }
        }
      } catch {
        // fall through
      }
    }
  }

  // Strategy 2: direct readdir of .pnpm (more reliable on Windows than Bun.Glob)
  const pnpmDir = resolve("node_modules/.pnpm");
  const pnpmName = packageName.replace(/\//g, "+");
  try {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith(`${pnpmName}@`)) {
        const candidate = resolve(pnpmDir, entry, "node_modules", packageName);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    // fall through
  }

  // Strategy 3: glob search in .pnpm (fallback)
  const pattern = `**/${pnpmName}@*/node_modules/${packageName}`;
  const glob = new Bun.Glob(pattern);
  for (const match of glob.scanSync({ cwd: pnpmDir, absolute: true })) {
    return match;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Native embedding plugin
//
// Intercepts dynamic require() calls at bundle time and redirects them to
// static paths so Bun can embed the .node files into the binary.
// ---------------------------------------------------------------------------

// Escape backslashes in paths for embedding inside JS string literals
function jsPath(p: string): string {
  return p.replace(/\\/g, "\\\\");
}

function createNativeEmbedPlugin(embeddedSkills: EmbeddedSkillsData): BunPlugin {
  const { os, arch } = platform;
  const embedNative = !values["skip-native"] && !platform.isCross;

  // Resolve paths once
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

  if (ptyPkgDir && ptyNodeFile && existsSync(ptyNodeFile)) {
    console.log(`[bun-compile] Will embed node-pty: ${ptyNodeFile}`);
  }
  if (sharpNodeFile) {
    console.log(`[bun-compile] Will embed sharp: ${sharpNodeFile}`);
    // Patch rpath for macOS/Linux so libvips resolves from @executable_path/lib/
    if (os === "darwin") {
      try {
        const patched = `/tmp/sharp-${sharpPlatform}-patched.node`;
        copyFileSync(sharpNodeFile, patched);
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
      if (ptyPkgDir) {
        build.onResolve({ filter: /^@lydell\/node-pty$/ }, () => {
          return { path: resolve(ptyPkgDir, "lib/index.js") };
        });
      }

      // Replace utils.js loadNativeModule with static require of pty.node
      if (ptyNodeFile && existsSync(ptyNodeFile)) {
        const utilsPattern = new RegExp(
          `node-pty-${os}-${arch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[/\\\\]lib[/\\\\]utils\\.js$`,
        );
        build.onLoad({ filter: utilsPattern }, () => {
          return {
            contents: `
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadNativeModule = exports.assign = void 0;
function assign(target) {
  var sources = [];
  for (var i = 1; i < arguments.length; i++) sources[i - 1] = arguments[i];
  sources.forEach(function (s) { return Object.keys(s).forEach(function (k) { return target[k] = s[k]; }); });
  return target;
}
exports.assign = assign;
function loadNativeModule(name) {
  return { dir: "embedded", module: require("${jsPath(ptyNodeFile)}") };
}
exports.loadNativeModule = loadNativeModule;
`,
            loader: "js",
          };
        });
      }

      // --- sharp: redirect sharp/lib/sharp.js → static require of .node ---
      if (sharpNodeFile) {
        build.onLoad({ filter: /sharp[/\\]lib[/\\]sharp\.js$/ }, () => {
          return {
            contents: `module.exports = require("${jsPath(sharpNodeFile)}");\n`,
            loader: "js",
          };
        });
      }

      // --- sqlite-vec: replace getLoadablePath to look next to binary ---
      const extSuffix = os === "win32" ? "dll" : os === "darwin" ? "dylib" : "so";
      build.onLoad({ filter: /sqlite-vec[/\\]index\.cjs$/ }, () => {
        return {
          contents: `
const { dirname, join } = require("node:path");
const { statSync } = require("node:fs");

function getLoadablePath() {
  const dir = dirname(process.execPath);
  const candidates = [
    join(dir, "lib", "vec0.${extSuffix}"),
    join(dir, "vec0.${extSuffix}"),
  ];
  for (const p of candidates) {
    if (statSync(p, { throwIfNoEntry: false })) return p;
  }
  throw new Error("sqlite-vec extension not found. Expected vec0.${extSuffix} in lib/ next to the binary.");
}
function load(db) { db.loadExtension(getLoadablePath()); }
module.exports = { getLoadablePath, load };
`,
          loader: "js",
        };
      });

      build.onLoad({ filter: /sqlite-vec[/\\]index\.mjs$/ }, () => {
        return {
          contents: `
import { dirname, join } from "node:path";
import { statSync } from "node:fs";

function getLoadablePath() {
  const dir = dirname(process.execPath);
  const candidates = [
    join(dir, "lib", "vec0.${extSuffix}"),
    join(dir, "vec0.${extSuffix}"),
  ];
  for (const p of candidates) {
    if (statSync(p, { throwIfNoEntry: false })) return p;
  }
  throw new Error("sqlite-vec extension not found. Expected vec0.${extSuffix} in lib/ next to the binary.");
}
function load(db) { db.loadExtension(getLoadablePath()); }
export { getLoadablePath, load };
`,
          loader: "js",
        };
      });

      console.log(`[bun-compile] Plugin: sqlite-vec → look for lib/vec0.${extSuffix}`);

      // --- jiti: resolve from sidecar node_modules next to binary ---
      // Bun compiled binaries need full file paths for require(), not package names.
      // require("path/to/jiti") fails but require("path/to/jiti/lib/jiti.cjs") works.
      const jitiRequireExpr = `require(require("node:path").join(require("node:path").dirname(process.execPath), "node_modules", "jiti", "lib", "jiti.cjs"))`;

      // --- plugin-sdk: embed pre-bundled JS files into binary via $bunfs ---
      // Scan the pre-built plugin-sdk directory and generate import statements.
      // Patch resolvePluginSdkAliasFile to check $bunfs paths first.
      const sdkFiles: string[] = [];
      const sdkImportLines: string[] = [];
      let sdkRootExpr = "null";
      if (existsSync(sdkTempDir)) {
        for (const f of readdirSync(sdkTempDir)) {
          if (f.endsWith(".js")) {
            const fullPath = resolve(sdkTempDir, f);
            sdkFiles.push(fullPath);
            sdkImportLines.push(
              `import __sdk${sdkFiles.length - 1} from ${JSON.stringify(fullPath)} with { type: "file" };`,
            );
          }
        }
        // Derive $bunfs plugin-sdk root from the first file
        if (sdkFiles.length > 0) {
          sdkRootExpr = `__sdk0.replace(/[\\\\/][^\\\\/]+$/, "")`;
        }
        console.log(
          `[bun-compile] Plugin: plugin-sdk → embedding ${sdkFiles.length} files into binary`,
        );
      }

      build.onLoad({ filter: /plugins[/\\]loader\.ts$/ }, (args) => {
        const original = readFileSync(args.path, "utf-8");
        // Prepend plugin-sdk file embeds + derive $bunfs root
        const sdkPreamble =
          sdkImportLines.length > 0
            ? sdkImportLines.join("\n") +
              `\nconst __embeddedSdkRoot: string | null = ${sdkRootExpr};\n`
            : "const __embeddedSdkRoot: string | null = null;\n";
        const patched =
          sdkPreamble +
          original
            .replace(
              /import\s*\{\s*createJiti\s*\}\s*from\s*["']jiti["'];?/,
              `const { createJiti } = ${jitiRequireExpr};`,
            )
            // In compiled binary, import.meta.url is /$bunfs/root/entry.js which
            // breaks resolvePluginSdkAliasFile's directory traversal. Replace with
            // process.execPath so it finds src/plugin-sdk/ next to the binary.
            .replace(
              /const\s+modulePath\s*=\s*params\.modulePath\s*\?\?\s*fileURLToPath\(import\.meta\.url\);/,
              `const modulePath = params.modulePath ?? process.execPath;`,
            )
            // Add $bunfs path check at the start of resolvePluginSdkAliasFile
            .replace(
              /let cursor = path\.dirname\(modulePath\);/,
              `// Bun compile: check embedded $bunfs plugin-sdk path first\n    if (__embeddedSdkRoot) {\n      const bunfsCandidate = path.join(__embeddedSdkRoot, params.distFile);\n      if (fs.existsSync(bunfsCandidate)) return bunfsCandidate;\n    }\n    let cursor = path.dirname(modulePath);`,
            );
        return { contents: patched, loader: "ts" };
      });

      build.onLoad({ filter: /plugin-sdk[/\\]root-alias\.cjs$/ }, (args) => {
        const original = readFileSync(args.path, "utf-8");
        const patched = original.replace(
          /const\s*\{\s*createJiti\s*\}\s*=\s*require\(["']jiti["']\);?/,
          `const { createJiti } = ${jitiRequireExpr};`,
        );
        return { contents: patched, loader: "js" };
      });

      console.log("[bun-compile] Plugin: jiti → resolve from sidecar node_modules");

      // --- control-ui: embed static assets into binary via $bunfs ---
      // At build time, scan dist/control-ui/ and generate import statements for
      // each file using `import ... with { type: "file" }`. This causes Bun to
      // embed them into the binary at $bunfs paths. Then patch resolveControlUiRootSync
      // to check the $bunfs root directory as a candidate.
      if (existsSync(resolve("dist/control-ui/index.html"))) {
        const controlUiDir = resolve("dist/control-ui");
        const controlUiFiles: string[] = [];
        const scanDir = (dir: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              scanDir(fullPath);
            } else {
              controlUiFiles.push(fullPath);
            }
          }
        };
        scanDir(controlUiDir);

        // Generate import lines that embed each file into $bunfs
        const importLines = controlUiFiles.map(
          (f, i) => `import __cui${i} from ${JSON.stringify(f)} with { type: "file" };`,
        );
        // Use the index.html import to derive the $bunfs root at runtime
        const indexImportIdx = controlUiFiles.findIndex((f) => f.endsWith("index.html"));
        const rootExpr =
          indexImportIdx >= 0
            ? `__cui${indexImportIdx}.replace(/[\\\\/]index\\.html$/, "")`
            : "null";

        build.onLoad({ filter: /infra[/\\]control-ui-assets\.ts$/ }, (args) => {
          const original = readFileSync(args.path, "utf-8");
          // Inject embedded file imports and add $bunfs root as first candidate
          const patched =
            importLines.join("\n") +
            `\nconst __embeddedControlUiRoot: string | null = ${rootExpr};\n` +
            original.replace(
              // Insert after "Packaged app" addCandidate line
              /addCandidate\(candidates, execDir \? path\.join\(execDir, "control-ui"\) : null\);/,
              `$&\n  // Bun compile: check embedded $bunfs path\n  addCandidate(candidates, __embeddedControlUiRoot);`,
            );
          return { contents: patched, loader: "ts" };
        });

        console.log(
          `[bun-compile] Plugin: control-ui → embedding ${controlUiFiles.length} files into binary`,
        );
      }

      // --- skills: embed skill files into binary with virtual FS overlay ---
      // $bunfs flattens files (no directory structure) and doesn't support readdirSync.
      // We create a virtual filesystem overlay:
      //   1. Embed all files via `import with { type: "file" }` → get flat $bunfs paths
      //   2. Build a virtual root dir (e.g. /$bunfs/root/__skills__/)
      //   3. Monkey-patch readdirSync, readFileSync, existsSync to map virtual paths
      //      back to real $bunfs paths using a build-time manifest + file map
      if (embeddedSkills.files.length > 0) {
        const skillImportLines = embeddedSkills.files.map(
          (f, i) => `import __ski${i} from ${JSON.stringify(f.absPath)} with { type: "file" };`,
        );

        // Generate file map assignments: __fileMap["rel/path"] = __skiN;
        const fileMapAssignments = embeddedSkills.files.map(
          (f, i) => `  __skiFileMap[${JSON.stringify(f.relPath)}] = __ski${i};`,
        );

        build.onLoad({ filter: /[/\\]entry\.ts$/ }, (args) => {
          let original = readFileSync(args.path, "utf-8");
          // Strip shebang — Bun compile handles it separately
          if (original.startsWith("#!")) {
            original = original.slice(original.indexOf("\n") + 1);
          }
          const preamble = [
            ...skillImportLines,
            `import __shimFs from "node:fs";`,
            `import __shimPath from "node:path";`,
            ``,
            `// Bun compile: virtual FS overlay for embedded skills`,
            `// $bunfs flattens files, so we create a virtual directory tree`,
            `const __skiFileMap: Record<string, string> = Object.create(null);`,
            ...fileMapAssignments,
            ``,
            `// Derive virtual root from $bunfs prefix + unique subdir`,
            `const __bunfsPrefix = __ski0.slice(0, __ski0.lastIndexOf(__ski0.includes("\\\\") ? "\\\\" : "/"));`,
            `const __skiSep = __ski0.includes("\\\\") ? "\\\\" : "/";`,
            `const __skillsVRoot = __bunfsPrefix + __skiSep + "__skills__";`,
            ``,
            `// Directory manifest (relative paths → child entries)`,
            `const __skiDirManifest: Record<string, { files: string[]; dirs: string[] }> = ${JSON.stringify(embeddedSkills.manifest)};`,
            ``,
            `// Set env var so resolveBundledSkillsDir() finds the virtual root`,
            `process.env.OPENCLAW_BUNDLED_SKILLS_DIR = __skillsVRoot;`,
            ``,
            `// Resolve virtual path to its relative key (or null if not under virtual root)`,
            `function __skiRelPath(p: string): string | null {`,
            `  if (!p.startsWith(__skillsVRoot)) return null;`,
            `  if (p === __skillsVRoot) return "";`,
            `  const after = p.slice(__skillsVRoot.length);`,
            `  if (after[0] !== "/" && after[0] !== "\\\\") return null;`,
            `  return after.slice(1).replace(/\\\\/g, "/");`,
            `}`,
            ``,
            `// Patch readdirSync`,
            `const __origReaddirSync = __shimFs.readdirSync;`,
            `(__shimFs as any).readdirSync = function(p: any, options?: any): any {`,
            `  if (typeof p === "string") {`,
            `    const rel = __skiRelPath(p);`,
            `    if (rel !== null) {`,
            `      const entry = __skiDirManifest[rel];`,
            `      if (entry) {`,
            `        if (options?.withFileTypes) {`,
            `          const makeDirent = (name: string, isDir: boolean) => ({`,
            `            name,`,
            `            isDirectory: () => isDir,`,
            `            isFile: () => !isDir,`,
            `            isSymbolicLink: () => false,`,
            `            isBlockDevice: () => false,`,
            `            isCharacterDevice: () => false,`,
            `            isFIFO: () => false,`,
            `            isSocket: () => false,`,
            `            parentPath: p,`,
            `            path: p,`,
            `          });`,
            `          return [`,
            `            ...entry.dirs.map((n: string) => makeDirent(n, true)),`,
            `            ...entry.files.map((n: string) => makeDirent(n, false)),`,
            `          ];`,
            `        }`,
            `        return [...entry.dirs, ...entry.files];`,
            `      }`,
            `    }`,
            `  }`,
            `  return __origReaddirSync.call(__shimFs, p, options);`,
            `};`,
            ``,
            `// Patch readFileSync — redirect virtual paths to real $bunfs paths`,
            `const __origReadFileSync = __shimFs.readFileSync;`,
            `(__shimFs as any).readFileSync = function(p: any, options?: any): any {`,
            `  if (typeof p === "string") {`,
            `    const rel = __skiRelPath(p);`,
            `    if (rel !== null && rel in __skiFileMap) {`,
            `      return __origReadFileSync.call(__shimFs, __skiFileMap[rel]!, options);`,
            `    }`,
            `  }`,
            `  return __origReadFileSync.call(__shimFs, p, options);`,
            `};`,
            ``,
            `// Patch statSync/lstatSync — return fake stats for virtual paths`,
            `function __skiMakeFakeStat(isDir: boolean, size: number) {`,
            `  const now = new Date();`,
            `  return {`,
            `    dev: 0, ino: 0, mode: isDir ? 16877 : 33188, nlink: 1,`,
            `    uid: 0, gid: 0, rdev: 0, size, blksize: 4096, blocks: Math.ceil(size / 512),`,
            `    atimeMs: now.getTime(), mtimeMs: now.getTime(), ctimeMs: now.getTime(), birthtimeMs: now.getTime(),`,
            `    atime: now, mtime: now, ctime: now, birthtime: now,`,
            `    isFile: () => !isDir, isDirectory: () => isDir, isBlockDevice: () => false,`,
            `    isCharacterDevice: () => false, isSymbolicLink: () => false, isFIFO: () => false, isSocket: () => false,`,
            `  };`,
            `}`,
            `const __origStatSync = __shimFs.statSync;`,
            `(__shimFs as any).statSync = function(p: any, options?: any): any {`,
            `  if (typeof p === "string") {`,
            `    const rel = __skiRelPath(p);`,
            `    if (rel !== null) {`,
            `      if (rel in __skiDirManifest) return __skiMakeFakeStat(true, 0);`,
            `      if (rel in __skiFileMap) {`,
            `        try { return __origStatSync.call(__shimFs, __skiFileMap[rel]!, options); }`,
            `        catch { return __skiMakeFakeStat(false, 1024); }`,
            `      }`,
            `      const err = new Error("ENOENT: no such file, stat '" + p + "'") as any;`,
            `      err.code = "ENOENT"; err.errno = -2; err.syscall = "stat"; err.path = p;`,
            `      throw err;`,
            `    }`,
            `  }`,
            `  return __origStatSync.call(__shimFs, p, options);`,
            `};`,
            `const __origLstatSync = __shimFs.lstatSync;`,
            `(__shimFs as any).lstatSync = function(p: any, options?: any): any {`,
            `  if (typeof p === "string") {`,
            `    const rel = __skiRelPath(p);`,
            `    if (rel !== null) {`,
            `      if (rel in __skiDirManifest) return __skiMakeFakeStat(true, 0);`,
            `      if (rel in __skiFileMap) {`,
            `        try { return __origLstatSync.call(__shimFs, __skiFileMap[rel]!, options); }`,
            `        catch { return __skiMakeFakeStat(false, 1024); }`,
            `      }`,
            `      const err = new Error("ENOENT: no such file, lstat '" + p + "'") as any;`,
            `      err.code = "ENOENT"; err.errno = -2; err.syscall = "lstat"; err.path = p;`,
            `      throw err;`,
            `    }`,
            `  }`,
            `  return __origLstatSync.call(__shimFs, p, options);`,
            `};`,
            ``,
            `// Patch existsSync — virtual dirs and files should exist`,
            `const __origExistsSync = __shimFs.existsSync;`,
            `(__shimFs as any).existsSync = function(p: any): boolean {`,
            `  if (typeof p === "string") {`,
            `    const rel = __skiRelPath(p);`,
            `    if (rel !== null) {`,
            `      return rel in __skiDirManifest || rel in __skiFileMap;`,
            `    }`,
            `  }`,
            `  return __origExistsSync.call(__shimFs, p);`,
            `};`,
            ``,
          ].join("\n");
          return { contents: preamble + original, loader: "ts" };
        });

        console.log(
          `[bun-compile] Plugin: skills → embedding ${embeddedSkills.files.length} files with virtual FS overlay`,
        );
      }

      // --- pi-coding-agent skills.js: fix destructured fs imports ---
      // Bun's bundler captures destructured imports as direct references, which
      // bypasses monkey-patches on the fs module. Replace the destructured import
      // with wrapper functions that access fs via property access at call time.
      build.onLoad({ filter: /pi-coding-agent[/\\]dist[/\\]core[/\\]skills\.js$/ }, (args) => {
        const original = readFileSync(args.path, "utf-8");
        const patched = original.replace(
          /import\s*\{\s*existsSync\s*,\s*readdirSync\s*,\s*readFileSync\s*,\s*realpathSync\s*,\s*statSync\s*\}\s*from\s*["']fs["'];?/,
          [
            `import __piFs from "fs";`,
            `const existsSync = (p) => __piFs.existsSync(p);`,
            `const readdirSync = (p, o) => __piFs.readdirSync(p, o);`,
            `const readFileSync = (p, o) => __piFs.readFileSync(p, o);`,
            `const realpathSync = (p) => __piFs.realpathSync(p);`,
            `const statSync = (p) => __piFs.statSync(p);`,
          ].join("\n"),
        );
        return { contents: patched, loader: "js" };
      });

      // --- ajv: schema-validator uses createRequire + require("ajv") which
      // creates a separate require scope the bundler can't follow.
      // Add a top-level import and replace the dynamic require with it. ---
      build.onLoad({ filter: /plugins[/\\]schema-validator\.ts$/ }, (args) => {
        const original = readFileSync(args.path, "utf-8");
        const patched = original
          .replace(
            /import\s*\{\s*createRequire\s*\}\s*from\s*["']node:module["'];?/,
            `import _ajvPkg from "ajv";`,
          )
          .replace(/const\s+require\s*=\s*createRequire\([^)]+\);?\n?/, "")
          .replace(
            /const\s+ajvModule\s*=\s*require\(["']ajv["']\)\s*as\s*[^;]+;/,
            `const ajvModule = _ajvPkg as unknown as { default?: new (opts?: object) => AjvLike };`,
          );
        return { contents: patched, loader: "ts" };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Build externals list
// ---------------------------------------------------------------------------

function buildExternals(): string[] {
  const { os } = platform;
  const list = [
    "opusscript",
    "@discordjs/opus",
    "node-llama-cpp",
    "@node-llama-cpp/*",
    "ffmpeg-static",
    "electron",
    "chromium-bidi",
    "chromium-bidi/*",
    "playwright-core",
    "authenticate-pam",
    "@napi-rs/canvas",
    "@matrix-org/matrix-sdk-crypto-nodejs",
    "koffi",
  ];

  // macOS uses sips for image processing, no need for sharp
  if (os === "darwin") {
    list.push("sharp", "@img/sharp-*");
  }
  if (os !== "darwin") {
    list.push("detect-libc");
  }

  // Dead-code branches for the other OS terminal
  if (os === "win32") {
    list.push("./unixTerminal");
  } else {
    list.push("./windowsTerminal");
  }

  return list;
}

// ---------------------------------------------------------------------------
// Copy non-embeddable native shared libraries to lib/
// ---------------------------------------------------------------------------

function copySidecarLibs() {
  const { os, arch } = platform;
  const libDir = join(outdir, "lib");
  mkdirSync(libDir, { recursive: true });
  let copied = 0;

  // sqlite-vec: vec0.{dylib|so|dll}
  const extSuffix = os === "win32" ? "dll" : os === "darwin" ? "dylib" : "so";
  const sqliteVecOs = os === "win32" ? "windows" : os === "darwin" ? "darwin" : "linux";
  const vecPkg = findInPnpm(`sqlite-vec-${sqliteVecOs}-${arch}`, "sqlite-vec");
  if (vecPkg) {
    const vecFile = join(vecPkg, `vec0.${extSuffix}`);
    if (existsSync(vecFile)) {
      copyFileSync(vecFile, join(libDir, `vec0.${extSuffix}`));
      console.log(`[bun-compile] Copied vec0.${extSuffix} → lib/`);
      copied++;
    }
  } else {
    console.warn(`[bun-compile] Warning: sqlite-vec-${sqliteVecOs}-${arch} not found`);
  }

  // sharp's libvips (Linux/Windows only)
  if (os !== "darwin") {
    const sharpPlatform = os === "win32" ? `win32-${arch}` : `${os}-${arch}`;
    const libvipsPkg = findInPnpm(`@img/sharp-libvips-${sharpPlatform}`);
    if (libvipsPkg) {
      const libvipsGlob = new Bun.Glob("lib/libvips*");
      for (const match of libvipsGlob.scanSync({ cwd: libvipsPkg, absolute: true })) {
        const filename = match.split("/").pop()!;
        copyFileSync(match, join(libDir, filename));
        console.log(`[bun-compile] Copied ${filename} → lib/`);
        copied++;
      }
    }
  }

  if (copied === 0) {
    rmSync(libDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Scan skills directory for embedding into binary
// ---------------------------------------------------------------------------

type EmbeddedSkillsData = {
  manifest: Record<string, { files: string[]; dirs: string[] }>;
  files: { absPath: string; relPath: string }[];
};

function scanSkillsForEmbedding(): EmbeddedSkillsData {
  const skillsDir = resolve("skills");
  const manifest: Record<string, { files: string[]; dirs: string[] }> = {};
  const files: { absPath: string; relPath: string }[] = [];

  if (!existsSync(skillsDir)) {
    return { manifest, files };
  }

  const scan = (dir: string, rel: string) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    const fileNames: string[] = [];
    const dirNames: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = join(dir, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        dirNames.push(entry.name);
        scan(fullPath, entryRel);
      } else if (entry.isFile()) {
        fileNames.push(entry.name);
        files.push({ absPath: fullPath, relPath: entryRel });
      }
    }
    manifest[rel] = { files: fileNames, dirs: dirNames };
  };
  scan(skillsDir, "");

  console.log(
    `[bun-compile] Scanned skills: ${files.length} files in ${Object.keys(manifest).length} directories`,
  );
  return { manifest, files };
}

// ---------------------------------------------------------------------------
// Bundle plugin-sdk entries as self-contained JS files.
//
// Extensions import "openclaw/plugin-sdk/*" at runtime via jiti.
// These plugin-sdk files re-export from deep in src/ (../plugins/, ../infra/).
// In a compiled binary, the source tree isn't on disk, so jiti can't resolve them.
// Solution: pre-bundle each entry into a standalone JS file under dist/plugin-sdk/.
// The existing resolvePluginSdkAliasFile() already looks for dist/plugin-sdk/*.
// ---------------------------------------------------------------------------

async function bundlePluginSdk(targetDir?: string) {
  const sdkOutDir = targetDir ?? join(outdir, "dist", "plugin-sdk");
  mkdirSync(sdkOutDir, { recursive: true });

  // Scoped entries from loader.ts (e.g. "openclaw/plugin-sdk/core" → core.ts → core.js)
  const scopedEntries = new Bun.Glob("*.ts").scanSync({
    cwd: resolve("src/plugin-sdk"),
    absolute: true,
  });
  const entrypoints: string[] = [];
  for (const entry of scopedEntries) {
    // Skip test files
    if (entry.endsWith(".test.ts")) {
      continue;
    }
    entrypoints.push(entry);
  }

  // These deps are optional/platform-specific and shouldn't be pulled into the SDK bundle
  const sdkExternals = buildExternals();

  // Bundle all entries at once for speed
  const sdkResult = await Bun.build({
    entrypoints,
    outdir: sdkOutDir,
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

  // Also bundle root-alias.cjs (CJS format for require("openclaw/plugin-sdk"))
  const rootAliasResult = await Bun.build({
    entrypoints: [resolve("src/plugin-sdk/root-alias.cjs")],
    outdir: sdkOutDir,
    target: "bun",
    format: "cjs",
    minify: true,
    external: sdkExternals,
  });

  if (!rootAliasResult.success) {
    console.error("[bun-compile] Plugin SDK root-alias bundle failed:");
    for (const log of rootAliasResult.logs) {
      console.error("  ", log.message || log);
    }
    // Non-fatal: root-alias is a fallback, scoped entries are more important
  }

  const entryCount = sdkResult.outputs.filter((o) => o.kind === "entry-point").length;
  console.log(`[bun-compile] Bundled ${entryCount} plugin-sdk entries → dist/plugin-sdk/`);
}

// ---------------------------------------------------------------------------
// Install jiti (pure JS, needed at runtime for plugin loading)
// ---------------------------------------------------------------------------

async function installJiti() {
  const rootPkg = JSON.parse(await Bun.file("package.json").text()) as {
    dependencies?: Record<string, string>;
  };
  const jitiVersion = rootPkg.dependencies?.jiti;
  if (!jitiVersion) {
    console.warn("[bun-compile] Warning: jiti not in dependencies, skipping");
    return;
  }

  const sidecarPkg = {
    name: "openclaw-sidecar",
    private: true,
    dependencies: { jiti: jitiVersion },
  };

  const mainPkgPath = join(outdir, "package.json");
  const mainPkgBackup = join(outdir, "package.json.bak");

  copyFileSync(mainPkgPath, mainPkgBackup);
  writeFileSync(mainPkgPath, JSON.stringify(sidecarPkg, null, 2));

  const installProc = Bun.spawn(["npm", "install", "--omit=dev", "--no-package-lock"], {
    stdout: "inherit",
    stderr: "inherit",
    cwd: outdir,
  });
  const installExit = await installProc.exited;

  copyFileSync(mainPkgBackup, mainPkgPath);
  rmSync(mainPkgBackup, { force: true });

  if (installExit !== 0) {
    console.error(`[bun-compile] jiti install failed (exit ${installExit})`);
    process.exit(installExit);
  }
  console.log("[bun-compile] Installed jiti to sidecar node_modules/.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

// Pre-bundle plugin-sdk before Bun.build() so files can be embedded into $bunfs
const sdkTempDir = join(outdir, ".plugin-sdk-prebuild");
await bundlePluginSdk(sdkTempDir);

// Scan skills directory for embedding into binary
const embeddedSkills = scanSkillsForEmbedding();

const plugin = createNativeEmbedPlugin(embeddedSkills);
const externals = buildExternals();
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

copyFileSync("package.json", join(outdir, "package.json"));
cpSync("extensions", join(outdir, "extensions"), { recursive: true });

// Skills are embedded in the binary via $bunfs (with readdirSync shim).
// Only copy as sidecar fallback if embedding failed (no skill files found).
if (embeddedSkills.files.length === 0) {
  cpSync("skills", join(outdir, "skills"), { recursive: true });
  console.log("[bun-compile] Skills not embedded, copied as sidecar fallback.");
}

// Clean up plugin-sdk pre-build temp dir (already embedded in binary)
rmSync(sdkTempDir, { recursive: true, force: true });

if (!existsSync("dist/control-ui")) {
  console.warn("[bun-compile] Warning: dist/control-ui not found. Run `pnpm ui:build` first.");
  console.warn("[bun-compile] Control UI will not be available in the binary.");
}

// Copy native shared libraries that can't be embedded
if (!values["skip-native"]) {
  copySidecarLibs();
  await installJiti();
}

console.log("[bun-compile] Done.");
