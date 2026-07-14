import { blake2b } from 'blakejs'
import nacl from 'tweetnacl'

const PUBLIC_KEY_BYTES = nacl.box.publicKeyLength
const NONCE_BYTES = nacl.box.nonceLength

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function encodeBase64(value: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < value.length; i++) {
    binary += String.fromCharCode(value[i]!)
  }
  return btoa(binary)
}

/** libsodium crypto_box_seal-compatible encryption. */
export function sealBox(
  message: Uint8Array,
  recipientPublicKey: Uint8Array,
): Uint8Array {
  if (recipientPublicKey.length !== PUBLIC_KEY_BYTES) {
    throw new Error('GitHub Actions Secrets の公開鍵が不正です。')
  }

  const ephemeral = nacl.box.keyPair()
  try {
    const nonce = blake2b(
      concatBytes(ephemeral.publicKey, recipientPublicKey),
      undefined,
      NONCE_BYTES,
    )
    const ciphertext = nacl.box(
      message,
      nonce,
      recipientPublicKey,
      ephemeral.secretKey,
    )
    return concatBytes(ephemeral.publicKey, ciphertext)
  } finally {
    ephemeral.secretKey.fill(0)
  }
}

export function sealStringToBase64(
  value: string,
  recipientPublicKeyBase64: string,
): string {
  const publicKey = decodeBase64(recipientPublicKeyBase64)
  return encodeBase64(sealBox(new TextEncoder().encode(value), publicKey))
}
