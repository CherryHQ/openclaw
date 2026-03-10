import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findInPnpm } from "./helpers.js";
import type { TargetPlatform } from "./types.js";

export function copySidecarLibs(platform: TargetPlatform, outdir: string): void {
  const { os, arch } = platform;
  const libDir = join(outdir, "lib");
  mkdirSync(libDir, { recursive: true });
  let copied = 0;

  // sqlite-vec: vec0.{dylib|so|dll} — now embedded in binary via $bunfs,
  // but copy as fallback if embedding wasn't available (cross-compile).
  if (platform.isCross) {
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
