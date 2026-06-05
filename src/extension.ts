import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Claude Commit');
  context.subscriptions.push(outputChannel);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'claudeCommit.generate';
  statusBarItem.text = '$(hubot) Claude Commit';
  statusBarItem.tooltip = 'Generate commit message with Claude';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const disposable = vscode.commands.registerCommand(
    'claudeCommit.generate',
    async () => {
      await generateCommitMessage(outputChannel);
    }
  );

  context.subscriptions.push(disposable);
}

async function generateCommitMessage(outputChannel: vscode.OutputChannel): Promise<void> {
  // Resolve workspace root
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage(
      'Claude Commit: No workspace folder is open. Please open a git repository.'
    );
    return;
  }

  // Use the first workspace folder as the repo root
  const repoRoot = workspaceFolders[0].uri.fsPath;

  // Get the Git extension to access the SCM input box
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) {
    vscode.window.showErrorMessage(
      'Claude Commit: The built-in Git extension is not available.'
    );
    return;
  }

  const git = gitExtension.isActive
    ? gitExtension.exports
    : await gitExtension.activate();

  const api = git.getAPI(1);
  if (!api) {
    vscode.window.showErrorMessage(
      'Claude Commit: Could not access the Git API.'
    );
    return;
  }

  // Find the repository matching the workspace root
  let repo = api.repositories.find((r: { rootUri: vscode.Uri }) =>
    r.rootUri.fsPath === repoRoot ||
    repoRoot.startsWith(r.rootUri.fsPath + path.sep)
  );

  if (!repo && api.repositories.length > 0) {
    // Fall back to first available repository
    repo = api.repositories[0];
  }

  if (!repo) {
    vscode.window.showErrorMessage(
      'Claude Commit: No git repository found in the current workspace.'
    );
    return;
  }

  // Read settings
  const config = vscode.workspace.getConfiguration('claudeCommit');
  const claudePath: string = config.get('claudePath', 'claude');
  const timeoutMs: number = config.get('timeout', 30000);

  // Get staged diff first; bail early if nothing is staged
  let diff: string;
  try {
    diff = await getGitDiff(repo!.rootUri.fsPath);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(
      `Claude Commit: Failed to get git diff — ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  if (!diff.trim()) {
    vscode.window.showWarningMessage('Claude Commit: No staged changes found. Stage some files first.');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Claude Commit',
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: 'Generating commit message…' });

      let message: string;
      try {
        message = await runClaude(claudePath, repo!.rootUri.fsPath, diff, timeoutMs, token, outputChannel);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const selection = await vscode.window.showErrorMessage(`Claude Commit: ${msg}`, 'Show Output');
        if (selection === 'Show Output') {
          outputChannel.show();
        }
        return;
      }

      if (token.isCancellationRequested) {
        return;
      }

      const trimmed = message.trim();
      if (!trimmed) {
        vscode.window.showWarningMessage(
          'Claude Commit: The CLI returned an empty message. Make sure changes are staged.'
        );
        return;
      }

      // Write the generated message into the SCM input box
      repo!.inputBox.value = trimmed;
    }
  );
}

function getGitDiff(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['diff', '--cached'], { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`git diff failed (code ${code}): ${stderr.trim()}`));
      }
    });
  });
}

function runClaude(
  claudePath: string,
  cwd: string,
  diff: string,
  timeoutMs: number,
  token: vscode.CancellationToken,
  outputChannel: vscode.OutputChannel
): Promise<string> {
  return new Promise((resolve, reject) => {
    const prompt =
      'Generate a concise conventional commit message for the following staged changes. ' +
      'Output only the commit message text, nothing else — no explanation, no markdown, no quotes.\n\n' +
      diff;
    const args = ['--print', prompt];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(claudePath, args, {
        cwd,
        shell: false,
        env: {
          ...process.env,
          // Ensure the CLI has a proper PATH so it can find git etc.
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        },
      });
    } catch (err: unknown) {
      reject(
        new Error(
          `Failed to spawn claude CLI ("${claudePath}"): ${err instanceof Error ? err.message : String(err)}`
        )
      );
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      outputChannel.appendLine(text.trimEnd());
    });

    // Timeout guard
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `Claude CLI timed out after ${timeoutMs}ms. You can increase the timeout via the 'claudeCommit.timeout' setting.`
        )
      );
    }, timeoutMs);

    // Cancellation support
    const cancelDisposable = token.onCancellationRequested(() => {
      clearTimeout(timer);
      child.kill();
      reject(new Error('Cancelled'));
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      cancelDisposable.dispose();
      if (err.message.includes('ENOENT')) {
        reject(
          new Error(
            `claude CLI not found at "${claudePath}". Install Claude Code CLI or set the 'claudeCommit.claudePath' setting.`
          )
        );
      } else {
        reject(err);
      }
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      cancelDisposable.dispose();

      if (token.isCancellationRequested) {
        return; // already rejected above
      }

      if (code === 0) {
        resolve(stdout);
      } else {
        outputChannel.appendLine(`claude exited with code ${code}`);
        const detail = stderr.trim() || stdout.trim();
        reject(
          new Error(
            `claude CLI exited with code ${code}.${detail ? ' ' + detail : ''}`
          )
        );
      }
    });
  });
}

export function deactivate() {
  // Nothing to clean up
}
