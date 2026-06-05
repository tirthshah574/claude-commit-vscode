# Claude Commit — VS Code Extension

Generate AI-powered commit messages using the [Claude CLI](https://claude.ai/code) directly from VS Code's Source Control panel.

## How it works

A sparkle button (✦) appears in the SCM toolbar above the commit message input box. Click it and the extension:

1. Detects your staged git changes
2. Invokes the `claude` CLI in your repo directory
3. Streams the generated message back into the commit input box

## Requirements

- [Claude Code CLI](https://claude.ai/code) installed and available in your `PATH`
- A git repository open in VS Code

## Usage

1. Stage your changes in the Source Control panel
2. Click the **✦ Generate with Claude** button in the SCM toolbar
3. Review and edit the generated message
4. Commit as usual (`⌘Enter`)

Alternatively, use the keyboard shortcut `⌘⇧G` then trigger the command from the Command Palette:
> **Claude Commit: Generate Commit Message**

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `claudeCommit.claudePath` | `claude` | Path to the `claude` CLI binary (if not in PATH) |
| `claudeCommit.timeout` | `30000` | Timeout in ms for CLI invocation |

## Installation

### From source

```bash
git clone https://github.com/yourname/claude-commit-vscode
cd claude-commit-vscode
npm install
npm run compile
# Press F5 in VS Code to launch Extension Development Host
```

### From VSIX

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension claude-commit-*.vsix
```

## How it differs from GitHub Copilot

GitHub Copilot's sparkle icon sits inside the commit input box via undocumented internal VS Code APIs. This extension places its button in the **SCM title toolbar** — the row directly above the input box — which is the highest position accessible to third-party extensions via the public `scm/title` menu contribution point.

## License

MIT
