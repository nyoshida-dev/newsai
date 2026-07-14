"""Collect AI news from RSS/Atom feeds and format for LLM analysis."""

from __future__ import annotations

import argparse
import re
import sys
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlparse

import httpx

from config import Config
from llm_providers import LLMError, LLMProvider

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_ATOM_NS = {"atom": "http://www.w3.org/2005/Atom"}


def _local_tag(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def _text(el: ET.Element | None) -> str:
    if el is None or el.text is None:
        return ""
    return el.text.strip()


def _strip_html(text: str, max_len: int = 300) -> str:
    cleaned = _HTML_TAG_RE.sub("", text or "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if len(cleaned) > max_len:
        return cleaned[: max_len - 1] + "…"
    return cleaned


def _parse_datetime(value: str) -> datetime | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        pass
    try:
        iso = value.replace("Z", "+00:00")
        return datetime.fromisoformat(iso)
    except ValueError:
        return None


def _child(el: ET.Element, *names: str) -> ET.Element | None:
    wanted = set(names)
    for child in el:
        if _local_tag(child.tag) in wanted:
            return child
    return None


def _children(el: ET.Element, *names: str) -> list[ET.Element]:
    wanted = set(names)
    return [c for c in el if _local_tag(c.tag) in wanted]


def _atom_link(entry: ET.Element) -> str:
    links = _children(entry, "link")
    for link in links:
        rel = link.get("rel") or "alternate"
        href = link.get("href") or ""
        if rel == "alternate" and href:
            return href
    for link in links:
        href = link.get("href") or ""
        if href:
            return href
    return ""


def _feed_title(root: ET.Element, feed_url: str) -> str:
    title_el = _child(root, "title")
    title = _text(title_el)
    if title:
        return title
    host = urlparse(feed_url).netloc or feed_url
    return host


def _parse_rss_items(root: ET.Element, feed_url: str) -> tuple[str, list[dict[str, Any]]]:
    channel = _child(root, "channel")
    if channel is None:
        channel = root
    title = _feed_title(channel, feed_url)
    items: list[dict[str, Any]] = []
    for item in _children(channel, "item"):
        pub = _parse_datetime(_text(_child(item, "pubDate", "published", "updated")))
        summary_el = _child(item, "description", "summary", "content")
        summary_raw = ""
        if summary_el is not None:
            summary_raw = _text(summary_el) or "".join(summary_el.itertext())
        link_el = _child(item, "link")
        link = _text(link_el) or (link_el.get("href") if link_el is not None else "") or ""
        items.append(
            {
                "feed_title": title,
                "title": _text(_child(item, "title")) or "(no title)",
                "link": link,
                "published": pub,
                "summary": _strip_html(summary_raw),
            }
        )
    return title, items


def _parse_atom_items(root: ET.Element, feed_url: str) -> tuple[str, list[dict[str, Any]]]:
    title = _feed_title(root, feed_url)
    items: list[dict[str, Any]] = []
    for entry in list(root.findall("atom:entry", _ATOM_NS)) + _children(root, "entry"):
        pub = _parse_datetime(
            _text(_child(entry, "published", "updated", "pubDate"))
        )
        summary_el = _child(entry, "summary", "content", "description")
        summary_raw = ""
        if summary_el is not None:
            summary_raw = _text(summary_el) or "".join(summary_el.itertext())
        items.append(
            {
                "feed_title": title,
                "title": _text(_child(entry, "title")) or "(no title)",
                "link": _atom_link(entry),
                "published": pub,
                "summary": _strip_html(summary_raw),
            }
        )
    return title, items


def _parse_feed(xml_text: str, feed_url: str) -> tuple[str, list[dict[str, Any]]]:
    root = ET.fromstring(xml_text)
    tag = _local_tag(root.tag).lower()
    if tag == "feed":
        return _parse_atom_items(root, feed_url)
    return _parse_rss_items(root, feed_url)


def fetch_feed_items(
    feeds: list[str],
    days: int,
    max_items_per_feed: int,
    verbose: bool = False,
) -> list[dict[str, Any]]:
    """Fetch and parse RSS/Atom feeds; one failure does not abort the run."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    collected: list[dict[str, Any]] = []

    for feed_url in feeds:
        feed_url = (feed_url or "").strip()
        if not feed_url:
            continue
        try:
            with httpx.Client(timeout=20.0, follow_redirects=True) as client:
                resp = client.get(feed_url)
                resp.raise_for_status()
                xml_text = resp.text
            _title, items = _parse_feed(xml_text, feed_url)
        except Exception as e:
            print(f"⚠️ feed取得失敗: {feed_url}: {e}", file=sys.stderr)
            continue

        kept: list[dict[str, Any]] = []
        for item in items:
            pub = item.get("published")
            if pub is not None:
                if pub.tzinfo is None:
                    pub = pub.replace(tzinfo=timezone.utc)
                    item["published"] = pub
                if pub < cutoff:
                    continue
            kept.append(item)

        kept.sort(
            key=lambda x: x.get("published") or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )
        kept = kept[:max_items_per_feed]
        if verbose:
            print(f"📡 {_title}: {len(kept)}件 (from {feed_url})", file=sys.stderr)
        collected.extend(kept)

    collected.sort(
        key=lambda x: x.get("published") or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    return collected


def format_items_for_analysis(items: list[dict[str, Any]]) -> str:
    """Format feed items as markdown grouped by feed title."""
    if not items:
        return ""

    groups: dict[str, list[dict[str, Any]]] = {}
    order: list[str] = []
    for item in items:
        key = item.get("feed_title") or "feed"
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(item)

    parts: list[str] = []
    for feed_title in order:
        parts.append(f"## {feed_title}")
        for item in groups[feed_title]:
            pub = item.get("published")
            date_str = pub.strftime("%Y-%m-%d") if isinstance(pub, datetime) else "unknown"
            title = item.get("title") or "(no title)"
            link = item.get("link") or ""
            summary = item.get("summary") or ""
            line = f"- [{title}]({link}) ({date_str})"
            if summary:
                line += f"\n  {summary}"
            parts.append(line)
        parts.append("")
    return "\n".join(parts).rstrip() + "\n"


def generate_web_news(
    provider: LLMProvider,
    cfg: Config,
    items_text: str,
    verbose: bool = False,
) -> str | None:
    """Build the web-news user prompt and call the provider."""
    web_search = cfg.web_mode in ("llm_search", "hybrid")
    instruction = cfg.instruction_prompt
    if cfg.instruction_file:
        with open(cfg.instruction_file, "r", encoding="utf-8") as f:
            instruction = f.read()
    parts: list[str] = [instruction.rstrip()]

    if cfg.web_mode in ("llm_search", "hybrid") and cfg.web_queries:
        parts.append("\n#検索トピック")
        parts.extend(f"- {q}" for q in cfg.web_queries)
        today = date.today().isoformat()
        parts.append(
            f"直近{cfg.days}日以内のニュースを対象にしてください。今日の日付: {today}"
        )

    if items_text.strip():
        parts.append("\n#収集済みフィード記事")
        parts.append(items_text.rstrip())

    user_prompt = "\n".join(parts) + "\n"
    if verbose:
        print("🧠 Web/X AIニュースを生成します...")
    try:
        return provider.generate(
            cfg.system_prompt,
            user_prompt,
            web_search=web_search,
        )
    except LLMError as e:
        print(str(e), file=sys.stderr)
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description="RSS/Atom フィードからAIニュースを収集")
    parser.add_argument(
        "--feeds",
        type=str,
        required=True,
        help="カンマ区切りのフィードURL",
    )
    parser.add_argument("--days", type=int, default=7, help="収集日数")
    parser.add_argument(
        "--max-items-per-feed",
        type=int,
        default=20,
        help="フィードあたりの最大件数",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    feeds = [u.strip() for u in args.feeds.split(",") if u.strip()]
    items = fetch_feed_items(
        feeds,
        days=args.days,
        max_items_per_feed=args.max_items_per_feed,
        verbose=args.verbose,
    )
    print(format_items_for_analysis(items), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
