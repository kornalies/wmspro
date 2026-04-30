import { APIError } from "@/lib/error-handler"

type ApiEnvelope<T> = {
  success?: boolean
  data?: T
  message?: string
  pagination?: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
  user?: T
  error?:
    | string
    | {
        code?: string
        message?: string
        details?: unknown
      }
}

class APIClient {
  private baseURL = process.env.NEXT_PUBLIC_API_URL || "/api"

  private async request<T>(endpoint: string, options?: RequestInit): Promise<ApiEnvelope<T>> {
    const response = await fetch(`${this.baseURL}${endpoint}`, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    })

    const contentType = response.headers.get("content-type") || ""
    const isJson = contentType.toLowerCase().includes("application/json")

    let body: ApiEnvelope<T>
    if (isJson) {
      body = (await response.json()) as ApiEnvelope<T>
    } else {
      const raw = await response.text()
      const snippet = raw.replace(/\s+/g, " ").slice(0, 180)
      throw new APIError(
        `Expected JSON response but received non-JSON content (${response.status}). ${snippet}`,
        "INVALID_RESPONSE_FORMAT",
        response.status
      )
    }

    if (!response.ok || body.success === false) {
      const message =
        typeof body.error === "string"
          ? body.error
          : body.error?.message || body.message || "Request failed"

      const code =
        typeof body.error === "string"
          ? "API_ERROR"
          : body.error?.code || `HTTP_${response.status}`

      throw new APIError(message, code, response.status, body)
    }

    return body
  }

  get<T>(endpoint: string) {
    return this.request<T>(endpoint)
  }

  post<T>(endpoint: string, data?: unknown) {
    return this.request<T>(endpoint, {
      method: "POST",
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  put<T>(endpoint: string, data?: unknown) {
    return this.request<T>(endpoint, {
      method: "PUT",
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  patch<T>(endpoint: string, data?: unknown) {
    return this.request<T>(endpoint, {
      method: "PATCH",
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  delete<T>(endpoint: string) {
    return this.request<T>(endpoint, { method: "DELETE" })
  }
}

export const apiClient = new APIClient()
