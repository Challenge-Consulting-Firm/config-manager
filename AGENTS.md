# Agent Instructions

このリポジトリで作業する AI エージェント（Codex / Claude Code / Cursor / Copilot など）向けの指示です。
`README.md` も併せて参照してください。

## 言語コミュニケーションルール

- **ユーザーへの返答は日本語で行うこと。** コードコメント・コミットメッセージ・PR 本文も日本語を基本とする。
  - ただし、識別子（変数名・関数名・型名）・CLI コマンド・ライブラリ名・ファイルパス・ログメッセージは英語のままにする。
  - ユーザーが英語で質問してきた場合も、返答は日本語でよい（原文の意図を汲んで日本語で答える）。
- ドキュメント・UI 文字列（ユーザー向けメッセージ）は日本語で書くこと。本リポジトリの既存 UI（`apps/web/src/pages/*`）や `README.md` も日本語で統一されているため、それに合わせる。
- 技術的判断や設計の根拠を説明する際も、日本語で簡潔かつ具体的に述べること。

## コーディング規約

- パッケージマネージャは `pnpm`（`packageManager: pnpm@9.0.0`）。`npm` / `yarn` は使わない。
- 変更後は必ず以下を実行して確認すること:
  ```bash
  pnpm -r run typecheck
  pnpm build
  ```
- 型安全性を最優先する。`any` は止むを得ない場合のみとし、その理由をコメントで明記する。
- 既存のパターン・ユーティリティを再利用する。類似機能がすでにある場合（例: ファイアウォール機能とルーティング機能）は、並列構造・命名規約（`extractXxx` / `serializeXxx` / `parseXxxCache` など）に従う。
- 新しい外部依存を追加する場合は、既存の `package.json` の依存範囲と整合する安定版を選ぶ。追加前にユーザーに一言ことわりを入れる。
- 使用済み変数・未使用 import・デッドコードは残さない（`tsc --noEmit` の `noUnusedLocals` / `noUnusedParameters` で弾かれるため）。
- コメントは「なぜそうしたか」を書く。コードが自明な場合はコメントを置かない。

## ディレクトリ構造の指針

- 共通ロジック・型定義・純粋関数は `packages/shared/src/` に置く（BFF と Web 両方から使うため）。
- BFF のルートハンドラ・Kintone クライアントは `apps/bff/src/` に置く。
- React ページ・コンポーネント・クライアント側ユーティリティは `apps/web/src/` に置く。
- 新機能を足す場合は、対応するエクスポートを `packages/shared/src/index.ts` に追加すること。

## Kintone 連携の注意

- フィールドコードは `apps/bff/src/kintone.ts` の `F.config.*` / `F.audit.*` と**完全一致**させる必要がある。
- 新しい Kintone フィールドを追加した場合は、`scripts/kintone/config-app-fields.json`（または `audit-app-fields.json`）にも同名・同型で定義を追加し、`README.md` のフィールド一覧表も更新すること。
- キャッシュ系フィールド（`fw_rules_json`, `routing_routes_json` など）は `MULTI_LINE_TEXT` で持ち、`bodyHash` と schema version で有効性を検証するパターンに従う。

## Git 運営

- ユーザーから明示的に指示されない限り、コミット・ブランチ作成・プッシュはしない。
- 変更対象外のコード（既存の無関係なバグ・フォーマット揺れ）は、原則として触らない。気付いた点は最後のメッセージで報告するに留める。

## 検証

- `pnpm -r run typecheck` と `pnpm build` が通ることを必ず確認する。
- テストやリンタが追加されている場合は、それらも実行する。
- 検証を実行しなかった場合は、その理由を明示する。
