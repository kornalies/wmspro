import { toast } from "sonner"

export class APIError extends Error {
  code: string
  status: number
  details?: unknown

  constructor(message: string, code = "API_ERROR", status = 500, details?: unknown) {
    super(message)
    this.name = "APIError"
    this.code = code
    this.status = status
    this.details = details
  }
}

export function handleError(error: unknown, fallback = "An unexpected error occurred") {
  if (error instanceof APIError) {
    toast.error(error.message)
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[APIError:${error.code}]`, error.details ?? error.message)
    }
    return
  }

  if (error instanceof Error) {
    toast.error(error.message || fallback)
    console.error(error)
    return
  }

  toast.error(fallback)
  console.error(error)
}
