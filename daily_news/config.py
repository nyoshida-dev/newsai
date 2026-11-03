"""設定値。環境変数 > config.toml の [post] > 既定値 の順で決まる。"""

import os
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_DIR = ROOT / "out"
TEMPLATE_DIR = ROOT / "templates"


def _post_section() -> dict:
    path = ROOT / "config.toml"
    if not path.is_file():
        return {}
    with path.open("rb") as f:
        return tomllib.load(f).get("post", {})


_post = _post_section()

# Slack
SLACK_CHANNEL_ID = os.environ.get("NEWSAI_CHANNEL") or str(_post.get("channel") or "")
HEADER = str(_post.get("header") or "📰 今日のAIニュース").replace("*", "").strip()
# トークンは環境変数 SLACK_BOT_TOKEN（.env 可）→ macOS キーチェーンの順で探す
KEYCHAIN_SERVICE = "newsai"
KEYCHAIN_ACCOUNT = "slack-bot-token"

# 1日に載せるトピック数
MIN_ITEMS = 3
MAX_ITEMS = 5
# 通知済みトピックを覚えておく日数（この間は続報でなければ載せない）
NOTIFIED_KEEP_DAYS = 14

CHROME_PATH = os.environ.get(
    "CHROME_PATH", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
)
