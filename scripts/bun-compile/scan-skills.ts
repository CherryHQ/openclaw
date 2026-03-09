import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EmbeddedSkillsData } from "./types.js";

export function scanSkillsForEmbedding(): EmbeddedSkillsData {
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
