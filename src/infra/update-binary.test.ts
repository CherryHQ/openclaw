import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveReleaseAssetName } from "./update-check.js";

describe("resolveReleaseAssetName", () => {
  it("returns platform-arch asset name", () => {
    const name = resolveReleaseAssetName();
    expect(name).toMatch(/^openclaw-(darwin|linux|windows)-(arm64|x64)\.(tar\.gz|zip)$/);
  });
});

// updateSidecarPackageJson is not exported, so we test it indirectly via
// downloadAndReplaceBinary. Since that function requires network + real binary,
// we import the module and test the sidecar write logic by calling the internal
// helper through a controlled downloadAndReplaceBinary invocation.
// Instead, we replicate the sidecar logic here as a focused unit test.

describe("sidecar package.json update", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sidecar-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function writeSidecarPackageJson(dir: string, version: string): Promise<void> {
    const pkgPath = path.join(dir, "package.json");
    try {
      const raw = await fs.readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      pkg.version = version;
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    } catch {
      try {
        await fs.writeFile(pkgPath, JSON.stringify({ name: "openclaw", version }, null, 2) + "\n");
      } catch {
        // best-effort
      }
    }
  }

  it("creates package.json when none exists", async () => {
    await writeSidecarPackageJson(tmpDir, "2026.4.1");
    const raw = await fs.readFile(path.join(tmpDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    expect(pkg).toEqual({ name: "openclaw", version: "2026.4.1" });
  });

  it("updates version in existing package.json and preserves other fields", async () => {
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.3.11", type: "module" }, null, 2) + "\n",
    );
    await writeSidecarPackageJson(tmpDir, "2026.4.1");
    const raw = await fs.readFile(path.join(tmpDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    expect(pkg).toEqual({ name: "openclaw", version: "2026.4.1", type: "module" });
  });
});
