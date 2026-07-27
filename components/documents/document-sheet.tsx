"use client"

/**
 * The one and only renderer for every document in the engine.
 *
 * Every layout decision — A4 geometry, letterhead, table styling, signature
 * boxes, print rules — lives here, so adding a document type is a builder in
 * lib/documents/builders.ts and nothing else. The GRN print page's approach
 * (visibility-based print isolation, @page A4) is kept because it prints
 * correctly across browsers; what changes is that it is written once.
 */

import type {
  DocumentModel,
  DocumentSection,
  DocumentTable,
} from "@/lib/documents/types"

function cellValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "-"
  return String(value)
}

function TableSection({ section }: { section: DocumentTable }) {
  const hasTotals = section.totals && Object.keys(section.totals).length > 0

  return (
    <section className="doc-section">
      {section.title ? <h2 className="doc-section-title">{section.title}</h2> : null}
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
              <tr key={index}>
                {section.columns.map((col) => (
                  <td
                    key={col.key}
                    className="doc-cell"
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
                    className="doc-cell"
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

function SectionRenderer({ section }: { section: DocumentSection }) {
  if (section.kind === "table") return <TableSection section={section} />

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

  return (
    <section className="doc-section doc-signatures-section">
      {section.title ? <h2 className="doc-section-title">{section.title}</h2> : null}
      <div
        className="doc-signatures"
        style={{ gridTemplateColumns: `repeat(${section.blocks.length}, minmax(0, 1fr))` }}
      >
        {section.blocks.map((block) => (
          <div key={block.role} className="doc-signature">
            <div className="doc-signature-space">{block.name || ""}</div>
            <div className="doc-signature-role">{block.role}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

export function DocumentSheet({ model }: { model: DocumentModel }) {
  const accent = model.branding.primaryColor

  return (
    <div className="doc-root bg-white p-8 text-sm">
      <header className="doc-letterhead" style={{ borderBottomColor: accent }}>
        <div className="doc-letterhead-left">
          {model.branding.logoUrl ? (
            // Tenant logos are arbitrary external URLs, so next/image's loader
            // would need every tenant domain whitelisted. A plain img keeps
            // onboarding a logo a settings change rather than a deploy.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={model.branding.logoUrl} alt="" className="doc-logo" />
          ) : null}
          <div>
            <p className="doc-company" style={{ color: accent }}>
              {model.branding.companyName}
            </p>
            {model.branding.companyCode ? (
              <p className="doc-company-code">{model.branding.companyCode}</p>
            ) : null}
          </div>
        </div>
        <div className="doc-letterhead-right">
          <h1 className="doc-title" style={{ color: accent }}>
            {model.title}
          </h1>
          <p className="doc-number">{model.documentNumber}</p>
          {model.statusBadge ? <p className="doc-badge">{model.statusBadge}</p> : null}
        </div>
      </header>

      <div className="doc-meta">
        {model.meta.map((field) => (
          <div key={field.label} className="doc-field">
            <span className="doc-field-label">{field.label}</span>
            <span className="doc-field-value">{field.value || "-"}</span>
          </div>
        ))}
      </div>

      {model.sections.map((section, index) => (
        <SectionRenderer key={index} section={section} />
      ))}

      {model.footerNote ? <p className="doc-footer">{model.footerNote}</p> : null}

      <style jsx global>{`
        .doc-root {
          color: #111827;
        }
        .doc-letterhead {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          border-bottom: 2px solid #0f3f7d;
          padding-bottom: 10px;
          margin-bottom: 12px;
        }
        .doc-letterhead-left {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .doc-logo {
          max-height: 48px;
          max-width: 160px;
          object-fit: contain;
        }
        .doc-company {
          font-size: 15px;
          font-weight: 700;
          line-height: 1.2;
        }
        .doc-company-code {
          font-size: 10px;
          color: #6b7280;
          letter-spacing: 0.06em;
        }
        .doc-letterhead-right {
          text-align: right;
        }
        .doc-title {
          font-size: 18px;
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .doc-number {
          font-size: 12px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #374151;
        }
        .doc-badge {
          display: inline-block;
          margin-top: 4px;
          border: 1px solid #dc2626;
          background: #fef2f2;
          color: #b91c1c;
          font-size: 10px;
          font-weight: 700;
          padding: 2px 6px;
          letter-spacing: 0.08em;
        }
        .doc-meta {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 6px 14px;
          margin-bottom: 14px;
        }
        .doc-field {
          display: flex;
          flex-direction: column;
          gap: 1px;
          min-width: 0;
        }
        .doc-field-label {
          font-size: 9px;
          text-transform: uppercase;
          letter-spacing: 0.07em;
          color: #6b7280;
        }
        .doc-field-value {
          font-size: 11px;
          font-weight: 600;
          overflow-wrap: anywhere;
        }
        .doc-section {
          margin-bottom: 14px;
          break-inside: avoid;
        }
        .doc-section-title {
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.07em;
          color: #374151;
          margin-bottom: 5px;
        }
        .doc-field-grid {
          display: grid;
          gap: 6px 14px;
          border: 1px solid #e5e7eb;
          padding: 8px 10px;
        }
        .doc-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 10.5px;
        }
        .doc-cell {
          border: 1px solid #d1d5db;
          padding: 4px 6px;
          vertical-align: top;
          overflow-wrap: anywhere;
        }
        .doc-head {
          font-weight: 700;
          background: #f3f4f6;
        }
        .doc-totals {
          font-weight: 700;
          background: #f9fafb;
        }
        .doc-empty {
          font-size: 11px;
          font-style: italic;
          color: #6b7280;
          border: 1px dashed #d1d5db;
          padding: 10px;
        }
        .doc-notes {
          font-size: 11px;
          border: 1px solid #e5e7eb;
          padding: 8px 10px;
          white-space: pre-wrap;
        }
        .doc-signatures-section {
          margin-top: 26px;
        }
        .doc-signatures {
          display: grid;
          gap: 18px;
        }
        .doc-signature-space {
          height: 40px;
          border-bottom: 1px solid #9ca3af;
        }
        .doc-signature-role {
          font-size: 9.5px;
          text-transform: uppercase;
          letter-spacing: 0.07em;
          color: #4b5563;
          padding-top: 3px;
        }
        .doc-footer {
          margin-top: 16px;
          border-top: 1px solid #e5e7eb;
          padding-top: 6px;
          font-size: 9px;
          color: #6b7280;
        }

        @page {
          size: A4;
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
        }
      `}</style>
    </div>
  )
}