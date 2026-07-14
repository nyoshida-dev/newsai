"""Multi-provider LLM abstraction for newsai."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys

from config import Config, load_config, resolve_api_key


class LLMError(RuntimeError):
    """Raised when an LLM provider fails."""


class LLMProvider:
    def generate(self, system_prompt: str, user_prompt: str) -> str:
        raise NotImplementedError


class OpenAICompatibleProvider(LLMProvider):
    def __init__(self, cfg: Config):
        self.cfg = cfg
        api_key = resolve_api_key(cfg)
        if not api_key:
            raise LLMError(
                f"❌ エラー: 環境変数 {cfg.api_key_env} が設定されていません。"
                f"provider=api の場合は API キーが必要です。"
                f"export {cfg.api_key_env}='sk-...' を設定するか、"
                f"config.toml の [llm].provider を変更してください。"
            )
        from openai import OpenAI

        self.client = OpenAI(
            api_key=api_key,
            base_url=cfg.base_url or None,
            timeout=cfg.timeout_seconds,
        )
        self.model = cfg.model or "gpt-5.5"
        self.max_completion_tokens = cfg.max_completion_tokens

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_completion_tokens=self.max_completion_tokens,
        )
        content = response.choices[0].message.content
        if not content or not str(content).strip():
            raise LLMError("❌ LLMから空の応答が返されました")
        return content


class CLIProviderBase(LLMProvider):
    def __init__(self, cfg: Config, cli_name: str):
        self.cfg = cfg
        self.cli_name = cli_name
        self.timeout = cfg.timeout_seconds
        self.model = cfg.model
        self.extra_cli_args = list(cfg.extra_cli_args)

    def _run(self, argv: list[str], stdin_text: str) -> str:
        try:
            result = subprocess.run(
                argv,
                input=stdin_text,
                capture_output=True,
                text=True,
                timeout=self.timeout,
            )
        except FileNotFoundError:
            raise LLMError(
                f"❌ {self.cli_name} が見つかりません。"
                f"インストールしてログインするか、config.toml の [llm].provider を変更してください"
                f"（例: npm i -g @openai/codex && codex login）"
            ) from None
        except subprocess.TimeoutExpired:
            raise LLMError(
                f"❌ {self.cli_name} がタイムアウトしました（{self.timeout}秒）。"
                f"config.toml の [llm].timeout_seconds を増やしてください。"
            ) from None

        if result.returncode != 0:
            stderr_tail = (result.stderr or "")[-2000:]
            raise LLMError(
                f"❌ {self.cli_name} が失敗しました (exit {result.returncode}):\n{stderr_tail}"
            )

        stdout = (result.stdout or "").strip()
        if not stdout:
            raise LLMError(f"❌ {self.cli_name} から空の応答が返されました")
        return stdout


class CodexProvider(CLIProviderBase):
    def __init__(self, cfg: Config):
        super().__init__(cfg, "codex")

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        argv = [
            "codex",
            "exec",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--ephemeral",
        ]
        if self.model:
            argv.extend(["-m", self.model])
        argv.extend(self.extra_cli_args)
        argv.append("-")
        stdin_text = system_prompt + "\n\n" + user_prompt
        return self._run(argv, stdin_text)


class ClaudeCodeProvider(CLIProviderBase):
    def __init__(self, cfg: Config):
        super().__init__(cfg, "claude")

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        argv = [
            "claude",
            "-p",
            "--output-format",
            "json",
            "--tools",
            "",
            "--no-session-persistence",
            "--system-prompt",
            system_prompt,
        ]
        if self.model:
            argv.extend(["--model", self.model])
        argv.extend(self.extra_cli_args)
        raw = self._run(argv, user_prompt)
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            raise LLMError(
                f"❌ claude の JSON 応答の解析に失敗しました: {e}\n"
                f"応答末尾: {raw[-500:]}"
            ) from e
        if data.get("is_error"):
            raise LLMError(
                f"❌ claude がエラーを返しました:\n{raw[-500:]}"
            )
        result = data.get("result")
        if result is None or not str(result).strip():
            raise LLMError(
                f"❌ claude から空の応答が返されました:\n{raw[-500:]}"
            )
        return str(result)


class OpencodeProvider(CLIProviderBase):
    def __init__(self, cfg: Config):
        super().__init__(cfg, "opencode")

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        argv = ["opencode", "run"]
        if self.model:
            argv.extend(["-m", self.model])
        argv.extend(self.extra_cli_args)
        argv.append("上記の入力に含まれる#指示に従って出力してください。")
        stdin_text = system_prompt + "\n\n" + user_prompt
        return self._run(argv, stdin_text)


_CLI_BINARIES = {
    "codex": ("codex", "npm i -g @openai/codex && codex login"),
    "claude": ("claude", "npm i -g @anthropic-ai/claude-code && claude setup-token"),
    "opencode": ("opencode", "npm i -g opencode-ai"),
}

_PROVIDERS = {
    "api": OpenAICompatibleProvider,
    "codex": CodexProvider,
    "claude": ClaudeCodeProvider,
    "opencode": OpencodeProvider,
}


def create_provider(cfg: Config) -> LLMProvider:
    name = (cfg.provider or "").strip().lower()
    if name not in _PROVIDERS:
        valid = ", ".join(sorted(_PROVIDERS))
        raise LLMError(
            f"❌ 不明な LLM プロバイダ: '{cfg.provider}'。"
            f"有効な値: {valid}"
        )

    if name in _CLI_BINARIES:
        binary, install_hint = _CLI_BINARIES[name]
        if shutil.which(binary) is None:
            raise LLMError(
                f"❌ {binary} が見つかりません。"
                f"インストールしてログインするか、config.toml の [llm].provider を変更してください"
                f"（例: {install_hint}）"
            )

    return _PROVIDERS[name](cfg)


def main() -> int:
    parser = argparse.ArgumentParser(description="LLM プロバイダのスモークテスト")
    parser.add_argument("--provider", type=str, help="プロバイダ名 (api|codex|claude|opencode)")
    parser.add_argument("--model", type=str, help="モデル名")
    parser.add_argument("--config", type=str, help="config.toml のパス")
    parser.add_argument("--prompt", type=str, help="テスト用ユーザープロンプト")
    args = parser.parse_args()

    cfg = load_config(args.config)
    if args.provider:
        cfg.provider = args.provider
    if args.model is not None:
        cfg.model = args.model

    prompt = args.prompt or "1+1は？数字のみ回答してください。"
    try:
        provider = create_provider(cfg)
        result = provider.generate(
            "あなたはテスト用アシスタントです。",
            prompt,
        )
        print(result)
        return 0
    except LLMError as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
