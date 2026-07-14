#!/usr/bin/env python3
"""Cheap schedule gate for GitHub Actions (stdlib only)."""

from __future__ import annotations

import argparse
import os
import sys
import tomllib
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

WEEKDAY_NAMES = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)

DEFAULTS = {
    "frequency": "weekly",
    "weekday": "friday",
    "hour": 18,
    "timezone": "Asia/Tokyo",
}


def load_schedule(path: Path) -> dict:
    cfg = dict(DEFAULTS)
    if not path.is_file():
        return cfg
    with open(path, "rb") as f:
        data = tomllib.load(f)
    section = data.get("schedule") or {}
    for key in DEFAULTS:
        if key in section:
            cfg[key] = section[key]
    return cfg


def validate(cfg: dict) -> None:
    frequency = str(cfg["frequency"]).lower()
    if frequency not in ("daily", "weekly"):
        print(
            f"エラー: frequency が不正です: {cfg['frequency']!r}（daily または weekly）",
            file=sys.stderr,
        )
        sys.exit(2)
    cfg["frequency"] = frequency

    weekday = str(cfg["weekday"]).lower()
    if weekday not in WEEKDAY_NAMES:
        print(
            f"エラー: weekday が不正です: {cfg['weekday']!r}（monday..sunday）",
            file=sys.stderr,
        )
        sys.exit(2)
    cfg["weekday"] = weekday

    try:
        hour = int(cfg["hour"])
    except (TypeError, ValueError):
        print(f"エラー: hour が不正です: {cfg['hour']!r}（0-23）", file=sys.stderr)
        sys.exit(2)
    if not 0 <= hour <= 23:
        print(f"エラー: hour が不正です: {hour}（0-23）", file=sys.stderr)
        sys.exit(2)
    cfg["hour"] = hour

    tz_name = str(cfg["timezone"])
    try:
        ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        print(f"エラー: timezone が不正です: {tz_name!r}", file=sys.stderr)
        sys.exit(2)
    cfg["timezone"] = tz_name


def parse_now(raw: str | None, tz: ZoneInfo) -> datetime:
    if raw is None:
        return datetime.now(tz)
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    return dt.astimezone(tz)


def emit(run: bool) -> None:
    line = f"run={'true' if run else 'false'}"
    print(line)
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Check delivery schedule gate")
    parser.add_argument("--config", default="config.toml", help="Path to config.toml")
    parser.add_argument("--now", default=None, help="ISO8601 override for tests")
    args = parser.parse_args()

    cfg = load_schedule(Path(args.config))
    validate(cfg)

    tz = ZoneInfo(cfg["timezone"])
    now = parse_now(args.now, tz)
    hour_ok = now.hour == cfg["hour"]
    day_ok = cfg["frequency"] == "daily" or WEEKDAY_NAMES[now.weekday()] == cfg["weekday"]
    should_run = hour_ok and day_ok

    print(
        f"現在時刻={now.isoformat()} 設定=frequency={cfg['frequency']} "
        f"weekday={cfg['weekday']} hour={cfg['hour']} timezone={cfg['timezone']} "
        f"判定={'実行' if should_run else 'スキップ'}",
        file=sys.stderr,
    )
    emit(should_run)


if __name__ == "__main__":
    main()
