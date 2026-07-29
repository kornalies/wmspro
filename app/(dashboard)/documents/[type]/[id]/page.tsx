"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { ArrowLeft, Loader2, Printer } from "lucide-react"

import api from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DocumentSheet } from "@/components/documents/document-sheet"
import { isDocumentType, type DocumentModel } from "@/lib/documents/types"

/**
 * One page for every document type. The `back` query param lets the caller send
 * the operator back where they came from, since the same document is reachable
 * from the DO screen, the wave screen and the DO list.
 */
export default function DocumentPage() {
  const params = useParams<{ type: string; id: string }>()
  const searchParams = useSearchParams()
  const backHref = searchParams.get("back") || "/do"

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [model, setModel] = useState<DocumentModel | null>(null)

  const load = useCallback(async () => {
    if (!params.type || !params.id) return
    if (!isDocumentType(params.type)) {
      setError(`Unknown document type '${params.type}'`)
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      const response = (await api.get(`/documents/${params.type}/${params.id}`)) as {
        data: DocumentModel
      }
      setModel(response.data)
      setError("")
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load document")
    } finally {
      setLoading(false)
    }
  }, [params.type, params.id])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error || !model) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm">
          <Link href={backHref}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Link>
        </Button>
        <p className="text-sm text-red-600">{error || "Unable to render this document."}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="no-print flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href={backHref}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Link>
        </Button>
        <Button onClick={() => window.print()}>
          <Printer className="mr-2 h-4 w-4" />
          Print
        </Button>
      </div>

      <div className="rounded-md border shadow-sm">
        <DocumentSheet model={model} />
      </div>
    </div>
  )
}