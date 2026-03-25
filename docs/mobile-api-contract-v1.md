# WMS Pro Mobile API Contract (v1)

This document defines the mobile API contract that is currently implemented in this repository.

## Base
- Base URL: `/api/mobile/*`
- Auth header for protected routes: `Authorization: Bearer <access_token>`
- Content type: `application/json`

## 1. Login
`POST /api/mobile/auth/login`

Request:
```json
{
  "company_code": "DEFAULT",
  "username": "admin",
  "password": "Admin@12345",
  "device_id": "uuid",
  "device_name": "Pixel 7"
}
```

Response:
```json
{
  "success": true,
  "data": {
    "access_token": "jwt",
    "refresh_token": "jwt",
    "expires_in": 86400,
    "user": {
      "id": 1,
      "username": "admin",
      "full_name": "Admin User",
      "email": "admin@example.com",
      "role": "ADMIN",
      "roles": ["ADMIN"],
      "permissions": ["grn.manage"],
      "company_id": 1,
      "company_code": "DEFAULT",
      "warehouse_id": null
    }
  }
}
```

## 2. Refresh Token
`POST /api/mobile/auth/refresh`

Request:
```json
{
  "refresh_token": "jwt",
  "device_id": "uuid"
}
```

Response:
```json
{
  "success": true,
  "data": {
    "access_token": "jwt",
    "refresh_token": "jwt",
    "expires_in": 86400
  }
}
```

## 3. Profile
`GET /api/mobile/auth/me`

Response:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "username": "admin",
    "role": "ADMIN",
    "company_id": 1,
    "permissions": ["grn.mobile.approve"]
  }
}
```

## 4. Logout
`POST /api/mobile/auth/logout`

Response:
```json
{
  "success": true,
  "data": null,
  "message": "Logged out successfully"
}
```

## 5. Mobile GRN Captures List
`GET /api/mobile/grn/captures?status=PENDING|APPROVED|REJECTED|ALL`

Response:
```json
{
  "success": true,
  "data": [
    {
      "id": 101,
      "capture_ref": "MGRN-2026-12345678",
      "status": "PENDING",
      "invoice_number": "INV-1001",
      "supplier_name": "ABC Supplier",
      "created_at": "2026-03-01T10:20:30.000Z"
    }
  ]
}
```

## 6. Create Mobile GRN Capture
`POST /api/mobile/grn/captures`

Request: `mobileGrnCaptureSchema` payload from `lib/validations/mobile-grn.ts`.

Response:
```json
{
  "success": true,
  "data": {
    "id": 101,
    "capture_ref": "MGRN-2026-12345678",
    "status": "PENDING"
  }
}
```

## 7. Capture Detail
`GET /api/mobile/grn/captures/{id}`

## 8. Approve Capture
`POST /api/mobile/grn/captures/{id}/approve`

Response:
```json
{
  "success": true,
  "data": {
    "capture_id": 101,
    "grn_id": 5001
  }
}
```

## 9. Reject Capture
`POST /api/mobile/grn/captures/{id}/reject`

Request:
```json
{
  "notes": "Rejected due to mismatch"
}
```

Response:
```json
{
  "success": true,
  "data": {
    "id": 101
  }
}
```

## 10. Item Lookup (Scanner Helper)
`POST /api/mobile/scans/items/lookup`

Request:
```json
{
  "query": "ITEM-100",
  "limit": 25
}
```

## 11. GRN Barcode Lookup
`POST /api/mobile/scans/grn/barcode/lookup`

Request:
```json
{
  "barcode": "SER-10001",
  "warehouse_id": 1
}
```

## 12. DO Barcode Parse
`POST /api/mobile/scans/do/parse`

Request:
```json
{
  "barcode": "DO-2026-001"
}
```

## Planned (Not Implemented Yet in This Repo)
- `POST /api/mobile/scans/gate/vehicle/lookup`
- `POST /api/mobile/offline/sync`

## Notes
- Mobile ML Kit performs OCR on-device; backend receives extracted text/fields only.
- Keep payloads minimal and explicit; avoid sending raw images in this contract.
