import os
import re
import sys
import argparse
from typing import Optional, List, Dict, Any
from datetime import datetime
from dotenv import load_dotenv
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError


class SlackPoster:
    def __init__(self, token: str, default_channel: Optional[str] = None, verbose: bool = False):
        self.client = WebClient(token=token)
        self.default_channel = default_channel or os.environ.get("SLACK_CHANNEL")
        self._channel_cache: Dict[str, str] = {}
        self.verbose = verbose

    def _log(self, message: str) -> None:
        if self.verbose:
            print(message)

    def _load_channel_cache(self) -> None:
        if self._channel_cache:
            return
        try:
            result = self.client.conversations_list(
                exclude_archived=True,
                types="public_channel,private_channel",
                limit=1000,
            )
            channels = result.get("channels", [])
            for ch in channels:
                self._channel_cache[ch.get("name", "")] = ch.get("id", "")
            while result.get("response_metadata", {}).get("next_cursor"):
                cursor = result["response_metadata"]["next_cursor"]
                result = self.client.conversations_list(
                    exclude_archived=True,
                    types="public_channel,private_channel",
                    limit=1000,
                    cursor=cursor,
                )
                for ch in result.get("channels", []):
                    self._channel_cache[ch.get("name", "")] = ch.get("id", "")
        except SlackApiError:
            pass

    def _resolve_channel_id(self, channel: str) -> Optional[str]:
        if not channel:
            return None
        if channel.startswith("C") or channel.startswith("G"):
            return channel
        name = channel.lstrip("#")
        self._load_channel_cache()
        return self._channel_cache.get(name)

    def _convert_channel_links(self, text: str) -> str:
        self._load_channel_cache()
        def replace_channel(match: re.Match) -> str:
            channel_name = match.group(1)
            channel_id = self._channel_cache.get(channel_name)
            if channel_id:
                return f"<#{channel_id}|{channel_name}>"
            return match.group(0)
        return re.sub(r"#([^\s（()）\[\]]+)", replace_channel, text)

    def _split_into_chunks(self, text: str, max_length: int = 3500) -> List[str]:
        chunks: List[str] = []
        if not text:
            return chunks
        paragraphs = text.split("\n\n")
        current = ""
        for p in paragraphs:
            candidate = (current + ("\n\n" if current else "") + p).strip()
            if len(candidate) <= max_length:
                current = candidate
            else:
                if current:
                    chunks.append(current)
                if len(p) <= max_length:
                    current = p
                else:
                    start = 0
                    while start < len(p):
                        end = min(start + max_length, len(p))
                        chunks.append(p[start:end])
                        start = end
                    current = ""
        if current:
            chunks.append(current)
        return chunks

    def format_slack_message(self, summary: str) -> str:
        current_week = datetime.now().strftime("%Y年%m月第%U週")
        header = f"📰 *今週の社内ニュース - {current_week}*\n\n"
        footer = f"\n\n---\n_Generated at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} by Weekly News Bot_"
        content = self._convert_channel_links(summary)
        return header + content + footer

    def post(self, text: str, channel: Optional[str] = None, thread: bool = True) -> Optional[str]:
        channel_id = self._resolve_channel_id(channel or self.default_channel or "")
        if not channel_id:
            print("❌ チャンネルが見つかりませんでした", file=sys.stderr)
            return None
        formatted_text = self.format_slack_message(text)
        text_chunks = self._split_into_chunks(formatted_text)
        if not text_chunks:
            print("❌ 投稿するテキストが空です", file=sys.stderr)
            return None
        try:
            first = self.client.chat_postMessage(
                channel=channel_id,
                text=text_chunks[0],
            )
            thread_ts = first.get("ts") if thread else None
            for chunk in text_chunks[1:]:
                self.client.chat_postMessage(channel=channel_id, text=chunk, thread_ts=thread_ts)
            permalink = None
            try:
                perm = self.client.chat_getPermalink(channel=channel_id, message_ts=first.get("ts"))
                permalink = perm.get("permalink")
            except SlackApiError:
                permalink = None
            self._log("✅ Slackへの投稿が完了しました")
            return permalink
        except SlackApiError as e:
            print(f"❌ Slack投稿エラー: {getattr(e.response, 'data', e.response).get('error', str(e))}", file=sys.stderr)
            return None


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(
        description="入力テキストをSlackに投稿する（投稿専用）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用例:
  echo "テキスト" | python post_slack.py --channel general
  python post_slack.py --channel general --text "本文"
  python post_slack.py --no-thread --text "スレッド化しない"
  python post_slack.py -v --text "詳細ログを表示"
        """,
    )
    parser.add_argument("--channel", type=str, help="投稿先チャンネル名またはID")
    parser.add_argument("--token", type=str, help="Slackボットトークン")
    parser.add_argument("--text", type=str, help="投稿する本文。未指定時はstdinを読む")
    parser.add_argument("--no-thread", action="store_true", help="スレッド化しない")
    parser.add_argument("-v", "--verbose", action="store_true", help="詳細なログを出力する")
    args = parser.parse_args()

    slack_token = args.token or os.environ.get("SLACK_BOT_TOKEN")
    if not slack_token:
        print("❌ エラー: SLACK_BOT_TOKEN が設定されていません", file=sys.stderr)
        print("export SLACK_BOT_TOKEN='xoxb-...' または --token を指定してください", file=sys.stderr)
        return 1

    text = args.text
    if text is None:
        try:
            if not sys.stdin.isatty():
                text = sys.stdin.read()
        except Exception:
            text = None
    if not text or not text.strip():
        print("❌ エラー: 投稿テキストが空です。--text で指定するかstdinから入力してください", file=sys.stderr)
        return 1

    poster = SlackPoster(
        token=slack_token,
        default_channel=args.channel or os.environ.get("SLACK_CHANNEL"),
        verbose=args.verbose
    )
    poster.post(text=text.strip(), channel=args.channel, thread=not args.no_thread)
    return 0


if __name__ == "__main__":
    exit(main())


