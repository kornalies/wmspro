"use client"

/**
 * The one and only renderer for every document in the engine.
 *
 * Every layout decision — A4 geometry, letterhead, table styling, signature
 * boxes, print rules — lives here, so adding a document type is a builder in
 * lib/documents/builders.ts and nothing else. The GRN print page's approach
 * (visibility-based print isolation, @page A4) is kept because it prints
 * correctly across browsers; what changes is that it is written once.
 *
 * The layout implements the GWU Enterprise Document Design Standard: header
 * option A (banded rule), table option A (filled header + zebra rows) and
 * footer option A (rule + two-column) from the approved sample pack, which were
 * chosen for print cost and legibility on thermal and mono printers.
 */

import type {
  DocumentModel,
  DocumentPartyCards,
  DocumentSection,
  DocumentStatusTone,
  DocumentSummaryTiles,
  DocumentTable,
  DocumentTerms,
} from "@/lib/documents/types"
import { EDDS_TEMPLATE_VERSION, shouldWatermark } from "@/lib/documents/types"

function cellValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "-"
  return String(value)
}

/** Print-safe status colours: light fills that survive mono printing as tints. */
const STATUS_TONES: Record<DocumentStatusTone, { bg: string; fg: string; dot: string }> = {
  pending: { bg: "#FEF3C7", fg: "#92400E", dot: "#D97706" },
  approved: { bg: "#DCFCE7", fg: "#166534", dot: "#16A34A" },
  completed: { bg: "#DCFCE7", fg: "#166534", dot: "#15803D" },
  "in-transit": { bg: "#DBEAFE", fg: "#1E40AF", dot: "#2563EB" },
  cancelled: { bg: "#FEE2E2", fg: "#991B1B", dot: "#DC2626" },
  draft: { bg: "#F1F5F9", fg: "#334155", dot: "#64748B" },
}

function TableSection({ section }: { section: DocumentTable }) {
  const hasTotals = section.totals && Object.keys(section.totals).length > 0

  return (
    <section className="doc-section">
      {(section.title || section.caption) && (
        <div className="doc-section-head">
          {section.title ? <h2 className="doc-section-title">{section.title}</h2> : <span />}
          {section.caption ? <span className="doc-section-caption">{section.caption}</span> : null}
        </div>
      )}
      {section.rows.length === 0 ? (
        <p className="doc-empty">{section.emptyText || "No rows."}</p>
      ) : (
        <table className="doc-table">
          <thead>
            <tr>
              {section.columns.map((col) => (
                <th
                  key={col.key}
                  className="doc-cell doc-head"
                  style={{ width: col.width, textAlign: col.align || "left" }}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {section.rows.map((row, index) => (
              <tr key={index} className={index % 2 === 1 ? "doc-row-alt" : undefined}>
                {section.columns.map((col) => (
                  <td
                    key={col.key}
                    className={`doc-cell${col.mono ? " doc-mono" : ""}`}
                    style={{ textAlign: col.align || "left" }}
                  >
                    {cellValue(row[col.key])}
                  </td>
                ))}
              </tr>
            ))}
            {hasTotals ? (
              <tr className="doc-totals">
                {section.columns.map((col) => (
                  <td
                    key={col.key}
                    className={`doc-cell${col.mono ? " doc-mono" : ""}`}
                    style={{ textAlign: col.align || "left" }}
                  >
                    {section.totals?.[col.key] === undefined
                      ? ""
                      : cellValue(section.totals[col.key])}
                  </td>
                ))}
              </tr>
            ) : null}
          </tbody>
        </table>
      )}
    </section>
  )
}

function PartyCardsSection({ section }: { section: DocumentPartyCards }) {
  return (
    <section className="doc-section doc-party-row" style={{ gridTemplateColumns: `repeat(${section.cards.length}, minmax(0, 1fr))` }}>
      {section.cards.map((card) => (
        <div key={card.title} className="doc-party-card">
          <div className="doc-party-head">{card.title}</div>
          <div className="doc-party-body">
            {card.fields.map((field) => (
              <div key={field.label} className="doc-field">
                <span className="doc-field-label">{field.label}</span>
                <span className="doc-field-value">{field.value || "-"}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

function SummaryTilesSection({ section }: { section: DocumentSummaryTiles }) {
  return (
    <section className="doc-section doc-tiles">
      {section.tiles.map((tile) => (
        <div key={tile.label} className="doc-tile">
          <span className="doc-tile-label">{tile.label}</span>
          <span className="doc-tile-value">
            {tile.value}
            {tile.unit ? <span className="doc-tile-unit"> {tile.unit}</span> : null}
          </span>
        </div>
      ))}
    </section>
  )
}

function TermsSection({ section }: { section: DocumentTerms }) {
  return (
    <section className="doc-section">
      <h2 className="doc-section-title">{section.title || "Terms & Conditions"}</h2>
      <ol className="doc-terms">
        {section.items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ol>
    </section>
  )
}

function SectionRenderer({ section }: { section: DocumentSection }) {
  if (section.kind === "table") return <TableSection section={section} />
  if (section.kind === "party-cards") return <PartyCardsSection section={section} />
  if (section.kind === "summary-tiles") return <SummaryTilesSection section={section} />
  if (section.kind === "terms") return <TermsSection section={section} />

  if (section.kind === "fields") {
    const columns = section.columns || 2
    return (
      <section className="doc-section">
        {section.title ? <h2 className="doc-section-title">{section.title}</h2> : null}
        <div
          className="doc-field-grid"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {section.fields.map((field) => (
            <div key={field.label} className="doc-field">
              <span className="doc-field-label">{field.label}</span>
              <span className="doc-field-value">{field.value || "-"}</span>
            </div>
          ))}
        </div>
      </section>
    )
  }

  if (section.kind === "notes") {
    return (
      <section className="doc-section">
        {section.title ? <h2 className="doc-section-title">{section.title}</h2> : null}
        <p className="doc-notes">{section.text}</p>
      </section>
    )
  }

  // Signature blocks carry Name / Designation / Date rules (FR-07) rather than a
  // bare line, because these get filled in by hand on a dock and an unlabelled
  // rule gets a scrawl with no date against it.
  return (
    <section className="doc-section doc-signatures-section">
      {section.title ? <h2 className="doc-section-title">{section.title}</h2> : null}
      <div
        className="doc-signatures"
        style={{ gridTemplateColumns: `repeat(${section.blocks.length}, minmax(0, 1fr))` }}
      >
        {section.blocks.map((block) => (
          <div key={block.role} className="doc-signature">
            <div className="doc-signature-head">{block.role}</div>
            <div className="doc-signature-space">{block.name || ""}</div>
            <div className="doc-signature-rules">
              <span>Name</span>
              <span>Designation</span>
              <span>Date</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function formatPrintedAt(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

export function DocumentSheet({ model }: { model: DocumentModel }) {
  const accent = model.branding.primaryColor
  const tone = STATUS_TONES[model.status.tone]
  const watermark = shouldWatermark(model.status)
  const brand = model.branding
  const identity = [
    brand.gstin ? `GSTIN ${brand.gstin}` : "",
    brand.cin ? `CIN ${brand.cin}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
  const contact = [brand.phone, brand.supportEmail].filter(Boolean).join(" · ")

  return (
    <div className="doc-root bg-white p-8 text-sm">
      {watermark ? (
        <div className="doc-watermark" aria-hidden="true">
          {model.status.label}
        </div>
      ) : null}

      <header className="doc-letterhead" style={{ borderBottomColor: accent }}>
        <div className="doc-letterhead-left">
          {brand.logoUrl ? (
            // Tenant logos are arbitrary URLs typed into tenant settings, so
            // next/image's loader would need every tenant domain whitelisted. A
            // plain img keeps onboarding a logo a settings change, not a deploy.
            //
            // NOTE: proxy.ts sets img-src 'self' data: blob:, so a logo hosted on
            // an external domain is blocked and the letterhead falls back to the
            // company name. Same-origin paths and data: URIs work. The portal
            // letterhead has the same constraint.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logoUrl} alt="" className="doc-logo" />
          ) : (
            <div className="doc-logo-slot">LOGO</div>
          )}
          <div className="doc-identity">
            <p className="doc-company" style={{ color: accent }}>
              {brand.companyName}
            </p>
            {brand.tagline ? <p className="doc-tagline">{brand.tagline}</p> : null}
            {brand.address ? <p className="doc-address">{brand.address}</p> : null}
            {contact ? <p className="doc-address">{contact}</p> : null}
            {identity ? <p className="doc-identity-line doc-mono">{identity}</p> : null}
          </div>
        </div>

        <div className="doc-letterhead-right">
          <div className="doc-title-block">
            <h1 className="doc-title" style={{ color: accent }}>
              {model.title}
            </h1>
            <div className="doc-header-meta">
              <span className="doc-header-meta-label">Document No</span>
              <span className="doc-header-meta-value doc-mono">{model.documentNumber}</span>
              <span className="doc-header-meta-label">Document Date</span>
              <span className="doc-header-meta-value doc-mono">{model.documentDate}</span>
              {model.warehouseLabel ? (
                <>
                  <span className="doc-header-meta-label">Warehouse</span>
                  <span className="doc-header-meta-value doc-mono">{model.warehouseLabel}</span>
                </>
              ) : null}
            </div>
            <span
              className="doc-badge"
              style={{ background: tone.bg, color: tone.fg, borderColor: tone.dot }}
            >
              <span className="doc-badge-dot" style={{ background: tone.dot }} />
              {model.status.label}
            </span>
          </div>

          {model.qr ? (
            <div className="doc-qr">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={model.qr.dataUri} alt="Verification QR code" />
              <span className="doc-qr-caption">
                Scan to
                <br />
                verify
              </span>
            </div>
          ) : null}
        </div>
      </header>

      {model.meta.length ? (
        <div className="doc-meta">
          {model.meta.map((field) => (
            <div key={field.label} className="doc-field">
              <span className="doc-field-label">{field.label}</span>
              <span className="doc-field-value">{field.value || "-"}</span>
            </div>
          ))}
        </div>
      ) : null}

      {model.sections.map((section, index) => (
        <SectionRenderer key={index} section={section} />
      ))}

      {model.footerNote ? <p className="doc-note-line">{model.footerNote}</p> : null}

      <footer className="doc-footer" style={{ borderTopColor: accent }}>
        <div className="doc-footer-left">
          <p>
            <strong>{brand.companyName}</strong>
            {brand.website ? ` · ${brand.website}` : ""}
            {brand.supportEmail ? ` · ${brand.supportEmail}` : ""}
          </p>
          <p className="doc-footer-muted">
            Confidential — intended solely for the named recipient. Reproduction or
            redistribution without written consent is prohibited.
          </p>
        </div>
        <div className="doc-footer-right doc-mono">
          <p>
            Template {EDDS_TEMPLATE_VERSION} · {model.documentNumber}
          </p>
          <p>Printed {formatPrintedAt(model.printedAt)} · SYSTEM GENERATED DOCUMENT</p>
        </div>
      </footer>

      <style jsx global>{`
        .doc-root {
          color: #1f2937;
          position: relative;
          font-family: var(--font-inter), ui-sans-serif, system-ui, sans-serif;
          font-variant-numeric: tabular-nums;
        }
        .doc-mono {
          font-family: var(--font-roboto-mono), ui-monospace, SFMono-Regular, Menlo, monospace;
        }

        /* ---- Watermark (FR-02) ------------------------------------------- */
        .doc-watermark {
          position: absolute;
          top: 42%;
          left: 50%;
          transform: translate(-50%, -50%) rotate(-32deg);
          font-size: 96px;
          font-weight: 800;
          letter-spacing: 0.12em;
          color: rgba(220, 38, 38, 0.12);
          pointer-events: none;
          user-select: none;
          white-space: nowrap;
          z-index: 0;
        }
        .doc-root > *:not(.doc-watermark) {
          position: relative;
          z-index: 1;
        }

        /* ---- Header, option A: banded rule (FR-01) ----------------------- */
        .doc-letterhead {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 24px;
          border-bottom: 3px solid #0f4c81;
          padding-bottom: 16px;
          margin-bottom: 16px;
        }
        .doc-letterhead-left {
          display: flex;
          align-items: flex-start;
          gap: 16px;
          min-width: 0;
        }
        .doc-logo {
          max-height: 56px;
          max-width: 160px;
          object-fit: contain;
        }
        .doc-logo-slot {
          width: 64px;
          height: 56px;
          border: 1px dashed #cbd5e1;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 8px;
          letter-spacing: 0.1em;
          color: #94a3b8;
          flex: none;
        }
        .doc-identity {
          min-width: 0;
        }
        .doc-company {
          font-size: 17px;
          font-weight: 700;
          line-height: 1.2;
          letter-spacing: -0.01em;
        }
        .doc-tagline {
          font-size: 9.5px;
          color: #00a8e8;
          font-weight: 600;
          margin-top: 2px;
        }
        .doc-address {
          font-size: 9px;
          color: #6b7280;
          line-height: 1.45;
          max-width: 42ch;
        }
        .doc-identity-line {
          font-size: 8.5px;
          color: #6b7280;
          margin-top: 2px;
        }

        .doc-letterhead-right {
          display: flex;
          align-items: flex-start;
          gap: 16px;
          flex: none;
        }
        .doc-title-block {
          text-align: right;
        }
        .doc-title {
          font-size: 24px;
          font-weight: 700;
          letter-spacing: -0.01em;
          line-height: 1.1;
          text-transform: uppercase;
        }
        .doc-header-meta {
          display: grid;
          grid-template-columns: auto auto;
          gap: 2px 10px;
          justify-content: end;
          align-items: baseline;
          margin-top: 8px;
        }
        .doc-header-meta-label {
          font-size: 8px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #6b7280;
        }
        .doc-header-meta-value {
          font-size: 10.5px;
          font-weight: 700;
          color: #1f2937;
        }
        .doc-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-top: 10px;
          border: 1px solid;
          border-radius: 999px;
          font-size: 9.5px;
          font-weight: 700;
          padding: 3px 10px;
          letter-spacing: 0.08em;
        }
        .doc-badge-dot {
          width: 5px;
          height: 5px;
          border-radius: 999px;
          flex: none;
        }
        .doc-qr {
          text-align: center;
          flex: none;
        }
        .doc-qr img {
          width: 68px;
          height: 68px;
          display: block;
        }
        .doc-qr-caption {
          display: block;
          font-size: 7px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #6b7280;
          margin-top: 3px;
          line-height: 1.3;
        }

        /* ---- Meta band (FR-03) ------------------------------------------- */
        .doc-meta {
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: 8px 16px;
          background: #f4f6f8;
          border: 1px solid #e5e7eb;
          border-radius: 4px;
          padding: 10px 14px;
          margin-bottom: 16px;
        }
        .doc-field {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .doc-field-label {
          font-size: 8px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #6b7280;
        }
        .doc-field-value {
          font-size: 10.5px;
          font-weight: 600;
          overflow-wrap: anywhere;
          line-height: 1.35;
        }

        .doc-section {
          margin-bottom: 16px;
          break-inside: avoid;
        }
        .doc-section-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 6px;
        }
        .doc-section-title {
          font-size: 10.5px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #1f2937;
          margin-bottom: 6px;
        }
        .doc-section-head .doc-section-title {
          margin-bottom: 0;
        }
        .doc-section-caption {
          font-size: 8.5px;
          color: #6b7280;
          text-align: right;
        }

        /* ---- Party cards (FR-04) ----------------------------------------- */
        .doc-party-row {
          display: grid;
          gap: 10px;
        }
        .doc-party-card {
          border: 1px solid #e5e7eb;
          border-radius: 4px;
          overflow: hidden;
          min-width: 0;
        }
        .doc-party-head {
          background: #0f4c81;
          color: #fff;
          font-size: 8.5px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.09em;
          padding: 5px 10px;
        }
        .doc-party-body {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 9px 10px;
        }

        .doc-field-grid {
          display: grid;
          gap: 8px 16px;
          border: 1px solid #e5e7eb;
          border-radius: 4px;
          padding: 10px 12px;
        }

        /* ---- Table, option A: filled header + zebra rows (FR-05) --------- */
        .doc-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 10px;
        }
        .doc-cell {
          border: 1px solid #e5e7eb;
          padding: 5px 7px;
          vertical-align: top;
          overflow-wrap: anywhere;
          line-height: 1.35;
        }
        .doc-head {
          font-weight: 700;
          background: #0f4c81;
          color: #fff;
          border-color: #0f4c81;
          font-size: 8.5px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          white-space: nowrap;
        }
        .doc-row-alt td {
          background: #f8fafc;
        }
        .doc-totals td {
          font-weight: 700;
          background: #eef2f6;
          border-top: 1.5px solid #0f4c81;
        }
        .doc-empty {
          font-size: 10.5px;
          font-style: italic;
          color: #6b7280;
          border: 1px dashed #d1d5db;
          border-radius: 4px;
          padding: 12px;
        }

        /* ---- Summary tiles (FR-06) --------------------------------------- */
        .doc-tiles {
          display: grid;
          grid-template-columns: repeat(6, minmax(0, 1fr));
          gap: 8px;
        }
        .doc-tile {
          border: 1px solid #e5e7eb;
          border-left: 3px solid #00a8e8;
          border-radius: 4px;
          padding: 8px 10px;
          display: flex;
          flex-direction: column;
          gap: 3px;
          min-width: 0;
        }
        .doc-tile-label {
          font-size: 7.5px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #6b7280;
        }
        .doc-tile-value {
          font-size: 15px;
          font-weight: 700;
          color: #0f4c81;
          overflow-wrap: anywhere;
        }
        .doc-tile-unit {
          font-size: 9px;
          font-weight: 600;
          color: #6b7280;
        }

        .doc-notes {
          font-size: 10.5px;
          border: 1px solid #e5e7eb;
          border-radius: 4px;
          padding: 9px 11px;
          white-space: pre-wrap;
          line-height: 1.45;
        }
        .doc-note-line {
          font-size: 9px;
          color: #6b7280;
          margin-bottom: 12px;
          line-height: 1.45;
        }

        /* ---- Terms (two columns, numbered) ------------------------------- */
        .doc-terms {
          columns: 2;
          column-gap: 24px;
          font-size: 8.5px;
          color: #4b5563;
          line-height: 1.5;
          padding-left: 14px;
          list-style: decimal;
        }
        .doc-terms li {
          break-inside: avoid;
          margin-bottom: 3px;
        }

        /* ---- Approvals (FR-07) ------------------------------------------- */
        .doc-signatures-section {
          margin-top: 24px;
        }
        .doc-signatures {
          display: grid;
          gap: 12px;
        }
        .doc-signature {
          border: 1px solid #e5e7eb;
          border-radius: 4px;
          overflow: hidden;
        }
        .doc-signature-head {
          background: #f4f6f8;
          border-bottom: 1px solid #e5e7eb;
          font-size: 8.5px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #374151;
          padding: 5px 9px;
        }
        .doc-signature-space {
          height: 42px;
          margin: 8px 9px 0;
          border-bottom: 1px dashed #9ca3af;
        }
        .doc-signature-rules {
          display: flex;
          flex-direction: column;
          gap: 1px;
          padding: 5px 9px 8px;
        }
        .doc-signature-rules span {
          font-size: 7.5px;
          text-transform: uppercase;
          letter-spacing: 0.07em;
          color: #9ca3af;
        }

        /* ---- Footer, option A: rule + two-column (FR-08) ----------------- */
        .doc-footer {
          margin-top: 20px;
          border-top: 2px solid #0f4c81;
          padding-top: 7px;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 24px;
          font-size: 8px;
          color: #4b5563;
          line-height: 1.5;
        }
        .doc-footer-right {
          text-align: right;
          white-space: nowrap;
        }
        .doc-footer-muted {
          color: #9ca3af;
          max-width: 62ch;
        }

        @page {
          size: A4 ${model.orientation === "landscape" ? "landscape" : "portrait"};
          margin: 12mm;
        }
        @media print {
          .no-print {
            display: none !important;
          }
          /* Print only the sheet. Hiding by visibility rather than display
             keeps the sheet's own layout intact while removing the app chrome. */
          body * {
            visibility: hidden;
          }
          .doc-root,
          .doc-root * {
            visibility: visible;
          }
          .doc-root {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            border: 0 !important;
            box-shadow: none !important;
            margin: 0 !important;
            padding: 0 !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          /* The footer repeats on every printed page rather than trailing the
             last one — a multi-page delivery note whose middle pages carry no
             document number or confidentiality notice is not auditable, and
             loose pages do get separated on a dock.

             Verified by printing a 3-page probe through headless Chrome: a
             position:fixed footer renders on all three pages, whereas the same
             block in normal flow renders only on the last.

             Page numbering is deliberately NOT attempted here. The same probe
             showed Chrome resolves counter(page)/counter(pages) to 0 outside
             @page margin boxes (which it does not support), so "Page N of M"
             printed as "Page 0 of 0" — worse than omitting it. The browser's own
             print header/footer supplies page numbers and is on by default;
             rendering them in the template needs a server-side PDF pass, which
             was explicitly descoped. */
          .doc-footer {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            background: #fff;
            margin-top: 0;
          }
          /* Reserve the footer's band so table rows never run underneath it. */
          .doc-root {
            padding-bottom: 16mm !important;
          }
          thead {
            display: table-header-group;
          }
          tfoot {
            display: table-footer-group;
          }
        }
      `}</style>
    </div>
  )
}
