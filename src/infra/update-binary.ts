import { execSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
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
      await fs.access(path.dirname(execPath), fsSync.constants.W_OK);
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
      // Unix: stage then atomic rename
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
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function findExtractedBinary(dir: string, name: string): Promise<string | null> {
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
