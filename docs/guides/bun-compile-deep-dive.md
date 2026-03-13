# Packaging OpenClaw as a Bun Compiled Binary: A Deep Dive

This document explains how OpenClaw is packaged into a single standalone binary using
Bun's compile feature, the challenges encountered, and the solutions developed. It serves
as both a technical reference and a record of the trial-and-error process.

## Table of Contents

- [Bun Runtime Fundamentals](#bun-runtime-fundamentals)
- [Bun Compile: How It Works](#bun-compile-how-it-works)
- [OpenClaw Architecture and What Needs Embedding](#openclaw-architecture-and-what-needs-embedding)
- [Approach 1: Naive Compile (and Why It Fails)](#approach-1-naive-compile-and-why-it-fails)
- [Approach 2: VFS Overlay with Monkey-Patched fs](#approach-2-vfs-overlay-with-monkey-patched-fs)
- [Approach 3: Pre-Bundling Extensions](#approach-3-pre-bundling-extensions)
- [The External Plugin Problem](#the-external-plugin-problem)
- [Approach 4: jiti as a Plugin Loader](#approach-4-jiti-as-a-plugin-loader)
- [Approach 5: Bun Native Module Loading (and the createRequire Bug)](#approach-5-bun-native-module-loading-and-the-createrequire-bug)
- [Approach 6: Spawning bun build (Requires bun in PATH)](#approach-6-spawning-bun-build-requires-bun-in-path)
- [Final Solution: Self-Spawning Bundler Mode](#final-solution-self-spawning-bundler-mode)
- [Bun Bundler Gotchas Reference](#bun-bundler-gotchas-reference)
- [Summary of Embedding Strategies](#summary-of-embedding-strategies)

---

## Bun Runtime Fundamentals

### Module Systems: ESM and CJS

Bun supports both ESM (`import`/`export`) and CJS (`require`/`module.exports`) natively,
with automatic interop between the two. Key behaviors:

- **ESM is the default** for `.ts` and `.mts` files. Bun transpiles TypeScript on-the-fly.
- **CJS is used** for `.cjs` files, or when `package.json` has `"type": "commonjs"`.
- **Interop**: `require()` can load ESM modules (Bun resolves them synchronously, unlike
  Node.js which throws `ERR_REQUIRE_ESM`). `import()` can load CJS modules.
- **`import.meta.url`**: In ESM, gives the `file://` URL of the current module. In a
  compiled binary, this points to a `/$bunfs/root/...` virtual path.
- **`createRequire(path)`**: Creates a CJS `require` function that resolves modules
  relative to the given path. Critical for plugin systems that need to load code from
  arbitrary filesystem locations.

### Bun's Bundler (`Bun.build`)

Bun includes a built-in bundler accessible via both CLI (`bun build`) and JavaScript API
(`Bun.build()`). Key options:

```typescript
const result = await Bun.build({
  entrypoints: ["./src/index.ts"], // Entry files
  outdir: "./dist", // Output directory
  target: "bun", // "bun" | "node" | "browser"
  format: "esm", // "esm" | "cjs"
  splitting: true, // Code splitting for shared chunks
  minify: true, // Minification
  external: ["some-package"], // Don't bundle these imports
  compile: { outfile: "./binary" }, // Compile to standalone binary
  plugins: [myPlugin], // Bundler plugins (onLoad, onResolve)
  define: { "process.env.X": '"Y"' }, // Compile-time string replacement
});
```

The bundler resolves all imports, tree-shakes unused code, and produces self-contained
output. When `compile` is set, it produces a standalone executable.

---

## Bun Compile: How It Works

`Bun.build({ compile: { outfile: "./binary" } })` produces a standalone binary that embeds:

1. **The Bun runtime** itself (JavaScript engine, standard library, Node.js compat layer)
2. **Your bundled application code** (all resolved imports merged into one or more chunks)
3. **Embedded files** via `import ... with { type: "file" }` syntax

### The $bunfs Virtual Filesystem

Embedded files live in a virtual filesystem:

- **macOS/Linux**: `/$bunfs/root/<hashed-name>`
- **Windows**: `B:\~BUN\root\<hashed-name>`

Critical limitation: **$bunfs flattens all files**. There is no directory structure. A file
imported as `./templates/foo/bar.md` becomes `/$bunfs/root/bar-a3f9x1.md` (content-hashed).
This means `readdirSync` on `$bunfs` paths returns `ENOENT` -- there are no directories to
list.

### What Works in $bunfs

| Operation                | Works? | Notes                            |
| ------------------------ | ------ | -------------------------------- |
| `readFileSync`           | Yes    | Reads embedded file content      |
| `existsSync`             | Yes    | Checks if path exists            |
| `statSync`               | Yes    | Returns file metadata            |
| `realpathSync`           | Yes    | Returns the path as-is           |
| `openSync` / `closeSync` | Yes    | File descriptor operations       |
| `require()` / `import()` | Yes    | Module loading                   |
| `readdirSync`            | **No** | ENOENT -- no directory structure |
| `writeFileSync`          | **No** | Read-only filesystem             |

### How Embedding Works

```typescript
// At bundle time, this embeds the file into the binary
import controlUiIndex from "./dist/control-ui/index.html" with { type: "file" };
// controlUiIndex === "/$bunfs/root/index-f01gte1v.html" (content-hashed path)
```

The `import with { type: "file" }` directive tells the bundler to embed the file's content
into the binary and return its virtual path as a string. The path is content-hashed, so you
cannot predict the exact filename at build time.

---

## OpenClaw Architecture and What Needs Embedding

OpenClaw is a modular system with a plugin architecture. To create a self-contained binary,
we need to embed these components:

### 1. Core Application (`src/`)

The main CLI, gateway server, agent runtime, and infrastructure code. This is the
straightforward part -- Bun's bundler handles it naturally.

### 2. Built-in Extensions (`extensions/`)

~30 channel/provider plugins (Discord, WhatsApp, Feishu, etc.) that ship with OpenClaw.
Each extension is a separate package with:

- `openclaw.plugin.json` (manifest)
- `package.json` (dependencies, entry point)
- TypeScript source files
- Optional assets (skills, templates)

**Challenge**: Extensions have their own `node_modules` dependencies. The bundler needs to
resolve and inline these.

### 3. Plugin SDK (`src/plugin-sdk/`)

The SDK that plugins import as `openclaw/plugin-sdk`. It provides the API surface
(config, channels, events, tools, etc.) that plugins use to interact with the core.

**Challenge**: The SDK must be available both at bundle time (for built-in extensions) and
at runtime (for external plugins installed by users). External plugins import
`openclaw/plugin-sdk` as a bare specifier, which needs to resolve to the embedded SDK.

### 4. Skills (`skills/`)

Markdown and text files that define agent capabilities. Loaded at runtime via
`readdirSync` to discover available skills.

**Challenge**: `readdirSync` doesn't work on `$bunfs`. We need a virtual directory listing.

### 5. Templates (`docs/reference/templates/`)

Reference templates for workspace configuration. Also discovered via directory listing.

### 6. Control UI (`dist/control-ui/`)

Static web assets (HTML, CSS, JS) served by the gateway's built-in web server.

**Challenge**: Content-hashed `$bunfs` paths lose the original filenames. The web server
needs to serve files by their original paths.

### 7. Native Addons (`.node` files)

- **node-pty**: Terminal emulation (platform-specific `.node` binary)
- **sharp**: Image processing (platform-specific `.node` binary)
- **sqlite-vec**: Vector search extension (`vec0.dylib`/`.so`/`.dll`)

**Challenge**: Native addons must be loaded via `require()` or `dlopen()`, which expects
real filesystem paths.

### 8. External Plugins (user-installed)

Plugins installed by users to `~/.openclaw/extensions/`. These are NOT known at build time
and have their own npm dependencies.

**Challenge**: The hardest problem. The compiled binary must load arbitrary TypeScript/JS
files with arbitrary npm dependencies from the filesystem at runtime.

---

## Approach 1: Naive Compile (and Why It Fails)

The simplest attempt:

```typescript
await Bun.build({
  entrypoints: ["./src/entry.ts"],
  compile: { outfile: "./dist/openclaw" },
});
```

This fails spectacularly because:

1. **`readdirSync` on skills/extensions/templates**: returns ENOENT (no $bunfs directories)
2. **Plugin manifest discovery**: walks directories to find `openclaw.plugin.json` files
3. **Control UI serving**: looks up files by original path, not content-hashed $bunfs path
4. **Native addons**: `.node` files embedded but can't be loaded from $bunfs directly
5. **Dynamic imports**: `getJiti()(pluginPath)` can't load from $bunfs
6. **Build-time env inlining**: `process.env.X` gets replaced with build-time values
   when `minify: true`

**Lesson**: Bun compile works great for simple applications, but a plugin-based architecture
requires significant patching of the module loading and filesystem layers.

---

## Approach 2: VFS Overlay with Monkey-Patched fs

Since `$bunfs` flattens files and doesn't support `readdirSync`, we build a Virtual
Filesystem overlay at compile time.

### Build-Time: Scanning and Manifesting

The build script (`scripts/build-bun-compile.ts`) scans each embeddable directory tree and
produces:

1. **File map**: `{ "discord/index.js": "/$bunfs/root/index-a3f9.js" }` -- maps relative
   paths to their content-hashed $bunfs paths
2. **Directory manifest**: `{ "": { dirs: ["discord", "feishu"], files: [] }, "discord": { files: ["index.js", "openclaw.plugin.json"], dirs: ["assets"] } }` -- reconstructs the
   directory tree in JSON

These are generated by `scanExtensionsForEmbedding`, `scanSkillsForEmbedding`, and
`scanTemplatesForEmbedding` in `scripts/bun-compile/scan-*.ts`.

### Runtime: Monkey-Patching Node's fs

The `patchEntryTs` function in `scripts/bun-compile/patches/vfs-overlay.ts` injects a
preamble at the top of `entry.ts` that monkey-patches `node:fs` methods:

```typescript
// Simplified version of the injected code
const __origReaddirSync = fs.readdirSync;
fs.readdirSync = function (p, options) {
  const hit = __vfsLookup(p); // Check if path is in VFS
  if (hit) {
    const entry = hit.dirManifest[hit.rel];
    if (entry) return [...entry.dirs, ...entry.files]; // Return from manifest
  }
  return __origReaddirSync.call(fs, p, options); // Fall through to real fs
};
```

Patched methods: `readdirSync`, `readFileSync`, `existsSync`, `statSync`, `lstatSync`,
`realpathSync`, `openSync`, `fstatSync`, `closeSync`.

### Why Monkey-Patching Instead of a Virtual Module?

A critical Bun bundler behavior: **named imports get scope-hoisted into direct bindings**.

When the bundler processes `import { existsSync } from "fs"`, it performs scope hoisting
and resolves the named import to a direct reference to the function (e.g. an internal
`$existsSync` binding). This eliminates the property lookup on the module object entirely,
so any runtime mutation of `fs.existsSync` has no effect on code that imported the
destructured name.

```typescript
// Bundler resolves this to a direct binding — bypasses the module object entirely
import { existsSync } from "fs";
existsSync("/some/path"); // Calls the original, not our monkey-patch

// This retains the property lookup at runtime, so our patch intercepts it
import fs from "fs";
fs.existsSync("/some/path"); // Uses our patched version
```

The monkey-patch approach works because most of OpenClaw's code uses `import fs from "fs"`
style imports (default import with property access). But some third-party dependencies use
named imports, which the bundler optimizes into direct bindings that bypass the module
object. This is an inherent limitation of the monkey-patching strategy.

---

## Approach 3: Pre-Bundling Extensions

Built-in extensions can't be simply imported into the main bundle because:

1. Each extension is a separate package with its own dependencies
2. Extensions are discovered dynamically at runtime (directory scanning)
3. Extensions use `openclaw/plugin-sdk` which needs special resolution

### Solution: Bundle Each Extension Separately

`scripts/bun-compile/prebundle-extensions.ts` bundles each extension individually before
the main compile:

```typescript
// For each extension in extensions/
const bundleResult = await Bun.build({
  entrypoints: [ext.entry], // e.g. extensions/discord/index.ts
  outdir: outDir, // Temp dir for bundled output
  target: "bun",
  format: "cjs", // CJS so we can load with new Function()
  minify: true,
  external: extExternals, // Don't bundle native addons, etc.
  plugins: [protobufLongFixPlugin],
});
```

Key decisions:

- **CJS format**: Extensions are loaded at runtime via `new Function()` wrapper (see
  Approach 5), which requires CJS module semantics
- **Per-extension bundling**: Each extension becomes a single `.js` file with all its npm
  dependencies inlined
- **Externals**: Native addons (node-pty, sharp) and core modules are kept external

### CJS .default Interop Bug

Bun's bundler has an interop bug when outputting CJS: `import x from "node:path"` generates
`x.default.join(...)` instead of `x.join(...)`. The workaround is post-processing with a
regex: `/(import_node_\w+)\.default\./g` -> `$1.`

### Plugin SDK Pre-Bundling

The Plugin SDK (`src/plugin-sdk/`) is separately bundled with code splitting:

```typescript
await Bun.build({
  entrypoints: [...allSdkEntries], // All *.ts files in src/plugin-sdk/
  outdir: sdkOutDir,
  root: resolve("src/plugin-sdk"), // Flatten output paths
  target: "bun",
  format: "esm", // ESM for the SDK
  splitting: true, // Share common chunks between entries
  minify: true,
});
```

The `root` option is critical: without it, `splitting: true` places output files in
subdirectories matching the source tree structure.

---

## The External Plugin Problem

Everything above handles **built-in** extensions (known at compile time). The hard problem
is **external plugins**: code that users install to `~/.openclaw/extensions/` with their own
npm dependencies. The compiled binary must:

1. Discover these plugins at runtime (directory scanning -- solved by VFS overlay for
   built-in, real fs for external)
2. Resolve `openclaw/plugin-sdk` imports to the embedded SDK
3. Resolve the plugin's npm dependencies (e.g. `dingtalk-stream`, `axios`)
4. Execute TypeScript/ESM/CJS source files

---

## Approach 4: jiti as a Plugin Loader

[jiti](https://github.com/unjs/jiti) is a runtime TypeScript/ESM loader that
OpenClaw already used in development. It creates a custom `require` function per file with:

- **Alias mapping**: `openclaw/plugin-sdk` -> absolute path to SDK files
- **Per-file resolution**: resolves `node_modules` from the file's directory
- **TypeScript support**: transpiles `.ts` files on-the-fly

```typescript
// Original OpenClaw loader (loader.ts)
const jiti = createJiti(import.meta.url, {
  alias: { "openclaw/plugin-sdk": sdkPath, ... },
  interopDefault: true,
});
const mod = jiti(pluginEntryPath);
```

### Why jiti Fails in Compiled Binaries

1. **`import.meta.url`** points to `/$bunfs/root/...`, not a real filesystem path. jiti
   can't resolve modules relative to a virtual path.
2. **jiti 2.6.1's `experimentalBun` option** doesn't actually exist -- it's a no-op.
3. **jiti's internal require** still uses Node.js module resolution, which doesn't work
   from `$bunfs` paths.

jiti was removed from the compiled binary path entirely.

---

## Approach 5: Bun Native Module Loading (and the createRequire Bug)

With jiti removed, the next idea was to use Bun's native module loading capabilities.

### For Built-in Extensions (Embedded in $bunfs)

These are pre-bundled as CJS. They can be loaded by reading the source from VFS and
evaluating it with a CJS wrapper:

```typescript
// Read source from VFS (monkey-patched readFileSync resolves $bunfs paths)
let code = fs.readFileSync(vfsPath, "utf-8");

// Strip Bun's CJS wrapper: (function(exports,require,module,__filename,__dirname){...})
const match = code.match(/^\s*\(function\s*\(exports,\s*require,.*?\)\s*\{/);
if (match) {
  code = code.slice(match[0].length);
  code = code.slice(0, code.lastIndexOf("})"));
}

// Execute with a CJS wrapper, using createRequire from the binary's location
const cjsRequire = createRequire(import.meta.url);
const fn = new Function("module", "exports", "require", "__filename", "__dirname", code);
const mod = { exports: {} };
fn(mod, mod.exports, cjsRequire, vfsPath, path.dirname(vfsPath));
// mod.exports is now the plugin module
```

This works because `createRequire(import.meta.url)` resolves from the binary's location,
and built-in extensions' dependencies are already bundled inline.

### For External Plugins: The createRequire Bug

The natural approach for external plugins would be:

```typescript
const require = createRequire(pluginFilePath);
const mod = require(pluginFilePath);
```

**This doesn't work.** In Bun compiled binaries, `createRequire(externalPath)` does NOT
resolve modules from the given path. It always resolves from the binary's location.

This was confirmed with standalone test binaries:

```typescript
// test.ts -> compiled to ./test-binary
import { createRequire } from "module";
const req = createRequire("/home/user/.openclaw/extensions/dingtalk/index.ts");
req.resolve("dingtalk-stream");
// Expected: resolves from /home/user/.openclaw/extensions/dingtalk/node_modules/
// Actual: resolves from /path/to/test-binary location -> FAILS
```

**Every loading method was tested and fails:**

| Method                               | Result                                        |
| ------------------------------------ | --------------------------------------------- |
| `createRequire(path).resolve(spec)`  | Resolves from binary location, not given path |
| `require(absolutePath)`              | Cannot resolve transitive dependencies        |
| `import(absolutePath)`               | Same resolution bug                           |
| `Bun.plugin() onResolve`             | Cannot override resolution for external paths |
| Symlink `node_modules` into temp dir | Bun ignores symlinks for resolution           |

**Inconsistency**: `createRequire().resolve()` works for _some_ packages (those with a
`"bun"` export condition, like `axios`) but fails for others (like `dingtalk-stream`,
`form-data`). This ruled out the "resolve each bare specifier individually" approach.

This behavior was reproducibly verified with standalone test binaries (see
`/tmp/bun-resolve-test/entry*.ts` in the development notes). As of Bun 1.3.x, no
upstream issue has been filed for this specific behavior. It may be an intentional
limitation of compiled binaries rather than a bug, but it contradicts the documented
behavior of `createRequire` which is supposed to resolve relative to the given path.

---

## Approach 6: Spawning bun build (Requires bun in PATH)

Since the compiled binary can't resolve external `node_modules`, the workaround is to
bundle the plugin's dependencies into a single file at load time:

```typescript
const { spawnSync } = require("child_process");
const bunBin = spawnSync("which", ["bun"]).stdout?.trim();

spawnSync(
  bunBin,
  [
    "build",
    "--bundle",
    "--target=bun",
    "--outfile",
    bundleOut,
    "--external",
    "openclaw/plugin-sdk", // Don't bundle SDK
    "--external",
    "openclaw/plugin-sdk/*",
    pluginEntryFile,
  ],
  { cwd: pluginRootDir },
); // cwd lets bun find node_modules
```

Then post-process the bundle to rewrite `openclaw/plugin-sdk` imports to absolute paths
pointing to the extracted SDK:

```typescript
bundleCode = bundleCode.replace(
  /from\s+["']openclaw\/plugin-sdk(\/[^"']+)?["']/g,
  (match, subpath) => {
    const target = subpath ? path.join(sdkDist, subpath + ".js") : path.join(sdkDist, "index.js");
    return `from "${target}"`;
  },
);
const mod = require(bundleOut); // Now loads with all deps resolved
```

**This works!** But it requires `bun` to be installed on the user's machine.

### The SDK ESM Module Type Issue

When the extracted SDK files were loaded by the bundled plugin, Bun failed with module
type errors. The fix: write a `package.json` with `{"type":"module"}` to the extracted
SDK directory, since the SDK is built as ESM format.

---

## Final Solution: Self-Spawning Bundler Mode

The compiled binary IS the Bun runtime. Instead of requiring an external `bun` binary,
the binary can spawn itself in a special "bundler mode".

### Architecture

```
Normal startup:            Bundler mode:
./openclaw gateway run     ./openclaw (with __OPENCLAW_BUNDLE_MODE=1)
       |                          |
  entry.ts preamble          entry.ts preamble
       |                          |
  [BUNDLE_MODE check]       [BUNDLE_MODE check] --> YES
       |                          |
      NO                    Bun.build({...})
       |                    writeFileSync(outfile)
  VFS setup                 process.exit(0)
  monkey-patches
  normal app startup
```

### Implementation: Entry Point Preamble

In `scripts/bun-compile/patches/vfs-overlay.ts`, the `patchEntryTs` function injects a
bundler mode check at the top of the entry point, after imports but before any VFS setup:

```typescript
// Injected at top of entry.ts (after imports, before VFS setup)
if (process.env["__OPENCLAW_BUNDLE_MODE"] === "1") {
  const entry = process.env["__OPENCLAW_BUNDLE_ENTRY"]!;
  const outfile = process.env["__OPENCLAW_BUNDLE_OUTFILE"]!;
  const cwd = process.env["__OPENCLAW_BUNDLE_CWD"]!;
  process.chdir(cwd);
  try {
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      external: ["openclaw/plugin-sdk", "openclaw/plugin-sdk/*"],
    });
    if (!result.success) {
      process.stderr.write("bun build failed: " + ...);
      process.exit(1);
    }
    const code = await result.outputs[0]!.text();
    fs.writeFileSync(outfile, code);
    process.exit(0);
  } catch (err) {
    process.stderr.write("bun build failed: " + String(err));
    process.exit(1);
  }
}
// Normal startup continues below...
```

### Implementation: Plugin Loader

In `scripts/bun-compile/patches/plugin-system.ts`, the `patchLoaderTs` function replaces
the jiti call with self-spawn bundling for external plugins:

```typescript
// Instead of: const bunBin = spawnSync("which", ["bun"]).stdout?.trim();
// Use:
const buildResult = spawnSync(process.execPath, [], {
  cwd: pluginRootDir,
  encoding: "utf-8",
  timeout: 30000,
  env: Object.assign({}, process.env, {
    ["__OPENCLAW_BUNDLE_MODE"]: "1",
    ["__OPENCLAW_BUNDLE_ENTRY"]: pluginEntryFile,
    ["__OPENCLAW_BUNDLE_OUTFILE"]: bundleOutPath,
    ["__OPENCLAW_BUNDLE_CWD"]: pluginRootDir,
  }),
});
```

### Key Technical Details

1. **Bracket notation for env vars**: `process.env["__OPENCLAW_BUNDLE_MODE"]` instead of
   `process.env.__OPENCLAW_BUNDLE_MODE`. Bun's minifier inlines `process.env.X` with the
   build-time value (undefined), dead-code-eliminating the entire check. Bracket notation
   (computed property access) prevents this optimization in current Bun versions. Note that
   this is an **implementation-dependent behavior**, not a language-level guarantee -- if
   Bun's minifier becomes more aggressive in the future (e.g. constant-folding computed
   property accesses with string literals), this workaround could break. Monitor across Bun
   upgrades.

2. **Manual file writing**: `Bun.build()` with `outfile` doesn't write files in compiled
   binaries. The workaround is to get the output text via `result.outputs[0].text()` and
   write it manually with `fs.writeFileSync()`.

3. **Top-level await**: The `await Bun.build()` call uses ESM top-level await. This works
   because `process.exit(0)` terminates the process before any subsequent code (VFS setup,
   app initialization) executes. Note that ESM imports at the top of the file are evaluated
   before the module body runs (they're hoisted per spec). In the current codebase, these
   imports are primarily module bindings without significant side effects. However, this is
   a **fragile assumption** -- if any imported module (or its transitive dependencies)
   introduces side effects (global state registration, file I/O, network requests), those
   would execute before the bundler mode check. This constraint must be monitored as the
   codebase evolves.

4. **`process.chdir(cwd)`**: Ensures `Bun.build()` resolves the plugin's `node_modules`
   from the correct directory.

---

## Bun Bundler Gotchas Reference

A collection of bugs and unexpected behaviors encountered during development:

### 1. process.env Inlining with minify

When `minify: true`, `process.env.SOME_VAR` gets replaced with the build-time value.
If the variable isn't set during build, the access becomes `undefined` and the code
may be dead-code eliminated.

**Fix**: Use `process.env["SOME_VAR"]` (bracket notation) to prevent inlining. This is
implementation-dependent -- it works because Bun's current minifier does not constant-fold
computed property accesses, but this could change in future versions.

### 2. CJS .default Interop

`import x from "node:path"` in CJS output generates `x.default.join(...)` instead of
`x.join(...)`.

**Fix**: Post-process with `/(import_node_\w+)\.default\./g` -> `$1.`.

### 3. splitting + root

Without the `root` option, `splitting: true` places entry files in subdirectories
matching the source tree. Some entries get renamed to chunk-style names.

**Fix**: Set `root: resolve("src/plugin-sdk")` to flatten entries.

### 4. Named fs Imports Bypass Monkey-Patches

`import { existsSync } from "fs"` gets scope-hoisted by the bundler into a direct binding,
eliminating the property lookup on the `fs` module object. Runtime monkey-patches on the
module object have no effect on these direct bindings.

**Fix**: Ensure code uses `fs.existsSync()` (property access on default import) not named
imports.

### 5. $bunfs outfile Doesn't Write

`Bun.build({ outfile: "/tmp/out.js" })` returns `success: true` in compiled binaries
but doesn't actually write the file.

**Fix**: Use `result.outputs[0].text()` + `fs.writeFileSync()`.

### 6. Bun.build Regex Filters Need Cross-Platform Paths

`onLoad` plugin filters like `/protobufjs\/src\//` fail on Windows.

**Fix**: Use `[/\\]` in regex patterns for path separators.

### 7. createRequire Resolution in Compiled Binaries

`createRequire(externalPath)` does not resolve from the given path in compiled binaries.
This was reproducibly verified with standalone test binaries across multiple loading methods
(see [Approach 5](#approach-5-bun-native-module-loading-and-the-createrequire-bug)). As of
Bun 1.3.x, it is unclear whether this is an intentional limitation or an unintended bug.

**Workaround**: Bundle external dependencies at load time (Approach 6 / Final Solution).

---

## Summary of Embedding Strategies

| Component           | Strategy                                      | Load Method                                    |
| ------------------- | --------------------------------------------- | ---------------------------------------------- |
| Core app            | Bun bundler (main entrypoint)                 | Direct execution                               |
| Built-in extensions | Pre-bundle (CJS) + $bunfs embed + VFS overlay | `new Function()` CJS wrapper                   |
| Plugin SDK          | Pre-bundle (ESM, splitting) + $bunfs embed    | Extract to temp dir on first use               |
| Skills              | $bunfs embed + VFS directory manifest         | Monkey-patched `readdirSync`                   |
| Templates           | $bunfs embed + VFS directory manifest         | Monkey-patched `readdirSync`                   |
| Control UI          | $bunfs embed + file map                       | Extract to temp dir, serve by original path    |
| node-pty, sharp     | Static `require()` redirect to $bunfs         | `require()` with embedded `.node`              |
| sqlite-vec          | $bunfs embed via `type: "file"`               | Extract `.dylib` to temp, `dlopen()`           |
| External plugins    | Self-spawn bundler mode at runtime            | `Bun.build()` + SDK path rewrite + `require()` |

### The Two Plugin Loading Paths

```
Built-in (embedded in $bunfs):
  VFS readFileSync -> strip CJS wrapper -> new Function() -> mod.exports

External (on disk, user-installed):
  spawnSync(process.execPath, { BUNDLE_MODE: 1 })
    -> subprocess runs Bun.build() -> writes bundle.js
  parent reads bundle.js -> rewrites SDK imports -> require() -> mod.exports
```

### File Map

```
scripts/
  build-bun-compile.ts           # Main build orchestrator
  bun-compile/
    patches/
      vfs-overlay.ts             # VFS monkey-patches + bundler mode preamble
      plugin-system.ts           # Plugin loader patches (SDK, extensions, external)
      build-info.ts              # Version, git commit, root path patches
      compat-fixes.ts            # Third-party compatibility patches
      native-embeds.ts           # node-pty, sharp, sqlite-vec embedding
    prebundle-extensions.ts      # Pre-bundles built-in extensions (CJS)
    prebundle-sdk.ts             # Pre-bundles plugin SDK (ESM, splitting)
    scan-extensions.ts           # Scans extension dirs for VFS manifest
    scan-skills.ts               # Scans skills dirs for VFS manifest
    scan-templates.ts            # Scans template dirs for VFS manifest
    externals.ts                 # External package list (not bundled)
    helpers.ts                   # Platform detection, path utilities
    sidecar.ts                   # Native library sidecar copying
    types.ts                     # Shared type definitions
    __tests__/                   # Test suite (83 tests)
```
