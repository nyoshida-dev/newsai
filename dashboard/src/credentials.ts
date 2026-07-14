export const CREDENTIALS = [
  {
    formName: 'claude_token',
    secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
    kind: 'password',
    help: 'claude setup-token の出力を貼り付けます。',
    json: false,
  },
  {
    formName: 'codex_auth_json',
    secretName: 'CODEX_AUTH_JSON',
    kind: 'json',
    help: '~/.codex/auth.json の内容を貼り付けます。',
    json: true,
  },
  {
    formName: 'opencode_api_key',
    secretName: 'OPENCODE_API_KEY',
    kind: 'password',
    help: 'カスタム OpenAI 互換プロバイダー用の API キーです。',
    json: false,
  },
  {
    formName: 'opencode_auth_json',
    secretName: 'OPENCODE_AUTH_JSON',
    kind: 'json',
    help: '~/.local/share/opencode/auth.json の内容（任意）を貼り付けます。',
    json: true,
  },
  {
    formName: 'openai_api_key',
    secretName: 'OPENAI_API_KEY',
    kind: 'password',
    help: 'api プロバイダー用の OpenAI API キーです。',
    json: false,
  },
] as const

export type Credential = (typeof CREDENTIALS)[number]
export type CredentialSecretName = Credential['secretName']
