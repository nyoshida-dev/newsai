"""PDF と短い要約を Slack に投稿し、掲載したトピックを通知済みとして記録する。

使い方:
  uv run python -m daily_news.post_slack            # out/report.json と対応する PDF を投稿
  uv run python -m daily_news.post_slack --dry-run  # 投稿内容を表示するだけ
  uv run python -m daily_news.post_slack --check    # トークンと権限の確認だけ
  uv run python -m daily_news.post_slack --error "内容"  # 実行に失敗したことを通知

items が空なら「本日は掲載なし」と投稿する。
ボットに files:write がない場合は、PDF を付けずに本文だけ投稿する。
"""

import argparse
import os
import ssl
import subprocess
import sys
from datetime import date
from pathlib import Path

import certifi
from dotenv import load_dotenv
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

from . import config, report as report_mod
from .render import host, pdf_path_for
from .state import add_notified

CATEGORY_MARK = {"新モデル": "🧠", "API・機能": "🔌", "開発ツール": "🛠️", "その他": "📌"}
# PDF を添付できないとき（権限不足）に本文だけで投稿する Slack のエラー
NO_UPLOAD_ERRORS = {"missing_scope", "not_allowed_token_type", "no_permission"}


def load_token() -> str:
    load_dotenv(config.ROOT / ".env")
    token = os.environ.get("SLACK_BOT_TOKEN")
    if token:
        return token
    r = subprocess.run(
        ["security", "find-generic-password", "-s", config.KEYCHAIN_SERVICE, "-a", config.KEYCHAIN_ACCOUNT, "-w"],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0 or not r.stdout.strip():
        sys.exit("Slack トークンが見つかりません。.env の SLACK_BOT_TOKEN かキーチェーンに保存してください。")
    return r.stdout.strip()


def client() -> WebClient:
    # python.org 版 Python は OS の証明書を参照しないため certifi を明示する
    return WebClient(token=load_token(), ssl=ssl.create_default_context(cafile=certifi.where()))


def build_comment(report: dict, with_links: bool = False) -> str:
    items = report["items"]
    x_count = sum(1 for it in items if it.get("x_buzz"))
    lines = [
        f"*{config.HEADER} {report['date']}*　{len(items)}件"
        + (f"（うち X で話題 {x_count}件）" if x_count else ""),
        report.get("summary", ""),
        "",
    ]
    for i, it in enumerate(items, 1):
        mark = CATEGORY_MARK.get(it.get("category"), "📌")
        update = "【続報】" if it.get("is_update") else ""
        line = f"{mark} {i}. {update}*{it['title']}* — {it['headline']}"
        if with_links and it.get("sources"):
            url = it["sources"][0]["url"]
            line += f"　<{url}|{host(url)}>"
        lines.append(line)
    lines += ["", "詳細は添付のPDFをご確認ください。" if not with_links else "（PDF は権限不足のため添付できませんでした）"]
    return "\n".join(lines)


def build_none_comment(report: dict) -> str:
    lines = [f"*{config.HEADER} {report['date']}*　本日は掲載なし"]
    lines.append(report.get("summary") or "新しく取り上げるべき AI ニュースはありませんでした。")
    return "\n".join(lines)


def build_error_comment(message: str) -> str:
    return "\n".join(
        [
            f"*:warning: {config.HEADER} {date.today().isoformat()}*　実行に失敗しました",
            "本日の AI ニュースは作成できていません。",
            f"```{message.strip()[:1500]}```",
        ]
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", type=Path, default=config.OUT_DIR / "report.json")
    ap.add_argument("--pdf", type=Path)
    ap.add_argument("--channel", default=config.SLACK_CHANNEL_ID)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--error", metavar="MESSAGE", help="実行に失敗したことを通知する")
    args = ap.parse_args()

    if not args.channel:
        sys.exit("通知先チャンネルがありません（config.toml の [post].channel か NEWSAI_CHANNEL）。")

    if args.error:
        text = build_error_comment(args.error)
        if args.dry_run:
            print(text)
        else:
            client().chat_postMessage(channel=args.channel, text=text)
            print("エラーを Slack に通知しました。")
        return 0

    if args.check:
        auth = client().auth_test()
        scopes = auth.headers.get("x-oauth-scopes", "")
        print(f"OK: bot={auth['user']} team={auth['team']} channel={args.channel}")
        print(f"スコープ: {scopes}")
        if "files:write" not in scopes:
            print("注意: files:write がないため PDF は添付できません（本文だけ投稿します）。")
        return 0

    try:
        report = report_mod.load(args.report)
    except report_mod.ReportError as e:
        print(e, file=sys.stderr)
        return 1
    items = report.get("items") or []

    if not items:
        text = build_none_comment(report)
        if args.dry_run:
            print(text)
        else:
            client().chat_postMessage(channel=args.channel, text=text)
            print("「掲載なし」を Slack に通知しました。")
        return 0

    pdf = args.pdf or pdf_path_for(report)
    if not pdf.exists():
        sys.exit(f"PDF がありません: {pdf}（先に render を実行してください）")

    if args.dry_run:
        print(build_comment(report))
        print(f"\n添付: {pdf}")
        return 0

    c = client()
    try:
        c.files_upload_v2(
            channel=args.channel,
            file=str(pdf),
            filename=pdf.name,
            title=f"{config.HEADER} {report['date']}",
            initial_comment=build_comment(report),
        )
        print(f"Slack に投稿しました（{len(items)}件、PDF 添付）。")
    except SlackApiError as e:
        err = (getattr(e.response, "data", None) or {}).get("error", "")
        if err not in NO_UPLOAD_ERRORS:
            raise
        c.chat_postMessage(
            channel=args.channel, text=build_comment(report, with_links=True), unfurl_links=False
        )
        print(f"Slack に投稿しました（{len(items)}件、PDF なし: {err}）。")
    add_notified(items, on=date.fromisoformat(report["date"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
