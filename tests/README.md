# UIの動作確認

Node.js、Playwright、Microsoft Edgeを使います。テスト用のブラウザーは独立したプロファイルで起動します。

```powershell
# boadgameディレクトリで実行（テスト依存を一時的に用意）
npm install --no-save --package-lock=false playwright
$env:PORT = '3100'
npm start
```

別のターミナルで実行します。

```powershell
node tests/ui-smoke.cjs
node tests/ui-states.cjs
```

- `ui-smoke.cjs`：実サーバーへの2人接続、キーボードでのドラフト、配置・取消、4ラウンド進行、結果の省略、再戦。
- `ui-states.cjs`：サーバーの状態形式を使った画面検証。4人・16マス、320〜1280px、ブレーキ設定、イベントの有効対象、復旧の必須条件、動きを減らす設定。

`TEST_URL`で接続先、`TEST_OUTPUT`で画面キャプチャの保存先を変更できます。既存のPlaywrightを使う場合は`PLAYWRIGHT_MODULE`にそのモジュールの絶対パスを指定してください。`BROWSER_CHANNEL`は既定で`msedge`です。
