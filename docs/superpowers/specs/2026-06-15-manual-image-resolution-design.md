# 設計: 解決できない画像参照の手動ファイル選択フォールバック

**日付**: 2026-06-15
**対象**: Auto ALT Writer (VS Code 拡張機能)
**ステータス**: 設計承認待ち

## 背景と問題

ALT生成は実画像ファイルをディスク/URLから読み込み、Gemini API に画像そのものを送って解析する。
そのため src が静的に確定しないと解析対象を特定できない。

現状、以下のケースは行き止まり（エラー表示して当該タグをスキップ）になっている。

- **動的パス**: `src={imageUrl}`、`src={\`/img/${x}.jpg\`}` など
  （`extractTagInfo` の動的判定 `imageProcessor.ts:133-141`、`validateImageSrc` `security.ts:123-137`）
- **ファイル未検出**: 静的パスだが実ファイルが見つからない（フレームワークのパス解決ミス含む）
  （`loadImageData` `imageProcessor.ts:231-235`）

これらに対し、ユーザーが解析対象の実ファイルを手動指定できるリカバリ経路を追加する。

## ゴール / 非ゴール

**ゴール**
- 動的パス・ファイル未検出のとき、ユーザーが実画像を手動選択して ALT 生成を継続できる。
- バッチ処理を中断せず、未解決分を最後にまとめて解決する。
- 同一の動的式は一度だけ尋ね、残りに自動適用する。

**非ゴール（YAGNI）**
- 変数の静的解決（代入の遡り、import 越え）。今回はやらない。
- 解決マッピングの永続化（セッションを跨いだ保存）。セッション内メモリのみ。
- 動的ルートが表示する「複数の異なる画像」への個別対応。ユーザーが代表画像を1枚選ぶ前提。

## 設計判断（UX原則による裏付け）

| 判断 | 内容 | 根拠 |
|------|------|------|
| 発動条件 | 動的パス **＋** ファイル未検出の両方 | Nielsen #9（エラーからの回復）, HIG Forgiveness |
| バッチ挙動 | 解決可能分を先に処理し、未解決は**最後にまとめて**選択 | HIG User control（割り込まない）, Nielsen #8 |
| ピッカーUI | ワークスペース画像を**ファイル名類似度順**に並べた QuickPick + 「ファイルを参照...」 | Nielsen #6（想起より認識）, #4（標準準拠） |
| WS外ファイル | **ワークスペース内のみ許可**（既存 `sanitizeFilePath`） | 既存セキュリティ方針との一貫性 |

### 原則由来の必須補強

1. **コンテキスト付きプロンプト**（Nielsen #6）: 後回しにするとユーザーはタグの記憶を失う。
   解決UIの各項目に「ファイル名・行番号・タグ抜粋・元の動的式」を必ず添える。
2. **同一式の重複排除**（Nielsen #7 / 負担最小化）: 同じ動的式は1回だけ尋ね、残りに自動適用。
3. **ステータスの可視化**（Nielsen #1 / HIG Feedback）: 進捗で「自動 N件 / 入力待ち M件」を区別。
   フェーズ1完了時に「✅ N件完了、✋ M件はファイル選択が必要です」を明示。

## アーキテクチャ

方針A: 専用リゾルバ・モジュール + バッチ2フェーズ化。

### 新規モジュール `src/services/imagePathResolver.ts`

単一責任 = 解決できない画像参照をユーザー入力で実ファイルに解決する。

```typescript
// セッション内マッピング: 同一の動的式/未解決srcは二度聞かない（補強2）
const sessionMappings = new Map<string, string>();  // unresolvedSrc → 実 fsPath

// ワークスペース画像候補のキャッシュ（バッチ中1回だけグロブ）
let candidateCache: { wsRoot: string; files: string[] } | null = null;

/** バッチ完了時・ドキュメント変更時にキャッシュとマッピングをクリア */
export function resetResolverCache(): void;

/** ワークスペース内の画像ファイルを列挙（キャッシュ付き） */
export async function getWorkspaceImageCandidates(wsRoot: string): Promise<string[]>;

/** クエリ（識別子トークン/ファイル名）に対する類似度でファイルを降順整列（純関数・テスト対象） */
export function rankCandidates(query: string, candidates: string[]): string[];

/** 動的式から識別子トークンを抽出（例 "${product.image}" → "image"）（純関数・テスト対象） */
export function extractQueryToken(unresolvedSrc: string): string;

/**
 * 解決できない参照を実パスに解決する。
 * 戻り値: 実 fsPath / 'skip'（このグループ飛ばす） / 'skip-all'（残り全部中断） / null（Esc=スキップ扱い）
 */
export async function resolveImagePath(
    unresolvedSrc: string,
    reason: 'dynamic' | 'not-found',
    context: { fileName: string; line: number; snippet: string },  // 補強1
    wsRoot: string
): Promise<string | 'skip' | 'skip-all' | null>;
```

### 結果型の拡張（既存コードへの最小フック）

`processSingleImageTag` の戻り値に「手動解決が必要」という第3の結果を追加する。

```typescript
interface DeferredResolution {
    kind: 'needs-manual-resolution';
    unresolvedSrc: string;                 // 元の動的式 or 未検出パス（グルーピングキー）
    reason: 'dynamic' | 'not-found';
    actualSelection: vscode.Selection;
    selectedText: string;
    tagType: 'img' | 'Image';
    context: { fileName: string; line: number; snippet: string };
}
```

- `extractTagInfo`（動的判定 `imageProcessor.ts:138`）と `loadImageData`（未検出 `:231`）は、
  エラー表示の代わりにこの遅延情報を呼び出し元へ返せるようにする。
- **単一タグ処理時**は即その場で `resolveImagePath` を呼ぶ（待たせる相手がいないため）。
- 解決後の「画像ロード→ALT生成→挿入」は既存ロジックを再利用する（重複実装しない）。

## データフロー（バッチ2フェーズ）

`extension.ts` の `processMultipleTags`（`:196-`）を2フェーズ化する。

```
フェーズ1（既存チャンクループ）:
  各タグ処理 → 解決可能: 従来どおり ALT 生成・挿入
            → 未解決:   DeferredResolution を deferredList に収集（挿入しない）
  進捗通知: 「自動 N / 入力待ち M」を区別（補強3）

フェーズ1完了:
  「✅ N件完了、✋ M件はファイル選択が必要です」を表示（補強3）

フェーズ2（解決ループ）:
  deferredList を unresolvedSrc でグルーピング（補強2）
  各グループにつき1回 resolveImagePath:
     QuickPick = [類似度順の候補...] + 「$(folder) ファイルを参照...」
                 + 「スキップ」 + 「残り全部スキップ」
     - 実パス       → グループ内の全タグについて 画像ロード→ALT生成→挿入
     - 'skip' / null → このグループを飛ばす
     - 'skip-all'    → 残りグループを中断
     - WS外を選択    → sanitizeFilePath が弾く → エラー表示し同グループを再プロンプト
  サマリ更新
```

挿入位置は既存の `cumulativeOffsetDelta` 機構（`extension.ts:238-`）をフェーズ2の遅延挿入にも適用し、
オフセット追従を保つ。

## 候補スキャンと順位付け

- グロブ: `vscode.workspace.findFiles('**/*.{png,jpg,jpeg,gif,webp,avif}', '**/{node_modules,.git,dist,build,.next,out}/**')`。バッチ中キャッシュ。
- クエリ抽出: 動的式は識別子トークン（`${product.image}` → `image`）、未検出パスは `path.basename`。
- 類似度: 部分一致 > トークン一致 > レーベンシュタイン距離 の優先で降順整列。
- QuickPick 各項目: `label` = ファイル名、`description` = ワークスペース相対パス（認識補助・Nielsen #6）。

## エラー処理・エッジケース

- ワークスペース未オープン: 本機能はワークスペース前提（既存 `loadImageData` も WS 未オープン時はエラー `imageProcessor.ts:209-211`）。WS が無い場合はフォールバックを起動せず従来どおりエラー表示。
- 選択ファイルが SVG / サイズ超過: 既存 `loadImageData` のバリデーションに再投入（再利用）し、不可ならエラー表示して同グループ再プロンプト。
- WS外選択: `sanitizeFilePath` が `null` を返す → エラー表示し再プロンプト。
- バッチ中のドキュメント編集: 既存オフセット追従機構を流用。
- キャンセル（token）: フェーズ1・2の両方で `isCancellationRequested` を尊重。

## セキュリティ

- 選択された実パスは必ず既存 `sanitizeFilePath(selectedPath, wsRoot)` を通し、ワークスペース内に限定。
- 新規の正規表現は追加しない（識別子トークン抽出は単純な分割/文字クラスのみ。ReDoS リスクなし）。
- API キー等の機微情報はログ出力しない（既存方針）。

## テスト方針

- ユニットテスト（`src/test/suite/` に追加。VS Code API 非依存の純関数を対象）:
  - `extractQueryToken`: 動的式・テンプレートリテラル・JSX変数からのトークン抽出。
  - `rankCandidates`: クエリ別の順位付けが期待どおりか。
- 手動テスト（CLAUDE.md の手動チェックリストに項目追加）:
  - 単一の動的タグ → その場で QuickPick → 解決して ALT 挿入。
  - バッチに動的＋未検出が混在 → フェーズ1完了表示 → フェーズ2まとめ解決。
  - 同一動的式が複数 → 1回だけ尋ね残りに自動適用。
  - スキップ / 残り全部スキップ / Esc / WS外選択（拒否）。

## 影響ファイル

| ファイル | 変更 |
|---------|------|
| `src/services/imagePathResolver.ts` | 新規（リゾルバ本体） |
| `src/services/imageProcessor.ts` | `extractTagInfo`/`loadImageData`/`processSingleImageTag` に遅延結果の経路を追加、単一タグ時は即解決 |
| `src/extension.ts` | `processMultipleTags` を2フェーズ化、進捗表示の文言追加 |
| `src/test/suite/` | リゾルバ純関数のユニットテスト追加 |
| `package.nls.json` / `package.nls.ja.json` | 新規メッセージ文字列 |
| `CLAUDE.md` | 手動テストチェックリストに項目追加 |
