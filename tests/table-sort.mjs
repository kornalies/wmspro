/**
 * List-table sorting acceptance.
 *
 * Three live bugs are guarded here, all of which looked like "sorting is a bit odd"
 * rather than an error, and so survived on main for a long time:
 *
 * 1. NUMERIC COLUMNS SORTED AS TEXT. Postgres `numeric` arrives as a JS string, but
 *    the old comparators branched on `typeof v === "number"` to pick a numeric
 *    compare. That branch never ran for money, so Item MRP and every contract rate
 *    fell through to localeCompare: 1200.00 sorted above 999.00.
 *
 * 2. AN INCONSISTENT COMPARATOR. Sniffing the kind with `Number.isFinite(Number(v))`
 *    classified "" and null as the finite number 0, so in a text column with gaps,
 *    blank-vs-blank compared numerically and blank-vs-value compared as text. The
 *    central assertion below is therefore not "these rows come out in this order" but
 *    the ANTISYMMETRY PROPERTY -- cmp(a,b) === -cmp(b,a) over a mixed matrix. An
 *    order-only test passes for an inconsistent comparator roughly by luck, which is
 *    exactly how this shipped.
 *
 * 3. NO TIEBREAK, so rows with equal keys reshuffled between renders.
 *
 * Pure: no database, no dev server.
 */

import process from "node:process"
import {
  compareValues,
  defaultDirFor,
  inferValueKind,
  makeComparator,
  nextSortState,
  sortRows,
} from "../lib/table-sort.ts"

let failures = 0
function check(label, condition, extra = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${extra ? ` :: ${extra}` : ""}`)
  if (!condition) failures++
}

function eq(label, actual, expected) {
  const ok = actual === expected
  check(label, ok, ok ? "" : `expected ${expected}, got ${actual}`)
}

function order(label, rows, kind, dir, expected, accessor = (r) => r.v) {
  const got = sortRows(rows, accessor, kind, dir, (r) => r.id).map((r) => r.id).join(",")
  check(label, got === expected, got === expected ? "" : `expected [${expected}], got [${got}]`)
}

const rowsOf = (...values) => values.map((v, i) => ({ id: i + 1, v }))

{
  // Bug 1, on the exact values the Items and Contracts screens serve. These arrive as
  // strings from node-postgres; a text compare puts "1200.00" first.
  const mrp = rowsOf("999.00", "1200.00", "85.50", "1000")
  order("numeric strings sort by magnitude ascending", mrp, "number", "asc", "3,1,4,2")
  order("numeric strings sort by magnitude descending", mrp, "number", "desc", "2,4,1,3")

  eq("1200.00 is greater than 999.00 as a number", compareValues("1200.00", "999.00", "number"), 1)
  // The old comparators ended in a bare `String(a).localeCompare(String(b))`, which is
  // codepoint-ish and puts "1200.00" first. Assert against that call directly so the
  // regression is pinned to the behaviour, not to a phrasing of it.
  eq("plain localeCompare is what got this wrong", "1200.00".localeCompare("999.00"), -1)
  check(
    "the shared comparator disagrees with plain localeCompare here",
    Math.sign(compareValues("1200.00", "999.00", "text")) !== Math.sign("1200.00".localeCompare("999.00"))
  )

  // Real JS numbers must keep working -- integer columns (min_stock_alert) come back
  // from pg already coerced, so both representations reach the same comparator.
  eq("mixed string and number compare numerically", compareValues(9, "10", "number"), -1)
}

{
  // Bug 2: a zero is a value, an empty string is not. Conflating them (Number("") === 0)
  // is what made the old comparator inconsistent.
  eq("zero is not blank", compareValues(0, "", "number"), -1)
  eq("blank sorts after a value", compareValues("", 5, "number"), 1)
  eq("two blanks are equal", compareValues("", null, "number"), 0)
  eq("whitespace counts as blank", compareValues("   ", "abc", "text"), 1)
  eq("false is a value, not a blank", compareValues(false, null, "boolean"), -1)
  eq("unparseable numbers are blank, not NaN", compareValues("n/a", 1, "number"), 1)
}

{
  // Blanks must not flip with direction: a descending sort exists to surface the
  // LARGEST values, so a wall of empty cells at the top defeats the click.
  const gappy = rowsOf("b", "", "a", null, "c")
  order("blanks sink to the bottom ascending", gappy, "text", "asc", "3,1,5,2,4")
  order("blanks stay at the bottom descending", gappy, "text", "desc", "5,1,3,2,4")
}

{
  // Bug 2's real assertion. A comparator must be antisymmetric and transitive or
  // Array#sort is free to emit anything; this matrix mixes every shape the API
  // actually returns into one column.
  const values = ["", null, undefined, "0", 0, "10", 10, "9", "abc", "  ", false, "2026-08-18"]
  for (const kind of ["text", "number", "date", "boolean"]) {
    let antisymmetric = true
    for (const a of values) {
      for (const b of values) {
        const ab = Math.sign(compareValues(a, b, kind))
        const ba = Math.sign(compareValues(b, a, kind))
        if (ab !== -ba) antisymmetric = false
      }
    }
    check(`${kind} comparator is antisymmetric across mixed input`, antisymmetric)
  }

  for (const kind of ["text", "number", "date", "boolean"]) {
    let transitive = true
    for (const a of values) {
      for (const b of values) {
        for (const c of values) {
          const ab = Math.sign(compareValues(a, b, kind))
          const bc = Math.sign(compareValues(b, c, kind))
          const ac = Math.sign(compareValues(a, c, kind))
          if (ab < 0 && bc < 0 && ac >= 0) transitive = false
          if (ab === 0 && bc === 0 && ac !== 0) transitive = false
        }
      }
    }
    check(`${kind} comparator is transitive across mixed input`, transitive)
  }
}

{
  // The DO list sorted on rawCell(), a DISPLAY formatter -- created_at reached the
  // comparator as "18 Aug 2026, 04:30 PM" and sorted alphabetically by day-of-month.
  // created_at is that screen's default sort key, so the list was wrong before any
  // click. These are the raw ISO values the fix passes instead.
  const stamps = rowsOf(
    "2026-08-18T04:30:00.000Z",
    "2026-01-09T23:00:00.000Z",
    "2025-12-31T10:00:00.000Z"
  )
  order("ISO timestamps sort chronologically, newest first", stamps, "date", "desc", "1,2,3")
  order("ISO timestamps sort chronologically, oldest first", stamps, "date", "asc", "3,2,1")

  // The same values as display strings are what the bug produced. Guard the shape so
  // nobody reintroduces a formatter in the sort path and calls it fixed.
  const formatted = rowsOf("18 Aug 2026, 04:30 PM", "09 Jan 2026, 11:00 PM", "31 Dec 2025, 10:00 AM")
  const asText = sortRows(formatted, (r) => r.v, "text", "asc", (r) => r.id).map((r) => r.id).join(",")
  check(
    "formatted timestamps do NOT sort chronologically as text (why sortCell exists)",
    asText !== "3,2,1",
    `text order was [${asText}]`
  )

  eq("an unparseable date is blank, not epoch zero", compareValues("not a date", "2020-01-01", "date"), 1)
}

{
  // The DO progress column reached the comparator as "85%", which Number() reads as
  // NaN, so it fell to text and put "9%" above "85%".
  const percents = rowsOf(85, 9, 100, 0)
  order("progress sorts numerically", percents, "number", "desc", "3,1,2,4")
  eq("a percent-suffixed string is not a number", compareValues("85%", "9%", "number"), 0)
}

{
  // Human ordering for code columns: the collator's numeric mode, not raw codepoints.
  const codes = rowsOf("ITEM-9", "ITEM-10", "ITEM-2")
  order("codes order by embedded number, not codepoint", codes, "text", "asc", "3,1,2")
}

{
  // Bug 3: equal keys must not reshuffle. Same key on every row -> id order, both ways.
  const flat = [
    { id: 3, v: "same" },
    { id: 1, v: "same" },
    { id: 2, v: "same" },
  ]
  eq(
    "equal keys fall back to the id tiebreak ascending",
    sortRows(flat, (r) => r.v, "text", "asc", (r) => r.id).map((r) => r.id).join(","),
    "1,2,3"
  )
  eq(
    "the tiebreak does not flip with direction",
    sortRows(flat, (r) => r.v, "text", "desc", (r) => r.id).map((r) => r.id).join(","),
    "1,2,3"
  )
  eq(
    "blank rows are also tiebroken, not left arbitrary",
    sortRows(rowsOf(null, null, null), (r) => r.v, "number", "desc", (r) => r.id).map((r) => r.id).join(","),
    "1,2,3"
  )

  // Sorting must not mutate the caller's array -- the screens hold these in react-query
  // caches and useMemo results.
  const source = rowsOf("b", "a")
  sortRows(source, (r) => r.v, "text", "asc", (r) => r.id)
  eq("sortRows leaves the input untouched", source.map((r) => r.v).join(","), "b,a")
}

{
  // The reports screen renders five different result shapes, so it infers. Inference
  // must be conservative: anything mixed is text, and it runs once per column.
  eq("all-numeric strings infer as number", inferValueKind(["1", "2.5", "300"]), "number")
  eq("ISO dates infer as date", inferValueKind(["2026-08-18", "2026-01-09T10:00:00Z"]), "date")
  eq("booleans infer as boolean", inferValueKind([true, false]), "boolean")
  eq("mixed content infers as text", inferValueKind(["1", "abc"]), "text")
  eq("blanks are skipped when inferring", inferValueKind([null, "", "5", "  ", "7"]), "number")
  eq("an all-blank column is text", inferValueKind([null, "", undefined]), "text")
  // A bare year is a number, not a date: Date.parse would happily claim it.
  eq("a plain integer is not mistaken for a date", inferValueKind(["2026", "1999"]), "number")
  eq("codes stay text", inferValueKind(["GRN-001", "GRN-002"]), "text")
}

{
  // First-click direction: text opens A->Z, quantities and dates open at the
  // interesting end. Previously admin screens opened asc and DO/GRN opened desc.
  eq("text opens ascending", defaultDirFor("text"), "asc")
  eq("numbers open descending", defaultDirFor("number"), "desc")
  eq("dates open descending", defaultDirFor("date"), "desc")

  eq(
    "clicking the active column flips it",
    nextSortState({ key: "name", dir: "asc" }, "name", "text").dir,
    "desc"
  )
  eq(
    "clicking a new text column opens ascending",
    nextSortState({ key: "amount", dir: "desc" }, "name", "text").dir,
    "asc"
  )
  eq(
    "clicking a new numeric column opens descending",
    nextSortState({ key: "name", dir: "asc" }, "amount", "number").dir,
    "desc"
  )
  eq(
    "clicking a new column switches the key",
    nextSortState({ key: "name", dir: "asc" }, "amount", "number").key,
    "amount"
  )
}

{
  // makeComparator is what the screens pass to Array#sort directly.
  const cmp = makeComparator((r) => r.v, "number", "desc", (r) => r.id)
  eq("makeComparator applies direction", Math.sign(cmp({ id: 1, v: "5" }, { id: 2, v: "9" })), 1)
  eq("makeComparator keeps blanks last while descending", Math.sign(cmp({ id: 1, v: null }, { id: 2, v: "9" })), 1)
}

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
