export interface TargetPlatform {
  os: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
  isCross: boolean;
}

export interface EmbeddedFileEntry {
  absPath: string;
  relPath: string;
}

export interface EmbeddedSkillsData {
  files: EmbeddedFileEntry[];
  manifest: Record<string, { files: string[]; dirs: string[] }>;
}

export interface EmbeddedExtensionsData {
  files: EmbeddedFileEntry[];
  manifest: Record<string, { files: string[]; dirs: string[] }>;
}

export interface EmbeddedTemplatesData {
  files: EmbeddedFileEntry[];
  manifest: Record<string, { files: string[]; dirs: string[] }>;
}

export interface PatchContext {
  platform: TargetPlatform;
  pkgJson: { name: string; version: string };
  gitHead: string | null;
  embedNative: boolean;
  // native paths
  ptyNodeFile: string | null;
  sharpNodeFile: string | null;
  vecFile: string | null;
  vecExtSuffix: string;
  // plugin-sdk embedding
  sdkFiles: Array<{ fullPath: string; basename: string }>;
  sdkImportLines: string[];
  sdkMapExpr: string;
  jitiBabelCjs: string;
  // control-ui
  controlUiFiles: Array<{ absPath: string; relPath: string }>;
  // VFS
  embeddedSkills: EmbeddedSkillsData;
  embeddedExtensions: EmbeddedExtensionsData;
  embeddedTemplates: EmbeddedTemplatesData;
}
