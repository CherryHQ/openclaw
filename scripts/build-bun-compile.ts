#!/usr/bin/env bun
/**
 * Build openclaw as a standalone binary using `bun build --compile`.
 *
 * Usage:
 *   bun scripts/build-bun-compile.ts
 *   bun scripts/build-bun-compile.ts --target bun-linux-x64
 */
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    target: { type: "string" },
    outdir: { type: "string", default: "dist-bun" },
  },
});

const outdir = values.outdir;
const target = values.target;

console.log(`[bun-compile] Building openclaw binary...`);
console.log(`[bun-compile] outdir: ${outdir}`);
if (target) {
  console.log(`[bun-compile] target: ${target}`);
}

// Clean output dir
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

// NOTE: --compile and --splitting are mutually exclusive in Bun.
// All code is bundled into a single file inside the binary.
const externals = [
  // Native modules — resolved at runtime from sidecar node_modules/
  "sharp",
  "@img/sharp-*",
  "@lydell/node-pty",
  "sqlite-vec",
  "opusscript",
  "@discordjs/opus",
  "node-llama-cpp",
  "@node-llama-cpp/*",
  // Plugin loader needs runtime filesystem access
  "jiti",
  // Optional/platform-specific deps that bundler can't resolve
  "ffmpeg-static",
  "electron",
  "chromium-bidi",
  "chromium-bidi/*",
  "playwright-core",
  "authenticate-pam",
  "@napi-rs/canvas",
  "@matrix-org/matrix-sdk-crypto-nodejs",
  "koffi",
];

const args = [
  "bun",
  "build",
  "--compile",
  "--minify",
  "--sourcemap",
  "./src/entry.ts",
  "--outfile",
  `${outdir}/openclaw`,
  ...externals.flatMap((ext) => ["--external", ext]),
];

if (target) {
  args.push("--target", target);
}

console.log(`[bun-compile] Running: ${args.join(" ")}`);

const proc = Bun.spawn(args, {
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    OPENCLAW_NO_RESPAWN: "1",
  },
});

const exitCode = await proc.exited;
if (exitCode !== 0) {
  console.error(`[bun-compile] Build failed with exit code ${exitCode}`);
  process.exit(exitCode);
}

console.log(`[bun-compile] Build succeeded.`);

// Copy sidecar files that the binary needs at runtime.
console.log(`[bun-compile] Copying sidecar files...`);

// package.json — needed by @mariozechner/pi-coding-agent at startup
copyFileSync("package.json", `${outdir}/package.json`);

// Bundled extensions (plugins)
cpSync("extensions", `${outdir}/extensions`, { recursive: true });

// Bundled skills
cpSync("skills", `${outdir}/skills`, { recursive: true });

// Control UI static assets (build with `pnpm ui:build` first)
if (existsSync("dist/control-ui")) {
  cpSync("dist/control-ui", `${outdir}/control-ui`, { recursive: true });
  console.log(`[bun-compile] Copied control-ui assets.`);
} else {
  console.warn(
    `[bun-compile] Warning: dist/control-ui not found. Run \`pnpm ui:build\` first for Control UI support.`,
  );
}

console.log(`[bun-compile] Done.`);
