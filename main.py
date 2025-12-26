import os
import argparse
import sys
from dotenv import load_dotenv
from collect_slack_messages import SlackMessageCollector
from generate_weekly_news import WeeklyNewsGenerator
from post_slack import SlackPoster


def main() -> int:
    load_dotenv()

    parser = argparse.ArgumentParser(
        description="週次社内ニュース生成・投稿ツール",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="詳細なログを出力する"
    )
    args = parser.parse_args()
    verbose = args.verbose

    slack_token = os.environ.get("SLACK_BOT_TOKEN")
    openai_key = os.environ.get("OPENAI_API_KEY")
    slack_channel = os.environ.get("SLACK_CHANNEL")

    if not slack_token:
        print("⚠️ SLACK_BOT_TOKEN が設定されていません")
        return 0
    if not openai_key:
        print("⚠️ OPENAI_API_KEY が設定されていません")
        return 0
    if not slack_channel:
        print("⚠️ SLACK_CHANNEL が設定されていません")
        return 0

    if verbose:
        print("📥 1週間分のSlackメッセージを取得します...")
    collector = SlackMessageCollector(slack_token, verbose=verbose)
    result = collector.collect_messages(days=7, auto_join=True)
    messages = result.get("messages", [])
    if not messages:
        print("⚠️ メッセージが取得できませんでした", file=sys.stderr)
        return 1

    if verbose:
        print("🧠 今週の話題ニュースを生成します...")
    generator = WeeklyNewsGenerator(openai_key, verbose=verbose)
    summary = generator.generate_news_text(days=7, messages=messages)
    if not summary:
        print("❌ 要約の生成に失敗しました", file=sys.stderr)
        return 1

    if verbose:
        print("📤 Slackに投稿します...")
    poster = SlackPoster(token=slack_token, default_channel=slack_channel, verbose=verbose)
    poster.post(text=summary, channel=slack_channel, thread=True)
    return 0


if __name__ == "__main__":
    exit(main())


