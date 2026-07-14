import os
import argparse
import sys
from dotenv import load_dotenv
from collect_slack_messages import SlackMessageCollector
from collect_web_news import (
    fetch_feed_items,
    format_items_for_analysis,
    generate_web_news,
)
from generate_weekly_news import WeeklyNewsGenerator
from post_slack import SlackPoster
from config import load_config
from llm_providers import create_provider, LLMError


def _run_slack_source(cfg, provider, slack_token: str, verbose: bool) -> str | None:
    if verbose:
        print("📥 1週間分のSlackメッセージを取得します...")
    collector = SlackMessageCollector(
        slack_token,
        verbose=verbose,
        exclude_channels=cfg.exclude_channels or None,
    )
    result = collector.collect_messages(
        days=cfg.days,
        auto_join=cfg.auto_join,
        channel_filter=cfg.channel_filter or None,
    )
    messages = result.get("messages", [])
    if not messages:
        print("⚠️ メッセージが取得できませんでした", file=sys.stderr)
        return None

    if verbose:
        print("🧠 今週の話題ニュースを生成します...")
    generator = WeeklyNewsGenerator(provider, cfg, verbose=verbose)
    return generator.generate_news_text(days=cfg.days, messages=messages)


def _run_web_source(cfg, provider, verbose: bool) -> str | None:
    items_text = ""
    if cfg.web_mode in ("feeds", "hybrid"):
        if not cfg.web_feeds:
            print(
                "⚠️ [collect.web].feeds が空です。RSS収集をスキップします。",
                file=sys.stderr,
            )
        else:
            if verbose:
                print("📥 RSS/Atomフィードからニュースを取得します...")
            items = fetch_feed_items(
                cfg.web_feeds,
                days=cfg.days,
                max_items_per_feed=cfg.web_max_items_per_feed,
                verbose=verbose,
            )
            items_text = format_items_for_analysis(items)
            if cfg.web_mode == "feeds" and not items:
                print("❌ フィードからニュースを取得できませんでした", file=sys.stderr)
                return None

    return generate_web_news(provider, cfg, items_text, verbose=verbose)


def main() -> int:
    load_dotenv()

    parser = argparse.ArgumentParser(
        description="週次AIニュース生成・投稿ツール",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="詳細なログを出力する"
    )
    parser.add_argument("--config", type=str, help="config.toml のパス")
    parser.add_argument("--provider", type=str, help="LLMプロバイダ (api|codex|claude|opencode)")
    parser.add_argument("--model", type=str, help="モデル名")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="要約を生成して標準出力に表示し、Slack投稿をスキップする",
    )
    args = parser.parse_args()
    verbose = args.verbose

    cfg = load_config(args.config)
    if args.provider:
        cfg.provider = args.provider
    if args.model is not None:
        cfg.model = args.model

    slack_token = os.environ.get("SLACK_BOT_TOKEN")
    slack_channel = os.environ.get("SLACK_CHANNEL") or cfg.channel

    if not slack_token:
        print("⚠️ SLACK_BOT_TOKEN が設定されていません")
        return 0
    if not slack_channel:
        print("⚠️ SLACK_CHANNEL が設定されていません")
        return 0
    if cfg.provider == "api" and not os.environ.get(cfg.api_key_env):
        print(f"⚠️ {cfg.api_key_env} が設定されていません")
        return 0

    try:
        provider = create_provider(cfg)
    except LLMError as e:
        print(str(e), file=sys.stderr)
        return 1

    source = (cfg.source or "web").strip().lower()
    if source == "slack":
        summary = _run_slack_source(cfg, provider, slack_token, verbose)
    elif source == "web":
        summary = _run_web_source(cfg, provider, verbose)
    else:
        print(f"❌ 不明な collect.source: '{cfg.source}'（web|slack）", file=sys.stderr)
        return 1

    if not summary:
        print("❌ 要約の生成に失敗しました", file=sys.stderr)
        return 1

    if args.dry_run:
        print(summary)
        return 0

    if verbose:
        print("📤 Slackに投稿します...")
    poster = SlackPoster(
        token=slack_token,
        default_channel=slack_channel,
        verbose=verbose,
        header=cfg.header,
    )
    poster.post(text=summary, channel=slack_channel, thread=cfg.thread)
    return 0


if __name__ == "__main__":
    exit(main())
