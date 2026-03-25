import { NextResponse } from "next/server"

export type ApiSuccess<T> = {
  success: true
  data: T
  message?: string
  pagination?: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export type ApiFailure = {
  success: false
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export function ok<T>(data: T, message?: string, init?: ResponseInit) {
  const body: ApiSuccess<T> = {
    success: true,
    data,
    ...(message ? { message } : {}),
  }
  return NextResponse.json(body, init)
}

export function paginated<T>(
  data: T,
  pagination: ApiSuccess<T>["pagination"],
  init?: ResponseInit
) {
  return NextResponse.json(
    {
      success: true,
      data,
      pagination,
    } satisfies ApiSuccess<T>,
    init
  )
}

export function fail(
  code: string,
  message: string,
  status: number,
  details?: unknown
) {
  const body: ApiFailure = {
    success: false,
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  }
  return NextResponse.json(body, { status })
}
