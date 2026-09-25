# BCL Discord Bridge

**スマホ1台だけの人も、BetterCrewLink の近接ボイスチャットに参加できるようにする Windows 用の中継アプリです。**

iPhone で Among Us と BetterCrewLink Web を同時に使うと、Among Us に切り替えた瞬間に Safari のマイクが止まったり、Wi-Fi 環境によっては P2P 接続がうまくいかず（オレンジの切断アイコン）声が届かなかったりします。
このアプリは、スマホ勢には **Discord アプリで通話するだけ** にしてもらい、PC 側で全員分の近接ボイスを作って Discord 経由で返します。

```
スマホ勢: Among Us を遊ぶ + Discord の通話に入るだけ
             │ Discord の音声
             ▼
PC（このアプリ）: 位置・生死・会議状態から1人ずつ専用の近接ミックスを作成
             │
             ▼
PC の BetterCrewLink Desktop（Mobile Host）とつながる
```

> 非公式のファン制作ツールです。Innersloth（Among Us）や BetterCrewLink の開発元とは関係ありません。

## できること

- 距離による音量変化と左右の聞こえ方
- 生存者・幽霊の聞き分け、会議中の全体通話
- BetterCrewLink のロビー設定（幽霊のみ・会議のみ・通信妨害・ベント・視界連動の距離）に追従
- 待機 VC にいる人を、ボタン1つで1人ずつ専用 VC へ自動振り分け（終了時は元に戻して専用 VC を削除）
- ゲーム中に色を間違えても、その人だけ付け直し可能
- 色の割り当てはユーザー名ごとに保存され、次回も自動で入る
- 最大10人（Bot の数だけ）まで同時に中継

未対応: 壁越しの遮断、カメラ越しの音声、インポスター無線、こもり・反響エフェクト。

## 必要なもの

| もの | 備考 |
| --- | --- |
| Windows 10/11 の PC 1台 | 遊ぶ間ずっと起動しておきます |
| [Node.js](https://nodejs.org/) 24 以降 | LTS 版でOK |
| [BetterCrewLink Desktop](https://github.com/OhMyGuus/BetterCrewLink) | PC で Among Us を遊ぶ人が起動し、設定で **Mobile Host を ON** |
| Discord サーバー | 自分が管理者のサーバー |
| Discord Bot | **中継するスマホ勢の人数ぶん**（下で説明） |

### なぜ Bot が人数ぶん必要？

Discord の仕様で、1つの Bot は同じサーバーの複数の VC に同時に入れません。1人ずつ別々の近接ミックスを返すには、1人につき Bot が1体必要です。

- スマホ勢 1人 → Bot 1体
- スマホ勢 6人 → Bot 6体
- PC 版 BetterCrewLink を自分で使う人 → Bot 不要

## セットアップ（最初の1回だけ）

### 1. ダウンロード

右上の **Code → Download ZIP** で落として展開するか、`git clone` します。

### 2. 1体目の Bot を作る

1. [Discord Developer Portal](https://discord.com/developers/applications) を開き、**New Application** で名前（例: `BCL Bridge`）を付けて作成
2. 左メニューの **Bot** → **Reset Token** でトークンを発行し、コピー
3. 同じ画面の上のほうにある **Application ID**（General Information ページ）もメモ

> トークンはパスワードと同じです。人に見せたり、チャットに貼ったりしないでください。

### 3. setup.cmd を実行

`setup.cmd` をダブルクリックし、聞かれたら Application ID と Token を貼り付けます（Token は画面に表示されません）。
部品のインストールとビルドが終わると **招待 URL** が表示されるので、開いて遊ぶサーバーに Bot を追加します。

1体目は管理用も兼ねるので「チャンネルの管理」「メンバーを移動」「接続」「発言」「チャンネルを見る」の権限を持ちます。

### 4. 2体目以降を追加（スマホ勢が2人以上いる場合）

必要な数だけ、手順2と同じように別の Bot を作り、毎回 `add-voice-bot.cmd` を実行して ID と Token を入力 → 表示された URL で同じサーバーに追加します。
追加 Bot の権限は「チャンネルを見る・接続・発言」だけです。

### 5. デスクトップにショートカットを作る

`create-shortcuts.cmd` をダブルクリックすると、デスクトップに次の2つができます。

- **BCL Bridge 起動** … アプリを起動して操作画面を開く（起動済みなら画面を開くだけ）
- **BCL Bridge 終了** … ゲーム中なら全員を待機 VC に戻し、専用 VC を消してから終了

## 遊び方

1. PC で BetterCrewLink Desktop を起動し、**Mobile Host を ON** にして Among Us のロビーに入る
2. 全員が Discord の同じ **待機 VC** に入る（スマホ勢は Discord アプリで。BetterCrewLink は開かない）
3. デスクトップの **BCL Bridge 起動** をダブルクリック → 操作画面（`http://127.0.0.1:38472/`）が開く
4. 待機 VC とロビーコードを選ぶ
5. スマホ勢を ON にして、**Among Us で実際に使っている色** を選ぶ（PC で BetterCrewLink を使う人は OFF）
6. **振り分けて開始** を押す
7. 終わるときは **終了して元に戻す**、アプリごと閉じるときは **BCL Bridge 終了**

> 黒い画面を × で閉じると専用 VC が残ることがあります。終了はショートカットから行ってください。

### 画面の表示

| 表示 | 意味 |
| --- | --- |
| PC待ち | BetterCrewLink Desktop の Mobile Host からの情報を待っています |
| 色待ち | 選んだ色のキャラがロビーにまだいません |
| 接続済み | 中継中です |
| 色が重複 | 同じ色が2人に割り当てられています（入れ替え途中なら問題なし） |

## うまくいかないとき

- **待機 VC に人が出ない** … 全員が同じボイスチャンネルに入っているか確認。画面は約1.5秒ごとに更新されます
- **管理 Bot の権限エラー** … `setup.cmd` の最後に出た URL から、もう一度サーバーに追加してください
- **ずっと「PC待ち」** … BetterCrewLink Desktop の Mobile Host が ON か、同じ BetterCrewLink サーバー（既定 `https://bettercrewl.ink`）を使っているか確認
- **ずっと「色待ち」** … 画面の色と Among Us の実際の色を合わせてください。ゲーム中でも一覧の選択欄から直せます
- **試合後のロビーで数秒無音** … 各スマホが読み込み終わるまで少し待ってください

原因調査用に、ゲーム中は `diagnostics.jsonl` に5秒ごとの状態が記録されます（ゲーム内の名前を含むので、共有するときは注意してください）。

## プライバシー

- 音声は中継中にリアルタイムで処理するだけで、録音はしません
- Bot のトークンは PC 内の `.env` にだけ保存され、Git には含まれません
- 使う前に、参加者全員に「Bot 経由で声が中継される」ことを伝えてください

## 開発者向け

```bash
npm install
npm run check   # 型チェック + テスト
npm run build
npm start
```

- `src/bcl/` … BetterCrewLink サーバーとの接続、近接計算、PC 内ミックス
- `src/discord/` … Discord Bot、VC の振り分け、音声の送受信
- `src/ui/` … 操作画面（`127.0.0.1` のみで待ち受け）
- `scripts/make-icons.ps1` … ショートカット用アイコンの生成

## ライセンス

[GPL-3.0](LICENSE)
