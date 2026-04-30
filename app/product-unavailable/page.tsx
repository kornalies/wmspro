import Link from "next/link"

export default function ProductUnavailablePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-semibold text-slate-900">Product Not Enabled</h1>
      <p className="mt-3 text-sm text-slate-600">
        Your tenant does not currently have access to this product. Contact your GWU account team
        to enable WMS, Freight Forwarding, or the combined bundle.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/dashboard"
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          Try Dashboard
        </Link>
        <Link
          href="/login"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Login Again
        </Link>
      </div>
    </main>
  )
}
