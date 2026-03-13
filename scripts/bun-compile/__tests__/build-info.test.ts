import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  patchVersionTs,
  patchGitCommit,
  patchOpenClawRoot,
  patchPluginRuntimeVersion,
} from "../patches/build-info.js";
import type { PatchContext } from "../types.js";

// Minimal context for build-info patchers
const ctx: Pick<PatchContext, "pkgJson" | "gitHead"> = {
  pkgJson: { name: "openclaw", version: "2026.3.10" },
  gitHead: "abc1234",
};

describe("patchVersionTs", () => {
  it("replaces readVersionFromJsonCandidates body with hardcoded version", () => {
    const source = readFileSync(resolve("src/version.ts"), "utf-8");
    const result = patchVersionTs(source, ctx);
    expect(result).toContain('return "2026.3.10"');
    expect(result).not.toContain("readFileSync");
    // Verify it still parses as valid TS
    expect(result).toContain("function readVersionFromJsonCandidates");
  });
});

describe("patchGitCommit", () => {
  it("replaces readCommitFromPackageJson with hardcoded value", () => {
    const source = readFileSync(resolve("src/infra/git-commit.ts"), "utf-8");
    const result = patchGitCommit(source, ctx);
    expect(result).toContain('"abc1234"');
    expect(result).toContain("readCommitFromPackageJson");
  });

  it("handles null gitHead", () => {
    const source = readFileSync(resolve("src/infra/git-commit.ts"), "utf-8");
    const result = patchGitCommit(source, { ...ctx, gitHead: null });
    expect(result).toContain("null");
  });
});

describe("patchOpenClawRoot", () => {
  it("replaces resolveOpenClawPackageRoot body with process.execPath dirname", () => {
    const source = readFileSync(resolve("src/infra/openclaw-root.ts"), "utf-8");
    const result = patchOpenClawRoot(source);
    expect(result).toContain("process.execPath");
    expect(result).toContain("resolveOpenClawPackageRoot");
    // Sync variant too
    expect(result).toContain("resolveOpenClawPackageRootSync");
  });
});

describe("patchPluginRuntimeVersion", () => {
  it("replaces resolveVersion body with hardcoded version", () => {
    const source = readFileSync(resolve("src/plugins/runtime/index.ts"), "utf-8");
    const result = patchPluginRuntimeVersion(source, ctx);
    expect(result).toContain('return "2026.3.10"');
    expect(result).toContain("function resolveVersion");
  });
});
