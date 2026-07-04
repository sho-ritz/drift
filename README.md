# Drift

仕様書とコードの対応関係を、人手の運用ルールではなく機械的に検知・維持する仕組み。

コード⇄仕様書の探索を「クエリのたびに文書全体を読む全文検索」から「事前計算済みグラフの
インデックス参照」に置き換えることで、AIエージェントのトークン使用量を構造的に削減する。
判定はすべてハッシュ比較で行い、LLM呼び出しは平常時ゼロ。

## 構成

```
packages/core     判定エンジン: アンカー抽出・ハッシュ・グラフストア・探索 (共有コア)
packages/cli      driftdocs (npm) — drift コマンド
packages/mcp      MCPサーバー: drift_context / drift_code / drift_status / drift_diff / drift_approve
obsidian-plugin   非エンジニア向け: ステータスパネル + 公開ボタン (コミュニティプラグイン配布)
templates/        GitHub Actions PR bot / git hook
```

Drift は [CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph) の拡張として動く。
シンボル解析は CodeGraph のインデックス (`.codegraph/codegraph.db`) を読み取り専用で再利用し、
Drift 自身は `.drift/drift.db` に spec アンカー・corresponds_to リンク・承認ログだけを持つ。

## データモデル

- **SpecAnchor** — markdown の見出しから自動導出されるセクション (`docs/auth.md#token-refresh`)。
  本文をキャッシュして持つので、コンテキスト取得時に文書を再読しない。
  見出しが曖昧な場合のみ `<!-- drift-anchor: name -->` で明示できる。
- **Link** — シンボル ↔ アンカーの多対多エッジ。承認時点の両側ハッシュ
  (コードは整形ノイズを正規化したもの) をピン留めする。
- **Status** — `fresh` (両側不変) / `stale` (どちらかが編集された) / `broken` (どちらかが消失)。

## 使い方

```sh
npm i -D driftdocs
npx drift init        # エージェント (claude-code/codex/gemini-cli)・戦略を選択
                      #   → CLAUDE.md 等に指示ブロックを冪等追記、skills を導入
npx drift index       # docs/ からアンカー抽出
npx drift sync        # @spec: アノテーション + .drift/links.json を反映
npx drift status      # 全リンクの fresh/stale/broken
npx drift context AuthService::refreshToken   # コード → 仕様 (階層フォールバック付き)
npx drift code docs/auth.md#login-flow        # 仕様 → コード
npx drift approve 3   # stale リンクを「まだ正しい」と再承認
npx drift mcp         # MCPサーバー起動 (stdio)
```

リンク宣言はコード側アノテーションでも:

```ts
// @spec: docs/auth.md#login-flow
async login(user: string, password: string): Promise<string> {
```

外部マッピングファイル (`.drift/links.json`) でも宣言できる (非侵襲):

```json
[{ "symbol": "AuthService::login", "spec": "docs/auth.md#login-flow" }]
```

## PR bot

`templates/drift-pr-bot.yml` を `.github/workflows/` にコピーすると、PRで変更された
ファイルに紐づくリンクだけを評価し、stale/broken をPRコメントで通知する
(マージはブロックしない)。常駐サーバーは不要。

## 設計ドキュメント

設計判断の全記録は設計サマリー (Artifact) を参照。要点:

- 検知はハッシュ比較のみ、LLMは人間の確認段階でだけ使う
- 探索は O(エッジ次数) のインデックス参照。直接リンクがなければ包含関係を遡って
  `inferred: true` 付きで返す
- 仕様書は Obsidian (git 管理下の `/docs`)。公開ボタンが唯一のコミット契機
- 未リンクのシンボルは一括バッチではなく、PRで触られた箇所から漸進的にリンクする
