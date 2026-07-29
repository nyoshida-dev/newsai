import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchConfigText, type Env } from './index'

const ENV: Env = {
  GITHUB_TOKEN: 'tok',
  REPO_OWNER: 'o',
  REPO_NAME: 'r',
  WORKFLOW_FILE: 'weekly-news.yml',
  REF: 'main',
  CONFIG_PATH: 'config.toml',
}

const TOML = '[schedule]\nfrequency = "daily"\nhour = 7\n'

function stubFetch(
  handler: (url: string) => Response | Promise<Response>,
): { urls: string[] } {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      return handler(url)
    }),
  )
  return { urls }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fetchConfigText', () => {
  it('uses the contents API when it succeeds, without hitting raw', async () => {
    const { urls } = stubFetch(() => new Response(TOML, { status: 200 }))
    expect(await fetchConfigText(ENV)).toBe(TOML)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('api.github.com')
    expect(urls[0]).toContain('/contents/config.toml?ref=main')
  })

  it('falls back to raw when the PAT lacks Contents: Read', async () => {
    const { urls } = stubFetch((url) =>
      url.includes('api.github.com')
        ? new Response('{"message":"Resource not accessible"}', { status: 403 })
        : new Response(TOML, { status: 200 }),
    )
    expect(await fetchConfigText(ENV)).toBe(TOML)
    expect(urls).toHaveLength(2)
    expect(urls[1]).toBe(
      'https://raw.githubusercontent.com/o/r/main/config.toml',
    )
  })

  it('falls back to raw when the contents API throws', async () => {
    const { urls } = stubFetch((url) => {
      if (url.includes('api.github.com')) throw new Error('network down')
      return new Response(TOML, { status: 200 })
    })
    expect(await fetchConfigText(ENV)).toBe(TOML)
    expect(urls).toHaveLength(2)
  })

  it('throws with both reasons when neither path works', async () => {
    stubFetch((url) =>
      url.includes('api.github.com')
        ? new Response('nope', { status: 403 })
        : new Response('nope', { status: 404 }),
    )
    await expect(fetchConfigText(ENV)).rejects.toThrow(
      /contents API: HTTP 403.*raw: HTTP 404/,
    )
  })
})
