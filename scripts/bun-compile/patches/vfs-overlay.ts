/**
 * VFS overlay patcher for Bun compiled binary.
 *
 * patchEntryTs: generates a VFS preamble with monkey-patched fs methods
 *   to serve embedded skills/extensions from virtual directory trees.
 * patchControlUiAssets: injects extraction logic for embedded control-ui assets.
 */
import type { PatchContext } from "../types.js";

// Build the complete VFS preamble for entry.ts
export function patchEntryTs(
  source: string,
  ctx: Pick<PatchContext, "pkgJson" | "embeddedSkills" | "embeddedExtensions">,
  vecFile: string | null,
): string {
  // Strip shebang
  let src = source;
  if (src.startsWith("#!")) {
    src = src.slice(src.indexOf("\n") + 1);
  }

  const { embeddedSkills, embeddedExtensions } = ctx;
  const hasSkills = embeddedSkills.files.length > 0;
  const hasExtensions = embeddedExtensions.files.length > 0;

  // Generate import lines
  const skillImportLines = hasSkills
    ? embeddedSkills.files.map(
        (f, i) => `import __ski${i} from ${JSON.stringify(f.absPath)} with { type: "file" };`,
      )
    : [];
  const extImportLines = hasExtensions
    ? embeddedExtensions.files.map(
        (f, i) => `import __ext${i} from ${JSON.stringify(f.absPath)} with { type: "file" };`,
      )
    : [];
  const skillFileMapAssignments = hasSkills
    ? embeddedSkills.files.map(
        (f, i) => `  __skiFileMap[${JSON.stringify(f.relPath)}] = __ski${i};`,
      )
    : [];
  const extFileMapAssignments = hasExtensions
    ? embeddedExtensions.files.map(
        (f, i) => `  __extFileMap[${JSON.stringify(f.relPath)}] = __ext${i};`,
      )
    : [];

  const vec0ImportLine = vecFile
    ? `import __vec0Path from ${JSON.stringify(vecFile)} with { type: "file" };`
    : null;

  const lines: string[] = [
    ...skillImportLines,
    ...extImportLines,
    ...(vec0ImportLine ? [vec0ImportLine] : []),
    `import __shimFs from "node:fs";`,
    `import __shimPath from "node:path";`,
    ``,
    `{`,
    `  const __pkgDir = __shimPath.dirname(process.execPath);`,
    `  const __pkgPath = __shimPath.join(__pkgDir, "package.json");`,
    `  if (!__shimFs.existsSync(__pkgPath)) {`,
    `    try { __shimFs.writeFileSync(__pkgPath, ${JSON.stringify(JSON.stringify({ name: ctx.pkgJson.name, version: ctx.pkgJson.version }) + "\n")}); }`,
    `    catch {}`,
    `  }`,
    `}`,
    ``,
  ];

  // --- VFS registries ---
  interface VfsEntry {
    tag: string;
    envVar: string;
    fileMapVar: string;
    dirManifestVar: string;
    manifest: Record<string, { files: string[]; dirs: string[] }>;
    fileMapAssignments: string[];
    anchorImport: string;
  }

  const vfsEntries: VfsEntry[] = [];
  if (hasSkills) {
    vfsEntries.push({
      tag: "__skills__",
      envVar: "OPENCLAW_BUNDLED_SKILLS_DIR",
      fileMapVar: "__skiFileMap",
      dirManifestVar: "__skiDirManifest",
      manifest: embeddedSkills.manifest,
      fileMapAssignments: skillFileMapAssignments,
      anchorImport: "__ski0",
    });
  }
  if (hasExtensions) {
    vfsEntries.push({
      tag: "__extensions__",
      envVar: "OPENCLAW_BUNDLED_PLUGINS_DIR",
      fileMapVar: "__extFileMap",
      dirManifestVar: "__extDirManifest",
      manifest: embeddedExtensions.manifest,
      fileMapAssignments: extFileMapAssignments,
      anchorImport: "__ext0",
    });
  }

  if (vfsEntries.length === 0) {
    return lines.join("\n") + "\n" + src;
  }

  // Derive $bunfs prefix from first available anchor
  const firstAnchor = vfsEntries[0]!.anchorImport;
  lines.push(
    `const __bunfsPrefix = ${firstAnchor}.slice(0, ${firstAnchor}.lastIndexOf(${firstAnchor}.includes("\\\\") ? "\\\\" : "/"));`,
    `const __vfsSep = ${firstAnchor}.includes("\\\\") ? "\\\\" : "/";`,
    ``,
    `const __vfsRoots: Array<{ vroot: string; fileMap: Record<string, string>; dirManifest: Record<string, { files: string[]; dirs: string[] }> }> = [];`,
    ``,
  );

  for (const entry of vfsEntries) {
    const cleanTag = entry.tag.replace(/__/g, "");
    lines.push(
      `const ${entry.fileMapVar}: Record<string, string> = Object.create(null);`,
      ...entry.fileMapAssignments,
      `const ${entry.dirManifestVar}: Record<string, { files: string[]; dirs: string[] }> = ${JSON.stringify(entry.manifest)};`,
      `const __vroot_${cleanTag} = __bunfsPrefix + __vfsSep + ${JSON.stringify(entry.tag)};`,
      `process.env.${entry.envVar} = __vroot_${cleanTag};`,
      `__vfsRoots.push({ vroot: __vroot_${cleanTag}, fileMap: ${entry.fileMapVar}, dirManifest: ${entry.dirManifestVar} });`,
      ``,
    );
  }

  // VFS lookup + all fs monkey-patches
  lines.push(...buildVfsMonkeyPatches());

  if (vec0ImportLine) {
    lines.push(
      `(globalThis as any).__vec0BunfsPath = __vec0Path;`,
      ``,
    );
  }

  return lines.join("\n") + "\n" + src;
}

function buildVfsMonkeyPatches(): string[] {
  return [
    `function __vfsLookup(p: string): { rel: string; fileMap: Record<string, string>; dirManifest: Record<string, { files: string[]; dirs: string[] }> } | null {`,
    `  for (const r of __vfsRoots) {`,
    `    if (!p.startsWith(r.vroot)) continue;`,
    `    if (p === r.vroot) return { rel: "", fileMap: r.fileMap, dirManifest: r.dirManifest };`,
    `    const after = p.slice(r.vroot.length);`,
    `    if (after[0] !== "/" && after[0] !== "\\\\") continue;`,
    `    return { rel: after.slice(1).replace(/\\\\\\\\/g, "/"), fileMap: r.fileMap, dirManifest: r.dirManifest };`,
    `  }`,
    `  return null;`,
    `}`,
    ``,
    `const __origReaddirSync = __shimFs.readdirSync;`,
    `(__shimFs as any).readdirSync = function(p: any, options?: any): any {`,
    `  if (typeof p === "string") {`,
    `    const hit = __vfsLookup(p);`,
    `    if (hit) {`,
    `      const entry = hit.dirManifest[hit.rel];`,
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
    `const __origReadFileSync = __shimFs.readFileSync;`,
    `(__shimFs as any).readFileSync = function(p: any, options?: any): any {`,
    `  if (typeof p === "string") {`,
    `    const hit = __vfsLookup(p);`,
    `    if (hit && hit.rel in hit.fileMap) {`,
    `      return __origReadFileSync.call(__shimFs, hit.fileMap[hit.rel]!, options);`,
    `    }`,
    `  }`,
    `  return __origReadFileSync.call(__shimFs, p, options);`,
    `};`,
    ``,
    `function __vfsMakeFakeStat(isDir: boolean, size: number) {`,
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
    `    const hit = __vfsLookup(p);`,
    `    if (hit) {`,
    `      if (hit.rel in hit.dirManifest) return __vfsMakeFakeStat(true, 0);`,
    `      if (hit.rel in hit.fileMap) {`,
    `        try { return __origStatSync.call(__shimFs, hit.fileMap[hit.rel]!, options); }`,
    `        catch { return __vfsMakeFakeStat(false, 1024); }`,
    `      }`,
    `      if (options?.throwIfNoEntry === false) return undefined;`,
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
    `    const hit = __vfsLookup(p);`,
    `    if (hit) {`,
    `      if (hit.rel in hit.dirManifest) return __vfsMakeFakeStat(true, 0);`,
    `      if (hit.rel in hit.fileMap) {`,
    `        try { return __origLstatSync.call(__shimFs, hit.fileMap[hit.rel]!, options); }`,
    `        catch { return __vfsMakeFakeStat(false, 1024); }`,
    `      }`,
    `      if (options?.throwIfNoEntry === false) return undefined;`,
    `      const err = new Error("ENOENT: no such file, lstat '" + p + "'") as any;`,
    `      err.code = "ENOENT"; err.errno = -2; err.syscall = "lstat"; err.path = p;`,
    `      throw err;`,
    `    }`,
    `  }`,
    `  return __origLstatSync.call(__shimFs, p, options);`,
    `};`,
    ``,
    `const __origExistsSync = __shimFs.existsSync;`,
    `(__shimFs as any).existsSync = function(p: any): boolean {`,
    `  if (typeof p === "string") {`,
    `    const hit = __vfsLookup(p);`,
    `    if (hit) {`,
    `      const exists = hit.rel in hit.dirManifest || hit.rel in hit.fileMap;`,
    `      if (process.env.OPENCLAW_VFS_DEBUG) console.error("[VFS:existsSync]", p, "→", exists, "(rel:", hit.rel + ")");`,
    `      return exists;`,
    `    }`,
    `  }`,
    `  return __origExistsSync.call(__shimFs, p);`,
    `};`,
    ``,
    `const __origRealpathSync = __shimFs.realpathSync;`,
    `(__shimFs as any).realpathSync = function(p: any, options?: any): any {`,
    `  if (typeof p === "string") {`,
    `    const hit = __vfsLookup(p);`,
    `    if (hit && (hit.rel in hit.dirManifest || hit.rel in hit.fileMap)) {`,
    `      return p;`,
    `    }`,
    `  }`,
    `  return __origRealpathSync.call(__shimFs, p, options);`,
    `};`,
    ``,
    `(globalThis as any).__vfsResolve = function(p: string): string | null {`,
    `  const hit = __vfsLookup(p);`,
    `  if (hit && hit.rel in hit.fileMap) return hit.fileMap[hit.rel]!;`,
    `  return null;`,
    `};`,
    ``,
    `const __origOpenSync = __shimFs.openSync;`,
    `const __vfsFdMap = new Map<number, string>();`,
    `(__shimFs as any).openSync = function(p: any, flags?: any, mode?: any): any {`,
    `  if (typeof p === "string") {`,
    `    const hit = __vfsLookup(p);`,
    `    if (hit && hit.rel in hit.fileMap) {`,
    `      const __realBunfsPath = hit.fileMap[hit.rel]!;`,
    `      const content = __origReadFileSync.call(__shimFs, __realBunfsPath);`,
    `      const tmpPath = require("node:os").tmpdir() + "/__vfs_" + Math.random().toString(36).slice(2) + ".tmp";`,
    `      __shimFs.writeFileSync(tmpPath, content);`,
    `      const fd = __origOpenSync.call(__shimFs, tmpPath, flags ?? 0, mode);`,
    `      __vfsFdMap.set(fd, tmpPath);`,
    `      return fd;`,
    `    }`,
    `  }`,
    `  return __origOpenSync.call(__shimFs, p, flags, mode);`,
    `};`,
    `const __origCloseSync = __shimFs.closeSync;`,
    `(__shimFs as any).closeSync = function(fd: any): void {`,
    `  __origCloseSync.call(__shimFs, fd);`,
    `  const tmpPath = __vfsFdMap.get(fd);`,
    `  if (tmpPath) {`,
    `    __vfsFdMap.delete(fd);`,
    `    try { __shimFs.unlinkSync(tmpPath); } catch {}`,
    `  }`,
    `};`,
    ``,
  ];
}

// Control-UI assets patcher (for control-ui-assets.ts)
export function patchControlUiAssets(
  source: string,
  controlUiFiles: Array<{ absPath: string; relPath: string }>,
): string {
  const cuiImportLines = controlUiFiles.map(
    (f, i) => `import __cui${i} from ${JSON.stringify(f.absPath)} with { type: "file" };`,
  );
  const cuiMapEntries = controlUiFiles.map(
    (f, i) => `${JSON.stringify(f.relPath)}: __cui${i}`,
  );

  const preamble = [
    `import __cuiOs from "node:os";`,
    ...cuiImportLines,
    `const __cuiFileMap: Record<string, string> = { ${cuiMapEntries.join(", ")} };`,
    `let __cuiCacheDir: string | null = null;`,
    `function __extractControlUi(): string | null {`,
    `  if (__cuiCacheDir) return __cuiCacheDir;`,
    `  if (Object.keys(__cuiFileMap).length === 0) return null;`,
    `  const dir = path.join(__cuiOs.tmpdir(), "openclaw-control-ui-" + process.pid);`,
    `  try {`,
    `    for (const [rel, src] of Object.entries(__cuiFileMap)) {`,
    `      const dest = path.join(dir, rel);`,
    `      fs.mkdirSync(path.dirname(dest), { recursive: true });`,
    `      fs.writeFileSync(dest, fs.readFileSync(src));`,
    `    }`,
    `    __cuiCacheDir = dir;`,
    `    process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });`,
    `  } catch {}`,
    `  return __cuiCacheDir;`,
    `}`,
  ].join("\n");

  const patched = source.replace(
    /addCandidate\(candidates, execDir \? path\.join\(execDir, "control-ui"\) : null\);/,
    `$&\n  addCandidate(candidates, __extractControlUi());`,
  );

  return preamble + "\n" + patched;
}
