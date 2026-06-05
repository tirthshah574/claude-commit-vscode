# Claude Commit

Generate commit messages with Claude directly from VS Code's Source Control panel.

## Usage

1. Stage your changes
2. Click the **robot icon** in the SCM toolbar
3. The commit message box is filled automatically — review and commit

You can also run **Claude Commit: Generate Commit Message** from the Command Palette (`⌘⇧P`).

## Requirements

- [Claude Code CLI](https://claude.ai/code) installed and available in your `PATH`
- A git repository open in VS Code

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeCommit.claudePath` | `claude` | Path to the `claude` binary if not in PATH |
| `claudeCommit.timeout` | `30000` | Timeout in ms |

## Install from VSIX

```bash
code --install-extension claude-commit-vscode-0.1.0.vsix
```

## License

MIT
