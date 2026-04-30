import fs from "node:fs"
import path from "node:path"

const root = process.cwd()

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8")
}

function assert(condition, message) {
  if (!condition) {
    console.error(`AUTH-DOMAIN-GUARD FAIL: ${message}`)
    process.exit(1)
  }
}

const proxySource = read("proxy.ts")
const authSource = read("lib/auth.ts")

assert(
  /verifyTokenWithoutSession\s*,\s*type TokenPayload/.test(proxySource),
  "proxy.ts must import verifyTokenWithoutSession from lib/auth."
)
assert(
  /verifyTokenWithoutSession\(token,\s*\{\s*purpose:\s*"access"\s*\}\)/.test(proxySource),
  "proxy.ts must verify cookie token with purpose=access."
)
assert(!/jwtVerify\s*\(/.test(proxySource), "proxy.ts must not call jwtVerify directly.")
assert(
  /\(payload\.actorType\s*\?\?\s*""\)\.toLowerCase\(\)\s*===\s*"mobile"/.test(proxySource),
  "proxy.ts must reject mobile actor tokens for browser app navigation."
)

assert(
  /verifyTokenWithoutSession\(\s*token:\s*string,\s*options\?:\s*\{\s*purpose\?:\s*TokenPurpose\s*\}/s.test(
    authSource
  ),
  "lib/auth.ts verifyTokenWithoutSession must support purpose option."
)

console.log("Auth domain guard passed.")

