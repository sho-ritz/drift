import { execFile } from "child_process";
import { existsSync } from "fs";
import { dirname, join, relative, sep } from "path";
import {
  App,
  FileSystemAdapter,
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";

const VIEW_TYPE = "drift-status";

interface DriftSettings {
  /** command used to invoke the drift CLI, split on spaces */
  driftCommand: string;
  /** commit message used by Publish */
  commitMessage: string;
  /** refresh the panel automatically when the active note changes */
  autoRefresh: boolean;
  /** also push after committing */
  pushOnPublish: boolean;
}

const DEFAULT_SETTINGS: DriftSettings = {
  driftCommand: "npx --yes driftdocs",
  commitMessage: "docs: publish from Obsidian",
  autoRefresh: true,
  pushOnPublish: true,
};

/** One row of `drift code <note> --json`. */
interface CodeLink {
  linkId: number;
  anchorId: string;
  heading: string;
  symbol: string;
  filePath: string;
  status: "fresh" | "stale" | "broken";
  origin: string;
}

/**
 * Non-engineer facing surface (Q15/Q18):
 *  - status panel: code symbols linked to the open note, grouped by spec
 *    section, with fresh/stale/broken badges
 *  - one-click "still correct" approval and unlink for broken links
 *    (same shared store as the PR bot)
 *  - explicit "Publish" button = git add/commit/push of the docs dir (Q17)
 *
 * The plugin shells out to the `drift` CLI so judgment logic lives in one
 * place (@driftdocs/core); Obsidian is presentation only.
 */
export default class DriftPlugin extends Plugin {
  settings: DriftSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new DriftStatusView(leaf, this));
    this.addSettingTab(new DriftSettingsTab(this.app, this));

    this.addRibbonIcon("git-compare-arrows", "Drift status", () => this.activateView());

    this.addCommand({
      id: "drift-open-panel",
      name: "Open status panel",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "drift-refresh",
      name: "Refresh status",
      callback: () => this.refreshView(),
    });
    this.addCommand({
      id: "drift-publish",
      name: "Publish docs (commit & push)",
      callback: () => this.publish(),
    });

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        if (this.settings.autoRefresh) this.refreshView();
      }),
    );
  }

  onunload() {}

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private vaultBasePath(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : ".";
  }

  /**
   * The vault base path is a subdir of the repo (Q16) — e.g. this vault is
   * rooted at docs/, while .drift/ and .git live one level up. Drift's
   * links are stored repo-root-relative, so both the cwd we shell out from
   * and any note paths we pass to `drift` must resolve against the actual
   * repo root, not the vault's base path.
   */
  repoRoot(): string {
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
    const [cmd, ...base] = this.settings.driftCommand.split(/\s+/).filter(Boolean);
    return this.shellExec(cmd ?? "npx", [...base, ...args], this.repoRoot(), 30_000);
  }

  git(args: string[]): Promise<string> {
    return this.shellExec("git", args, this.repoRoot(), 60_000);
  }

  /** Links for one note, via the CLI's JSON output. */
  async codeLinks(noteRepoPath: string): Promise<CodeLink[]> {
    const out = await this.drift(["code", noteRepoPath, "--json"]);
    const start = out.indexOf("[");
    if (start === -1) return [];
    return JSON.parse(out.slice(start)) as CodeLink[];
  }

  async approve(linkId: number): Promise<void> {
    await this.drift(["approve", String(linkId)]);
  }

  async unlink(linkId: number): Promise<void> {
    await this.drift(["unlink", String(linkId)]);
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
      await this.git(["commit", "-m", this.settings.commitMessage]);
      if (this.settings.pushOnPublish) await this.git(["push"]);
      await this.drift(["index"]).catch(() => {});
      new Notice(this.settings.pushOnPublish ? "Drift: published" : "Drift: committed");
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

const STATUS_LABEL: Record<CodeLink["status"], string> = {
  fresh: "Fresh",
  stale: "Stale",
  broken: "Broken",
};

const STATUS_HINT: Record<CodeLink["status"], string> = {
  fresh: "Code and spec are unchanged since the last approval.",
  stale: "Code or spec changed since approval — review whether they still agree.",
  broken: "The linked symbol or section no longer exists.",
};

class DriftStatusView extends ItemView {
  private rendering = false;

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

  private iconButton(parent: HTMLElement, icon: string, tooltip: string, onClick: () => void): HTMLElement {
    const btn = parent.createEl("button", { cls: "drift-icon-btn", attr: { "aria-label": tooltip } });
    setIcon(btn, icon);
    btn.onclick = onClick;
    return btn;
  }

  async render() {
    if (this.rendering) return;
    this.rendering = true;
    try {
      await this.renderInner();
    } finally {
      this.rendering = false;
    }
  }

  private async renderInner() {
    const el = this.containerEl.children[1] as HTMLElement;
    el.empty();
    el.addClass("drift-panel");

    // ---- toolbar -----------------------------------------------------
    const toolbar = el.createDiv({ cls: "drift-toolbar" });
    toolbar.createEl("h4", { text: "Drift", cls: "drift-title" });
    const actions = toolbar.createDiv({ cls: "drift-toolbar-actions" });
    this.iconButton(actions, "refresh-cw", "Refresh", () => this.render());
    const publishBtn = actions.createEl("button", {
      text: "Publish",
      cls: "mod-cta drift-publish-btn",
    });
    publishBtn.onclick = () => this.plugin.publish();

    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      el.createDiv({
        cls: "drift-empty",
        text: "Open a Markdown note to see the code it corresponds to.",
      });
      return;
    }

    el.createDiv({ cls: "drift-note-name", text: file.basename });

    const body = el.createDiv({ cls: "drift-body" });
    body.createDiv({ cls: "drift-loading", text: "Loading…" });

    let links: CodeLink[];
    try {
      links = await this.plugin.codeLinks(this.plugin.toRepoRelativePath(file.path));
    } catch (e) {
      body.empty();
      const err = body.createDiv({ cls: "drift-error" });
      err.createDiv({ text: "Could not query Drift." });
      err.createEl("code", { text: (e as Error).message });
      err.createDiv({
        cls: "drift-error-hint",
        text: "Is the repo initialized? Run `drift init && drift index && drift sync` in a terminal, and check the CLI command in the plugin settings.",
      });
      return;
    }

    body.empty();

    // ---- summary -----------------------------------------------------
    const counts = { fresh: 0, stale: 0, broken: 0 };
    for (const l of links) counts[l.status]++;
    const summary = body.createDiv({ cls: "drift-summary" });
    for (const status of ["fresh", "stale", "broken"] as const) {
      const chip = summary.createDiv({
        cls: `drift-chip drift-chip-${status}`,
        attr: { "aria-label": STATUS_HINT[status] },
      });
      chip.createSpan({ cls: "drift-chip-count", text: String(counts[status]) });
      chip.createSpan({ text: ` ${STATUS_LABEL[status].toLowerCase()}` });
    }

    if (links.length === 0) {
      body.createDiv({
        cls: "drift-empty",
        text: "No code is linked to this note yet. Links come from @spec: comments in code, .drift/links.json, or `drift suggest`.",
      });
      return;
    }

    // ---- links grouped by spec section --------------------------------
    const byAnchor = new Map<string, { heading: string; rows: CodeLink[] }>();
    for (const l of links) {
      const g = byAnchor.get(l.anchorId) ?? { heading: l.heading, rows: [] };
      g.rows.push(l);
      byAnchor.set(l.anchorId, g);
    }

    for (const [anchorId, group] of byAnchor) {
      const section = body.createDiv({ cls: "drift-section" });
      const head = section.createDiv({ cls: "drift-section-head" });
      setIcon(head.createSpan({ cls: "drift-section-icon" }), "hash");
      head.createSpan({ cls: "drift-section-heading", text: group.heading });
      head.createSpan({ cls: "drift-section-anchor", text: anchorId.split("#")[1] ?? "" });

      for (const link of group.rows) {
        const row = section.createDiv({ cls: `drift-row drift-row-${link.status}` });

        const badge = row.createSpan({
          cls: `drift-badge drift-badge-${link.status}`,
          text: STATUS_LABEL[link.status],
          attr: { "aria-label": STATUS_HINT[link.status] },
        });
        badge.tabIndex = 0;

        const main = row.createDiv({ cls: "drift-row-main" });
        main.createEl("code", { cls: "drift-symbol", text: link.symbol });
        main.createDiv({ cls: "drift-file", text: link.filePath });

        const rowActions = row.createDiv({ cls: "drift-row-actions" });
        if (link.status === "stale") {
          const approveBtn = rowActions.createEl("button", {
            text: "Still correct",
            cls: "drift-approve-btn",
            attr: { "aria-label": "Re-approve: the code and this section still agree" },
          });
          approveBtn.onclick = async () => {
            approveBtn.disabled = true;
            try {
              await this.plugin.approve(link.linkId);
              new Notice(`Drift: approved ${link.symbol}`);
              this.render();
            } catch (e) {
              approveBtn.disabled = false;
              new Notice(`Drift approve failed: ${(e as Error).message}`);
            }
          };
        }
        if (link.status === "broken") {
          const unlinkBtn = rowActions.createEl("button", {
            text: "Remove link",
            cls: "drift-unlink-btn",
            attr: { "aria-label": "Remove this link (the code or section is gone)" },
          });
          unlinkBtn.onclick = async () => {
            unlinkBtn.disabled = true;
            try {
              await this.plugin.unlink(link.linkId);
              new Notice(`Drift: removed link to ${link.symbol}`);
              this.render();
            } catch (e) {
              unlinkBtn.disabled = false;
              new Notice(`Drift unlink failed: ${(e as Error).message}`);
            }
          };
        }
      }
    }

    body.createDiv({
      cls: "drift-footer",
      text: `Updated ${new Date().toLocaleTimeString()}`,
    });
  }
}

class DriftSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: DriftPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Drift CLI command")
      .setDesc("How to invoke the drift CLI. Use `npx --yes driftdocs`, or an absolute path if drift is installed globally.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.driftCommand)
          .setValue(this.plugin.settings.driftCommand)
          .onChange(async (v) => {
            this.plugin.settings.driftCommand = v.trim() || DEFAULT_SETTINGS.driftCommand;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Commit message")
      .setDesc("Used by the Publish button.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.commitMessage)
          .setValue(this.plugin.settings.commitMessage)
          .onChange(async (v) => {
            this.plugin.settings.commitMessage = v.trim() || DEFAULT_SETTINGS.commitMessage;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Push on publish")
      .setDesc("Publish runs git push after committing. Turn off to only commit locally.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.pushOnPublish).onChange(async (v) => {
          this.plugin.settings.pushOnPublish = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Auto-refresh")
      .setDesc("Refresh the status panel whenever the active note changes.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoRefresh).onChange(async (v) => {
          this.plugin.settings.autoRefresh = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
