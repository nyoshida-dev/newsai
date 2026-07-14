import type { Session } from './session'

/** Cloudflare Worker bindings + Hono variables for the dashboard app. */
export type Env = {
  Bindings: {
    REPO_OWNER: string
    REPO_NAME: string
    WORKFLOW_FILE: string
    CONFIG_PATH: string
    GITHUB_CLIENT_ID: string
    GITHUB_CLIENT_SECRET: string
    SESSION_SECRET: string
  }
  Variables: {
    session: Session
  }
}
