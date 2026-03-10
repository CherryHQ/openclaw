/**
 * Plugin-system patchers for Bun compiled binary.
 *
 * patchLoaderTs: patches loader.ts with SDK embedding, custom createRequire, jiti config
 * patchManifestTs: patches manifest.ts with VFS bypass for openBoundaryFileSync
 * patchDiscoveryTs: patches discovery.ts with VFS bypass for package resolution
 */
import type { PatchContext } from "../types.js";

// --- Preamble code blocks (injected at top of loader.ts) ---

function buildSdkPreamble(
  ctx: Pick<PatchContext, "sdkImportLines" | "sdkMapExpr" | "jitiBabelCjs">,
): string {
  return [
    `import __sdkOs from "node:os";`,
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
    // Embed jiti babel.cjs
    `import __jitiBabelBunfs from ${JSON.stringify(ctx.jitiBabelCjs)} with { type: "file" };`,
    `let __jitiBabelPath: string | null = null;`,
    `function __extractJitiBabel(): string {`,
    `  if (__jitiBabelPath) return __jitiBabelPath;`,
    `  const tmpDir = path.join(__sdkOs.tmpdir(), "openclaw-jiti-" + process.pid);`,
    `  fs.mkdirSync(tmpDir, { recursive: true });`,
    `  const dest = path.join(tmpDir, "babel.cjs");`,
    `  fs.writeFileSync(dest, fs.readFileSync(__jitiBabelBunfs));`,
    `  __jitiBabelPath = dest;`,
    `  process.on("exit", () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });`,
    `  return dest;`,
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
    `    __sdkCacheDir = dir;`,
    `    process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });`,
    `  } catch {}`,
    `  return __sdkCacheDir;`,
    `}`,
  ].join("\n");
}

// --- Custom createRequire + jiti config code block ---

function buildCreateRequireBlock(): string {
  return [
    `// --- Bun compile: custom module resolution for external plugins ---`,
    `    const __Module = require("module") as any;`,
    `    const __origCreateRequire = __Module.createRequire;`,
    `    __Module.createRequire = function __bunCreateRequire(filepath: string) {`,
    `      const __dir = path.dirname(filepath);`,
    `      const __realRequire = typeof require === "function" ? require : __origCreateRequire(filepath);`,
    `      const __builtins: Set<string> = new Set(__Module.builtinModules ?? []);`,
    `      function __resolvePackage(dir: string, spec: string): string | null {`,
    `        const parts = spec.split("/");`,
    `        const pkgName = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;`,
    `        const subpath = spec.startsWith("@") ? parts.slice(2).join("/") : parts.slice(1).join("/");`,
    `        let cursor = dir;`,
    `        for (let i = 0; i < 64; i++) {`,
    `          const pkgDir = path.join(cursor, "node_modules", pkgName);`,
    `          if (fs.existsSync(pkgDir)) {`,
    `            if (subpath) {`,
    `              for (const ext of ["", ".js", ".cjs", ".json", "/index.js", "/index.cjs"]) {`,
    `                const c = path.join(pkgDir, subpath + ext);`,
    `                if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;`,
    `              }`,
    `            }`,
    `            const pjPath = path.join(pkgDir, "package.json");`,
    `            if (fs.existsSync(pjPath)) {`,
    `              const pj = JSON.parse(fs.readFileSync(pjPath, "utf-8"));`,
    `              if (subpath && pj.exports) {`,
    `                const ek = "./" + subpath;`,
    `                const ev = pj.exports[ek];`,
    `                if (typeof ev === "string") return path.join(pkgDir, ev);`,
    `                if (ev?.require) return path.join(pkgDir, typeof ev.require === "string" ? ev.require : ev.require.default);`,
    `                if (ev?.default) return path.join(pkgDir, ev.default);`,
    `              }`,
    `              if (!subpath) {`,
    `                const dot = pj.exports?.["."];`,
    `                if (dot) {`,
    `                  const m = typeof dot === "string" ? dot`,
    `                    : dot.require ? (typeof dot.require === "string" ? dot.require : dot.require.default)`,
    `                    : dot.default ?? dot.node ?? null;`,
    `                  if (m) return path.join(pkgDir, m);`,
    `                }`,
    `                if (pj.main) return path.join(pkgDir, pj.main);`,
    `                return path.join(pkgDir, "index.js");`,
    `              }`,
    `            }`,
    `            if (!subpath) return path.join(pkgDir, "index.js");`,
    `          }`,
    `          const parent = path.dirname(cursor);`,
    `          if (parent === cursor) break;`,
    `          cursor = parent;`,
    `        }`,
    `        return null;`,
    `      }`,
    `      function __resolveFile(dir: string, rel: string): string | null {`,
    `        for (const ext of ["", ".ts", ".tsx", ".js", ".cjs", ".mjs", ".json", "/index.ts", "/index.js"]) {`,
    `          const abs = path.resolve(dir, rel + ext);`,
    `          if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;`,
    `        }`,
    `        return null;`,
    `      }`,
    `      const customRequire: any = (id: string) => __realRequire(customRequire.resolve(id));`,
    `      customRequire.resolve = (id: string) => {`,
    `        if (path.isAbsolute(id)) return id;`,
    `        if (id.startsWith(".")) {`,
    `          const r = __resolveFile(__dir, id);`,
    `          if (r) return r;`,
    `          throw new Error("Cannot find module '" + id + "' from '" + filepath + "'");`,
    `        }`,
    `        if (id.startsWith("node:") || __builtins.has(id) || id === "module") return id;`,
    `        const r = __resolvePackage(__dir, id);`,
    `        if (r) return r;`,
    `        throw new Error("Cannot find module '" + id + "' from '" + filepath + "'");`,
    `      };`,
    `      customRequire.cache = {};`,
    `      customRequire.extensions = {};`,
    `      return customRequire;`,
    `    };`,
  ].join("\n");
}

function buildJitiTransformBlock(): string {
  return [
    `      transform(opts: any) {`,
    `        const fn = opts.filename ?? "";`,
    `        if (fn.includes("node_modules") && (fn.endsWith(".cjs") || fn.endsWith(".js"))) {`,
    `          return { code: opts.source };`,
    `        }`,
    `        const babelTransform = require(__extractJitiBabel());`,
    `        return babelTransform(opts);`,
    `      },`,
  ].join("\n");
}

// --- Main patchers ---

export function patchLoaderTs(
  source: string,
  ctx: Pick<PatchContext, "sdkImportLines" | "sdkMapExpr" | "jitiBabelCjs" | "sdkFiles">,
): string {
  const preamble = buildSdkPreamble(ctx);

  const patched = source
    // 1. Replace modulePath default from fileURLToPath to process.execPath
    .replace(
      /const\s+modulePath\s*=\s*params\.modulePath\s*\?\?\s*fileURLToPath\(import\.meta\.url\);/,
      `const modulePath = params.modulePath ?? process.execPath;`,
    )
    // 2. Add extracted plugin-sdk dir as first search candidate before cursor walk
    .replace(
      /let cursor = path\.dirname\(modulePath\);/,
      [
        `const __sdkRoot = __extractPluginSdk();`,
        `    if (__sdkRoot) {`,
        `      const __sdkDist = path.join(__sdkRoot, "dist", "plugin-sdk", params.distFile);`,
        `      if (fs.existsSync(__sdkDist)) return __sdkDist;`,
        `    }`,
        `    let cursor = path.dirname(modulePath);`,
      ].join("\n"),
    )
    // 3. For embedded extensions ($bunfs VFS paths), bypass openBoundaryFileSync
    .replace(
      /const pluginRoot = safeRealpathOrResolve\(candidate\.rootDir\);\s*\n\s*const opened = openBoundaryFileSync\(\{[\s\S]*?\}\);\s*\n\s*if \(!opened\.ok\) \{\s*\n\s*pushPluginLoadError\([^)]+\);\s*\n\s*continue;\s*\n\s*\}\s*\n\s*const safeSource = opened\.path;\s*\n\s*fs\.closeSync\(opened\.fd\);/,
      [
        `const pluginRoot = safeRealpathOrResolve(candidate.rootDir);`,
        `    let safeSource: string;`,
        `    if (candidate.rootDir.includes("$bunfs") || candidate.source.includes("$bunfs")) {`,
        `      safeSource = candidate.source;`,
        `    } else {`,
        `      const opened = openBoundaryFileSync({`,
        `        absolutePath: candidate.source,`,
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
      ].join("\n"),
    )
    // 4. Inject custom createRequire monkey-patch before jiti init
    .replace(
      /jitiLoader = createJiti\(import\.meta\.url, \{/,
      [
        buildCreateRequireBlock(),
        `    jitiLoader = createJiti(import.meta.url, {`,
        `      tryNative: false,`,
        `      fsCache: false,`,
      ].join("\n"),
    )
    // 5. Add custom transform to jiti options
    .replace(
      /interopDefault: true,\s*\n\s*extensions:/,
      [
        `interopDefault: true,`,
        buildJitiTransformBlock(),
        `      extensions:`,
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
      `  if (__vfsResolve?.(manifestPath)) {`,
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
      `          skills: Array.isArray(raw.skills) ? raw.skills.filter((s: any) => typeof s === "string") : [],`,
      `          name: typeof raw.name === "string" ? raw.name.trim() : undefined,`,
      `          description: typeof raw.description === "string" ? raw.description.trim() : undefined,`,
      `          version: typeof raw.version === "string" ? raw.version.trim() : undefined,`,
      `          uiHints: isRecord(raw.uiHints) ? raw.uiHints as any : undefined,`,
      `        },`,
      `        manifestPath,`,
      `      };`,
      `    } catch (err) {`,
      `      return { ok: false, error: "failed to parse plugin manifest: " + String(err), manifestPath };`,
      `    }`,
      `  }`,
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
