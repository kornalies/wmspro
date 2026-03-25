import { createCipheriv, createHash, randomBytes } from "node:crypto"

function getKeyMaterial() {
  const source = process.env.DATA_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!source) {
    throw new Error("Missing DATA_ENCRYPTION_KEY or JWT_SECRET for credential encryption")
  }
  return createHash("sha256").update(source).digest()
}

export function encryptSecret(value: string): string {
  const key = getKeyMaterial()
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`
}
