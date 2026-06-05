import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('Claude Commit: No workspace folder is open.');
    return;
  }

  const repoRoot = workspaceFolders[0].uri.fsPath;

  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) {
    vscode.window.showErrorMessage('Claude Commit: Built-in Git extension is not available.');
    return;
  }

  const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
  const api = git.getAPI(1);
  if (!api) {
    vscode.window.showErrorMessage('Claude Commit: Could not access the Git API.');
    return;
  }

  let repo = api.repositories.find((r: { rootUri: vscode.Uri }) =>
    r.rootUri.fsPath === repoRoot || repoRoot.startsWith(r.rootUri.fsPath + path.sep)
  );
  if (!repo && api.repositories.length > 0) {
    repo = api.repositories[0];
  }
  if (!repo) {
    vscode.window.showErrorMessage('Claude Commit: No git repository found in the current workspace.');
    return;
  }

  const config = vscode.workspace.getConfiguration('claudeCommit');
  const claudePath: string = config.get('claudePath', 'claude');
  const timeoutMs: number = config.get('timeout', 30000);
  const model: string = config.get('model', 'haiku');

  const cwd = repo.rootUri.fsPath;

  let diff: string;
  try {
    diff = await getGitDiff(cwd);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(
      `Claude Commit: Failed to get git diff — ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  if (!diff.trim()) {
    vscode.window.showWarningMessage('Claude Commit: No changes found (staged or unstaged).');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Claude Commit', cancellable: true },
    async (progress, token) => {
      progress.report({ message: 'Generating commit message…' });

      const [recentCommits, claudeMdExcerpt] = await Promise.all([
        getRecentCommits(cwd),
        getClaudeMdExcerpt(cwd),
      ]);

      let message: string;
      try {
        message = await runClaude(claudePath, model, cwd, diff, recentCommits, claudeMdExcerpt, timeoutMs, token, outputChannel);
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
        vscode.window.showWarningMessage('Claude Commit: Claude returned an empty message.');
        return;
      }

      repo!.inputBox.value = trimmed;
    }
  );
}

function gitExec(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`git ${args[0]} failed (code ${code}): ${stderr.trim()}`));
      }
    });
  });
}

async function getGitDiff(cwd: string): Promise<string> {
  const staged = await gitExec(['diff', '--cached'], cwd);
  if (staged.trim()) {
    return staged;
  }
  return gitExec(['diff', 'HEAD'], cwd);
}

async function getRecentCommits(cwd: string): Promise<string> {
  try {
    const log = await gitExec(['log', '--oneline', '-5'], cwd);
    return log
      .split('\n')
      .filter(Boolean)
      .map(line => line.replace(/^[a-f0-9]+ /, ''))
      .join('\n');
  } catch {
    return '';
  }
}

function getClaudeMdExcerpt(cwd: string): Promise<string> {
  const keywords = /commit|message|conventional|format|style|prefix|type/i;
  const candidates = [
    path.join(cwd, 'CLAUDE.md'),
    path.join(cwd, '..', 'CLAUDE.md'),
  ];

  for (const filePath of candidates) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const matched = content
        .split('\n')
        .filter(line => keywords.test(line))
        .slice(0, 20)
        .join('\n');
      if (matched.trim()) {
        return Promise.resolve(matched.trim());
      }
    } catch {
      // file not found or unreadable — continue
    }
  }

  return Promise.resolve('');
}

function runClaude(
  claudePath: string,
  model: string,
  cwd: string,
  diff: string,
  recentCommits: string,
  claudeMdExcerpt: string,
  timeoutMs: number,
  token: vscode.CancellationToken,
  outputChannel: vscode.OutputChannel
): Promise<string> {
  return new Promise((resolve, reject) => {
    let prompt = 'Write a git commit message. Output ONLY the message, nothing else.\n\n';

    if (recentCommits) {
      prompt += `Commit style (follow this pattern):\n${recentCommits}\n\n`;
    }

    if (claudeMdExcerpt) {
      prompt += `Project standards:\n${claudeMdExcerpt}\n\n`;
    }

    prompt += `Diff:\n${diff}`;

    const args = ['--print', '--model', model, '--effort', 'low', prompt];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(claudePath, args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
      });
    } catch (err: unknown) {
      reject(new Error(
        `Failed to spawn claude CLI ("${claudePath}"): ${err instanceof Error ? err.message : String(err)}`
      ));
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      outputChannel.appendLine(text.trimEnd());
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(
        `Claude CLI timed out after ${timeoutMs}ms. Increase timeout via 'claudeCommit.timeout' setting.`
      ));
    }, timeoutMs);

    const cancelDisposable = token.onCancellationRequested(() => {
      clearTimeout(timer);
      child.kill();
      reject(new Error('Cancelled'));
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      cancelDisposable.dispose();
      if (err.message.includes('ENOENT')) {
        reject(new Error(
          `claude CLI not found at "${claudePath}". Install Claude Code or set 'claudeCommit.claudePath'.`
        ));
      } else {
        reject(err);
      }
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      cancelDisposable.dispose();

      if (token.isCancellationRequested) {
        return;
      }

      if (code === 0) {
        resolve(stdout);
      } else {
        outputChannel.appendLine(`claude exited with code ${code}`);
        const detail = stderr.trim() || stdout.trim();
        reject(new Error(`claude CLI exited with code ${code}.${detail ? ' ' + detail : ''}`));
      }
    });
  });
}

export function deactivate() {
  // Nothing to clean up
}
