import { execFile } from "child_process";
import { existsSync } from "fs";
import { dirname, join, relative, sep } from "path";
import * as vscode from "vscode";

/**
 * Drift VS Code extension: puts spec-link status where engineers already
 * look. One CodeLens per linked symbol —
 *   `spec: ✓ fresh  docs/auth.md#login-flow`
 * Clicking opens the spec section; stale links get an extra `Approve` lens,
 * broken links with a rename candidate get `Relink`.
 *
 * All judgment lives in the drift CLI (`drift file-links --json`); the
 * extension is presentation only, mirroring the Obsidian plugin's design.
 */

interface FileLink {
  linkId: number;
  symbol: string;
  anchorId: string;
  heading: string;
  status: "fresh" | "stale" | "broken";
  startLine: number | null;
  endLine: number | null;
  movedTo?: { symbol: string; filePath: string };
}

const STATUS_ICON: Record<FileLink["status"], string> = {
  fresh: "✓",
  stale: "△",
  broken: "✗",
};

function driftCommand(): string[] {
  const cmd = vscode.workspace.getConfiguration("drift").get<string>("command") ?? "npx --yes driftdocs";
  return cmd.split(/\s+/).filter(Boolean);
}

/** Walk up from the file's directory to the dir containing .drift/ (or .git). */
function repoRootFor(fileDir: string): string | null {
  let dir = fileDir;
  for (;;) {
    if (existsSync(join(dir, ".drift")) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * GUI apps on macOS/Linux don't inherit the user's shell PATH (no .zshrc/.bashrc
 * sourcing), so tools installed via nvm/mise/volta/homebrew are often not found
 * by a plain execFile. Running through a login+interactive shell picks up the
 * same PATH the user gets in a terminal.
 */
function runDrift(root: string, args: string[], timeoutMs = 20_000): Promise<string> {
  const [cmd, ...base] = driftCommand();
  return new Promise((resolve, reject) => {
    if (process.platform === "win32") {
      execFile(
        cmd,
        [...base, ...args],
        { cwd: root, timeout: timeoutMs, shell: true },
        (err, stdout, stderr) => {
          if (err && !stdout) reject(new Error(stderr.trim() || err.message));
          else resolve(stdout);
        },
      );
      return;
    }
    const shell = process.env.SHELL || "/bin/zsh";
    const quoted = [cmd, ...base, ...args]
      .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
      .join(" ");
    execFile(
      shell,
      ["-ilc", quoted],
      { cwd: root, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err && !stdout) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      },
    );
  });
}

class DriftLensProvider implements vscode.CodeLensProvider {
  private cache = new Map<string, { version: number; links: FileLink[] }>();
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  refresh(document?: vscode.TextDocument): void {
    if (document) this.cache.delete(document.uri.fsPath);
    else this.cache.clear();
    this.emitter.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!vscode.workspace.getConfiguration("drift").get<boolean>("enableCodeLens")) return [];
    if (document.uri.scheme !== "file") return [];

    const root = repoRootFor(dirname(document.uri.fsPath));
    if (!root || !existsSync(join(root, ".drift"))) return [];
    const rel = relative(root, document.uri.fsPath).split(sep).join("/");

    let entry = this.cache.get(document.uri.fsPath);
    if (!entry || entry.version !== document.version) {
      try {
        const out = await runDrift(root, ["file-links", rel, "--json"]);
        const start = out.indexOf("[");
        const links = start === -1 ? [] : (JSON.parse(out.slice(start)) as FileLink[]);
        entry = { version: document.version, links };
        this.cache.set(document.uri.fsPath, entry);
      } catch {
        return []; // drift unavailable — stay silent rather than nag
      }
    }

    const lenses: vscode.CodeLens[] = [];
    for (const link of entry.links) {
      const line = Math.max(0, (link.startLine ?? 1) - 1);
      const range = new vscode.Range(line, 0, line, 0);

      lenses.push(
        new vscode.CodeLens(range, {
          title: `spec: ${STATUS_ICON[link.status]} ${link.status}  ${link.anchorId}`,
          tooltip: `${link.heading} — click to open the spec section`,
          command: "drift.openSpec",
          arguments: [root, link.anchorId],
        }),
      );
      if (link.status === "stale") {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "Approve (still correct)",
            tooltip: "Re-pin this link: the code and spec still agree",
            command: "drift.approve",
            arguments: [root, link.linkId, document],
          }),
        );
      }
      if (link.status === "broken" && link.movedTo) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `Relink → ${link.movedTo.symbol}`,
            tooltip: "The old symbol vanished but this one has identical content",
            command: "drift.relink",
            arguments: [root, link.linkId, document],
          }),
        );
      }
    }
    return lenses;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new DriftLensProvider();

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, provider),

    vscode.workspace.onDidSaveTextDocument((doc) => provider.refresh(doc)),

    vscode.commands.registerCommand("drift.refresh", () => provider.refresh()),

    vscode.commands.registerCommand(
      "drift.openSpec",
      async (root: string, anchorId: string) => {
        const [file, slug] = anchorId.split("#");
        const uri = vscode.Uri.file(join(root, file));
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        if (slug) {
          // jump to the heading whose slug matches
          const text = doc.getText();
          const lines = text.split("\n");
          const target = lines.findIndex((l) => {
            const m = l.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
            if (!m) return false;
            const derived = m[1].trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
            return derived === slug;
          });
          if (target >= 0) {
            const pos = new vscode.Position(target, 0);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
            editor.selection = new vscode.Selection(pos, pos);
          }
        }
      },
    ),

    vscode.commands.registerCommand(
      "drift.approve",
      async (root: string, linkId: number, doc?: vscode.TextDocument) => {
        try {
          await runDrift(root, ["approve", String(linkId)]);
          vscode.window.showInformationMessage(`Drift: approved link ${linkId}`);
          provider.refresh(doc);
        } catch (e) {
          vscode.window.showErrorMessage(`Drift approve failed: ${(e as Error).message}`);
        }
      },
    ),

    vscode.commands.registerCommand(
      "drift.relink",
      async (root: string, linkId: number, doc?: vscode.TextDocument) => {
        try {
          const out = await runDrift(root, ["relink", String(linkId)]);
          vscode.window.showInformationMessage(`Drift: ${out.trim()}`);
          provider.refresh(doc);
        } catch (e) {
          vscode.window.showErrorMessage(`Drift relink failed: ${(e as Error).message}`);
        }
      },
    ),
  );
}

export function deactivate(): void {}
