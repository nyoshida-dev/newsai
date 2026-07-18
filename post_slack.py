import os
import re
import sys
import argparse
from typing import Optional, List, Dict, Any
from datetime import datetime
from urllib.parse import urlparse
from dotenv import load_dotenv
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError


class SlackPoster:
    def __init__(
        self,
        token: str,
        default_channel: Optional[str] = None,
        verbose: bool = False,
        header: str = "",
    ):
        self.client = WebClient(token=token)
        self.default_channel = default_channel or os.environ.get("SLACK_CHANNEL")
        self._channel_cache: Dict[str, str] = {}
        self.verbose = verbose
        self.header = header

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
        if self.header:
            header = f"{self.header}\n\n"
        else:
            header = f"📰 *今週の社内ニュース - {current_week}*\n\n"
        footer = f"\n\n---\n_Generated at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} by News Bot_"
        content = self._convert_channel_links(summary)
        return header + content + footer

    # ---- Slack Block Kit rendering ----

    # 番号見出し: "1. *タイトル* 絵文字" / 出典行: "・ 出典: <URL>" / セクション: "【注目ニュース】"
    _NUM_RE = re.compile(r"^\s*(\d+)[.．)]\s*(.*)$")
    _SRC_RE = re.compile(r"^[・\-\s]*出典[:：]\s*<?([^>\s|]+)>?\s*$")
    _SEC_RE = re.compile(r"^\s*[【\[]\s*(.+?)\s*[】\]]\s*$")
    _BULLET_RE = re.compile(r"^[・\-\s]+")
    _SECTION_ICON = {"注目ニュース": "🔎", "番外編": "🗂️"}
    _MAX_BLOCKS = 48  # Slack hard limit is 50 blocks per message

    @staticmethod
    def _source_label(url: str) -> str:
        try:
            host = urlparse(url).netloc or url
        except Exception:
            host = url
        return host[4:] if host.startswith("www.") else host

    def _parse_digest(self, summary: str) -> List[Any]:
        """Parse the digest into [(section_title, [{title, desc, url}]), ...].

        Returns [] when nothing parseable is found so the caller can fall back
        to plain text. Lenient by design — the LLM output can drift.
        """
        sections: List[Any] = []
        cur_title: Optional[str] = None
        cur_items: List[Dict[str, Any]] = []
        item: Optional[Dict[str, Any]] = None

        def flush_item() -> None:
            nonlocal item
            if item and (item["title"] or item["desc"]):
                cur_items.append(item)
            item = None

        def flush_section() -> None:
            nonlocal cur_items
            flush_item()
            if cur_title is not None:
                sections.append((cur_title, cur_items))
            cur_items = []

        for raw in summary.splitlines():
            line = raw.strip()
            if not line:
                continue
            m_sec = self._SEC_RE.match(line)
            if m_sec:
                flush_section()
                cur_title = m_sec.group(1)
                continue
            m_num = self._NUM_RE.match(line)
            if m_num:
                flush_item()
                if cur_title is None:
                    cur_title = ""
                item = {"title": m_num.group(2).strip(), "desc": [], "url": None}
                continue
            m_src = self._SRC_RE.match(line)
            if m_src and item is not None:
                item["url"] = m_src.group(1).strip()
                continue
            body = self._BULLET_RE.sub("", line).strip()
            if item is not None and body:
                item["desc"].append(body)
        flush_section()

        norm: List[Any] = []
        for title, items in sections:
            fixed = [
                {"title": it["title"], "desc": "\n".join(it["desc"]).strip(), "url": it["url"]}
                for it in items
            ]
            if fixed:
                norm.append((title, fixed))
        return norm

    def _item_blocks(self, idx: int, it: Dict[str, Any]) -> List[Dict[str, Any]]:
        title = it["title"]
        # LLM titles already carry *bold* + trailing emoji; don't double-bold.
        heading = f"{idx}. {title}" if title.startswith("*") else f"*{idx}. {title}*"
        text = heading + ("\n" + it["desc"] if it["desc"] else "")
        blocks: List[Dict[str, Any]] = [
            {"type": "section", "text": {"type": "mrkdwn", "text": text[:2900]}}
        ]
        if it["url"]:
            label = self._source_label(it["url"])
            blocks.append(
                {
                    "type": "context",
                    "elements": [{"type": "mrkdwn", "text": f"🔗 <{it['url']}|{label}>"}],
                }
            )
        return blocks

    def _build_section_messages(self, header_text: str, sections: List[Any]) -> List[List[Dict[str, Any]]]:
        """One message per section (番外編 lands in-thread). Long sections split
        across additional in-thread messages, staying under the 50-block limit."""
        messages: List[List[Dict[str, Any]]] = []
        for si, (title, items) in enumerate(sections):
            icon = self._SECTION_ICON.get(title, "•")
            subhead = {"type": "section", "text": {"type": "mrkdwn", "text": f"*{icon} {title}*"}}
            blocks: List[Dict[str, Any]] = []
            if si == 0:
                blocks.append(
                    {"type": "header", "text": {"type": "plain_text", "text": header_text[:150], "emoji": True}}
                )
            blocks.append(subhead)
            for i, it in enumerate(items, 1):
                grp = self._item_blocks(i, it)
                if len(blocks) + len(grp) + 1 > self._MAX_BLOCKS:
                    messages.append(blocks)
                    blocks = [subhead]
                blocks.extend(grp)
                blocks.append({"type": "divider"})
            if blocks and blocks[-1]["type"] == "divider":
                blocks.pop()
            messages.append(blocks)
        return messages

    def _permalink(self, channel_id: str, ts: Optional[str]) -> Optional[str]:
        if not ts:
            return None
        try:
            return self.client.chat_getPermalink(channel=channel_id, message_ts=ts).get("permalink")
        except SlackApiError:
            return None

    def _linkify_sources(self, text: str) -> str:
        """Fallback text path: collapse raw 出典 URLs into Slack hyperlinks."""
        out: List[str] = []
        for line in text.splitlines():
            m = self._SRC_RE.match(line.strip())
            if m:
                url = m.group(1).strip()
                out.append(f"・ 🔗 <{url}|出典: {self._source_label(url)}>")
            else:
                out.append(line)
        return "\n".join(out)

    def post(self, text: str, channel: Optional[str] = None, thread: bool = True) -> Optional[str]:
        channel_id = self._resolve_channel_id(channel or self.default_channel or "")
        if not channel_id:
            print("❌ チャンネルが見つかりませんでした", file=sys.stderr)
            return None

        header_text = (self.header or "📰 今日のAIニュース").replace("*", "").strip()
        sections = self._parse_digest(text)
        if sections:
            try:
                return self._post_blocks(channel_id, sections, thread, header_text)
            except SlackApiError as e:
                err = getattr(e.response, "data", {}) or {}
                self._log(f"⚠️ Block Kit投稿に失敗（{err.get('error', e)}）。テキストで再試行します。")

        return self._post_text(channel_id, text, thread)

    def _post_blocks(
        self, channel_id: str, sections: List[Any], thread: bool, header_text: str
    ) -> Optional[str]:
        messages = self._build_section_messages(header_text, sections)
        first = self.client.chat_postMessage(
            channel=channel_id, blocks=messages[0], text=header_text
        )
        thread_ts = first.get("ts") if thread else None
        for blocks in messages[1:]:
            self.client.chat_postMessage(
                channel=channel_id, blocks=blocks, text=header_text, thread_ts=thread_ts
            )
        self._log("✅ Slackへの投稿が完了しました（Block Kit）")
        return self._permalink(channel_id, first.get("ts"))

    def _post_text(self, channel_id: str, text: str, thread: bool) -> Optional[str]:
        formatted_text = self.format_slack_message(self._linkify_sources(text))
        text_chunks = self._split_into_chunks(formatted_text)
        if not text_chunks:
            print("❌ 投稿するテキストが空です", file=sys.stderr)
            return None
        try:
            first = self.client.chat_postMessage(channel=channel_id, text=text_chunks[0])
            thread_ts = first.get("ts") if thread else None
            for chunk in text_chunks[1:]:
                self.client.chat_postMessage(channel=channel_id, text=chunk, thread_ts=thread_ts)
            self._log("✅ Slackへの投稿が完了しました")
            return self._permalink(channel_id, first.get("ts"))
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


