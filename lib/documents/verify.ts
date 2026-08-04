/**
 * Signed document-verification tokens and the QR images that carry them (FR-09).
 *
 * A printed document leaves the building. The QR on it has to be resolvable by
 * a transporter at a gate or an auditor months later, neither of whom has a WMS
 * login — so the token is opaque and self-contained, and the page it resolves to
 * is deliberately thin (document number, type, date, status, validity). It
 * proves the paper is genuine and current; it does not disclose what is on it.
 * See app/verify/[token] for the payload that actually reaches a reader.
 *
 * The token is signed with a key derived from JWT_SECRET but namespaced by
 * audience, so a verification token can never be replayed as a session token
 * and vice versa, even though both are JWS.
 */

import { SignJWT, jwtVerify } from "jose"
import QRCode from "qrcode"

import type { DocumentQr, DocumentType } from "@/lib/documents/types"

const ISSUER = "gwu-wms"
const AUDIENCE = "gwu-wms/document-verify"

export type DocumentTokenPayload = {
  type: DocumentType
  /** The subject record id — means a different table per type, see DOCUMENT_SUBJECT. */
  id: number
  companyId: number
}

function secretKey(): Uint8Array | null {
  const raw = process.env.DOCUMENT_VERIFY_SECRET || process.env.JWT_SECRET
  if (!raw) return null
  return new TextEncoder().encode(raw)
}

function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "http://localhost:3000"
  ).replace(/\/+$/, "")
}

/**
 * Documents are archival — a delivery note may be produced in an audit years
 * later — so tokens do not expire. Revocation, if it is ever needed, belongs on
 * the record's status rather than on the token, because the verify page reads
 * live status anyway and a cancelled document already reports itself cancelled.
 */
export async function signDocumentToken(
  payload: DocumentTokenPayload
): Promise<string | null> {
  const key = secretKey()
  if (!key) return null

  return new SignJWT({ t: payload.type, i: payload.id, c: payload.companyId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(key)
}

export async function verifyDocumentToken(
  token: string
): Promise<DocumentTokenPayload | null> {
  const key = secretKey()
  if (!key || !token) return null

  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience: AUDIENCE,
    })
    const type = payload.t
    const id = Number(payload.i)
    const companyId = Number(payload.c)
    if (typeof type !== "string" || !Number.isInteger(id) || !Number.isInteger(companyId)) {
      return null
    }
    return { type: type as DocumentType, id, companyId }
  } catch {
    // Tampered, wrong audience, or signed with a rotated key. All the same to a
    // reader: this QR does not verify.
    return null
  }
}

export function verifyUrl(token: string): string {
  return `${baseUrl()}/verify/${token}`
}

/**
 * Renders the QR as a PNG data: URI.
 *
 * Inlined rather than served from a route because proxy.ts sets
 * img-src 'self' data: blob:, and because the printed page has no network at
 * all — whatever is in the ink is what the reader gets. Error-correction level M
 * survives a stapled, folded, thermally-printed page in practice; H would be
 * more robust but costs modules and this QR sits in a 22mm box.
 */
export async function renderQr(url: string): Promise<string> {
  return QRCode.toDataURL(url, {
    errorCorrectionLevel: "M",
    margin: 1,
    scale: 6,
    color: { dark: "#1F2937", light: "#FFFFFF" },
  })
}

/** Convenience: token → QR, or undefined when signing is unconfigured. */
export async function buildDocumentQr(
  payload: DocumentTokenPayload
): Promise<DocumentQr | undefined> {
  const token = await signDocumentToken(payload)
  if (!token) return undefined
  const url = verifyUrl(token)
  return { dataUri: await renderQr(url), url }
}
