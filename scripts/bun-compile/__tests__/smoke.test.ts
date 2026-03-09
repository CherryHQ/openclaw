import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

describe("bun-compile smoke test", () => {
  const binary = resolve("dist-bun/openclaw");

  it("binary exists", () => {
    expect(existsSync(binary)).toBe(true);
  });

  it("binary runs --version", () => {
    const output = execFileSync(binary, ["--version"], { encoding: "utf-8", timeout: 10_000 });
    expect(output.trim()).toMatch(/^\d{4}\.\d+\.\d+/);
  });

  it("plugins list exits without crashing", () => {
    const result = spawnSync(binary, ["plugins", "list"], {
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    // Should not crash with a signal (SIGSEGV, SIGABRT, etc.)
    expect(result.signal).toBeNull();
    // Exit code 0 or 1 (config warnings are ok), not > 1 (crash)
    expect(result.status).toBeLessThanOrEqual(1);
  });
});
