# win-dori

> **win-dori は [sisyphuslabs/dori-superagent](https://github.com/sisyphuslabs/dori-superagent) の Windows 移植版です。** Dori と dori-superagent は Sisyphus Labs のプロジェクトです。win-dori は上流のコミット [7ac0ed7](https://github.com/sisyphuslabs/dori-superagent/commit/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444) に追従し、上流の挙動とデフォルトをそのまま保ちます。足しているのは Windows に必要なものだけです。PowerShell でのインストール、シェルを見分ける pane、自動起動と Slack リスナーを備えた Windows プロファイルです。Dori の功績は上流の作者にあり、Windows 部分のバグは私たちの責任です。上流の issue は [sisyphuslabs/dori-superagent/issues](https://github.com/sisyphuslabs/dori-superagent/issues) へどうぞ。

> **ライセンス。** この移植から、win-dori は上流と同じく [Sustainable Use License](LICENSE) で提供されます。個人利用、社内業務での利用、無償の非商用利用に限られます。win-dori が何を変えたかは [NOTICE.md](NOTICE.md) にあります。`fa86ddf` までのバージョンは MIT で、引き続き MIT です。

**Dori はあなたのチャットの中にいます。Slack、Telegram、Discord のどこからでも仕事を伝えると、ジョブごとに専用のコーディングエージェントセッションが立ち、マージまで追跡されます。マージの前には、その head に対する CLEAR レビューが必須です。**

[English](README.md) | [한국어](README.ko.md) | [简体中文](README.zh.md) | 日本語 | [Deutsch](README.de.md) | [Italiano](README.it.md)

<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

Dori は [Sisyphus Labs](https://sisyphuslabs.ai) のマルチセッション向けコーディングエージェント harness です。あなたと話すのは lead セッション一つだけです。依頼は lane になり、lane とは専用の herdr タブで動く [omo](https://github.com/code-yeongyu/oh-my-openagent) セッション一つと、そのための brief です。証拠が実物で確認できるまで lane は閉じません。duty ループが静かになった lane を動かし続け、マージゲートが成果物と `main` の間に立ちます。

ここには二つのプログラムがあります。win-dori ではハーネスが `dori-harness`(上流では `dori`)、Dori mode のメッセンジャー CLI が `dori` なので、一台のマシンに両方置けます。上流の文章で `dori up` や `dori merge` とあるところは、win-dori では `dori-harness up`、`dori-harness merge` です。

| 構成要素 | 中身 | 使う場面 |
|---|---|---|
| harness (`src/`、`prompts/`) | lead、lane、duty ループ、毎時のループ、レビューとマージゲート | 一つのマシンで全体を回したい |
| Dori mode (`skills/dori-mode`) | メッセンジャー用 CLI: 送信、受信、プレゼンス、完了プロトコル | チャットから話しかけたい |

## 得られるもの

| 得られるもの | 意味 | 実装場所 |
|---|---|---|
| 待ち行列ではなく並列作業 | ジョブごとに専用タブと専用エージェントセッションが開き、同時にいくつでも走る | `dori-harness start`、`src/lanes.ts` |
| 証拠がなければ done にならない | lane は `dori-harness ready --evidence <リンク>` で終わり、lead はそのリンクが実物で確認できてから閉じる | `src/lanes.ts` の `ready()`、`prompts/lane-footer.md` |
| セッションを中断させない | 作業中のペイン宛てのメッセージは溜められ、ペインが idle になったときにまとめて届く | `src/inbox.ts` |
| 沈黙に気づく | 10 分と 20 分で催促し、40 分で lead へエスカレーション | `src/duty.ts` の `NUDGE_MINUTES` |
| 次の仕事を自分で見つける | 毎時のループが backlog から取り出し、lane 数とホストの制限を守り、人には判断だけを聞く | `src/loop.ts`、[docs/hourly-loop.md](docs/hourly-loop.md) |
| 状況が一箇所に残る | ジョブごとにメッセージ一つを、投稿し直さずその場で編集する | `skills/dori-mode/scripts/src/messenger/` の `edit` |
| 声は一つ | lane と duty セッションはあなたに話しかけず、すべて lead に集まる | `prompts/lead.md`、`prompts/duty.md` |
| あなたの書き方で返す | 書くものに絵文字は使わず、短く、そのスレッドの言語で返します | `skills/dori-mode/SKILL.md` |

![architecture](docs/architecture.png)

## チャットから話しかける

このリポジトリが実装しているチャネルは三つです。どれも投稿、その場での編集、スレッド返信ができます。

| チャネル | 送信と編集 | 受信 | オンライン表示 | 設定するもの |
|---|---|---|---|---|
| Slack | 投稿、スレッド返信、その場で編集 | スレッドビュー、自分が投稿したスレッド、DM とメンション | 可（ユーザートークンのみ） | `DORI_SLACK_TOKEN`、ユーザートークンなら `DORI_SLACK_COOKIE` も |
| Telegram | 投稿、フォーラムトピックへの返信、その場で編集 | オーナーの DM、指定したグループの一トピック、編集、メディアの file id | bot には該当なし | `DORI_TELEGRAM_TOKEN`、`DORI_TELEGRAM_OWNER_ID`、任意で `DORI_TELEGRAM_GROUP_ID` と `DORI_TELEGRAM_TOPIC_ID` |
| Discord | 投稿、スレッドへの投稿、その場で編集 | このリポジトリには未実装 | 可（gateway 接続） | `DORI_DISCORD_TOKEN` |

### Slack

ユーザートークンは実在のメンバーとして振る舞います。有料シートが必要で、そのメンバーが見えるものはすべて見え、`dori presence slack` で緑のドットを保てます。bot トークンはシート不要で、招待されたチャネルと付与されたスコープだけが見え、アプリとして表示されます。どちらかを選んで記録してください。オンボーディングで何を読めるかがこれで決まります。

```powershell
$env:DORI_SLACK_TOKEN = "xoxp-..."
$env:DORI_SLACK_COOKIE = "..."          # `d` クッキー。ユーザートークンのときだけ

dori send slack --to C0123456789 --text "PR #12 はグリーン" --thread 1712345678.123456
dori send slack --to C0123456789 --edit 1712345678.123456 --text "PR #12 マージ済み"
dori inbound slack --loop 1           # 新着ごとに 1 行の INBOUND
dori presence slack                   # ユーザートークン: オンライン表示を保つ
```

Dori が立てたスレッドへの、メンションの付かない返信も届きます。受信は Slack のスレッドビュー、Dori が投稿したすべてのスレッド（`<stateDir>/slack-threads.json` に記録）、そして未読の DM、グループ DM、メンションを読みます。

### Telegram

```powershell
$env:DORI_TELEGRAM_TOKEN = "..."
$env:DORI_TELEGRAM_OWNER_ID = "123456789"      # 依頼として扱うのはこのアカウントだけ
$env:DORI_TELEGRAM_GROUP_ID = "-1001234567890" # 任意: グループを一つ
$env:DORI_TELEGRAM_TOPIC_ID = "42"             # 任意: その中のフォーラムトピックを一つ

dori send telegram --to -1001234567890 --thread 42 --text "PR #12 はグリーン"
dori inbound telegram --loop 1
```

受信はオーナー限定です。設定したオーナーからの DM は必ず通り、グループでは設定したトピックだけが通り、bot の発言は決して通りません。編集は独立したメッセージとして届きます。ボイスメモ、写真、ドキュメントは `file_id` を含む行として届くので、それを Telegram の `getFile` に渡します。ダウンロードした音声は `dori transcribe <ファイル>` が `hooks.transcribe` 経由でテキストにします。

### Discord

```powershell
$env:DORI_DISCORD_TOKEN = "..."

dori send discord --to 123456789012345678 --text "PR #12 はグリーン"
dori presence discord                 # gateway 上でオンライン表示を保つ
```

送信は動きます。`--thread` で渡したスレッドへの投稿も含みます。受信が欠けています。`dori inbound` が受け付けるのは `slack` と `telegram` だけで、このリポジトリの Discord gateway 接続は identify と heartbeat を行いますが、受信メッセージを配送しません。プラットフォーム側は `references/setup.md` の手順で agent-messenger を入れ、残りは各プラットフォームの現行 API を直接読んでください。

### コマンドには出ていないがライブラリにあるもの

メッセンジャーの各モジュールは import できる型付きクラスで、CLI が出している以上のことができます。

- Slack のファイルアップロード（アップロード URL を取ってから complete）: `skills/dori-mode/scripts/src/messenger/slack.ts`
- Telegram のフォーラムトピック（作成、改名、閉鎖、再開）、`Thinking…` から始めるドラフトストリーミング、HTML の表: `skills/dori-mode/scripts/src/messenger/telegram.ts`
- Discord のスレッド作成、改名、アーカイブ: `skills/dori-mode/scripts/src/messenger/discord.ts`

モジュールの一覧は [skills/dori-mode/references/scripts.md](skills/dori-mode/references/scripts.md) にあります。

### 他のチャネルはない

このリポジトリに Teams、WhatsApp、LINE、WeChat、iMessage、KakaoTalk、Lark の対応はなく、`dori send` は知らないチャネルを拒否します。Sisyphus Labs のホスト版プロダクトにはもっと広いプラットフォーム一覧がありますが、この README が引き継ぐ注記も同じです。出荷されている Dori mode が対応するのは Telegram、Discord、Slack の三つです。

## インストール

[Bun](https://bun.sh) 1.4.4 以降、git、[herdr](https://herdr.dev) または herdr-core `hc`([ランタイム](#ランタイム) を参照)、pane の中で動くコーディングエージェント [omo](https://github.com/code-yeongyu/oh-my-openagent)、レビューとチェックとマージに使う GitHub CLI `gh` が必要です。

### Windows

PowerShell で、どのフォルダからでも:

```powershell
irm https://raw.githubusercontent.com/useonmn/win-dori/main/install.ps1 | iex
```

チェックアウトがあれば cmd.exe で `install.cmd` を実行しても構いません。同じ引数で `install.ps1` を呼びます。

インストールはこの一行で終わりです。git が必要で(なくて winget があれば `Git.Git` を入れます)、bun と herdr がなければ公式インストーラーで入れます(`DORI_NO_DEPS=1` で無効)。インストール先は `%USERPROFILE%\.dori\src` で、もう一度実行するとその複製を更新します(`DORI_NO_PULL=1` で pull を省略)。スキルは `%USERPROFILE%\.agents\skills\dori-mode` にディレクトリジャンクションでリンクするので、管理者権限も開発者モードもいりません。`bun install` と `bun link` を実行し、bun のグローバル bin フォルダをユーザーの PATH に足します。そのあと `profile/` の Windows プロファイルを配置します。`DORI_SKIP_PROFILE=1` ならそれを飛ばし、例の設定を `%USERPROFILE%\.dori\config.json` にコピーします。`DORI_SRC`、`SKILLS_DIR`、`DORI_HOME` で場所を変え、`DORI_REPO` でフォークを指せます。PATH の変更を反映させるため、終わったら新しいターミナルを開いてください。

あとは herdr を開き、その中で omo を起動して「Dori mode」と言うだけです。

### Windows プロファイル

どのメッセンジャーを選んでも、プロファイルが再起動後も Dori を動かし続けます。起動スクリプト、設定、自動起動タスク、Slack ならチャンネルのルールとアプリマニフェスト付きの Socket Mode 受信リスナーです。ユーザー名、フォルダ、チャンネルはどこにも書かれていません。パスはすべて `%USERPROFILE%` から、id はすべてあなたのトークンから得ます。

初めて「Dori mode」と言うと、Dori が会話の中で自分を設定します。メッセンジャーを尋ね、あなただけが読めるメモ帳ファイルを開いてトークンを受け取ります(トークンをチャットに貼らないでください)。`dori setup <messenger>` がトークンを確かめ、分かる id を埋め、あなたの Windows ユーザーだけが読める `%USERPROFILE%\.dori\<messenger>.env`(`slack.env`、`telegram.env`、`discord.env`)を保存し、`Dori Autostart` タスクを登録します。以後はログオンすると herdr が起動し、Dori の名前のワークスペースが開き、そこでエージェントが始まります。

Slack リスナーは拾ったメッセージに目のリアクションを付け、スレッドに作業中のステータスを出し、Dori が返信すると目をチェックマークに替えます。

プロファイルの手順は何度実行しても安全です。編集したファイルは残して差分を見せ、`config.json` は作るだけで置き換えません。`DORI_DRY_RUN=1` はプレビュー、`DORI_FORCE=1` は編集済みファイルを置き換えて `.bak-<time>` の複製を残し、`DORI_NO_TASK=1` はタスクを登録しません。実行のたびに、それを元に戻す `%USERPROFILE%\.dori\undo-profile-<time>.ps1` を書き出します。構成要素の一覧は [profile/INVENTORY.md](profile/INVENTORY.md) にあり、チェックアウトから `profile\install-profile.ps1 -DryRun` でプロファイルの手順だけを実行できます。

### ランタイム

レーンは herdr か herdr-core `hc` の中で動きます。選ぶ順番は、先に当てはまったものが勝ちです。`DORI_RUNTIME`、`config.json` の `runtime` キー、`HC_TERMINAL_ID`(hc の中にいる)、`HERDR_PANE_ID`(herdr の中にいる)、最後に PATH にある片方のバイナリです。PATH に herdr だけがあれば herdr が既定です。Windows では hc を herdr-core の公式インストーラーで入れます。

### macOS と Linux

```sh
curl -fsSL https://raw.githubusercontent.com/useonmn/win-dori/main/install.sh | bash
```

リポジトリを `~/.dori/src` にクローンし、スキルを `~/.agents/skills/dori-mode` にリンクし、`dori` を PATH に載せ、例の設定を `~/.dori/config.json` にコピーします。

### チェックアウトからハーネスを使う

```powershell
git clone https://github.com/useonmn/win-dori
cd win-dori
bun install
bun link        # `dori-harness` を PATH に載せます。しない場合は `bun src/cli.ts` を使います
```

そのあと `~/.dori/config.json` に少なくとも `leadPane`(`herdr pane current` で分かります)、`laneWorkspace`、`defaultCwd` を設定してください。

### Windows での注意

- トークンはユーザー環境変数ではなく `~/.dori/<messenger>.env` に置きます。`dori` がそのファイル(または `DORI_ENV_FILE` のファイル)を自分で読みます。その場限りのシェルでは、上の例のように `$env:DORI_SLACK_TOKEN = "xoxp-..."` で設定します。
- ハーネスは pane にコマンドを打ち込むので、pane ごとにシェルを調べてそれに合わせてクォートします。pwsh、Windows PowerShell 5.1、cmd、Git Bash です。`DORI_PANE_SHELL`(`posix`、`pwsh`、`powershell`、`cmd`)で上書きできます。
- ホストガードは `powershell.exe` の呼び出し一回で負荷、メモリ、スワップ、ディスクを読みます。負荷は CPU 使用率かける CPU 数にプロセッサキューを足した値なので、Unix の 1 分平均より大きく揺れます。
- `Done =` のコマンドは `["bun","test"]` のような argv のリストなので、同じ行が Windows、macOS、Linux で通ります。

## クイックスタート

herdr のサーバーを起動してから、harness を立ち上げます。

```sh
dori-harness up
# UP lead=w1:p1 duty=w1:p2 loop=w1:p3 hourly=w1:p4 home=~/.dori
```

`dori` という名前の herdr ワークスペースが開き、lead（`prompts/lead.md` をシステムプロンプトに追記した omo セッション）と、その下に duty セッション、duty ループ、毎時のループが並びます。lead に話しかけてください。lead は brief（目的、入力、成果物、停止条件、制約。[examples/brief.md](examples/brief.md) 参照）を書き、自分で lane を開きます。シェルから開くこともできます。

```sh
dori-harness start fix-flaky-login --brief examples/brief.md
# STARTED fix-flaky-login pane=w1:p5 brief=~/.dori/briefs/fix-flaky-login.md

dori-harness status
# lead=w1:p1 duty=w1:p2 home=~/.dori
# fix-flaky-login         working  w1:p5    active 0m ago  start: examples/brief.md
```

lane のキーは `^[a-z][a-z0-9-]{1,40}$` に一致し、すでに開いているキーは拒否されます。lane の中では、lane のルールが渡すコマンドで報告し、終わります。

```sh
dori-harness report fix-flaky-login --text '再現: 20 回中 1 回失敗、共有セッションフィクスチャ'
dori-harness report fix-flaky-login --status waiting --text 'WAITING: owner/repo#12 のチェック待ち'
dori-harness ready fix-flaky-login --text '原因を修正、チェックはグリーン' --evidence https://github.com/owner/repo/pull/12
# READY fix-flaky-login
```

lead はペインで `[READY fix-flaky-login]` を読み、自分でゲートを回します。

```sh
dori-harness review owner/repo#12             # head に固定した新しい omo レビュアー。receipt を書く
dori-harness merge owner/repo#12 --dry-run    # MERGE_OK owner/repo#12 head=<sha> (dry run)、または MERGE_REFUSED <理由>
dori-harness merge owner/repo#12              # gh pr merge --squash --match-head-commit <sha>
dori-harness done fix-flaky-login             # lane のタブを閉じる。READY の lane だけが閉じられる
```

`dori-harness send <lead|duty|key|pane> --text '...'` はペインへ届けるか、忙しければ溜めます。`--text` を省くと標準入力から読みます。エージェントが受け取るコマンドは `src/cli.ts` の絶対パスと `DORI_HOME` を設定した形で描画されるので、PATH 上の `dori` がどちらでも動きます。

## 仕組み

![lane lifecycle](docs/lane-flow.png)

あなたと話すのは lead だけです。lead は依頼を brief にし、lane を開き、lane からの報告を読み、マージします。

lane は専用タブのエージェントセッション一つで、brief 一つと lane のルール（`prompts/lane-footer.md`）を追記して起動します。区切りは `dori-harness report` で報告し、最後は `dori-harness ready` で終わります。証拠のリンクがなければ `dori-harness ready` は通りません。lane の行動はすべて一行になって lead に届きます。`[START]`、`[REPORT]`、`[READY]`、`[LOST]`、`[ESCALATE]` です。

duty ループは `dori-harness duty --interval 60` で、duty セッションの隣で動く普通のプロセスです。tick ごとに、idle になったペインへ溜まったメッセージを流し、黙った lane を催促し、lead にエスカレーションし、ペインが消えた lane を lost として記録します。

毎時のループは `dori-harness loop` です。一時間ごとに backlog を現実と突き合わせ、見落としを監査し、誰の判断も要らない次の項目を開始し、開いている問いを一度だけ聞き、報告を一つ送ります。マージも push もペインの閉鎖もしません。

状態は `~/.dori`（または `$DORI_HOME`）配下の JSON です。`lanes/`、`inbox/`、`briefs/`、`receipts/`、そして毎時のループ用の `backlog/` と `loop/`、停止ファイル用の `duty/` があります。harness が追加する常駐プロセスはこの二つのループだけで、実行時の依存は Bun だけです。

### マージゲート

`dori-harness merge` は `gh` で PR の head SHA を読み、理由を名指しして拒否します。

| 拒否 | 意味 |
|---|---|
| `no_receipt` | この head に対する CLEAR のレビュー receipt がない |
| `review_block` | この head の receipt が BLOCK |
| `no_checks` | チェックが一つもない。空のリストはグリーンにならない |
| `checks_red` | 失敗したチェックがある |
| `checks_all_skipped` | すべてのチェックが skip され、何も通っていない |

receipt を書くのは `dori-harness review` だけで、他の何も書きません。head に固定した `prompts/review.md` を非対話の omo に渡して実行し、`VERDICT:` 行を出さないレビュアーは receipt を残しません。レビューの後に push すれば head が動くので、古い receipt は効きません。

`~/.dori/config.json` の `hooks.reviewCommand` で、内蔵レビュアーを自前のコマンドに差し替えられます。同じ `VERDICT:` 行を出す必要があります。

## コマンド一覧

harness、`src/cli.ts`。

| コマンド | 内容 |
|---|---|
| `dori-harness up [--cwd DIR]` | lead、duty、duty ループ、毎時のループのペインを開く |
| `dori-harness start <key> --brief FILE [--cwd DIR]` | lane を開く。新しいタブ、エージェントセッション、brief と lane ルール |
| `dori-harness report <key> --text T [--status working\|waiting]` | lane が区切りまたは待ちを記録する |
| `dori-harness ready <key> --text T --evidence LINK` | lane が終わる。証拠がなければ拒否 |
| `dori-harness review <owner/repo#N> [--model M]` | その head での新しいレビュアー。receipt を書く |
| `dori-harness merge <owner/repo#N> [--dry-run]` | CLEAR の receipt とグリーンのチェックのうえで squash マージ |
| `dori-harness done <key>` | lead が READY の lane を閉じる |
| `dori-harness status` | ロールと開いているすべての lane |
| `dori-harness duty [--once] \| stop \| resume \| status` | duty ループと停止スイッチ |
| `dori-harness loop [--once] \| stop \| resume \| status` | 毎時のループと停止スイッチ |
| `dori-harness backlog add \| list \| decide \| drop \| import` | 毎時のループが取り出す待ち行列 |
| `dori-harness send <target> --text T` と `dori-harness inbox list\|ack\|resend` | 配送、待機、保留された配送の解決 |
| `dori-harness role <lead\|duty> [PANE]` | `dori-harness up` を使わなかったときにペインを登録する |

引数なしで `bun src/cli.ts` を実行すると、すべてのフラグ付きで同じ一覧が出ます。

Dori mode、`skills/dori-mode/scripts/src/cli.ts`。

| コマンド | 内容 |
|---|---|
| `dori launch <key> --title T --brief FILE --done "..."` | lane を開く。実行時間、トークン、コストの上限を任意で付ける |
| `dori claim-done` と `dori object-done` | 5 分の完了フロー |
| `dori close <key>` | `Done =` のシグナルが実物で確認できた lane を閉じる |
| `dori sync` / `dori boot` | レジストリと実ペインの突き合わせ。再起動後の読み取り専用チェック |
| `dori freshness` / `dori dead-panes` / `dori guard` / `dori heavy` | 催促、検出、ホスト負荷の監視、重いコマンドの制限 |
| `dori send` / `dori inbound` / `dori presence` / `dori transcribe` | 上記のメッセンジャー用コマンド |
| `dori worklog` / `dori lesson` / `dori checkpoint` | 依頼の記録、リポジトリごとの学び、完了したステップ |

`dori launch --dry-run` は lane が受け取る形の brief を出力します。

## 拡張する

`~/.dori/config.json` のライフサイクルフックは、状態の変化で自前のプログラムを呼びます。argv 配列として渡され、`{key}`、`{text}`、`{evidence}`、`{repo}`、`{number}`、`{sha}` が引数ごとに埋まり、シェルは経由しません。

| フック | 発火 |
|---|---|
| `hooks.onReady` | lane が証拠付きで終わったとき |
| `hooks.onReport` | lane が報告したとき |
| `hooks.onLost` | lane のペインが消えたとき |
| `hooks.reviewCommand` | 内蔵レビュアーを置き換える |

応答しないフックがコマンドを止めることはありません。CLI は実行中のフックを最大 2 秒だけ待ち、その旨を出力します。`DORI_PROMPTS_DIR` で四つのプロンプトを自前のものに差し替え、`DORI_AGENT_CMD` で `omo` を別のエージェントに替え、`DORI_HOME` で状態ディレクトリを移せます。

## コンテナで動かす

[examples/container](examples/container) は gh、node、bun、herdr、omo、harness を固定した Ubuntu イメージと、`dori` サービス一つ、そしてすべての状態を入れる名前付きボリュームを用意します。公開イメージはありません。ローカルでビルドし、中で一度ログインしてください。[docs/container.md](docs/container.md) にビルド、再起動しても残るボリューム、サイジングがあります。

## テスト

```sh
bun run test        # ./test/ の 275 テスト
bun run test:skill  # skills/dori-mode/scripts の 308 テスト
bun run ci          # Biome、tsc、knip、250 行のラチェット、そのあと両方のスイート
```

どちらのスイートもモデルもネットワークも要りません。harness は偽の herdr と偽の `gh` に対して、Dori mode は偽の herdr、git、`gh` に対して走ります。エンドツーエンドのテスト二つは本物の herdr サーバーを起動し、`herdr` が PATH にないときは自分自身を skip します。

Windows プロファイルには専用のテストがあります(Windows のみ): `cd profile; bun test`。追跡されているファイルにハードコードされたユーザーパスや個人の値があると、`bun scripts/check-paths.ts` が失敗します。

## テレメトリー

`dori` は omo と同じやり方で匿名の利用数を送ります。`https://t.omo.dev` への OTLP/HTTP JSON で、`~/.dori/telemetry.json` に置いたランダムなインストール id の sha256 だけを送ります。外に出るのは数と固定の enum です。インストール、日次アクティブ、lane 開始、lane ready、レビュー完了、マージ判定、そして一時間に一度の duty サマリーです。パス、リポジトリ名、PR 番号、lane キー、brief、メッセージその他のテキストは送りません。`DORI_TELEMETRY=0` で止まり（`DO_NOT_TRACK=1` も効きます）、`DORI_TELEMETRY_ENDPOINT` で送り先を変えられます。テレメトリーがコマンドを失敗させることはありません。

## コントリビュート

コントリビューターは、レビューやマージの前に[コントリビューターライセンス契約](https://github.com/sisyphuslabs/dori-superagent/blob/main/CLA.md)へ一度署名します。プルリクエストに `I have read the CLA Document and I hereby sign the CLA` とコメントしてください。ゲート、テストコマンド、プルリクエストの規則は [CONTRIBUTING.md](CONTRIBUTING.md) にあります。

## ライセンス

上流 [7ac0ed7](https://github.com/sisyphuslabs/dori-superagent/commit/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444) の移植から、win-dori は上流と同じく [Sustainable Use License](LICENSE) 1.0 で提供され、サードパーティのコンポーネントはそれぞれのライセンスに従います。個人利用、社内業務での利用、無償の非商用利用が認められ、商用利用には所有者である Sisyphus Labs のライセンスが必要です。win-dori が何を変えたかは [NOTICE.md](NOTICE.md) にあります。`fa86ddf` までの win-dori のバージョンは MIT で、引き続き MIT です。`prompts/` のプロンプトはエージェントが実際に受け取る指示で、信頼する前に読み切れるほど短いものです。
