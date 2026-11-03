"""out/report.json を A4 の PDF にする（Chrome のヘッドレス印刷を使う）。

使い方: uv run python -m daily_news.render [report.json] [出力.pdf]
"""

import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from jinja2 import Environment, FileSystemLoader, select_autoescape

from . import config, report as report_mod

CATEGORY_CLASS = {"新モデル": "model", "API・機能": "api", "開発ツール": "tool", "その他": "other"}


def host(url: str) -> str:
    h = urlparse(url).netloc or url
    return h[4:] if h.startswith("www.") else h


def _env() -> Environment:
    env = Environment(
        loader=FileSystemLoader(config.TEMPLATE_DIR),
        autoescape=select_autoescape(["html"]),
    )
    env.filters["cat_class"] = lambda s: CATEGORY_CLASS.get(s, "other")
    env.filters["host"] = host
    return env


def render_html(report: dict) -> str:
    return _env().get_template("report.html").render(r=report, header=config.HEADER)


def html_to_pdf(html: str, pdf_path: Path) -> None:
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        html_path = Path(tmp) / "report.html"
        html_path.write_text(html)
        subprocess.run(
            [
                config.CHROME_PATH,
                "--headless=new",
                "--disable-gpu",
                "--no-pdf-header-footer",
                f"--user-data-dir={tmp}/profile",
                f"--print-to-pdf={pdf_path}",
                html_path.as_uri(),
            ],
            check=True,
            capture_output=True,
            timeout=120,
        )
    if not pdf_path.exists():
        raise RuntimeError("PDF の生成に失敗しました")


def pdf_path_for(report: dict) -> Path:
    return config.OUT_DIR / f"ai-news-{report['date']}.pdf"


def main(argv: list[str]) -> int:
    src = Path(argv[1]) if len(argv) > 1 else config.OUT_DIR / "report.json"
    try:
        report = report_mod.load(src)
    except report_mod.ReportError as e:
        print(e, file=sys.stderr)
        return 1
    dst = Path(argv[2]) if len(argv) > 2 else pdf_path_for(report)
    html = render_html(report)
    dst.with_suffix(".html").write_text(html)  # 確認用
    html_to_pdf(html, dst)
    print(dst)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
