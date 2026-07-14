import type { FormValues } from './config'
import type { WorkflowRun } from './github'

const CSS = `
:root{--bg:#f7f6f3;--fg:#1a1a1a;--muted:#666;--border:#d8d5ce;--accent:#1f4b3a;--err:#8b1e1e;--flash:#e8f0eb}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
a{color:var(--accent)}header{display:flex;justify-content:space-between;align-items:center;padding:1rem 1.25rem;border-bottom:1px solid var(--border);background:#fff}
main{max-width:880px;margin:0 auto;padding:1.25rem}h1{font-size:1.25rem;margin:0 0 1rem}h2{font-size:1.05rem;margin:1.5rem 0 .75rem}
.card{background:#fff;border:1px solid var(--border);padding:1rem 1.25rem;margin-bottom:1rem}
label{display:block;font-weight:600;margin:.85rem 0 .3rem}input,select,textarea{width:100%;padding:.45rem .55rem;border:1px solid var(--border);font:inherit;background:#fff}
textarea{font-family:ui-monospace,Menlo,monospace;font-size:13px}button,.btn{display:inline-block;background:var(--accent);color:#fff;border:0;padding:.5rem 1rem;font:inherit;cursor:pointer;text-decoration:none}
button.secondary{background:#555}.flash{background:var(--flash);border:1px solid #b7d4c2;padding:.6rem .8rem;margin-bottom:1rem}
.err{background:#f8e8e8;border:1px solid #e0b0b0;padding:.6rem .8rem;margin-bottom:1rem;color:var(--err)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:.4rem .35rem;border-bottom:1px solid var(--border)}
.muted{color:var(--muted);font-size:13px}.actions{margin-top:1rem;display:flex;gap:.75rem;flex-wrap:wrap}
`

function Layout(props: {
  title: string
  user?: string
  children?: unknown
}) {
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <header>
          <strong>newsai dashboard</strong>
          {props.user ? (
            <form method="post" action="/logout" style="margin:0">
              <span class="muted" style="margin-right:.75rem">
                {props.user}
              </span>
              <button type="submit" class="secondary">
                ログアウト
              </button>
            </form>
          ) : null}
        </header>
        <main>{props.children}</main>
      </body>
    </html>
  )
}

export function LoginPage(props: { error?: string }) {
  return (
    <Layout title="ログイン — newsai">
      <h1>ログイン</h1>
      {props.error ? <div class="err">{props.error}</div> : null}
      <div class="card">
        <p>
          GitHub でログインしてください。対象リポジトリへの push
          権限が必要です。
        </p>
        <p>
          <a class="btn" href="/login">
            GitHub でログイン
          </a>
        </p>
      </div>
    </Layout>
  )
}

function SettingsForm(props: { values: FormValues; sha: string }) {
  const v = props.values
  return (
    <form method="post" action="/settings">
      <input type="hidden" name="sha" value={props.sha} />
      <label for="provider">LLM プロバイダ</label>
      <select id="provider" name="provider">
        {(['api', 'codex', 'claude', 'opencode'] as const).map((p) => (
          <option value={p} selected={v.provider === p}>
            {p}
          </option>
        ))}
      </select>

      <label for="model">モデル</label>
      <input id="model" name="model" type="text" value={v.model} />

      <label for="days">収集日数</label>
      <input
        id="days"
        name="days"
        type="number"
        min="1"
        max="90"
        value={String(v.days)}
      />

      <label for="channel_filter">チャンネルフィルタ</label>
      <input
        id="channel_filter"
        name="channel_filter"
        type="text"
        value={v.channel_filter}
      />

      <label for="exclude_channels">除外チャンネル（カンマ区切り）</label>
      <input
        id="exclude_channels"
        name="exclude_channels"
        type="text"
        value={v.exclude_channels}
      />

      <label for="system">システムプロンプト</label>
      <textarea id="system" name="system" rows={4}>{v.system}</textarea>

      <label for="instruction">指示プロンプト</label>
      <textarea id="instruction" name="instruction" rows={24}>{v.instruction}</textarea>

      <label for="channel">投稿先チャンネル</label>
      <input id="channel" name="channel" type="text" value={v.channel} />

      <label for="header">ヘッダー接頭辞</label>
      <input id="header" name="header" type="text" value={v.header} />

      <div class="actions">
        <button type="submit">設定を保存</button>
      </div>
    </form>
  )
}

export function Dashboard(props: {
  user: string
  values: FormValues
  sha: string
  runs: WorkflowRun[]
  flash?: string
}) {
  return (
    <Layout title="dashboard — newsai" user={props.user}>
      <h1>管理ダッシュボード</h1>
      {props.flash ? <div class="flash">{props.flash}</div> : null}

      <div class="card">
        <h2>設定 (config.toml)</h2>
        <p class="muted">
          保存するとリポジトリにコミットされます。コメントは保持されません。
        </p>
        <SettingsForm values={props.values} sha={props.sha} />
      </div>

      <div class="card">
        <h2>手動実行</h2>
        <form method="post" action="/run" id="run-form">
          <button type="submit" id="run-btn">
            今すぐ実行
          </button>
        </form>
        <script
          dangerouslySetInnerHTML={{
            __html: `document.getElementById('run-form').addEventListener('submit',function(e){if(!confirm('ワークフローを実行しますか？'))e.preventDefault();});`,
          }}
        />
      </div>

      <div class="card">
        <h2>最近の実行（最大10件）</h2>
        {props.runs.length === 0 ? (
          <p class="muted">実行履歴がありません。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>状態</th>
                <th>結果</th>
                <th>タイトル</th>
                <th>日時</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {props.runs.map((r) => (
                <tr>
                  <td>{r.status}</td>
                  <td>{r.conclusion ?? '—'}</td>
                  <td>{r.display_title || r.name}</td>
                  <td>{r.created_at}</td>
                  <td>
                    <a href={r.html_url} target="_blank" rel="noreferrer">
                      開く
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  )
}

export function ConflictPage(props: {
  user: string
  values: FormValues
  sha: string
}) {
  return (
    <Layout title="競合 — newsai" user={props.user}>
      <h1>競合が発生しました</h1>
      <div class="err">
        他の人が設定を更新したため、保存できませんでした。最新の内容を確認し、再度編集して保存してください。
      </div>
      <div class="card">
        <SettingsForm values={props.values} sha={props.sha} />
      </div>
    </Layout>
  )
}

export function ForbiddenPage(props: { login?: string }) {
  return (
    <Layout title="権限なし — newsai">
      <h1>アクセス権限がありません</h1>
      <div class="err">
        {props.login ? `${props.login} さんに` : 'あなたに'}
        は対象リポジトリへの push 権限がありません。
      </div>
      <p>
        <a class="btn" href="/login">
          別のアカウントでログイン
        </a>
      </p>
    </Layout>
  )
}

export function ErrorPage(props: {
  title?: string
  message: string
  user?: string
}) {
  return (
    <Layout title={props.title ?? 'エラー — newsai'} user={props.user}>
      <h1>{props.title ?? 'エラー'}</h1>
      <div class="err">{props.message}</div>
      <p>
        <a href="/">トップに戻る</a>
      </p>
    </Layout>
  )
}

export function SetupErrorPage(props: { user: string; path: string }) {
  return (
    <Layout title="セットアップ — newsai" user={props.user}>
      <h1>config.toml が見つかりません</h1>
      <div class="err">
        リポジトリに <code>{props.path}</code>{' '}
        がありません。先にリポジトリ側で作成してください（ダッシュボードは自動作成しません）。
      </div>
    </Layout>
  )
}
