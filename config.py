"""Configuration loader for newsai (stdlib only)."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any


DEFAULT_SYSTEM_PROMPT = (
    "あなたは社内コミュニケーションの専門家です。"
    "Slackメッセージから重要な情報を抽出し、わかりやすくまとめることが得意です。"
)

DEFAULT_INSTRUCTION_PROMPT = """#指示
以下のSlackメッセージから、「話題のニュース」として取り上げるのに良さそうなものをピックアップして「今週の注目ニュース」として取り上げるのにふさわしいものをピックアップしてください。

- 上位10件の「今週の注目ニュース」を選んでください。
- 外部のニュースは取り上げないでください。
- もし重要なニュースが見つからない場合は、「今週は特に重要なニュースはありませんでした」と返してください。
- ネガティブなニュースは取り上げないでください。
- 番外編として、ユーモアのあるニュースを5件選んでください。
- 出力結果には【注目ニュース】と【番外編】の2つのセクションを作成してください。
- 出力結果には枕詞や最後のコメントは含めないでください。

#出力形式
- 各ニュースの間には必ず空行を1行入れてください。
- ニュースタイトル。タイトルの先頭にニュースの番号を付けてください。ニュースの最後にはタイトルに対応する絵文字を付けてください。ニュースタイトルは*で囲んでください。
- 詳細説明（1-2文）。200字以内程度。
- 最後の行に、チャンネル名を記載してください。チャンネル名は必ず行頭に#から始めてください（Slackがリンクとして認識するため）。

例：
【注目ニュース】

1. *ニュースタイトル* 絵文字
・ 詳細説明をここに記載します。
・ #channel_name

2. *次のニュースタイトル* 絵文字
・ 詳細説明をここに記載します。
・ #channel_name

【番外編】

1. *ニュースタイトル* 絵文字
・ 詳細説明をここに記載します。
・ #channel_name

#Slackメッセージ
Slackメッセージはある会社内でやり取りされた1週間分のメッセージです。各メッセージには投稿者名が[名前]の形式で含まれています。
"""


@dataclass
class Config:
    # [llm]
    provider: str = "api"  # api | codex | claude | opencode
    model: str = ""  # "" = provider default; api resolves to "gpt-5.5"
    base_url: str = ""  # api only; "" = OpenAI default
    api_key_env: str = "OPENAI_API_KEY"
    max_completion_tokens: int = 15000
    timeout_seconds: int = 600
    extra_cli_args: list[str] = field(default_factory=list)
    # [prompt]
    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    instruction_prompt: str = DEFAULT_INSTRUCTION_PROMPT
    instruction_file: str = ""  # if set, read file content and use instead of instruction_prompt
    # [collect]
    source: str = "web"  # web | slack
    days: int = 7
    channel_filter: str = ""
    exclude_channels: list[str] = field(default_factory=list)
    max_messages_per_channel: int = 100
    max_message_chars: int = 500
    auto_join: bool = True
    # [collect.web]
    web_mode: str = "llm_search"  # llm_search | feeds | hybrid
    web_queries: list[str] = field(
        default_factory=lambda: ["AI 最新ニュース", "LLM リリース", "生成AI 活用事例"]
    )
    web_feeds: list[str] = field(default_factory=list)
    web_max_items_per_feed: int = 20
    # [post]
    channel: str = ""  # SLACK_CHANNEL env takes precedence when set
    thread: bool = True
    header: str = ""


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    return [str(value)]


def _resolve_config_path(path: str | None = None) -> Path | None:
    if path:
        p = Path(path)
        return p if p.is_file() else None
    env_path = os.environ.get("NEWSAI_CONFIG")
    if env_path:
        p = Path(env_path)
        return p if p.is_file() else None
    p = Path("config.toml")
    return p if p.is_file() else None


def _apply_toml(cfg: Config, data: dict[str, Any]) -> Config:
    llm = data.get("llm") or {}
    prompt = data.get("prompt") or {}
    collect = data.get("collect") or {}
    post = data.get("post") or {}

    updates: dict[str, Any] = {}

    if "provider" in llm:
        updates["provider"] = str(llm["provider"])
    if "model" in llm:
        updates["model"] = str(llm["model"])
    if "base_url" in llm:
        updates["base_url"] = str(llm["base_url"])
    if "api_key_env" in llm:
        updates["api_key_env"] = str(llm["api_key_env"])
    if "max_completion_tokens" in llm:
        updates["max_completion_tokens"] = int(llm["max_completion_tokens"])
    if "timeout_seconds" in llm:
        updates["timeout_seconds"] = int(llm["timeout_seconds"])
    if "extra_cli_args" in llm:
        updates["extra_cli_args"] = _as_list(llm["extra_cli_args"])

    if "system" in prompt:
        updates["system_prompt"] = str(prompt["system"])
    if "instruction" in prompt:
        updates["instruction_prompt"] = str(prompt["instruction"])
    if "instruction_file" in prompt:
        updates["instruction_file"] = str(prompt["instruction_file"])

    if "source" in collect:
        updates["source"] = str(collect["source"])
    if "days" in collect:
        updates["days"] = int(collect["days"])
    if "channel_filter" in collect:
        updates["channel_filter"] = str(collect["channel_filter"])
    if "exclude_channels" in collect:
        updates["exclude_channels"] = _as_list(collect["exclude_channels"])
    if "max_messages_per_channel" in collect:
        updates["max_messages_per_channel"] = int(collect["max_messages_per_channel"])
    if "max_message_chars" in collect:
        updates["max_message_chars"] = int(collect["max_message_chars"])
    if "auto_join" in collect:
        updates["auto_join"] = bool(collect["auto_join"])

    web = collect.get("web") or {}
    if "mode" in web:
        updates["web_mode"] = str(web["mode"])
    if "queries" in web:
        updates["web_queries"] = _as_list(web["queries"])
    if "feeds" in web:
        updates["web_feeds"] = _as_list(web["feeds"])
    if "max_items_per_feed" in web:
        updates["web_max_items_per_feed"] = int(web["max_items_per_feed"])

    if "channel" in post:
        updates["channel"] = str(post["channel"])
    if "thread" in post:
        updates["thread"] = bool(post["thread"])
    if "header" in post:
        updates["header"] = str(post["header"])

    return replace(cfg, **updates) if updates else cfg


def _apply_env(cfg: Config) -> Config:
    updates: dict[str, Any] = {}
    if (v := os.environ.get("LLM_PROVIDER")) is not None and v != "":
        updates["provider"] = v
    if (v := os.environ.get("LLM_MODEL")) is not None and v != "":
        updates["model"] = v
    if (v := os.environ.get("LLM_BASE_URL")) is not None and v != "":
        updates["base_url"] = v
    if (v := os.environ.get("LLM_TIMEOUT_SECONDS")) is not None and v != "":
        updates["timeout_seconds"] = int(v)
    if (v := os.environ.get("NEWSAI_SOURCE")) is not None and v != "":
        updates["source"] = v
    return replace(cfg, **updates) if updates else cfg


def load_config(path: str | None = None) -> Config:
    """Load config with precedence: defaults → config.toml → env vars.

    Lookup order for TOML: path arg → NEWSAI_CONFIG env → ./config.toml.
    Missing file is OK (keep defaults).
    """
    cfg = Config()
    config_path = _resolve_config_path(path)
    if config_path is not None:
        with open(config_path, "rb") as f:
            data = tomllib.load(f)
        cfg = _apply_toml(cfg, data)
    cfg = _apply_env(cfg)
    return cfg


def resolve_api_key(cfg: Config) -> str | None:
    return os.environ.get(cfg.api_key_env)
