# Claude Commit — VS Code Extension

## Project Overview

VS Code extension that adds a sparkle (✦) button to the SCM toolbar. Clicking it runs `claude --print /commit-msg` in the workspace root and writes the output into the SCM commit input box.

Entry point: `src/extension.ts` → compiled to `out/extension.js`

## Build & Development

```bash
npm run compile          # one-shot TypeScript compile
npm run watch            # incremental watch mode
npm run lint             # ESLint on src/
```

Press **F5** in VS Code to launch the Extension Development Host.

Package for distribution:
```bash
npx vsce package         # produces claude-commit-*.vsix
```

## Architecture

- `src/extension.ts` — single file; `activate()` registers `claudeCommit.generate`
- The command: resolves workspace root → gets `vscode.git` API → checks staged changes → spawns `claude --print /commit-msg` → writes trimmed stdout to `repo.inputBox.value`
- No runtime dependencies; only `devDependencies` (TypeScript, `@types/vscode`, `@types/node`)

## Coding Standards

See `.claude/rules/typescript.md` for TypeScript rules and `.claude/rules/vscode-extension.md` for VS Code API conventions.

- Target ES2020 / CommonJS (set in `tsconfig.json`)
- `strict: true` — no implicit any, no unchecked indexing
- No comments unless the WHY is non-obvious; self-documenting identifiers preferred
- No `console.log` in production code — use `vscode.window.show*Message` for user-facing output

## Key Constraints

- Only the public `scm/title` menu contribution point is available to third-party extensions for the SCM toolbar (not the input-box interior, which requires internal VS Code APIs)
- The `vscode.git` built-in extension must be active; always guard with `isActive` / `activate()` before calling `getAPI(1)`
- `repo.inputBox.value` is the correct property for the SCM commit message box (not `repo.state.HEAD`)
- Spawn the Claude CLI with `shell: false` to avoid injection; inherit `process.env` and ensure `PATH` is set

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeCommit.claudePath` | `"claude"` | Path to claude CLI binary |
| `claudeCommit.timeout` | `30000` | Timeout in ms for CLI |
