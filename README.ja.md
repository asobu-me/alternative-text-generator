# Auto ALT Text Writer

Gemini API で、画像の `alt`、動画の `aria-label`（または書き起こしコメント）を自動生成して挿入する VS Code 拡張機能です。

![デモ](https://raw.githubusercontent.com/asobu-me/auto-alt-text-writer/main/images/readme.gif)

[English](README.md)

## 使い方

APIキーの設定は不要です。共有の無料枠が同梱されているので、インストール後すぐ使えます。

無料枠でGeminiに送信した画像やテキストは、AIの学習など品質改善に利用されることがあります。詳しくは[Googleの利用規約](https://ai.google.dev/gemini-api/terms)をご覧ください。機密情報や非公開の画像は送らないでください。

1. `<img>` タグの中にカーソルを置く（複数まとめて処理したいときは範囲を選択）
2. `Cmd+Alt+A`（Windows/Linux: `Ctrl+K Ctrl+A`）を押す
3. 生成された `alt` を確認して挿入する

動画は `Cmd+Alt+V`（Windows/Linux: `Ctrl+K Ctrl+V`）で `aria-label` を生成します。右クリックメニューとコマンドパレットからも実行できます。

生成前に確認画面が出るのが既定です。確認を省いて直接書き込みたい場合は、設定の Insertion Mode を「自動で挿入」にしてください。

### 動画の代替テキストについて

`aria-label` は、画像の `alt` のような代替テキストとしては不十分です。支援技術のユーザーにタイトルや機能を伝えるためのもので、動画内の視覚情報を伝える手段ではありません。

本来は、動画の前後に説明を置くか、`<track kind="descriptions">` で音声解説を提供してください。この機能は `aria-label` しか選べない場合の最終手段です。

## 設定

`Cmd+,`（Windows: `Ctrl+,`）で設定を開き、「Auto ALT Text Writer」で検索してください。画像・動画・共通・上級の4グループに分かれています。

| 設定 | 既定値 | 内容 |
|---|---|---|
| Alt Generation Mode | 検索エンジン向け | 検索エンジン向け（SEO）か、スクリーンリーダー向け（A11Y）か |
| Decorative Keywords | `icon-` `bg-` `deco-` | ファイル名にこれらを含む画像は飾りとみなし、`alt=""` にする |
| Video Description Mode | 要約 | 短いラベル（aria-label）か、書き起こし（コメント）か |
| Output Language | 自動 | 自動 / 日本語 / English。自動はVS Codeの表示言語に追従 |
| Insertion Mode | 確認してから挿入 | 確認をはさむか、そのまま挿入するか |
| Context Analysis Enabled | オフ | 周辺テキストを読み、説明済みなら `alt=""` にする |
| Custom File Path | `.vscode/custom-prompts.md` | カスタムプロンプトのファイルの場所 |

Decorative Keywords はファイル名の部分一致（大文字小文字を区別しない）です。`bg-` のように末尾のハイフンを残しておくと、`background.jpg` まで飾り扱いになるのを防げます。

## カスタムプロンプト

AI への指示を、自分で書いた Markdown ファイルに差し替えられます。

コマンドパレットで **「Auto ALT Text Writer: カスタムプロンプトのファイルを作成」** を実行すると、雛形が作られて開きます。

書き方のルールは2つです。

1. `# 見出し` で仕分ける。**書いた見出しだけが上書きされる**
2. 見出しの下に書いた文章が、そのまま AI への指示になる

```markdown
# SEO

あなたはSEOの専門家です。
検索されやすい語で被写体を説明してください。
商品名が読める場合は必ず入れてください。
```

これで SEO の指示だけが差し替わります。書かなかった見出しは既定のままです。

### 使える見出し

| 見出し | 上書きするもの |
|---|---|
| `SEO` | 画像の alt（検索エンジン向け） |
| `A11Y` | 画像の alt（スクリーンリーダー向け） |
| `Video` | 動画の aria-label |
| `Transcript` | 動画の書き起こし |

大文字小文字は区別しません。見出しが上の4つに当てはまらないときは通知が出ます。

モデルは `gemini-3.5-flash-lite` 固定で、変更できません。

出力言語と周辺テキストの扱いは、拡張機能が自動で指示に加えます。プロンプトに書く必要はありません。設定画面の値がそのまま効きます。

4つ全部を書いた例は [docs/custom-prompts.example.md](docs/custom-prompts.example.md) にあります。

### ファイルの場所

| 書き方 | 設定できる場所 | 解決先 |
|---|---|---|
| `.vscode/custom-prompts.md`（既定） | 設定不要 | ワークスペースルートからの相対 |
| `prompts/my.md` などの相対パス | どこでも | ワークスペースルートからの相対 |
| `~/alt-prompts.md` などの絶対パス | ユーザー設定のみ | そのパス。全プロジェクトで共有できる |

ワークスペース設定・フォルダー設定に絶対パスを書いても無視されます。このファイルの内容は Gemini API に送信されるため、リポジトリ側からワークスペース外のファイルを読み出せないようにしています。ファイルサイズの上限は256KBです。

## 対応ファイル

HTML（.html）、PHP（.php）、JavaScript/JSX（.js .jsx）、TypeScript/TSX（.ts .tsx）。**HTML以外は静的パスのみ対応です**（変数やテンプレートリテラルで組み立てる動的なパスは検出できません。詳しくは下記「パスの書き方」）。

画像は JPG・PNG・GIF・WebP・BMP。SVG は Gemini API の制限により非対応で、PNG や JPG に変換してから実行してください。動画は 20MB まで（10MB以下推奨）。

### パスの書き方

```html
<!-- 対応 -->
<img src="./images/photo.jpg">
<img src="/static/hero.jpg">
<img src="https://example.com/image.jpg">
<Image src="/static/hero.jpg" width={500} height={300} />

<!-- 非対応（実行時に値が決まるため） -->
<Image src={imageUrl} />
<Image src={`/uploads/${id}.jpg`} />
<img src="<?php echo $url; ?>">
```

Next.js・Vite・Create React App・Astro・Remix は自動検出し、`/` 始まりのパスを `public` ディレクトリに解決します（`/logo.png` → `public/logo.png`）。フレームワークのプロジェクトでは、`public` の中のファイルは必ず `/` 始まりで書いてください。相対パスで書くと `src` ディレクトリを探して見つかりません。

## うまくいかないとき

**画像が見つからない**
パスを確認してください。フレームワークを使っている場合は `/` 始まりで書きます。フォルダーを開かずにファイル単体で開いていると、相対パスを解決できません。

**429 Too Many Requests**
共有の無料枠の上限（15回/分）です。1分ほど待つか、自分のAPIキーを設定してください。

**動的なsrcは処理できない**
`src={variable}` のように実行時に決まるパスは読めません。ファイル選択ダイアログが出るので、手動で画像を指定してください。

**Content Blocked**
Gemini の安全性フィルターが反応しました。その画像の `alt` は手動で書いてください。

**大量に処理すると遅い**
10件ずつに分けて処理していますが、コンテキスト分析を有効にすると1件あたりの時間が増えます。急ぐときはオフにしてください。

## 自分のAPIキーを使う（任意）

自分のキーを使うと、自分のレート制限で処理でき、画像や動画が共有サービスを経由せず Google へ直接送信されます。ただし無料のキーのままだと、送信データがAI学習に使われる可能性は変わりません。使われたくない場合は、課金を有効にしたキーを使ってください。

1. [Google AI Studio](https://aistudio.google.com/app/api-keys) でキーを作成
2. コマンドパレットで「Auto ALT Text Writer: 自分のGemini APIキーを設定」を実行
3. 入力欄にキーを貼り付け

やめるときは「Auto ALT Text Writer: 自分のGemini APIキーを削除」を実行すると、共有の無料枠に戻ります。

<details>
<summary>キーの保存場所と送信先</summary>

キーは VS Code の SecretStorage 経由で OS のキーチェーン（macOS Keychain、Windows Credential Manager、Linux Secret Service）に保存されます。`settings.json` やプレーンテキストには保存されず、Settings Sync でも同期されず、共有プロキシにも送信されません。送信先は Google のみで、リクエストヘッダーに入ります。URLやログには載りません。

</details>

<details>
<summary>仕組みとセキュリティ</summary>

**既定の経路**: APIキーなしで動くよう、Cloudflare Worker のプロキシを経由します。実際のGemini APIキーはプロキシ側にのみ存在し、拡張機能には含まれていません。プロキシ側でモデル名を許可制にし、レート制限をかけています。

**自分のキーを設定した場合**: プロキシを経由せず Google へ直接送信します。モデル名は許可された文字種のみを通し、送信先ホストは定数です。

**画像の取得**: リモート画像はプライベートIPアドレスへのアクセスを遮断し（SSRF対策）、検証後のIPアドレスに接続を固定します。ローカル画像はワークスペース内に限定し、シンボリックリンクによる脱出も realpath で防いでいます。

**カスタムプロンプト**: リポジトリが用意したファイルを読む可能性があるため、Workspace Trust が必要です。パーサーは正規表現を使わず、敵対的な入力でも線形時間で処理します。書き起こしをコメントとして挿入する際は、コメントの終端記号を無害化してからファイルに書き込みます。

**正規表現**: タグ検出のパターンは ReDoS を起こさないよう検証済みです。

**メモリ**: バッチ処理は10件ずつに分割し、チャンクごとにキャッシュを破棄します。

</details>

## ライセンス

MIT
