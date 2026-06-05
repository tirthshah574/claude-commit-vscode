---
paths:
  - "src/**/*.ts"
  - "package.json"
---

# VS Code Extension Rules

## API Usage
- Always guard `vscode.extensions.getExtension(...)` with both existence and activation checks
- Use `gitExtension.isActive ? gitExtension.exports : await gitExtension.activate()` pattern
- Register all disposables via `context.subscriptions.push(...)`
- Use `vscode.window.withProgress` with `cancellable: true` for any CLI invocation
- Never use internal/undocumented VS Code APIs; only the public `vscode` module

## SCM Integration
- The `scm/title` menu contribution point is the only public toolbar location for third-party extensions
- `repo.inputBox.value` writes to the commit message box
- `repo.state.indexChanges` holds staged files — check length before running Claude

## Error Handling
- Use `vscode.window.showErrorMessage` for hard failures
- Use `vscode.window.showWarningMessage` for soft failures (no staged changes, empty output)
- Always handle ENOENT separately with a helpful install message
- Clean up timers and cancellation disposables in all code paths (`clearTimeout` + `dispose()`)

## Child Process
- Spawn with `shell: false` — never interpolate user input into shell strings
- Always inherit `process.env` and ensure `PATH` includes standard bin directories
- Capture both `stdout` and `stderr`; report stderr in error messages when non-empty

## package.json
- `activationEvents` should be minimal — only `onCommand:claudeCommit.generate`
- Keep `engines.vscode` at the minimum version that provides needed APIs
- No runtime `dependencies` — all packages go in `devDependencies`
