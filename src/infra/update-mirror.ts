import { fetchWithTimeout } from "../utils/fetch-timeout.js";

export type UpdateMirror = "github" | "gitcode";

type MirrorConfig = {
  releasesApi: string;
  acceptHeader: string;
};

const MIRRORS: Record<UpdateMirror, MirrorConfig> = {
  github: {
    releasesApi: "https://api.github.com/repos/CherryHQ/openclaw/releases",
    acceptHeader: "application/vnd.github.v3+json",
  },
  gitcode: {
    releasesApi: "https://api.gitcode.com/api/v5/repos/CherryHQ/openclaw/releases",
    acceptHeader: "application/json",
  },
};

export function getMirrorConfig(mirror: UpdateMirror): MirrorConfig {
  return MIRRORS[mirror];
}

let cachedMirror: UpdateMirror | null = null;

export async function resolveUpdateMirror(params?: {
  timeoutMs?: number;
  force?: boolean;
}): Promise<UpdateMirror> {
  // Allow env override
  const envMirror = process.env.OPENCLAW_UPDATE_MIRROR?.trim().toLowerCase();
  if (envMirror === "github" || envMirror === "gitcode") {
    return envMirror;
  }

  if (cachedMirror && !params?.force) {
    return cachedMirror;
  }

  const inChina = await isUserInChina(params?.timeoutMs ?? 3000);
  cachedMirror = inChina ? "gitcode" : "github";
  return cachedMirror;
}

async function isUserInChina(timeoutMs: number): Promise<boolean> {
  try {
    const country = await getIpCountry(timeoutMs);
    return country.toLowerCase() === "cn";
  } catch {
    return false;
  }
}

async function getIpCountry(timeoutMs: number): Promise<string> {
  try {
    const res = await fetchWithTimeout(
      "https://api.ipinfo.io/lite/me?token=2a42580355dae4",
      { headers: { "User-Agent": "openclaw-updater" } },
      Math.max(500, timeoutMs),
    );
    if (!res.ok) {
      return "US";
    }
    const data = (await res.json()) as { country_code?: string };
    return data.country_code || "US";
  } catch {
    return "US";
  }
}

export function resetMirrorCacheForTest(): void {
  cachedMirror = null;
}
