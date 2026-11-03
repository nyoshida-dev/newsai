"""out/report.json の読み込みと形式チェック。形式は prompts/daily.md を参照。"""

import json
from pathlib import Path

from . import config

CATEGORIES = ("新モデル", "API・機能", "開発ツール", "その他")
REQUIRED = ("key", "category", "vendor", "title", "headline", "overview", "sources")


class ReportError(ValueError):
    pass


def load(path: Path) -> dict:
    report = json.loads(path.read_text())
    validate(report)
    return report


def validate(report: dict) -> None:
    """壊れた report.json をそのまま投稿しないよう、最低限の形式を確かめる。"""
    errors: list[str] = []
    if not report.get("date"):
        errors.append("date がありません")
    items = report.get("items")
    if not isinstance(items, list):
        errors.append("items が配列ではありません")
        items = []
    # 下限（MIN_ITEMS）は手順書での目安。ニュースが少ない日に水増しさせないため、ここでは上限だけ止める。
    if len(items) > config.MAX_ITEMS:
        errors.append(f"items は最大{config.MAX_ITEMS}件です（{len(items)}件）")
    keys = [it.get("key") for it in items]
    if len(keys) != len(set(keys)):
        errors.append("items に同じ key が重複しています（同じ話題は1件にまとめる）")
    for i, it in enumerate(items, 1):
        for f in REQUIRED:
            if not it.get(f):
                errors.append(f"items[{i}] に {f} がありません")
        if it.get("category") and it["category"] not in CATEGORIES:
            errors.append(f"items[{i}].category は {' / '.join(CATEGORIES)} のいずれかです")
        for s in list(it.get("sources") or []) + list(it.get("x_posts") or []):
            if not str(s.get("url", "")).startswith(("http://", "https://")):
                errors.append(f"items[{i}] に URL でない出典があります: {s}")
    if errors:
        raise ReportError("report.json の形式エラー:\n- " + "\n- ".join(errors))
