# Binary Self-Update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable `openclaw update` to self-update bun-compiled binary installs by downloading the correct platform binary from GitHub Releases.

**Architecture:** Extend the existing `installKind` union with `"binary"`. Add a new `src/infra/update-binary.ts` module that fetches GitHub Releases, downloads the matching platform asset, and replaces the running binary in-place. Wire this into the existing `update-command.ts` as a third branch alongside npm and git.

**Tech Stack:** Node.js fs/path, fetch API, tar/unzip extraction via child_process, existing `fetchWithTimeout` helper.

---

### Task 1: Extend installKind type and add binary detection

**Files:**

- Modify: `src/infra/update-check.ts:42-49` (UpdateCheckResult type)
- Modify: `src/infra/update-check.ts:449-489` (checkUpdateStatus function)
- Modify: `src/infra/update-channels.ts:37-63` (resolveEffectiveUpdateChannel)
- Modify: `src/infra/update-channels.ts:85-109` (resolveUpdateChannelDisplay)
- Test: `src/infra/update-check.test.ts` (new or extend existing)

**Step 1: Add `"binary"` to `installKind` union type**

In `src/infra/update-check.ts`, change the `UpdateCheckResult` type at line 44:

```typescript
// Before:
installKind: "git" | "package" | "unknown";

// After:
installKind: "git" | "package" | "binary" | "unknown";
```

**Step 2: Add `isBinaryInstall()` detection helper**

Add this function in `src/infra/update-check.ts` near the top (after the type definitions):

```typescript
export function isBinaryInstall(): boolean {
  const execBase = path.basename(process.execPath).toLowerCase();
  const nodeOrBun = new Set(["node", "node.exe", "bun", "bun.exe"]);
  if (nodeOrBun.has(execBase)) {
    return false;
  }
  // Bun compiled binaries have the openclaw name as the executable
  return execBase === "openclaw" || execBase === "openclaw.exe";
}
```

**Step 3: Update `checkUpdateStatus` to detect binary**

In `src/infra/update-check.ts` around line 466-470, before the git detection:

```typescript
// Before:
const installKind: UpdateCheckResult["installKind"] = isGit ? "git" : "package";

// After:
const installKind: UpdateCheckResult["installKind"] = isBinaryInstall()
  ? "binary"
  : isGit
    ? "git"
    : "package";
```

**Step 4: Update `resolveEffectiveUpdateChannel` in `update-channels.ts`**

At line 37, update the `installKind` parameter type and add binary handling:

```typescript
// Update param type:
installKind: "git" | "package" | "binary" | "unknown";

// Add before the `if (params.installKind === "package")` block:
if (params.installKind === "binary") {
  return {
    channel: params.configChannel ?? DEFAULT_PACKAGE_CHANNEL,
    source: params.configChannel ? "config" : "default",
  };
}
```

Also update `resolveUpdateChannelDisplay` at line 87 — same `installKind` type change.

**Step 5: Commit**

```
scripts/committer "feat(update): add binary installKind detection" src/infra/update-check.ts src/infra/update-channels.ts
```

---

### Task 2: Add GitHub Releases version check

**Files:**

- Modify: `src/infra/update-check.ts` (add `fetchGitHubRelease` function)
- Test: `src/infra/update-binary.test.ts`

**Step 1: Add `GitHubReleaseInfo` type and fetch function**

Add to `src/infra/update-check.ts`:

```typescript
export type GitHubReleaseInfo = {
  tagName: string;
  version: string;
  prerelease: boolean;
  assets: Array<{ name: string; url: string; size: number }>;
  error?: string;
};

const GITHUB_RELEASES_API = "https://api.github.com/repos/CherryHQ/cherry-studio/releases";

export async function fetchGitHubRelease(params: {
  channel: UpdateChannel;
  timeoutMs?: number;
}): Promise<GitHubReleaseInfo | null> {
  const timeoutMs = params.timeoutMs ?? 5000;
  try {
    const url = params.channel === "beta" ? GITHUB_RELEASES_API : `${GITHUB_RELEASES_API}/latest`;

    const res = await fetchWithTimeout(
      url,
      { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "openclaw-updater" } },
      Math.max(500, timeoutMs),
    );
    if (!res.ok) {
      return null;
    }

    const json = await res.json();

    // For beta, find the first prerelease; for stable, /latest already returns the latest non-prerelease
    const release =
      params.channel === "beta"
        ? Array.isArray(json)
          ? (json.find((r: any) => r.prerelease) ?? json[0])
          : json
        : json;

    if (!release?.tag_name) {
      return null;
    }

    const tagName = String(release.tag_name);
    const version = tagName.startsWith("v") ? tagName.slice(1) : tagName;

    return {
      tagName,
      version,
      prerelease: Boolean(release.prerelease),
      assets: (release.assets ?? []).map((a: any) => ({
        name: String(a.name ?? ""),
        url: String(a.browser_download_url ?? ""),
        size: Number(a.size ?? 0),
      })),
    };
  } catch {
    return null;
  }
}
```

**Step 2: Add `resolveAssetName` helper**

```typescript
export function resolveReleaseAssetName(): string {
  const plat = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch;
  const ext = process.platform === "win32" ? "zip" : "tar.gz";
  return `openclaw-${plat}-${arch}.${ext}`;
}
```

**Step 3: Write test for asset name resolution**

Create `src/infra/update-binary.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveReleaseAssetName } from "./update-check.js";

describe("resolveReleaseAssetName", () => {
  it("returns platform-arch asset name", () => {
    const name = resolveReleaseAssetName();
    expect(name).toMatch(/^openclaw-(darwin|linux|windows)-(arm64|x64)\.(tar\.gz|zip)$/);
  });
});
```

**Step 4: Run test**

Run: `pnpm vitest run src/infra/update-binary.test.ts`

**Step 5: Commit**

```
scripts/committer "feat(update): add GitHub Releases version check" src/infra/update-check.ts src/infra/update-binary.test.ts
```

---

### Task 3: Implement binary download and replace

**Files:**

- Create: `src/infra/update-binary.ts`
- Test: `src/infra/update-binary.test.ts` (extend)

**Step 1: Create `src/infra/update-binary.ts`**

```typescript
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import type { GitHubReleaseInfo } from "./update-check.js";

export type BinaryUpdateResult = {
  status: "ok" | "error" | "up-to-date";
  before: string;
  after?: string;
  error?: string;
};

export async function downloadAndReplaceBinary(params: {
  release: GitHubReleaseInfo;
  assetName: string;
  execPath?: string;
  timeoutMs?: number;
}): Promise<BinaryUpdateResult> {
  const execPath = params.execPath ?? process.execPath;
  const asset = params.release.assets.find((a) => a.name === params.assetName);
  if (!asset) {
    return {
      status: "error",
      before: params.release.version,
      error: `Asset ${params.assetName} not found in release ${params.release.tagName}`,
    };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-"));

  try {
    // Download asset
    const archivePath = path.join(tmpDir, asset.name);
    const res = await fetchWithTimeout(
      asset.url,
      { headers: { "User-Agent": "openclaw-updater" } },
      params.timeoutMs ?? 120_000,
    );
    if (!res.ok) {
      return {
        status: "error",
        before: params.release.version,
        error: `Download failed: HTTP ${res.status}`,
      };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(archivePath, buffer);

    // Extract
    const extractDir = path.join(tmpDir, "extract");
    await fs.mkdir(extractDir, { recursive: true });

    if (asset.name.endsWith(".tar.gz")) {
      execSync(`tar -xzf ${JSON.stringify(archivePath)} -C ${JSON.stringify(extractDir)}`, {
        timeout: 30_000,
      });
    } else if (asset.name.endsWith(".zip")) {
      if (process.platform === "win32") {
        execSync(
          `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}'"`,
          { timeout: 30_000 },
        );
      } else {
        execSync(`unzip -o ${JSON.stringify(archivePath)} -d ${JSON.stringify(extractDir)}`, {
          timeout: 30_000,
        });
      }
    }

    // Find the binary in extracted files
    const binaryName = process.platform === "win32" ? "openclaw.exe" : "openclaw";
    const newBinary = await findExtractedBinary(extractDir, binaryName);
    if (!newBinary) {
      return {
        status: "error",
        before: params.release.version,
        error: "Binary not found in archive",
      };
    }

    // Check write permission
    try {
      await fs.access(path.dirname(execPath), fs.constants.W_OK);
    } catch {
      return {
        status: "error",
        before: params.release.version,
        error: `Permission denied: cannot write to ${path.dirname(execPath)}. Try running with sudo.`,
      };
    }

    // Replace binary
    if (process.platform === "win32") {
      // Windows: can't overwrite running exe, rename first
      const oldPath = `${execPath}.old`;
      try {
        await fs.unlink(oldPath);
      } catch {
        // ignore
      }
      await fs.rename(execPath, oldPath);
      await fs.copyFile(newBinary, execPath);
    } else {
      // Unix: atomic rename
      const stagePath = `${execPath}.new`;
      await fs.copyFile(newBinary, stagePath);
      await fs.chmod(stagePath, 0o755);
      await fs.rename(stagePath, execPath);
    }

    return {
      status: "ok",
      before: params.release.version,
      after: params.release.version,
    };
  } catch (err) {
    return { status: "error", before: params.release.version, error: String(err) };
  } finally {
    // Cleanup temp dir
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function findExtractedBinary(dir: string, name: string): Promise<string | null> {
  // Check top level
  const direct = path.join(dir, name);
  if (fsSync.existsSync(direct)) {
    return direct;
  }
  // Check one level deep (archives may have a wrapper directory)
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nested = path.join(dir, entry.name, name);
        if (fsSync.existsSync(nested)) {
          return nested;
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export async function cleanupOldBinary(): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  const oldPath = `${process.execPath}.old`;
  try {
    await fs.unlink(oldPath);
  } catch {
    // ignore — file may not exist or still locked
  }
}
```

**Step 2: Write tests**

Add to `src/infra/update-binary.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveReleaseAssetName } from "./update-check.js";

describe("resolveReleaseAssetName", () => {
  it("returns platform-arch asset name", () => {
    const name = resolveReleaseAssetName();
    expect(name).toMatch(/^openclaw-(darwin|linux|windows)-(arm64|x64)\.(tar\.gz|zip)$/);
  });
});

// downloadAndReplaceBinary is integration-heavy — tested via smoke test
```

**Step 3: Run test**

Run: `pnpm vitest run src/infra/update-binary.test.ts`

**Step 4: Commit**

```
scripts/committer "feat(update): add binary download and replace module" src/infra/update-binary.ts src/infra/update-binary.test.ts
```

---

### Task 4: Wire binary update into update-command.ts

**Files:**

- Modify: `src/cli/update-cli/update-command.ts:630-918`
- Modify: `src/cli/update-cli/shared.ts:131-139`
- Modify: `src/cli/update-cli/status.ts:93-98`

**Step 1: Update `resolveUpdateRoot` in `shared.ts`**

At line 131-139, add binary detection:

```typescript
export async function resolveUpdateRoot(): Promise<string> {
  // Binary install: root is the directory containing the binary
  if (isBinaryInstall()) {
    return path.dirname(process.execPath);
  }
  return (
    (await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })) ?? process.cwd()
  );
}
```

Add the import at top of `shared.ts`:

```typescript
import { isBinaryInstall } from "../../infra/update-check.js";
```

**Step 2: Add binary update branch in `updateCommand`**

In `src/cli/update-cli/update-command.ts`, inside `updateCommand()` around line 838, before the existing `switchToPackage` ternary, add the binary branch:

```typescript
// Add import at top of file:
import { downloadAndReplaceBinary, cleanupOldBinary } from "../../infra/update-binary.js";
import {
  fetchGitHubRelease,
  isBinaryInstall,
  resolveReleaseAssetName,
} from "../../infra/update-check.js";

// Inside updateCommand(), after the showProgress/progress setup (~line 817), before the switchToPackage ternary:

// Clean up any .old binary from a previous Windows update
await cleanupOldBinary();

if (isBinaryInstall()) {
  progress.onStepStart?.({ name: "check GitHub releases", command: "", index: 0, total: 3 });
  const release = await fetchGitHubRelease({ channel, timeoutMs: timeoutMs ?? 10_000 });
  if (!release) {
    stop();
    if (!opts.json) {
      defaultRuntime.log(theme.error("Failed to check GitHub releases."));
    }
    defaultRuntime.exit(1);
    return;
  }

  const cmpResult = compareSemverStrings(currentVersion ?? "0.0.0", release.version);
  if (cmpResult != null && cmpResult >= 0) {
    stop();
    if (!opts.json) {
      defaultRuntime.log(theme.success(`Already up to date (${release.version}).`));
    }
    defaultRuntime.exit(0);
    return;
  }

  progress.onStepStart?.({ name: "download and replace binary", command: "", index: 1, total: 3 });
  const assetName = resolveReleaseAssetName();
  const binaryResult = await downloadAndReplaceBinary({
    release,
    assetName,
    timeoutMs: timeoutMs ?? 120_000,
  });

  stop();
  if (binaryResult.status === "error") {
    if (!opts.json) {
      defaultRuntime.log(theme.error(`Update failed: ${binaryResult.error}`));
    }
    defaultRuntime.exit(1);
    return;
  }

  if (!opts.json) {
    defaultRuntime.log(theme.success(`Updated to ${release.version}`));
  }

  // Continue to plugin updates, shell completion, restart — same as npm path
  // (skip the switchToPackage/runGitUpdate block below)
} else {
  // existing switchToPackage / runGitUpdate logic
}
```

Wrap the existing `switchToPackage ? runPackageInstallUpdate(...) : runGitUpdate(...)` block in the `else` of the binary check.

**Step 3: Update status display for binary**

In `src/cli/update-cli/status.ts` around line 93-98, add binary label:

```typescript
const installLabel =
  update.installKind === "binary"
    ? `binary (${update.root ?? process.execPath})`
    : update.installKind === "git"
      ? `git (${update.root ?? "unknown"})`
      : update.installKind === "package"
        ? update.packageManager
        : "unknown";
```

**Step 4: Commit**

```
scripts/committer "feat(update): wire binary self-update into update command" src/cli/update-cli/update-command.ts src/cli/update-cli/shared.ts src/cli/update-cli/status.ts
```

---

### Task 5: Update background check and wizard for binary installs

**Files:**

- Modify: `src/infra/update-startup.ts:364-374`
- Modify: `src/cli/update-cli/wizard.ts`

**Step 1: Support binary in background update check**

In `src/infra/update-startup.ts` at line 364, change the early return:

```typescript
// Before:
  if (status.installKind !== "package") {

// After:
  if (status.installKind !== "package" && status.installKind !== "binary") {
```

Then after line 376, add a branch for binary that uses GitHub API instead of npm:

```typescript
let resolvedVersion: string | null = null;
let resolvedTag: string = "latest";

if (status.installKind === "binary") {
  const { fetchGitHubRelease } = await import("./update-check.js");
  const release = await fetchGitHubRelease({ channel, timeoutMs: 2500 });
  if (!release?.version) {
    await writeState(statePath, nextState);
    return;
  }
  resolvedVersion = release.version;
  resolvedTag = release.prerelease ? "beta" : "latest";
} else {
  const resolved = await resolveNpmChannelTag({ channel, timeoutMs: 2500 });
  resolvedTag = resolved.tag;
  if (!resolved.version) {
    await writeState(statePath, nextState);
    return;
  }
  resolvedVersion = resolved.version;
}
```

Then replace subsequent `resolved.version` / `resolved.tag` references with `resolvedVersion` / `resolvedTag`.

**Step 2: Update wizard to hide dev channel for binary**

In `src/cli/update-cli/wizard.ts`, in the `selectStyled` options, conditionally hide the "Dev" option for binary installs:

```typescript
import { isBinaryInstall } from "../../infra/update-check.js";

// In the options array, wrap the dev option:
const options = [
  { value: "keep", label: `Keep current (${channelInfo.channel})`, hint: channelLabel },
  { value: "stable", label: "Stable", hint: "Tagged releases" },
  { value: "beta", label: "Beta", hint: "Prereleases" },
  // Binary installs don't support dev (no git checkout)
  ...(!isBinaryInstall() ? [{ value: "dev", label: "Dev", hint: "Git main" }] : []),
];
```

**Step 3: Commit**

```
scripts/committer "feat(update): support binary in background check and wizard" src/infra/update-startup.ts src/cli/update-cli/wizard.ts
```

---

### Task 6: Add dry-run support and update CI workflow

**Files:**

- Modify: `src/cli/update-cli/update-command.ts` (dry-run preview for binary)
- Modify: `.github/workflows/bun-compile-release.yml` (use CherryHQ/cherry-studio)

**Step 1: Add binary to dry-run preview**

In the dry-run block of `updateCommand()` (~line 698-762), add binary mode detection:

```typescript
    if (updateInstallKind === "git") {
      mode = "git";
    } else if (updateInstallKind === "binary") {
      mode = "binary";
    } else if (updateInstallKind === "package") {
```

And in the actions array:

```typescript
    if (isBinaryInstall()) {
      actions.push(`Download and replace binary from GitHub release (${tag})`);
    } else if (switchToGit) {
```

**Step 2: Update `UpdateRunResult` mode to include `"binary"`**

Check `src/infra/update-runner.ts` for the `mode` type and add `"binary"` if needed.

**Step 3: Update CI workflow repo**

In `.github/workflows/bun-compile-release.yml`, verify the release job targets `CherryHQ/cherry-studio` (currently it uses `softprops/action-gh-release` which publishes to the current repo — this is correct if the workflow runs in the `CherryHQ/cherry-studio` repo).

**Step 4: Commit**

```
scripts/committer "feat(update): add binary dry-run and finalize CI" src/cli/update-cli/update-command.ts
```

---

### Task 7: End-to-end verification

**Step 1: Build binary and test update detection**

```bash
bun scripts/build-bun-compile.ts --outdir dist-bun
./dist-bun/openclaw update --dry-run
```

Verify output shows `Install kind: binary` and `Download and replace binary from GitHub release`.

**Step 2: Test update status**

```bash
./dist-bun/openclaw update status
```

Verify it shows `binary (path)` as install type.

**Step 3: Run existing tests**

```bash
pnpm vitest run src/infra/update-binary.test.ts
pnpm vitest run src/infra/update-check.test.ts
pnpm vitest run src/infra/update-startup.test.ts
```

**Step 4: Commit any fixes**

```
scripts/committer "test(update): verify binary self-update flow" src/
```
