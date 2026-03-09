import type { TargetPlatform } from "./types.js";

export function buildExternals(platform: TargetPlatform): string[] {
  const { os } = platform;
  const list = [
    "opusscript",
    "@discordjs/opus",
    "node-llama-cpp",
    "@node-llama-cpp/*",
    "ffmpeg-static",
    "electron",
    "chromium-bidi",
    "chromium-bidi/*",
    "playwright-core",
    "playwright-core/*",
    "authenticate-pam",
    "@napi-rs/canvas",
    "@matrix-org/matrix-sdk-crypto-nodejs",
    "koffi",
  ];

  if (os === "darwin") {
    list.push("sharp", "@img/sharp-*");
  }
  if (os !== "darwin") {
    list.push("detect-libc");
  }

  // Dead-code branches for the other OS terminal
  if (os === "win32") {
    list.push("./unixTerminal");
  } else {
    list.push("./windowsTerminal");
  }

  return list;
}
