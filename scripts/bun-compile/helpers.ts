import { existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { TargetPlatform } from "./types.js";

export function detectPlatform(target?: string): TargetPlatform {
  if (!target) {
    return {
      os: process.platform as TargetPlatform["os"],
      arch: process.arch as TargetPlatform["arch"],
      isCross: false,
    };
  }
  const parts = target.split("-");
  const os = (parts[1] === "windows" ? "win32" : parts[1]) as TargetPlatform["os"];
  const arch = parts[2] as TargetPlatform["arch"];
  const isCross = os !== process.platform || arch !== process.arch;
  return { os, arch, isCross };
}

export function findInPnpm(packageName: string, parentPackage?: string): string | null {
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

/** Escape backslashes in paths for embedding inside JS string literals */
export function jsPath(p: string): string {
  return p.replace(/\\/g, "\\\\");
}
