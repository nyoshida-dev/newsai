import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

export type Session = {
  t: string
  u: string
  exp: number
}

const SESSION_NAME = 'session'
const STATE_NAME = 'oauth_state'
const SESSION_MAX_AGE = 604800
const OAUTH_STATE_MAX_AGE = 600

const HOST_OPTS = { prefix: 'host' as const }

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  )
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

/** AES-GCM seal: returns base64url(iv[12] ‖ ciphertext). */
export async function seal(
  secret: string,
  payload: object,
): Promise<string> {
  const key = await deriveKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const pt = new TextEncoder().encode(JSON.stringify(payload))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt),
  )
  const packed = new Uint8Array(iv.length + ct.length)
  packed.set(iv, 0)
  packed.set(ct, iv.length)
  return b64urlEncode(packed)
}

/** Decrypt sealed cookie value; null on any failure or expired Session. */
export async function unseal(
  secret: string,
  sealed: string,
): Promise<Session | null> {
  try {
    const packed = b64urlDecode(sealed)
    if (packed.length < 13) return null
    const iv = packed.slice(0, 12)
    const ct = packed.slice(12)
    const key = await deriveKey(secret)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
    const data = JSON.parse(new TextDecoder().decode(pt)) as Session
    if (
      typeof data.t !== 'string' ||
      typeof data.u !== 'string' ||
      typeof data.exp !== 'number'
    ) {
      return null
    }
    if (data.exp < Math.floor(Date.now() / 1000)) return null
    return data
  } catch {
    return null
  }
}

export function setSessionCookie(c: Context, value: string): void {
  setCookie(c, SESSION_NAME, value, {
    ...HOST_OPTS,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: SESSION_MAX_AGE,
  })
}

export function getSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_NAME, 'host')
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_NAME, HOST_OPTS)
}

export function setStateCookie(c: Context, value: string): void {
  setCookie(c, STATE_NAME, value, {
    ...HOST_OPTS,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: OAUTH_STATE_MAX_AGE,
  })
}

export function getStateCookie(c: Context): string | undefined {
  return getCookie(c, STATE_NAME, 'host')
}

export function clearStateCookie(c: Context): void {
  deleteCookie(c, STATE_NAME, HOST_OPTS)
}

export function randomHex(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('')
}
