import { describe, it, expect } from "vitest";
import { resolveReleaseAssetName } from "./update-check.js";

describe("resolveReleaseAssetName", () => {
  it("returns platform-arch asset name", () => {
    const name = resolveReleaseAssetName();
    expect(name).toMatch(/^openclaw-(darwin|linux|windows)-(arm64|x64)\.(tar\.gz|zip)$/);
  });
});
