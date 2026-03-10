import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { patchEntryTs, patchControlUiAssets } from "../patches/vfs-overlay.js";
import type { PatchContext } from "../types.js";

const ctx: Pick<PatchContext, "pkgJson" | "embeddedSkills" | "embeddedExtensions"> = {
  pkgJson: { name: "openclaw", version: "2026.3.10" },
  embeddedSkills: {
    files: [{ absPath: "/tmp/skills/foo.md", relPath: "foo.md" }],
    manifest: { "": { files: ["foo.md"], dirs: [] } },
  },
  embeddedExtensions: {
    files: [{ absPath: "/tmp/ext/bar/index.js", relPath: "bar/index.js" }],
    manifest: {
      "": { files: [], dirs: ["bar"] },
      bar: { files: ["index.js"], dirs: [] },
    },
  },
};

describe("patchEntryTs", () => {
  it("injects VFS preamble before original source", () => {
    const source = readFileSync(resolve("src/entry.ts"), "utf-8");
    const result = patchEntryTs(source, ctx, null);
    expect(result).toContain("__vfsLookup");
    expect(result).toContain("__shimFs");
    expect(result).toContain("readdirSync");
    expect(result).toContain("OPENCLAW_BUNDLED_SKILLS_DIR");
    expect(result).toContain("OPENCLAW_BUNDLED_PLUGINS_DIR");
  });

  it("patches existsSync, statSync, lstatSync, realpathSync, openSync, closeSync", () => {
    const source = readFileSync(resolve("src/entry.ts"), "utf-8");
    const result = patchEntryTs(source, ctx, null);
    expect(result).toContain("__origExistsSync");
    expect(result).toContain("__origStatSync");
    expect(result).toContain("__origLstatSync");
    expect(result).toContain("__origRealpathSync");
    expect(result).toContain("__origOpenSync");
    expect(result).toContain("__origCloseSync");
  });

  it("includes vec0 embed when provided", () => {
    const source = readFileSync(resolve("src/entry.ts"), "utf-8");
    const result = patchEntryTs(source, ctx, "/path/to/vec0.dylib");
    expect(result).toContain("__vec0BunfsPath");
    expect(result).toContain("vec0.dylib");
  });

  it("strips shebang", () => {
    const source = "#!/usr/bin/env bun\nconsole.log('hello');";
    const result = patchEntryTs(source, ctx, null);
    expect(result).not.toContain("#!/usr/bin/env");
  });
});

describe("patchControlUiAssets", () => {
  it("injects control-ui extraction preamble", () => {
    const source = readFileSync(resolve("src/infra/control-ui-assets.ts"), "utf-8");
    const cuiFiles = [{ absPath: "/tmp/cui/index.html", relPath: "index.html" }];
    const result = patchControlUiAssets(source, cuiFiles);
    expect(result).toContain("__extractControlUi");
    expect(result).toContain("__cuiFileMap");
  });
});
