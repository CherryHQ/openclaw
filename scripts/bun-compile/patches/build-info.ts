import { Project } from "ts-morph";
import type { PatchContext } from "../types.js";

function createProject(source: string, fileName = "source.ts") {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile(fileName, source);
}

export function patchVersionTs(
  source: string,
  ctx: Pick<PatchContext, "pkgJson">,
): string {
  const sf = createProject(source, "version.ts");
  const fn = sf.getFunctionOrThrow("readVersionFromJsonCandidates");
  fn.setBodyText(`return ${JSON.stringify(ctx.pkgJson.version)};`);
  return sf.getFullText();
}

export function patchGitCommit(
  source: string,
  ctx: Pick<PatchContext, "gitHead">,
): string {
  const sf = createProject(source, "git-commit.ts");
  // readCommitFromPackageJson is a const arrow function
  const decl = sf.getVariableDeclarationOrThrow("readCommitFromPackageJson");
  decl.setInitializer(`() => ${JSON.stringify(ctx.gitHead)}`);
  return sf.getFullText();
}

export function patchOpenClawRoot(source: string): string {
  const sf = createProject(source, "openclaw-root.ts");
  // Replace async variant
  const asyncFn = sf.getFunctionOrThrow("resolveOpenClawPackageRoot");
  asyncFn.setBodyText(
    `return require("node:path").dirname(process.execPath);`,
  );
  // Replace sync variant
  const syncFn = sf.getFunctionOrThrow("resolveOpenClawPackageRootSync");
  syncFn.setBodyText(
    `return require("node:path").dirname(process.execPath);`,
  );
  return sf.getFullText();
}

export function patchPluginRuntimeVersion(
  source: string,
  ctx: Pick<PatchContext, "pkgJson">,
): string {
  const sf = createProject(source, "runtime-index.ts");
  const fn = sf.getFunctionOrThrow("resolveVersion");
  fn.setBodyText(`return ${JSON.stringify(ctx.pkgJson.version)};`);
  return sf.getFullText();
}
