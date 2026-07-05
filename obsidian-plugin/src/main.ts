import { execFile } from "child_process";
import { existsSync } from "fs";
import { dirname, join, relative, sep } from "path";
import {
  ItemView,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

const VIEW_TYPE = "drift-status";

/**
 * Non-engineer facing surface (Q15/Q18 MVP):
 *  - status panel: code symbols linked to the open note, with fresh/stale/broken
 *  - one-click "still correct" approval (same shared store as the PR bot)
 *  - explicit "Publish" button = git add/commit/push of the docs dir (Q17)
 *
 * The plugin shells out to the `drift` CLI so judgment logic lives in one
 * place (@driftdocs/core); Obsidian is presentation only.
 */
export default class DriftPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new DriftStatusView(leaf, this));

    this.addRibbonIcon("git-compare-arrows", "Drift status", () => this.activateView());

    this.addCommand({
      id: "drift-publish",
      name: "Publish docs (commit & push)",
      callback: () => this.publish(),
    });

    this.registerEvent(
      this.app.workspace.on("file-open", () => this.refreshView()),
    );
  }

  onunload() {}

  private vaultBasePath(): string {
    const adapter = this.app.vault.adapter as { basePath?: string };
    return adapter.basePath ?? ".";
  }

  /**
   * The vault base path is a subdir of the repo (Q16) — e.g. this vault is
   * rooted at docs/, while .drift/ and .git live one level up. Drift's
   * links are stored repo-root-relative, so both the cwd we shell out from
   * and any note paths we pass to `drift` must resolve against the actual
   * repo root, not the vault's base path.
   */
  private repoRoot(): string {
    let dir = this.vaultBasePath();
    while (true) {
      if (existsSync(join(dir, ".drift")) || existsSync(join(dir, ".git"))) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) return this.vaultBasePath();
      dir = parent;
    }
  }

  /** Convert a vault-relative path (e.g. TFile.path) to repo-root-relative. */
  toRepoRelativePath(vaultRelativePath: string): string {
    const abs = join(this.vaultBasePath(), vaultRelativePath);
    return relative(this.repoRoot(), abs).split(sep).join("/");
  }

  /**
   * GUI apps on macOS/Linux don't inherit the user's shell PATH (no .zshrc/.bashrc
   * sourcing), so tools installed via nvm/mise/volta/homebrew are often not found
   * by a plain execFile. Running through a login+interactive shell picks up the
   * same PATH the user gets in a terminal.
   */
  private shellExec(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const shell = process.env.SHELL || "/bin/zsh";
      const quoted = [cmd, ...args]
        .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
        .join(" ");
      execFile(
        shell,
        ["-ilc", quoted],
        { cwd, timeout: timeoutMs },
        (err, stdout, stderr) => {
          if (err && !stdout) reject(new Error(stderr || err.message));
          else resolve(stdout);
        },
      );
    });
  }

  drift(args: string[]): Promise<string> {
    return this.shellExec("npx", ["--yes", "driftdocs", ...args], this.repoRoot(), 30_000);
  }

  git(args: string[]): Promise<string> {
    return this.shellExec("git", args, this.repoRoot(), 60_000);
  }

  /** Q17: publishing is an explicit checkpoint, not a save-time side effect. */
  async publish() {
    try {
      await this.git(["add", "-A", "."]);
      const status = await this.git(["status", "--porcelain"]);
      if (!status.trim()) {
        new Notice("Drift: no changes to publish");
        return;
      }
      await this.git(["commit", "-m", "docs: publish from Obsidian"]);
      await this.git(["push"]);
      await this.drift(["index"]).catch(() => {});
      new Notice("Drift: published");
      this.refreshView();
    } catch (e) {
      new Notice(`Drift publish failed: ${(e as Error).message}`);
    }
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  refreshView() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      (leaf.view as DriftStatusView).render();
    }
  }
}

class DriftStatusView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: DriftPlugin,
  ) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "Drift";
  }
  getIcon() {
    return "git-compare-arrows";
  }

  async onOpen() {
    await this.render();
  }

  async render() {
    const el = this.containerEl.children[1];
    el.empty();
    el.createEl("h4", { text: "Drift — この仕様のコード対応" });

    const publishBtn = el.createEl("button", { text: "公開（コミット＆プッシュ）" });
    publishBtn.onclick = () => this.plugin.publish();

    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      el.createEl("p", { text: "Markdownノートを開くと、対応するコードが表示されます。" });
      return;
    }

    const list = el.createEl("div");
    list.createEl("p", { text: "読み込み中..." });
    try {
      const notePath = this.plugin.toRepoRelativePath(file.path);
      const out = await this.plugin.drift(["code", notePath]);
      list.empty();
      const lines = out.trim().split("\n").filter(Boolean);
      if (lines.length === 0 || out.includes("no code linked")) {
        list.createEl("p", { text: "このノートに紐づくコードはまだありません。" });
        return;
      }
      for (const line of lines) {
        const row = list.createEl("div", { cls: "drift-row" });
        row.createEl("code", { text: line });
      }
    } catch (e) {
      list.empty();
      list.createEl("p", { text: `取得できませんでした: ${(e as Error).message}` });
    }
  }
}
