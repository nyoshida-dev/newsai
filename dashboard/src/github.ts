export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: string,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

export type GitHubUser = { login: string }
export type GitHubRepo = {
  default_branch: string
  permissions?: { push?: boolean; admin?: boolean; pull?: boolean }
}
export type ConfigFile = { content: string; sha: string }
export type WorkflowRun = {
  id: number
  name: string
  display_title: string
  status: string
  conclusion: string | null
  html_url: string
  created_at: string
  updated_at: string
}
export type ActionsPublicKey = { key_id: string; key: string }
export type ActionsSecret = {
  name: string
  created_at: string
  updated_at: string
}

const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const UA = 'newsai-dashboard'

function headers(token: string, extra?: HeadersInit): Headers {
  const h = new Headers(extra)
  h.set('Authorization', `Bearer ${token}`)
  h.set('X-GitHub-Api-Version', API_VERSION)
  h.set('User-Agent', UA)
  h.set('Accept', 'application/vnd.github+json')
  return h
}

async function gh<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ data: T; status: number }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: headers(token, init?.headers),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new GitHubError(
      res.status,
      `GitHub API ${res.status} for ${path}`,
      text,
    )
  }
  if (res.status === 204 || text === '') {
    return { data: undefined as T, status: res.status }
  }
  return { data: JSON.parse(text) as T, status: res.status }
}

export async function getUser(token: string): Promise<GitHubUser> {
  const { data } = await gh<GitHubUser>(token, '/user')
  return data
}

export async function getRepo(
  token: string,
  owner: string,
  repo: string,
): Promise<GitHubRepo> {
  const { data } = await gh<GitHubRepo>(token, `/repos/${owner}/${repo}`)
  return data
}

export async function getConfigFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
): Promise<ConfigFile> {
  const { data } = await gh<{ content: string; encoding: string; sha: string }>(
    token,
    `/repos/${owner}/${repo}/contents/${path}`,
  )
  if (data.encoding !== 'base64') {
    throw new Error(`unexpected encoding: ${data.encoding}`)
  }
  const b64 = data.content.replace(/\n/g, '')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { content: new TextDecoder().decode(bytes), sha: data.sha }
}

export async function putConfigFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  opts: { message: string; content: string; sha: string; branch: string },
): Promise<void> {
  const bytes = new TextEncoder().encode(opts.content)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  const content = btoa(bin)
  await gh(token, `/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: opts.message,
      content,
      sha: opts.sha,
      branch: opts.branch,
    }),
  })
}

export async function dispatchWorkflow(
  token: string,
  owner: string,
  repo: string,
  workflowFile: string,
  ref: string,
): Promise<{ html_url?: string } | null> {
  const res = await fetch(
    `${API}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: 'POST',
      headers: headers(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ref, return_run_details: true }),
    },
  )
  if (res.status === 204) return null
  const text = await res.text()
  if (!res.ok) {
    throw new GitHubError(
      res.status,
      `GitHub API ${res.status} for workflow dispatch`,
      text,
    )
  }
  if (!text) return null
  return JSON.parse(text) as { html_url?: string }
}

export async function listWorkflowRuns(
  token: string,
  owner: string,
  repo: string,
  workflowFile: string,
): Promise<WorkflowRun[]> {
  const { data } = await gh<{ workflow_runs: WorkflowRun[] }>(
    token,
    `/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=10`,
  )
  return data.workflow_runs ?? []
}

export async function getActionsPublicKey(
  token: string,
  owner: string,
  repo: string,
): Promise<ActionsPublicKey> {
  const { data } = await gh<ActionsPublicKey>(
    token,
    `/repos/${owner}/${repo}/actions/secrets/public-key`,
  )
  return data
}

export async function listActionsSecrets(
  token: string,
  owner: string,
  repo: string,
): Promise<ActionsSecret[]> {
  const { data } = await gh<{ secrets: ActionsSecret[] }>(
    token,
    `/repos/${owner}/${repo}/actions/secrets?per_page=100`,
  )
  return data.secrets ?? []
}

export async function putActionsSecret(
  token: string,
  owner: string,
  repo: string,
  name: string,
  encryptedValue: string,
  keyId: string,
): Promise<void> {
  await gh(token, `/repos/${owner}/${repo}/actions/secrets/${name}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_value: encryptedValue, key_id: keyId }),
  })
}

export async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  })
  const data = (await res.json()) as {
    access_token?: string
    error?: string
    error_description?: string
  }
  if (!data.access_token) {
    throw new Error(
      data.error_description || data.error || 'token exchange failed',
    )
  }
  return data.access_token
}
