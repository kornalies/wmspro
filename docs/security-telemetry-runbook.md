# Security Telemetry Runbook

Last updated: 2026-04-22

## Scope
This runbook covers runtime security telemetry emitted by:
- `wms-frontend` (`/api/health` and `/api/security/telemetry`)
- `wms-mobile-api` (`/health`, `/api/v1/health`, `/api/v1/security/telemetry`)

## Telemetry Signals
### 1. Web (`wms-frontend`)
- `proxy_invalid_access_token`
- `proxy_mobile_actor_token_rejected`
- `mobile_auth_actor_scope_rejected`
- `mobile_refresh_invalid_token`

### 2. Mobile API (`wms-mobile-api`)
- Access-token and tenant failures:
  - `invalid_token_purpose`
  - `missing_session_context`
  - `session_invalid_or_revoked`
- Refresh-token failures:
  - `refresh_invalid_or_expired_token`
  - `refresh_invalid_purpose`
  - `refresh_missing_session_context`
  - `refresh_missing_jti`
  - `refresh_session_invalid_or_revoked`
  - `refresh_rotation_failed`

## Severity Thresholds
### Web (`securityStatus`)
- `normal`: total events `< 20` and no single event `>= 10`
- `elevated`: total events `>= 20` or any single event `>= 10`
- `critical`: total events `>= 100` or any single event `>= 50`

### Mobile API (`securityStatus`)
- `normal`: noisy auth failures `< 20` and no single noisy reason `>= 10`
- `elevated`: noisy auth failures `>= 20` or any single noisy reason `>= 10`
- `critical`: noisy auth failures `>= 100` or any single noisy reason `>= 50`

## Escalation Matrix
1. `normal`
- Owner: On-call engineer
- Action: monitor daily trend, no immediate incident.

2. `elevated`
- Owner: On-call + security/dev lead
- Action:
  - Verify release/config changes in last 24h.
  - Sample offending routes and token issuers from logs.
  - Validate mobile app `WMS_API_BASE_URL` and session scope behavior.
  - Open an incident ticket if sustained for > 30 minutes.

3. `critical`
- Owner: Incident commander + engineering manager + security lead
- Action:
  - Declare security incident.
  - Freeze deployments on affected services.
  - Enable heightened log retention and collect token failure samples.
  - If abuse suspected, rotate JWT secret and force session revocation plan.

## Operator Checks
1. Web health telemetry:
- `GET /api/health`

2. Web secured telemetry endpoint:
- `GET /api/security/telemetry` (ADMIN/SUPER_ADMIN or `audit.view`)

3. Mobile API health telemetry:
- `GET /health`
- `GET /api/v1/health`

4. Mobile API secured telemetry endpoint:
- `GET /api/v1/security/telemetry` (requires auth with ADMIN/SUPER_ADMIN)

## Immediate Mitigations
1. If `proxy_mobile_actor_token_rejected` spikes:
- Check browser clients for mobile token/cookie misuse.
- Force logout sessions that carry `actorType=mobile`.

2. If `refresh_rotation_failed` spikes:
- Check DB write path for `mobile_auth_sessions` and lock contention.
- Audit session table health and index usage.

3. If `invalid_token_purpose` or `refresh_invalid_purpose` spikes:
- Confirm clients are not swapping access/refresh tokens.
- Verify auth SDK/client flow and deployment versions.

