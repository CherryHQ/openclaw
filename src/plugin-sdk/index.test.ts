import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildPluginSdkEntrySources,
  buildPluginSdkPackageExports,
  buildPluginSdkSpecifiers,
  pluginSdkEntrypoints,
} from "./entrypoints.js";
import * as sdk from "./index.js";

const require = createRequire(import.meta.url);
const pluginSdkSpecifiers = buildPluginSdkSpecifiers();
const execFileAsync = promisify(execFile);

const tsdownModuleUrl = pathToFileURL(require.resolve("tsdown")).href;

describe("plugin-sdk exports", () => {
  it("does not expose runtime modules", () => {
    const forbidden = [
      "chunkMarkdownText",
      "chunkText",
      "hasControlCommand",
      "isControlCommandMessage",
      "shouldComputeCommandAuthorized",
      "shouldHandleTextCommands",
      "buildMentionRegexes",
      "matchesMentionPatterns",
      "resolveStateDir",
      "writeConfigFile",
      "enqueueSystemEvent",
      "fetchRemoteMedia",
      "saveMediaBuffer",
      "formatAgentEnvelope",
      "buildPairingReply",
      "resolveAgentRoute",
      "dispatchReplyFromConfig",
      "createReplyDispatcherWithTyping",
      "dispatchReplyWithBufferedBlockDispatcher",
      "resolveCommandAuthorizedFromAuthorizers",
      "monitorSlackProvider",
      "monitorTelegramProvider",
      "monitorIMessageProvider",
      "monitorSignalProvider",
      "sendMessageSlack",
      "sendMessageTelegram",
      "sendMessageIMessage",
      "sendMessageSignal",
      "sendMessageWhatsApp",
      "probeSlack",
      "probeTelegram",
      "probeIMessage",
      "probeSignal",
    ];

    for (const key of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(sdk, key)).toBe(false);
    }
  });

  it("keeps the root surface legacy-compatible without exposing runtime modules", () => {
    expect(typeof sdk.emptyPluginConfigSchema).toBe("function");
    expect(typeof sdk.delegateCompactionToRuntime).toBe("function");
    expect(typeof sdk.onDiagnosticEvent).toBe("function");
    expect(typeof sdk.resolveControlCommandGate).toBe("function");
    expect(typeof sdk.buildChannelConfigSchema).toBe("function");
    expect(typeof sdk.readStringParam).toBe("function");
    expect(typeof sdk.jsonResult).toBe("function");
    expect(typeof sdk.normalizeAccountId).toBe("function");
    expect(typeof sdk.formatDocsLink).toBe("function");
    expect(typeof sdk.extractToolSend).toBe("function");
    expect(typeof sdk.DEFAULT_ACCOUNT_ID).toBe("string");
    expect(Object.prototype.hasOwnProperty.call(sdk, "buildAgentSessionKey")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sdk, "isDangerousNameMatchingEnabled")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sdk, "emitDiagnosticEvent")).toBe(false);
  });

  it("emits importable bundled subpath entries", { timeout: 240_000 }, async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-sdk-build-"));
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-sdk-consumer-"));

    try {
      const buildScriptPath = path.join(fixtureDir, "build-plugin-sdk.mjs");
      await fs.writeFile(
        buildScriptPath,
        `import { build } from ${JSON.stringify(tsdownModuleUrl)};
await build(${JSON.stringify({
          clean: true,
          config: false,
          dts: false,
          entry: buildPluginSdkEntrySources(),
          env: { NODE_ENV: "production" },
          fixedExtension: false,
          logLevel: "error",
          outDir,
          platform: "node",
        })});
`,
      );
      await execFileAsync(process.execPath, [buildScriptPath], {
        cwd: process.cwd(),
      });

      for (const entry of pluginSdkEntrypoints) {
        const module = await import(pathToFileURL(path.join(outDir, `${entry}.js`)).href);
        expect(module).toBeTypeOf("object");
      }

      const packageDir = path.join(fixtureDir, "openclaw");
      const consumerDir = path.join(fixtureDir, "consumer");
      const consumerEntry = path.join(consumerDir, "import-plugin-sdk.mjs");

      await fs.mkdir(path.join(packageDir, "dist"), { recursive: true });
      await fs.symlink(outDir, path.join(packageDir, "dist", "plugin-sdk"), "dir");
      await fs.writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify(
          {
            exports: buildPluginSdkPackageExports(),
            name: "openclaw",
            type: "module",
          },
          null,
          2,
        ),
      );

      await fs.mkdir(path.join(consumerDir, "node_modules"), { recursive: true });
      await fs.symlink(packageDir, path.join(consumerDir, "node_modules", "openclaw"), "dir");
      await fs.writeFile(
        consumerEntry,
        [
          `const specifiers = ${JSON.stringify(pluginSdkSpecifiers)};`,
          "const results = {};",
          "for (const specifier of specifiers) {",
          "  results[specifier] = typeof (await import(specifier));",
          "}",
          'const rootSdk = await import("openclaw/plugin-sdk");',
          "results.rootCompat = {",
          "  buildChannelConfigSchema: typeof rootSdk.buildChannelConfigSchema,",
          "  readStringParam: typeof rootSdk.readStringParam,",
          "  jsonResult: typeof rootSdk.jsonResult,",
          "  normalizeAccountId: typeof rootSdk.normalizeAccountId,",
          "  formatDocsLink: typeof rootSdk.formatDocsLink,",
          "  extractToolSend: typeof rootSdk.extractToolSend,",
          "  defaultAccountId: typeof rootSdk.DEFAULT_ACCOUNT_ID,",
          "};",
          "export default results;",
        ].join("\n"),
      );

      const { default: importResults } = await import(pathToFileURL(consumerEntry).href);
      expect(importResults).toMatchObject({
        ...Object.fromEntries(
          pluginSdkSpecifiers.map((specifier: string) => [specifier, "object"]),
        ),
        rootCompat: {
          buildChannelConfigSchema: "function",
          readStringParam: "function",
          jsonResult: "function",
          normalizeAccountId: "function",
          formatDocsLink: "function",
          extractToolSend: "function",
          defaultAccountId: "string",
        },
      });
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("keeps package.json plugin-sdk exports synced with the manifest", async () => {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
      exports?: Record<string, unknown>;
    };
    const currentPluginSdkExports = Object.fromEntries(
      Object.entries(packageJson.exports ?? {}).filter(([key]) => key.startsWith("./plugin-sdk")),
    );

    expect(currentPluginSdkExports).toEqual(buildPluginSdkPackageExports());
  });
});
