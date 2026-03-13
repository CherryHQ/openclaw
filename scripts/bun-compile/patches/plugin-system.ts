/**
 * Plugin-system patchers for Bun compiled binary.
 *
 * patchLoaderTs: patches loader.ts with SDK embedding, native require() for external plugins (no jiti)
 * patchManifestTs: patches manifest.ts with VFS bypass for openBoundaryFileSync
 * patchDiscoveryTs: patches discovery.ts with VFS bypass for package resolution
 */
import type { PatchContext } from "../types.js";

// --- Preamble code blocks (injected at top of loader.ts) ---

function buildSdkPreamble(
  ctx: Pick<PatchContext, "sdkImportLines" | "sdkMapExpr">,
): string {
  return [
    `import __sdkOs from "node:os";`,
    `import { createRequire as __bunCreateRequire } from "node:module";`,
    // Error.captureStackTrace patch for Bun/JSC compatibility
    `{`,
    `  const __origCST = Error.captureStackTrace;`,
    `  if (__origCST) {`,
    `    Error.captureStackTrace = function(t: any, c?: Function) {`,
    `      try { return __origCST.call(Error, t, c); }`,
    `      catch { if (t && typeof t === "object") t.stack = new Error().stack; }`,
    `    };`,
    `  }`,
    `}`,
    // SDK extraction
    ...ctx.sdkImportLines,
    `const __sdkBunfsMap: Record<string, string> = ${ctx.sdkMapExpr};`,
    `let __sdkCacheDir: string | null = null;`,
    `function __extractPluginSdk(): string | null {`,
    `  if (__sdkCacheDir) return __sdkCacheDir;`,
    `  if (Object.keys(__sdkBunfsMap).length === 0) return null;`,
    `  const dir = path.join(__sdkOs.tmpdir(), "openclaw-plugin-sdk-" + process.pid);`,
    `  const sdkDir = path.join(dir, "dist", "plugin-sdk");`,
    `  try {`,
    `    fs.mkdirSync(sdkDir, { recursive: true });`,
    `    for (const [name, src] of Object.entries(__sdkBunfsMap)) {`,
    `      fs.writeFileSync(path.join(sdkDir, name), fs.readFileSync(src));`,
    `    }`,
    `    // SDK was built with format: "esm", so Bun needs package.json to know module type`,
    `    fs.writeFileSync(path.join(sdkDir, "package.json"), '{"type":"module"}');`,
    `    __sdkCacheDir = dir;`,
    `    process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });`,
    `  } catch {}`,
    `  return __sdkCacheDir;`,
    `}`,
    // Build SDK alias map for rewriting imports in external plugin source files.
    // This replaces jiti's alias functionality: before loading an external plugin,
    // we replace "openclaw/plugin-sdk" import specifiers with absolute paths to
    // the extracted SDK files. Stored on globalThis for access from loader.ts.
    `{`,
    `  const __sdkRootDir = __extractPluginSdk();`,
    `  if (__sdkRootDir) {`,
    `    const __sdkDist = path.join(__sdkRootDir, "dist", "plugin-sdk");`,
    `    (globalThis as any).__openclawSdkDist = __sdkDist;`,
    `  }`,
    `}`,
  ].join("\n");
}

// --- Main patchers ---

export function patchLoaderTs(
  source: string,
  ctx: Pick<PatchContext, "sdkImportLines" | "sdkMapExpr" | "sdkFiles">,
): string {
  const preamble = buildSdkPreamble(ctx);

  const patched = source
    // 1. Replace modulePath default from fileURLToPath to process.execPath (both occurrences)
    .replace(
      /fileURLToPath\(import\.meta\.url\)/g,
      `process.execPath`,
    )
    // 2. Add extracted plugin-sdk dir as first search candidate before cursor walk
    .replace(
      /let cursor = path\.dirname\(params\.modulePath\);/,
      [
        `const __sdkRoot = __extractPluginSdk();`,
        `    if (__sdkRoot) {`,
        `      const __sdkDist = path.join(__sdkRoot, "dist", "plugin-sdk", params.distFile);`,
        `      if (fs.existsSync(__sdkDist)) return __sdkDist;`,
        `    }`,
        `    let cursor = path.dirname(params.modulePath);`,
      ].join("\n"),
    )
    // 3. For embedded extensions ($bunfs VFS paths), bypass openBoundaryFileSync
    // Match the block from pluginRoot through fs.closeSync(opened.fd), tolerating
    // any intermediate variable declarations (e.g. loadSource added upstream).
    .replace(
      /const pluginRoot = safeRealpathOrResolve\(candidate\.rootDir\);[\s\S]*?const opened = openBoundaryFileSync\(\{[\s\S]*?\}\);\s*\n\s*if \(!opened\.ok\) \{\s*\n\s*pushPluginLoadError\([^)]+\);\s*\n\s*continue;\s*\n\s*\}\s*\n\s*const safeSource = opened\.path;\s*\n\s*fs\.closeSync\(opened\.fd\);/,
      (match) => {
        // Extract the block between pluginRoot and `const opened =` to preserve
        // any intermediate statements (e.g. loadSource) added by upstream.
        const openedIdx = match.indexOf("const opened = openBoundaryFileSync");
        const afterPluginRoot = match.indexOf("\n", "const pluginRoot = safeRealpathOrResolve(candidate.rootDir);".length);
        const intermediateBlock = match.slice(afterPluginRoot, openedIdx).trim();
        // Detect what variable the openBoundaryFileSync uses for absolutePath
        const absPathMatch = match.match(/absolutePath:\s*(\S+),/);
        const absPathVar = absPathMatch?.[1] ?? "candidate.source";
        return [
          `const pluginRoot = safeRealpathOrResolve(candidate.rootDir);`,
          ...(intermediateBlock ? [`    ${intermediateBlock}`] : []),
          `    let safeSource: string;`,
          `    if (candidate.origin === "bundled") {`,
          `      safeSource = candidate.source;`,
          `    } else {`,
          `      const opened = openBoundaryFileSync({`,
          `        absolutePath: ${absPathVar},`,
          `        rootPath: pluginRoot,`,
          `        boundaryLabel: "plugin root",`,
          `        rejectHardlinks: candidate.origin !== "bundled",`,
          `        skipLexicalRootCheck: true,`,
          `      });`,
          `      if (!opened.ok) {`,
          `        pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");`,
          `        continue;`,
          `      }`,
          `      safeSource = opened.path;`,
          `      fs.closeSync(opened.fd);`,
          `    }`,
        ].join("\n");
      },
    )
    // 4. Replace jiti with native loading for all plugin paths.
    //    - $bunfs/VFS extensions: read source via VFS, evaluate with new Function() CJS wrapper
    //      (preserves require resolution from binary context, not temp dir)
    //    - External extensions: use Bun's native require() directly (handles TS/ESM/CJS)
    //    No jiti needed in compiled binary — Bun runtime handles everything natively.
    .replace(
      /mod = getJiti\(\)\(safeSource\) as OpenClawPluginModule;/,
      [
        `if (safeSource.includes("$bunfs") || safeSource.includes("__extensions__")) {`,
        `        const __vfsR = (globalThis as any).__vfsResolve as ((p: string) => string | null) | undefined;`,
        `        const __realPath = __vfsR?.(safeSource) ?? safeSource;`,
        `        let __code = fs.readFileSync(__realPath, "utf-8");`,
        `        // Bun CJS output wraps code in (function(exports,require,module,__filename,__dirname){...})`,
        `        // Strip the wrapper so new Function() can execute the inner code directly.`,
        `        const __bunCjsMatch = __code.match(/^[\\s\\S]*?\\(function\\s*\\(exports,\\s*require,\\s*module,\\s*__filename,\\s*__dirname\\)\\s*\\{/);`,
        `        if (__bunCjsMatch) {`,
        `          __code = __code.slice(__bunCjsMatch[0].length);`,
        `          const __lastParen = __code.lastIndexOf("})");`,
        `          if (__lastParen !== -1) __code = __code.slice(0, __lastParen);`,
        `        }`,
        `        const __cjsModule = { exports: {} as any };`,
        `        const __baseRequire = __bunCreateRequire(import.meta.url);`,
        `        const __sdkDistDir = (globalThis as any).__openclawSdkDist as string | undefined;`,
        `        // Proxy require: redirect openclaw/plugin-sdk/* to extracted SDK dir`,
        `        const __cjsRequire = __sdkDistDir ? Object.assign(function __proxyRequire(id: string) {`,
        `          if (id === "openclaw/plugin-sdk" || id.startsWith("openclaw/plugin-sdk/")) {`,
        `            const sub = id === "openclaw/plugin-sdk" ? "index.js" : id.slice("openclaw/plugin-sdk/".length) + ".js";`,
        `            return __baseRequire(path.join(__sdkDistDir, sub));`,
        `          }`,
        `          return __baseRequire(id);`,
        `        }, { resolve: __baseRequire.resolve }) : __baseRequire;`,
        `        const __cjsFn = new Function("module", "exports", "require", "__filename", "__dirname", __code);`,
        `        __cjsFn(__cjsModule, __cjsModule.exports, __cjsRequire, __realPath, path.dirname(__realPath));`,
        `        mod = __cjsModule.exports as OpenClawPluginModule;`,
        `      } else {`,
        `        // External plugins: Bun compiled binary cannot resolve node_modules from`,
        `        // external file paths (confirmed bug). Workaround: spawn ourselves in`,
        `        // __OPENCLAW_BUNDLE_MODE to run Bun.build() and bundle all npm deps into`,
        `        // a single file, then post-process to rewrite openclaw/plugin-sdk paths.`,
        `        const __sdkDist = (globalThis as any).__openclawSdkDist as string | undefined;`,
        `        const __pluginRoot = candidate.rootDir;`,
        `        const __tmpDir = path.join(__sdkOs.tmpdir(), "openclaw-ext-" + pluginId + "-" + process.pid);`,
        `        try {`,
        `          fs.mkdirSync(__tmpDir, { recursive: true });`,
        `          const __bundleOut = path.join(__tmpDir, "bundle.js");`,
        `          // Spawn ourselves in bundler mode — the compiled binary IS bun`,
        `          const { spawnSync: __spawnSync } = require("node:child_process") as typeof import("node:child_process");`,
        `          const __buildResult = __spawnSync(process.execPath, [], {`,
        `            cwd: __pluginRoot,`,
        `            encoding: "utf-8",`,
        `            timeout: 30000,`,
        `            env: Object.assign({}, process.env, {`,
        `              ["__OPENCLAW_BUNDLE_MODE"]: "1",`,
        `              ["__OPENCLAW_BUNDLE_ENTRY"]: safeSource,`,
        `              ["__OPENCLAW_BUNDLE_OUTFILE"]: __bundleOut,`,
        `              ["__OPENCLAW_BUNDLE_CWD"]: __pluginRoot,`,
        `            }),`,
        `          });`,
        `          if (__buildResult.status !== 0) throw new Error("bun build failed: " + (__buildResult.stderr || "unknown error").slice(0, 500));`,
        `          // Post-process: rewrite openclaw/plugin-sdk imports to absolute SDK paths`,
        `          let __bundleCode = fs.readFileSync(__bundleOut, "utf-8");`,
        `          if (__sdkDist) {`,
        `            __bundleCode = __bundleCode.replace(`,
        `              /(?:from\\s+|require\\s*\\(\\s*|import\\s*\\(\\s*)(["'])openclaw\\/plugin-sdk(?:\\/([^"']+))?\\1/g,`,
        `              (m: string, q: string, subpath: string | undefined) => {`,
        `                const target = subpath ? path.join(__sdkDist, subpath + ".js") : path.join(__sdkDist, "index.js");`,
        `                const prefix = m.startsWith("from") ? "from " : m.startsWith("require") ? "require(" : "import(";`,
        `                return prefix + q + target + q;`,
        `              },`,
        `            );`,
        `          }`,
        `          fs.writeFileSync(__bundleOut, __bundleCode);`,
        `          mod = require(__bundleOut) as OpenClawPluginModule;`,
        `          process.on("exit", () => { try { fs.rmSync(__tmpDir, { recursive: true, force: true }); } catch {} });`,
        `        } catch (__extErr) {`,
        `          try { fs.rmSync(__tmpDir, { recursive: true, force: true }); } catch {}`,
        `          throw __extErr;`,
        `        }`,
        `      }`,
      ].join("\n"),
    );

  return preamble + "\n" + patched;
}

export function patchManifestTs(source: string): string {
  return source.replace(
    /export function loadPluginManifest\(\n\s*rootDir: string,\n\s*rejectHardlinks = true,\n\): PluginManifestLoadResult \{\n\s*const manifestPath = resolvePluginManifestPath\(rootDir\);/,
    [
      `export function loadPluginManifest(`,
      `  rootDir: string,`,
      `  rejectHardlinks = true,`,
      `): PluginManifestLoadResult {`,
      `  const __vfsResolve = (globalThis as any).__vfsResolve as ((p: string) => string | null) | undefined;`,
      `  const manifestPath = resolvePluginManifestPath(rootDir);`,
      `  if (process.env.OPENCLAW_VFS_DEBUG) console.error("[VFS:loadPluginManifest]", { rootDir, manifestPath, hasVfsResolve: !!__vfsResolve, resolved: __vfsResolve?.(manifestPath) ?? "N/A" });`,
      `  if (__vfsResolve?.(manifestPath)) {`,
      `    if (process.env.OPENCLAW_VFS_DEBUG) console.error("[VFS:loadPluginManifest:BYPASS]", manifestPath);`,
      `    try {`,
      `      const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;`,
      `      if (!isRecord(raw)) return { ok: false, error: "plugin manifest must be an object", manifestPath };`,
      `      const id = typeof raw.id === "string" ? raw.id.trim() : "";`,
      `      if (!id) return { ok: false, error: "plugin manifest requires id", manifestPath };`,
      `      const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null;`,
      `      if (!configSchema) return { ok: false, error: "plugin manifest requires configSchema", manifestPath };`,
      `      return {`,
      `        ok: true,`,
      `        manifest: {`,
      `          id,`,
      `          configSchema,`,
      `          kind: typeof raw.kind === "string" ? (raw.kind as any) : undefined,`,
      `          channels: Array.isArray(raw.channels) ? raw.channels.filter((s: any) => typeof s === "string") : [],`,
      `          providers: Array.isArray(raw.providers) ? raw.providers.filter((s: any) => typeof s === "string") : [],`,
      `          providerAuthEnvVars: isRecord(raw.providerAuthEnvVars) ? raw.providerAuthEnvVars as any : undefined,`,
      `          providerAuthChoices: Array.isArray(raw.providerAuthChoices) ? raw.providerAuthChoices as any : undefined,`,
      `          skills: Array.isArray(raw.skills) ? raw.skills.filter((s: any) => typeof s === "string") : [],`,
      `          name: typeof raw.name === "string" ? raw.name.trim() : undefined,`,
      `          description: typeof raw.description === "string" ? raw.description.trim() : undefined,`,
      `          version: typeof raw.version === "string" ? raw.version.trim() : undefined,`,
      `          uiHints: isRecord(raw.uiHints) ? raw.uiHints as any : undefined,`,
      `        },`,
      `        manifestPath,`,
      `      };`,
      `    } catch (err) {`,
      `      if (process.env.OPENCLAW_VFS_DEBUG) console.error("[VFS:loadPluginManifest:ERROR]", manifestPath, String(err));`,
      `      return { ok: false, error: "failed to parse plugin manifest: " + String(err), manifestPath };`,
      `    }`,
      `  }`,
      `  if (process.env.OPENCLAW_VFS_DEBUG) console.error("[VFS:loadPluginManifest:FALLTHROUGH]", rootDir, new Error().stack?.split("\\n").slice(0,5).join("\\n"));`,
    ].join("\n"),
  );
}

export function patchDiscoveryTs(source: string): string {
  return source
    .replace(
      /function readPackageManifest\(dir: string, rejectHardlinks = true\): PackageManifest \| null \{/,
      [
        `function readPackageManifest(dir: string, rejectHardlinks = true): PackageManifest | null {`,
        `  const __vfsResolve = (globalThis as any).__vfsResolve as ((p: string) => string | null) | undefined;`,
        `  const __vfsPkgPath = path.join(dir, "package.json");`,
        `  if (__vfsResolve?.(__vfsPkgPath)) {`,
        `    try { return JSON.parse(fs.readFileSync(__vfsPkgPath, "utf-8")) as PackageManifest; }`,
        `    catch { return null; }`,
        `  }`,
      ].join("\n"),
    )
    .replace(
      /const source = path\.resolve\(params\.packageDir, params\.entryPath\);\n\s*const opened = openBoundaryFileSync\(\{/,
      [
        `const source = path.resolve(params.packageDir, params.entryPath);`,
        `  const __vfsR2 = (globalThis as any).__vfsResolve as ((p: string) => string | null) | undefined;`,
        `  if (__vfsR2?.(source)) return source;`,
        `  const opened = openBoundaryFileSync({`,
      ].join("\n"),
    );
}
