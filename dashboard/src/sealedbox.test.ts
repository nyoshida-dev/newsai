import { blake2b } from 'blakejs'
import { describe, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import { sealBox } from './sealedbox'

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

describe('sealBox', () => {
  it('round-trips with the crypto_box_seal wire format', () => {
    const recipient = nacl.box.keyPair()
    const message = new TextEncoder().encode('GitHub Actions secret 🔐')

    const sealed = sealBox(message, recipient.publicKey)

    expect(sealed).toHaveLength(
      nacl.box.publicKeyLength + message.length + nacl.box.overheadLength,
    )
    const ephemeralPublicKey = sealed.slice(0, nacl.box.publicKeyLength)
    const ciphertext = sealed.slice(nacl.box.publicKeyLength)
    const nonce = blake2b(
      concatBytes(ephemeralPublicKey, recipient.publicKey),
      undefined,
      nacl.box.nonceLength,
    )
    const opened = nacl.box.open(
      ciphertext,
      nonce,
      ephemeralPublicKey,
      recipient.secretKey,
    )

    expect(opened).not.toBeNull()
    expect(new TextDecoder().decode(opened!)).toBe(
      new TextDecoder().decode(message),
    )
  })
})
