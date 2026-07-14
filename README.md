## newsai

newsai (News×AI) collects the latest AI news from the web and X (via LLM web search and/or RSS), generates a weekly digest, and posts it to Slack.
Slack-message collection remains available (`[collect] source = "slack"`). Scheduled runs use GitHub Actions. Fork this repository and configure the secrets / variables below for your chosen LLM provider.

### Secrets and variables (provider matrix)

| Provider | Local install / login | GitHub Actions secret(s) |
|---|---|---|
| `api` | Set `OPENAI_API_KEY` (optional `base_url` / `api_key_env` in `config.toml`). Use with `[collect.web] mode = "feeds"` only | `OPENAI_API_KEY` |
| `codex` (default in example) | `npm i -g @openai/codex && codex login` | `CODEX_AUTH_JSON` (= contents of `~/.codex/auth.json`) |
| `claude` | `npm i -g @anthropic-ai/claude-code && claude setup-token` | `CLAUDE_CODE_OAUTH_TOKEN` (= output of `claude setup-token`) |
| `opencode` | `npm i -g opencode-ai` (+ login) | `OPENCODE_AUTH_JSON` (= contents of `~/.local/share/opencode/auth.json`), or `OPENCODE_API_KEY` for a custom OpenAI-compatible provider |

Always required (any provider):

- `SLACK_BOT_TOKEN`
- `SLACK_CHANNEL`
- `SLACK_EXCLUDE_CHANNELS` (optional; mainly for `source = "slack"`)

Repository variable:

- `LLM_PROVIDER` — default provider when the `workflow_dispatch` **provider** input is empty (`api` \| `codex` \| `claude` \| `opencode`)
- `LLM_MODEL` (optional)

`workflow_dispatch` inputs:

- **provider** — override `LLM_PROVIDER` for a single run (`""` / `api` / `codex` / `claude` / `opencode`)
- **dry_run** — generate but do not post to Slack (`--dry-run`; the digest is printed into Actions logs)

### Schedule

配信スケジュールはダッシュボードの保存時に workflow の cron に反映される（ログインユーザーのトークンで commit）。`config.toml` の `[schedule]` を手で編集した場合は cron も手で合わせる必要がある。OAuth スコープは `repo workflow`。timezone の DST 注意（保存時点の UTC オフセットで固定計算）。

| Key | Description |
|---|---|
| `frequency` | `daily` or `weekly` |
| `weekday` | `monday`..`sunday` (used when `frequency = "weekly"`) |
| `hour` | Delivery hour `0`–`23` in `timezone` |
| `timezone` | IANA name (default `Asia/Tokyo`) |

Defaults preserve Friday 18:00 JST (`cron: "0 9 * * 5"`). Manual `workflow_dispatch` always runs.

**Auth caveats:** Claude `setup-token` is the officially supported CI path. Codex `auth.json` in CI is positioned for trusted private automation (OpenAI recommends API keys for production). opencode subscription OAuth in CI is a gray zone — use at your own risk. Codex / opencode refresh tokens may rotate — re-seed the secret when auth fails. Never cache `auth.json` in `actions/cache`. `--dry-run` prints the digest into Actions logs.

**X / Twitter:** coverage comes from the LLM’s built-in web search (CLI providers). No X API key is required.

See the blog for more details.

https://zenn.dev/peoplex_blog/articles/2509-how-to-create-ai-news

![newsai](https://github.com/user-attachments/assets/62359488-bf6e-48a1-a3d2-9140736fdc5f)

### Main components
- **collect_web_news.py**: Fetch RSS/Atom feeds and format items for analysis (also used in hybrid mode)
- **collect_slack_messages.py**: Collect recent messages from Slack (optional; `source = "slack"`)
- **generate_weekly_news.py**: Analyze Slack messages and generate weekly news copy
- **post_slack.py**: Post the generated copy to Slack
- **main.py**: Run collect → generate → post end to end (`source` switches web vs slack)
- **config.toml** / **config.py**: Externalized prompts and collection parameters
- **llm_providers.py**: Multi-provider LLM abstraction (`api` / `codex` / `claude` / `opencode`)

## Requirements
- **Python**: 3.13 or later
- **uv**: Used for Python package and environment management
- **Slack bot token**: `SLACK_BOT_TOKEN`
- **LLM credentials**: depends on provider (see matrix above). For `api`, an OpenAI-compatible API key.

### Slack permissions
When `source = "web"` (default), the bot only needs:
- `chat:write`

When `source = "slack"`, also:
- `channels:read`, `channels:history`
- `channels.join` (if you want to auto-join public channels)

## Setup

### Install uv (macOS)
```bash
brew install uv
```
or
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### Set up dependencies
```bash
uv python install 3.13
uv sync
```

### Environment variables (.env recommended)
Create `.env` at the project root:
```bash
cp .env.example .env
```
Set each environment variable appropriately.

### Configuration (config.toml)
Copy the example and edit:
```bash
cp config.example.toml config.toml
```

Precedence (highest first): **CLI args > env vars > config.toml > built-in defaults**. Missing `config.toml` keeps the previous default behavior.

| Section | Key | Description |
|---|---|---|
| `[llm]` | `provider` | `api` \| `codex` \| `claude` \| `opencode` |
| `[llm]` | `model` | Model id; empty = provider default (`api` → `gpt-5.5`) |
| `[llm]` | `base_url` | OpenAI-compatible base URL (`api` only) |
| `[llm]` | `api_key_env` | Env var name for the API key (not the secret itself) |
| `[llm]` | `max_completion_tokens` | Max tokens (`api` only) |
| `[llm]` | `timeout_seconds` | Request / CLI timeout |
| `[llm]` | `extra_cli_args` | Extra argv for CLI providers |
| `[llm.opencode]` | `base_url` | Custom OpenAI-compatible API base URL; empty disables custom-provider setup |
| `[llm.opencode]` | `npm` | opencode provider package (default `@ai-sdk/openai-compatible`) |
| `[llm.opencode]` | `provider_id` | opencode provider ID (default `custom`) |
| `[prompt]` | `system` | System prompt |
| `[prompt]` | `instruction` | Instruction prompt |
| `[prompt]` | `instruction_file` | If set, read this file instead of `instruction` |
| `[collect]` | `source` | `web` (default) \| `slack`. Override with `NEWSAI_SOURCE` |
| `[collect]` | `days` | Collection window in days |
| `[collect]` | `channel_filter` | Substring filter for channel names (`slack`) |
| `[collect]` | `exclude_channels` | Extra excluded channels (`slack`) |
| `[collect]` | `max_messages_per_channel` | Cap messages per channel (`slack`) |
| `[collect]` | `max_message_chars` | Truncate each message (`slack`) |
| `[collect]` | `auto_join` | Auto-join public channels (`slack`) |
| `[collect.web]` | `mode` | `llm_search` \| `feeds` \| `hybrid`. `llm_search`/`hybrid` need a CLI provider |
| `[collect.web]` | `queries` | Search topics for LLM web search |
| `[collect.web]` | `feeds` | RSS/Atom URLs for `feeds` / `hybrid` |
| `[collect.web]` | `max_items_per_feed` | Cap items per feed |
| `[post]` | `channel` | Default post channel (`SLACK_CHANNEL` env wins when set) |
| `[post]` | `thread` | Post long text as a thread |
| `[post]` | `header` | Custom header prefix (empty = default weekly title) |
| `[schedule]` | `frequency` | `daily` \| `weekly` |
| `[schedule]` | `weekday` | `monday`..`sunday` (weekly only) |
| `[schedule]` | `hour` | Delivery hour `0`–`23` in `timezone` |
| `[schedule]` | `timezone` | IANA timezone name |

### LLM smoke test
```bash
uv run python llm_providers.py --prompt "1+1は？数字のみ回答してください。"
uv run python llm_providers.py --provider claude --prompt "こんにちは"
```

## Scripts and how to run

### collect_web_news.py (Collect RSS/Atom)
- **Overview**: Fetch feeds and print formatted markdown for analysis
- **Examples**
```bash
uv run python collect_web_news.py --feeds https://hnrss.org/newest?q=AI --days 7 -v
```

### collect_slack_messages.py (Collect Slack messages)
- **Overview**: Collect messages from public channels in the workspace for a specified period and save as `slack_messages_YYYYMMDD_HHMMSS.json`
- **Key arguments**
  - `--days`: Number of days to collect (default: 7)
  - `--output`: Output file name (auto-named if omitted)
  - `--token`: Slack bot token (uses `SLACK_BOT_TOKEN` if omitted)
  - `--no-auto-join`: Disable auto-joining public channels
  - `--channel`: Target only channels whose names contain the specified string
- **Examples**
```bash
uv run python collect_slack_messages.py --days 7
uv run python collect_slack_messages.py --days 30 --channel general
uv run python collect_slack_messages.py --output messages.json
```

### generate_weekly_news.py (Generate weekly news from Slack JSON)
- **Overview**: Read the saved JSON and, using the configured LLM provider, generate weekly news copy including "Highlights" and "Extras"
- **Key arguments**
  - `--messages-file`: Path to the collected JSON (if omitted, automatically detect the latest `slack_messages_*.json`)
  - `--days`: Number of days to analyze (default from config)
  - `--provider`: LLM provider (`api` \| `codex` \| `claude` \| `opencode`)
  - `--model`: Model name
  - `--config`: Path to `config.toml`
  - `--openai-key`: Deprecated alias; forces `provider=api` and sets the API key
- **Examples**
```bash
uv run python generate_weekly_news.py
uv run python generate_weekly_news.py --days 7 --messages-file slack_messages_20250929_145307.json
uv run python generate_weekly_news.py --provider claude --model sonnet
uv run python generate_weekly_news.py --config ./config.toml --provider api
```
The output is printed as text to stdout.

### post_slack.py (Post to Slack)
- **Overview**: Post arbitrary text to Slack. You can pass the body via `--text` or via standard input
- **Key arguments**
  - `--channel`: Destination channel name or ID (defaults to `SLACK_CHANNEL`)
  - `--token`: Slack bot token (defaults to `SLACK_BOT_TOKEN`)
  - `--text`: Message body (if omitted, read from standard input)
- **Example**
```bash
uv run python post_slack.py --channel general --text "Body"
```

### main.py (Run end to end)
- **Overview**: Run collection → summary generation → Slack post. Default source is web/X AI news; set `source = "slack"` or `NEWSAI_SOURCE=slack` for the legacy Slack flow
- **Required environment variables**: `SLACK_BOT_TOKEN`, `SLACK_CHANNEL`, plus provider credentials (see matrix)
- **Key arguments**: `--provider`, `--model`, `--config`, `--dry-run` (generate and print, skip Slack post)
- **Example**
```bash
uv run python main.py
uv run python main.py --dry-run
uv run python main.py --provider claude
```

## Admin dashboard (optional)
A simple hosted dashboard (Cloudflare Workers) to edit config.toml, trigger runs, and view run history.
1. Create a GitHub OAuth App (Settings → Developer settings → OAuth Apps):
   - Homepage URL:  https://newsai-dashboard.<your-subdomain>.workers.dev
   - Authorization callback URL: https://newsai-dashboard.<your-subdomain>.workers.dev/auth/callback
2. cd dashboard && npm install
3. Edit wrangler.jsonc: set REPO_OWNER / REPO_NAME to your fork.
4. npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET   # e.g. openssl rand -hex 32
5. npx wrangler deploy
OAuth scope requested: `repo workflow` (needed to commit the workflow cron on schedule save). After upgrading an existing deployment, re-login is required (orchestrator rotates `SESSION_SECRET` to invalidate old sessions).
Anyone may log in with GitHub, but only users with push access to the repo can use the dashboard.
Saving from the dashboard does not preserve comments in config.toml (see config.example.toml for the commented reference).
If the repo is org-owned with OAuth App restrictions, approve the app for the org.
Local dev: create a second OAuth App with callback http://localhost:8787/auth/callback, copy .dev.vars.example to .dev.vars, then npx wrangler dev.

### Dashboard credentials

The dashboard's 「認証情報」 section writes credentials directly to GitHub Actions Secrets with GitHub's repository public key. Values are write-only: the dashboard can show whether each secret is registered and its update date, but it cannot read the stored value. Credential values are never persisted on Cloudflare.

| Dashboard field | GitHub Actions Secret |
|---|---|
| Claude setup token | `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex `~/.codex/auth.json` | `CODEX_AUTH_JSON` |
| opencode API key | `OPENCODE_API_KEY` |
| opencode `~/.local/share/opencode/auth.json` (optional) | `OPENCODE_AUTH_JSON` |
| OpenAI API key | `OPENAI_API_KEY` |

For a custom OpenAI-compatible opencode provider, set 「opencode BASE URL」 in the LLM settings and register `OPENCODE_API_KEY`. The workflow creates `~/.config/opencode/opencode.json` for provider ID `custom`; set `[llm].model` to `custom/<model-name>` (for example, `custom/my-model`). Leaving the base URL empty disables this setup.
