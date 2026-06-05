import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// Replaces the large default Claude Code coding-agent system prompt with a tight,
// task-specific contract — the single biggest input-token saving available without
// --bare (which would break OAuth/keychain auth).
const COMMIT_SYSTEM_PROMPT =
  'You are a git commit message generator. Output ONLY the raw commit message text — ' +
  'no explanation, no markdown fences, no quotes. Just the message itself, ready to copy-paste. ' +
  'Rules: ' +
  '1. Study the recent commits provided and match the exact format and style of the project. ' +
  '2. Use conventional commit types where applicable: feat, fix, refactor, docs, test, chore, perf, style, delete. ' +
  '3. Subject line: imperative mood, lowercase after the prefix, no trailing period, max 72 chars. ' +
  '4. If there are multiple logical changes, write a multi-line message with a short subject and a bullet-point body. ' +
  '5. If commit guidelines from a CLAUDE.md file are provided, treat them as the highest priority and follow them strictly alongside the recent commit style. ' +
  'If there are no changes, say: "No changes to commit."';

// ~25k tokens — generous for normal code, prevents argv-limit issues on huge diffs.
const MAX_DIFF_CHARS = 100_000;

// Applied to every diff call so generated files never inflate token usage.
// Harmless when no generated files are present.
const GENERATED_PATHSPECS = [
  ':(exclude)package-lock.json',
  ':(exclude)pnpm-lock.yaml',
  ':(exclude)yarn.lock',
  ':(exclude)*.lock',
  ':(exclude)*.min.js',
  ':(exclude)*.min.css',
  ':(exclude)*.map',
  ':(exclude)dist/',
  ':(exclude)build/',
];

function isLockFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return (
    base === 'package-lock.json' ||
    base === 'pnpm-lock.yaml' ||
    base === 'yarn.lock' ||
    base.endsWith('.lock')
  );
}

function isGeneratedFile(filePath: string): boolean {
  if (isLockFile(filePath)) { return true; }
  const base = path.basename(filePath);
  if (base.endsWith('.min.js') || base.endsWith('.min.css') || base.endsWith('.map')) {
    return true;
  }
  const segments = filePath.split(/[/\\]/);
  return segments.includes('dist') || segments.includes('build');
}

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

  // Fast-path: all staged files are generated (lockfiles, dist, …) — skip the LLM entirely.
  // This is the most common "boring" commit scenario and has zero latency.
  const trivialMessage = await tryTrivialCommitMessage(cwd);
  if (trivialMessage !== null) {
    repo.inputBox.value = trivialMessage;
    return;
  }

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

// Returns a deterministic message when all staged files are generated, or null to continue
// with the normal LLM flow. Only fires when there ARE staged files and ALL are generated.
async function tryTrivialCommitMessage(cwd: string): Promise<string | null> {
  const raw = await gitExec(['diff', '--cached', '--name-only'], cwd).catch(() => '');
  const staged = raw.split('\n').filter(Boolean);
  if (staged.length === 0 || staged.some(f => !isGeneratedFile(f))) {
    return null;
  }
  return staged.every(f => isLockFile(f))
    ? 'chore: update dependencies'
    : 'chore: update generated assets';
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

async function getStagedDiff(cwd: string): Promise<string> {
  const diff = await gitExec(['diff', '--cached', ...GENERATED_PATHSPECS], cwd);
  if (!diff.trim()) { return ''; }
  if (diff.length <= MAX_DIFF_CHARS) { return diff; }
  // Diff too large — fall back to --stat so the model still gets file-level context
  const stat = await gitExec(['diff', '--cached', '--stat', ...GENERATED_PATHSPECS], cwd);
  return `[Large diff — showing file change summary only]\n${stat}`;
}

async function getGitDiff(cwd: string): Promise<string> {
  const staged = await getStagedDiff(cwd);
  if (staged.trim()) {
    return staged;
  }

  // Unstaged tracked changes
  const unstaged = await gitExec(['diff', ...GENERATED_PATHSPECS], cwd).catch(() => '');

  // Untracked (new) files — include their content, skip generated
  const untrackedList = await gitExec(['ls-files', '--others', '--exclude-standard'], cwd).catch(() => '');
  const untrackedFiles = untrackedList.split('\n').filter(f => f && !isGeneratedFile(f));

  let untrackedDiff = '';
  for (const file of untrackedFiles) {
    try {
      const buf = fs.readFileSync(path.join(cwd, file));
      // Skip binary files — null bytes in spawn args cause an EINVAL crash
      if (buf.includes(0)) {
        untrackedDiff += `\n+++ new file: ${file} [binary]\n`;
      } else {
        untrackedDiff += `\n+++ new file: ${file}\n${buf.toString('utf8')}`;
      }
    } catch {
      untrackedDiff += `\n+++ new file: ${file}\n`;
    }
  }

  const combined = (unstaged + untrackedDiff).trim();
  return combined.length > MAX_DIFF_CHARS ? combined.slice(0, MAX_DIFF_CHARS) : combined;
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
  const sectionKeywords = /commit|message|conventional|format|style|prefix/i;
  const candidates = [
    path.join(cwd, 'CLAUDE.md'),
    path.join(cwd, '..', 'CLAUDE.md'),
  ];

  for (const filePath of candidates) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');

      let sectionStart = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^#{1,3}\s/.test(lines[i]) && sectionKeywords.test(lines[i])) {
          sectionStart = i;
          break;
        }
      }

      if (sectionStart !== -1) {
        const headerLevel = (lines[sectionStart].match(/^#+/) ?? [''])[0].length;
        const headerPattern = new RegExp(`^#{1,${headerLevel}}\\s`);
        let sectionEnd = lines.length;
        for (let i = sectionStart + 1; i < lines.length; i++) {
          if (headerPattern.test(lines[i])) {
            sectionEnd = i;
            break;
          }
        }
        return Promise.resolve(lines.slice(sectionStart, sectionEnd).join('\n').trim());
      }

      if (content.trim()) {
        return Promise.resolve(content.trim());
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
    let prompt = '';

    if (recentCommits) {
      prompt += `Commit style (follow this pattern):\n${recentCommits}\n\n`;
    }

    if (claudeMdExcerpt) {
      prompt += `Project standards:\n${claudeMdExcerpt}\n\n`;
    }

    prompt += `Diff:\n${diff}`;

    const args = [
      '--print',
      '--model', model,
      '--effort', 'low',
      '--system-prompt', COMMIT_SYSTEM_PROMPT,
      '--setting-sources', '',
      prompt,
      '--tools', '',   // must come after the positional prompt — --tools is variadic
    ];

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
