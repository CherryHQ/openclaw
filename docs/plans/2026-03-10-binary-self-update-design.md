# Binary Self-Update Design

**Date:** 2026-03-10
**Status:** Approved

## Context

The bun-compiled binary distribution packages everything (skills, extensions, plugin-sdk, control-ui, native .node files) into a single executable via `$bunfs`. The existing `openclaw update` command only supports npm/pnpm global installs and git checkouts. Binary installs need a dedicated update path that downloads the correct platform binary from GitHub Releases.

## Design

### Detection

Add `installKind: "binary"` to `UpdateCheckResult`. Detection: when `process.execPath` basename is `openclaw` (or `openclaw.exe`) and is NOT a Node/Bun runtime binary, classify as binary install. In the bun-compiled binary, the build-info patcher already hardcodes `resolveOpenClawPackageRoot` to return `dirname(process.execPath)` — this is a reliable signal.

### Version Check

Query GitHub Releases API for latest version:

```
GET https://api.github.com/repos/CherryHQ/cherry-studio/releases/latest
```

Compare `tag_name` (e.g. `v2026.3.10`) against current `VERSION`. Support beta channel via listing releases and finding latest prerelease.

### Asset Matching

Map `process.platform` + `process.arch` to release asset name:

| Platform | Arch  | Asset                          |
| -------- | ----- | ------------------------------ |
| darwin   | arm64 | `openclaw-darwin-arm64.tar.gz` |
| darwin   | x64   | `openclaw-darwin-x64.tar.gz`   |
| linux    | x64   | `openclaw-linux-x64.tar.gz`    |
| linux    | arm64 | `openclaw-linux-arm64.tar.gz`  |
| win32    | x64   | `openclaw-windows-x64.zip`     |
| win32    | arm64 | `openclaw-windows-arm64.zip`   |

### Update Flow (in-place replace)

1. Download matching asset to temp file
2. Extract to temp directory
3. **Unix:** atomic `rename(tmpBinary, process.execPath)`
4. **Windows:** `rename(process.execPath, process.execPath + '.old')` then `rename(tmpBinary, process.execPath)` — clean up `.old` on next startup
5. `chmod +x` on Unix
6. Restart gateway if running

### File Changes

| File                                   | Change                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/infra/update-check.ts`            | Extend `installKind` type to include `"binary"`; add `fetchGitHubLatestRelease()` helper |
| `src/infra/update-channels.ts`         | Extend `installKind` type refs; binary defaults to `"stable"` channel                    |
| `src/infra/update-binary.ts`           | **New:** `downloadAndReplaceBinary()` — download, extract, replace binary in-place       |
| `src/cli/update-cli/update-command.ts` | Add binary branch in `updateCommand()`; call `downloadAndReplaceBinary()`                |
| `src/cli/update-cli/shared.ts`         | `resolveUpdateRoot()` returns `dirname(process.execPath)` for binary                     |
| `src/cli/update-cli/status.ts`         | Display binary install info                                                              |
| `src/infra/update-startup.ts`          | Background update check supports binary kind                                             |

### Unchanged

- Plugin updates, shell completion, doctor, daemon restart — run normally after binary replacement
- Update wizard — hides git/dev channel for binary installs (binary only supports stable/beta)
- Existing npm/git update paths — no regressions

### Edge Cases

- **Permission denied:** binary in `/usr/local/bin` may need sudo. Detect and prompt.
- **Running gateway:** prepare restart script before replacing binary (existing pattern from `restart-helper.ts`).
- **Windows locked exe:** rename-then-replace pattern handles this.
- **Network failure:** temp file cleanup on error; no partial state.
- **Downgrade:** same confirmation flow as existing npm path.
