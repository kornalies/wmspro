# Finance UAT Checklist (Pilot)

## Scope

- Billing transactions
- Invoice draft/finalize lifecycle
- Payments
- Ledger/trial-balance sync
- Portal billing visibility

## Checklist

1. Create contract/rate card and verify retrieval.
2. Post billing transaction and verify charge staging.
3. Generate invoice draft for period and verify line totals.
4. Finalize invoice and verify status transition.
5. Post partial payment and verify outstanding balance.
6. Post full payment and verify `PAID` transition.
7. Validate trial balance endpoint returns synced totals.
8. Validate journals endpoint returns posted entries.
9. Validate credit note/debit note create and invoice impact.
10. Validate portal billing API returns invoice rows for mapped client.

## Evidence Required

- API request/response snapshot for each step.
- DB record IDs (invoice ID, payment ID, journal entry ID).
- Expected vs actual totals (taxable, tax, grand total, balance).

## Exit Criteria

- 0 critical defects.
- 0 high defects in invoice generation, payment posting, or ledger sync.
- Stakeholder signoff from Finance SME and Project Lead.

