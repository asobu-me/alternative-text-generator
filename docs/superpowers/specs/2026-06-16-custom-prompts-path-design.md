# 設計: 柔軟かつ安全なカスタムプロンプトパス解決

- **日付**: 2026-06-16
- **対象**: `autoAltWriter.customFilePath` の解決ロジック（`src/core/prompts.ts` / `src/utils/security.ts`）
- **目的**: カスタムプロンプトのパス指定を柔軟（全プロジェクト共通のグローバル指定が可能）にしつつ、外部ファイル流出（Gemini API への送信）を「絶対に」起こさない。

## 背景と問題

現状の `loadCustomPrompts()`（`src/core/prompts.ts:647`）は:

```ts
const customPromptsPath = config.get('customFilePath', '.vscode/custom-prompts.md');
const workspaceRoot = workspaceFolders[0].uri.fsPath;       // 最初のフォルダ固定
const absolutePath = path.resolve(workspaceRoot, customPromptsPath);
if (!isPathInWorkspace(absolutePath, workspaceRoot)) return null;  // ワークスペース外は拒否
```

制約:

1. ワークスペースルート起点の相対パスのみ。絶対パス・`~` は弾かれる。
2. ワークスペース外に置けない → 複数プロジェクトで共通プロンプトを共有できない。
3. `isPathInWorkspace` は文字列比較のみで **シンボリックリンクを解決しない** → ワークスペース内に置いた symlink でリンク先（外部の機密ファイル）が読まれ Gemini に送信される脆弱性が存在する。

## 脅威モデル

カスタムプロンプトファイルの内容は **Gemini API（外部の第三者）に送信される**。したがって「読めるファイルを読む」こと自体が情報流出になりうる。主要な攻撃シナリオ:

- **A. リポジトリ設定による絶対パス注入**: 攻撃者が `.vscode/settings.json`（コミット対象）に `customFilePath: "/Users/victim/.ssh/id_rsa"` 等を仕込む。被害者がリポジトリを開くと当該ファイルが Gemini に送信される。
- **B. symlink によるワークスペース脱出**: 攻撃者がワークスペース内に `.vscode/custom-prompts.md → /etc/passwd` のような symlink をコミット。文字列比較の `isPathInWorkspace` を通過し、リンク先が読まれる。

## 決定事項

- **B-1**: 絶対パス・`~` は **ユーザーのグローバル(User)設定由来の時だけ** 許可。リポジトリ(Workspace/Folder)由来の絶対パスは拒否。
- **A-1**: 専用機構は追加しない。グローバル設定に絶対パスを書くこと＝全プロジェクト共通プロンプト、という単一機構で実現。
- **C-1**: ワークスペース相対パスの解決時に `fs.realpathSync` で実体パスを取得し、実体がワークスペース内かを再チェック（symlink 脱出を防ぐ）。グローバル由来の信頼済み絶対パスには適用不要。

## 信頼モデル

| 設定値の種類 | 由来 | 扱い |
|---|---|---|
| 相対パス | どの由来でも | ワークスペースroot起点で解決し、**realpath実体がワークスペース内**であることを確認（C-1）。OK→使用 |
| 絶対パス / `~` | グローバル(User)設定 | 信頼済み。`~`展開してそのまま使用（ワークスペース制限なし） |
| 絶対パス / `~` | リポジトリ(Workspace/Folder)設定 | **拒否**（攻撃面）。グローバル設定→デフォルトの順にフォールバック |

由来判定には `config.inspect('customFilePath')` の `globalValue`（信頼）と `workspaceValue` / `workspaceFolderValue`（非信頼）を使う。

## 解決アルゴリズム（`resolveCustomPromptsPath()`）

1. `config.inspect<string>('customFilePath')` で各スコープ値を取得。
2. **有効値の選択**: VS Code 本来の優先順 `workspaceFolderValue > workspaceValue > globalValue > defaultValue` で最初に存在する値を採用し、その由来（信頼/非信頼）を記録。
3. **セキュリティ・フィルタ**: 採用値が「非信頼由来 かつ 絶対/`~`」なら破棄し、`globalValue` → `defaultValue` の順に再選択する（フォールバックは1段のみ）。
4. **解決と検証**:
   - 絶対 / `~`（ここに到達するのはグローバル由来＝信頼済みのみ）: 先頭 `~` を `os.homedir()` に展開し絶対パス確定。ワークスペース不要。
   - 相対: ワークスペースroot起点で `path.resolve`。`existsSync` で存在確認 → `fs.realpathSync` で実体取得 → `realpath(workspaceRoot)` 配下か境界（`+ path.sep`）込みで再チェック。外れたら破棄。
5. **共通検証**: 存在する / ファイルである / 10MB 以下。いずれか満たさなければ `null`（=内蔵デフォルトプロンプトで継続、現状どおり）。

補足:
- ワークスペースroot 自体も realpath 化してから比較（macOS の `/tmp`→`/private/tmp` 等のリンク差異を吸収）。
- ファイル不在時は `realpathSync` を呼ばず `existsSync` で先に弾く（`realpathSync` は不在で throw するため）。
- `~user` 形式は展開しない（未対応・存在しなければ `null` に落ちる）。

## 構成（テスト容易性のため分離）

- `src/utils/security.ts` に純粋関数を追加:
  - `selectTrustedPromptValue(inspect)` → `{ value: string, trusted: boolean } | null`（vscode/fs 非依存の純ロジック。セキュリティ・フィルタとフォールバックを担当）
  - `resolveSafePromptPath(value, trusted, workspaceRoot, fsAdapter)` → `string | null`（fs はアダプタ注入で単体テスト可能。realpath 含む解決・検証を担当）
- `src/core/prompts.ts` の `loadCustomPrompts()` は上記を呼ぶだけに簡素化。既存キャッシュ（解決後の絶対パスをキーにした `customPromptsCache` / `lastPromptsFilePath`）はそのまま流用。
- 既存 `isPathInWorkspace` は realpath 版に置換、または `resolveSafePromptPath` 内へ統一。

## エラー処理・可視性

- 非信頼の絶対パスを拒否した時: `console.warn` で「リポジトリ設定が外部パスを指定したため無視した」旨を記録。モーダルは出さない（アラート疲れ回避）。
- 解決失敗・対象なしは常に `null` → 内蔵デフォルトプロンプトで継続（フェイルセーフ）。
- ログに API キー等の秘匿情報は出さない（パスは秘匿情報ではないので出力可）。

## テスト（`src/test/suite/security.test.ts` に追加）

- 相対パス → ワークスペース内: 許可
- 相対パスだが symlink で外部へ脱出: **拒否**（C-1）
- 兄弟ディレクトリ接頭辞一致（`proj` vs `proj-secrets`）: 拒否
- グローバル設定の絶対パス: 許可
- グローバル設定の `~/...`: ホーム展開して許可
- リポジトリ設定の絶対パス: **拒否**（B-1）し、デフォルトにフォールバック
- リポジトリ(相対) がグローバル(絶対) を上書き: リポジトリ相対が勝つ
- 10MB 超 / ディレクトリ / 不在: `null`

## スコープ外（YAGNI）

- マルチルートの2番目以降フォルダ対応（現状 `workspaceFolders[0]` 維持）
- インラインプロンプト設定（settings.json に直接プロンプト文字列）
- ゼロコンフィグの固定パス探索（`globalStorageUri` / `~/.config/...`）
