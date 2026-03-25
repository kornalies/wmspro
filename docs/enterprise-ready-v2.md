# Enterprise-Ready v2 Baseline

## Objective

Establish a minimum enterprise hardening baseline for web traffic:

- End-to-end request traceability via `x-request-id`
- Secure-by-default browser response headers
- Consistent behavior across normal and redirect responses

## Implemented in this repo

File: `proxy.ts`

1. Request ID propagation
- Reads `x-request-id` first, then `x-correlation-id`.
- Generates a UUID when neither header is present.
- Returns `x-request-id` on every matched response.

2. Security headers
- `x-content-type-options: nosniff`
- `x-frame-options: DENY`
- `referrer-policy: strict-origin-when-cross-origin`
- `permissions-policy: camera=(), microphone=(), geolocation=()`
- `content-security-policy` with self-origin defaults and `frame-ancestors 'none'`
- `strict-transport-security` added on HTTPS requests

3. Redirect coverage
- Security headers and request ID are now added to redirect responses too
  (for example unauthenticated redirect to `/login`).

## Operational notes

- If your frontend needs third-party scripts/CDNs, update CSP allow-lists in `proxy.ts`.
- Keep HSTS enabled only behind HTTPS-enabled deployment endpoints.
- Forward `x-request-id` from your ingress/proxy (Nginx/ALB/Cloudflare) for best observability.

## Verification

1. Unauthenticated request to a protected page:
- Expect redirect to `/login`
- Expect `x-request-id` and security headers in response

2. Authenticated request to `/dashboard`:
- Expect `200`
- Expect the same header set including `x-request-id`

3. HTTPS deployment:
- Expect `strict-transport-security` header present
