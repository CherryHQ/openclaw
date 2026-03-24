import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EmbeddedExtensionsData } from "./types.js";

export function scanExtensionsForEmbedding(extTempDir: string): EmbeddedExtensionsData {
  const manifest: Record<string, { files: string[]; dirs: string[] }> = {};
  const files: { absPath: string; relPath: string }[] = [];

  const resolvedDir = resolve(extTempDir);
  if (!existsSync(resolvedDir)) {
    return { manifest, files };
  }

  const scan = (dir: string, rel: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const fileNames: string[] = [];
    const dirNames: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.name === "node_modules") {
        continue;
      }
      const fullPath = join(dir, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        dirNames.push(entry.name);
        scan(fullPath, entryRel);
      } else if (entry.isFile()) {
        // Skip .node native binaries — they need sidecar, not $bunfs embedding
        if (entry.name.endsWith(".node")) {
          continue;
        }
        fileNames.push(entry.name);
        files.push({ absPath: fullPath, relPath: entryRel });
      }
    }
    manifest[rel] = { files: fileNames, dirs: dirNames };
  };
  scan(resolvedDir, "");

  console.log(
    `[bun-compile] Scanned extensions for embedding: ${files.length} files in ${Object.keys(manifest).length} directories`,
  );
  return { manifest, files };
}
