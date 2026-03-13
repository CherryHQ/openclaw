import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EmbeddedTemplatesData } from "./types.js";

export function scanTemplatesForEmbedding(): EmbeddedTemplatesData {
  const templatesDir = resolve("docs/reference/templates");
  const manifest: Record<string, { files: string[]; dirs: string[] }> = {};
  const files: { absPath: string; relPath: string }[] = [];

  if (!existsSync(templatesDir)) {
    return { manifest, files };
  }

  const entries = readdirSync(templatesDir, { withFileTypes: true });
  const fileNames: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (entry.isFile()) {
      fileNames.push(entry.name);
      files.push({ absPath: join(templatesDir, entry.name), relPath: entry.name });
    }
  }
  manifest[""] = { files: fileNames, dirs: [] };

  console.log(`[bun-compile] Scanned templates: ${files.length} files`);
  return { manifest, files };
}
