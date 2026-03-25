import { NextRequest } from "next/server"

import { POST as dispatchPOST } from "@/app/api/do/[id]/dispatch/route"

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  return dispatchPOST(request, context)
}
