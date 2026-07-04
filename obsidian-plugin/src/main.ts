import { execFile } from "child_process";
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

  private repoRoot(): string {
    // vault lives inside the repo (Q16); the vault base path is a subdir of it
    const adapter = this.app.vault.adapter as { basePath?: string };
    return adapter.basePath ?? ".";
  }

  drift(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "npx",
        ["--yes", "driftdocs", ...args],
        { cwd: this.repoRoot(), timeout: 30_000 },
        (err, stdout, stderr) => {
          if (err && !stdout) reject(new Error(stderr || err.message));
          else resolve(stdout);
        },
      );
    });
  }

  git(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd: this.repoRoot(), timeout: 60_000 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve(stdout);
        },
      );
    });
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
      // note path relative to repo root = docsDir prefix handled by CLI config
      const out = await this.plugin.drift(["code", file.path]);
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
