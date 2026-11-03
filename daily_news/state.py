"""通知済みトピックの記録（別の日に同じ話題を重ねて通知しないため）。

使い方: uv run python -m daily_news.state   # 直近に通知したトピックを表示
"""

import json
import sys
from datetime import date, timedelta

from .config import DATA_DIR, NOTIFIED_KEEP_DAYS

NOTIFIED_PATH = DATA_DIR / "notified.json"


def load_notified() -> list[dict]:
    """[{key, title, urls, date}] を新しい順で返す。"""
    if not NOTIFIED_PATH.exists():
        return []
    data = json.loads(NOTIFIED_PATH.read_text())
    return sorted(data, key=lambda t: t.get("date", ""), reverse=True)


def add_notified(items: list[dict], on: date | None = None) -> None:
    on = on or date.today()
    cutoff = (on - timedelta(days=NOTIFIED_KEEP_DAYS)).isoformat()
    new_keys = {it.get("key") for it in items}
    # 同じ key を再投稿したときは古い記録を置き換える
    data = [
        t for t in load_notified() if t.get("date", "") >= cutoff and t.get("key") not in new_keys
    ]
    for it in items:
        data.append(
            {
                "key": it.get("key", ""),
                "title": it.get("title", ""),
                "urls": [s["url"] for s in it.get("sources", []) if s.get("url")],
                "date": on.isoformat(),
            }
        )
    DATA_DIR.mkdir(exist_ok=True)
    NOTIFIED_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def main() -> int:
    topics = load_notified()
    if not topics:
        print("通知済みのトピックはありません。")
        return 0
    print(f"直近{NOTIFIED_KEEP_DAYS}日に通知したトピック（{len(topics)}件）:")
    for t in topics:
        print(f"- {t['date']} [{t['key']}] {t['title']}")
        for url in t.get("urls", []):
            print(f"    {url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
