import {
  BASE_URL,
  ensureChaosFixtures,
  login,
  summarizePass,
  withDb,
  fail,
} from "./_shared.mjs"

async function apiPost(path, token, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function apiPut(path, token, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function createFinanceFixture(fixtures) {
  const now = Date.now()
  const future = new Date(Date.UTC(2099, 0, 1))
  future.setUTCDate(future.getUTCDate() + (now % 300))
  const invoiceDate = future.toISOString().slice(0, 10)
  const dueDate = invoiceDate
  const out = { invoiceId: 0, billedTxId: 0 }

  await withDb(async (client) => {
    await client.query("BEGIN")
    try {
      await client.query("SELECT set_config('app.company_id', $1, true)", [String(fixtures.tenantA.companyId)])

      const inv = await client.query(
        `INSERT INTO invoice_header (
           company_id, invoice_number, client_id, billing_cycle, period_from, period_to,
           billing_period, invoice_date, due_date, currency, taxable_amount, total_tax_amount,
           grand_total, paid_amount, balance_amount, status, draft_run_key, created_by, updated_by
         ) VALUES (
           $1, $2, $3, 'MONTHLY', $4::date, $4::date,
           'Finance Hardening', $4::date, $5::date, 'INR', 100, 18,
           118, 0, 118, 'DRAFT', $6, $7, $7
         )
         RETURNING id`,
        [
          fixtures.tenantA.companyId,
          `INV-HARD-${now}`,
          fixtures.ids.a.clientId,
          invoiceDate,
          dueDate,
          `RK${String(now).slice(-8)}`,
          fixtures.ids?.a?.userId || null,
        ]
      )
      out.invoiceId = Number(inv.rows[0]?.id || 0)

      const tx = await client.query(
        `INSERT INTO billing_transactions (
           company_id, client_id, warehouse_id, charge_type, source_type, source_doc_id, source_ref_no,
           event_date, period_from, period_to, uom, quantity, rate, amount, currency,
           tax_code, gst_rate, cgst_amount, sgst_amount, igst_amount, total_tax_amount, gross_amount,
           status, billed_at, billed_by, invoice_id, created_by, updated_by
         ) VALUES (
           $1, $2, $3, 'OUTBOUND_HANDLING', 'DO', 999999, 'HARDENING-TX',
           $4::date, $4::date, $4::date, 'UNIT', 1, 100, 100, 'INR',
           'GST', 18, 9, 9, 0, 18, 118,
           'BILLED', CURRENT_TIMESTAMP, $5, $6, $5, $5
         )
         RETURNING id`,
        [
          fixtures.tenantA.companyId,
          fixtures.ids.a.clientId,
          fixtures.ids.a.warehouseId,
          invoiceDate,
          fixtures.ids?.a?.userId || null,
          out.invoiceId,
        ]
      )
      out.billedTxId = Number(tx.rows[0]?.id || 0)

      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    }
  })

  if (!out.invoiceId || !out.billedTxId) {
    fail("FIN-HARDENING: failed to create invoice/billing fixture")
  }
  return out
}

async function scenarioFH1DraftIdempotency(token, fixtures) {
  const today = new Date().toISOString().slice(0, 10)
  const idem = `idem-draft-${Date.now()}`
  const body = {
    period_from: today,
    period_to: today,
    client_id: fixtures.ids.a.clientId,
    run_key: `RK-${String(Date.now()).slice(-8)}`,
  }
  const first = await apiPost("/finance/invoices/draft", token, body, {
    "x-idempotency-key": idem,
  })
  if (first.status !== 200) {
    fail(`FH1 first draft generation failed status=${first.status}`)
  }
  const second = await apiPost("/finance/invoices/draft", token, body, {
    "x-idempotency-key": idem,
  })
  if (second.status !== 200 || second.json?.message !== "Idempotent replay") {
    fail(`FH1 expected idempotent replay, got status=${second.status} message=${second.json?.message || ""}`)
  }
  summarizePass("FIN_HARDENING 1")
}

async function scenarioFH2FinalizeIdempotency(token, invoiceId) {
  const idem = `idem-finalize-${Date.now()}`
  const first = await apiPost(`/finance/invoices/${invoiceId}/finalize`, token, {}, {
    "x-idempotency-key": idem,
  })
  if (first.status !== 200) {
    fail(`FH2 first finalize failed status=${first.status}`)
  }
  const second = await apiPost(`/finance/invoices/${invoiceId}/finalize`, token, {}, {
    "x-idempotency-key": idem,
  })
  if (second.status !== 200 || second.json?.message !== "Idempotent replay") {
    fail(`FH2 expected idempotent replay, got status=${second.status} message=${second.json?.message || ""}`)
  }
  summarizePass("FIN_HARDENING 2")
}

async function scenarioFH3PaymentChecks(token, invoiceId) {
  const overpay = await apiPost(`/finance/invoices/${invoiceId}/payments`, token, {
    payment_date: new Date().toISOString().slice(0, 10),
    amount: 1000,
    payment_mode: "NEFT",
    reference_no: `OVR-${Date.now()}`,
  })
  if (overpay.status !== 400) {
    fail(
      `FH3 expected overpayment rejection status=400 got ${overpay.status} message=${overpay.json?.error?.message || overpay.json?.message || ""}`
    )
  }

  const idem = `idem-pay-${Date.now()}`
  const body = {
    payment_date: new Date().toISOString().slice(0, 10),
    amount: 10,
    payment_mode: "NEFT",
    reference_no: `PAY-${Date.now()}`,
  }
  const first = await apiPost(`/finance/invoices/${invoiceId}/payments`, token, body, {
    "x-idempotency-key": idem,
  })
  if (first.status !== 200 || !first.json?.data?.payment?.id) {
    fail(`FH3 first payment failed status=${first.status} message=${first.json?.error?.message || first.json?.message || ""}`)
  }
  const firstPaymentId = Number(first.json.data.payment.id)

  const second = await apiPost(`/finance/invoices/${invoiceId}/payments`, token, body, {
    "x-idempotency-key": idem,
  })
  const replayPaymentId = Number(second.json?.data?.payment?.id || 0)
  if (second.status !== 200 || second.json?.message !== "Idempotent replay" || replayPaymentId !== firstPaymentId) {
    fail(
      `FH3 payment replay failed status=${second.status} message=${second.json?.message || ""} paymentId=${replayPaymentId}`
    )
  }

  summarizePass("FIN_HARDENING 3")
}

async function scenarioFH4UnsafeUnbillBlocked(token, billedTxId) {
  const unbill = await apiPut("/finance/billing-transactions", token, {
    id: billedTxId,
    action: "UNBILL",
  })
  if (unbill.status !== 409) {
    fail(`FH4 expected billed UNBILL to be blocked with 409, got ${unbill.status}`)
  }
  summarizePass("FIN_HARDENING 4")
}

async function main() {
  const fixtures = await ensureChaosFixtures()
  const token = await login(fixtures.tenantA.code, fixtures.tenantA.username, fixtures.tenantA.password)
  const financeFixture = await createFinanceFixture(fixtures)

  await scenarioFH1DraftIdempotency(token, fixtures)
  await scenarioFH2FinalizeIdempotency(token, financeFixture.invoiceId)
  await scenarioFH3PaymentChecks(token, financeFixture.invoiceId)
  await scenarioFH4UnsafeUnbillBlocked(token, financeFixture.billedTxId)
  console.log("Finance hardening suite complete")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
