# Claude スケジュールタスクの登録内容

Claude デスクトップアプリの「スケジュール」で新規タスクを作り、以下を設定する。

- タイトル: 【毎朝】今日のAIニュース
- 実行時刻: 毎日 7:00（cron: `0 7 * * *`）
- 作業フォルダ: `/Users/nyoshida/dev/github.com/nyoshida-dev/newsai`
- プロンプト: 下の「---」以降をそのまま貼り付ける

---

毎朝の「今日のAIニュース」を実行してください。

作業ディレクトリ: /Users/nyoshida/dev/github.com/nyoshida-dev/newsai
（Bash では毎回 `cd /Users/nyoshida/dev/github.com/nyoshida-dev/newsai && ...` の形で実行してください）

手順書 /Users/nyoshida/dev/github.com/nyoshida-dev/newsai/prompts/daily.md を最初に読み、その手順と選定基準に正確に従ってください。概要は次のとおりです。

1. `git pull --ff-only` で最新の設定を取り込む（失敗しても続行）
2. `uv run python -m daily_news.state` で直近に通知したトピックを確認する
3. WebSearch / WebFetch で直近2日の AI ニュースを集める。X の話題は `site:x.com` を付けた WebSearch で拾う
4. 同じ発表を扱う記事・投稿は1つのトピックにまとめる。通知済みの話題は大きな続報以外は載せない
5. 3〜5件を選び、out/report.json を手順書の形式で書く（取り上げるものがなければ items は空配列）
6. items があれば `uv run python -m daily_news.render` で PDF を作る
7. `uv run python -m daily_news.post_slack` で Slack に投稿する
8. どこかでエラーになったら `uv run python -m daily_news.post_slack --error "どの手順で何が起きたか"` で失敗を通知して終了する。同じコマンドの再試行は1回まで

注意:
- 毎日必ず Slack に1通（掲載あり / 掲載なし / エラー のいずれか）届くようにすること
- Slack のトークンはスクリプトが .env から読むので、トークンを探したり表示したりしないこと
- 文章はすべて日本語。確認できた事実だけを書き、推測で書かないこと
- 最後に、通知した件数とトピック名（または掲載なし・エラーの旨）を1〜2行で報告して終了すること
