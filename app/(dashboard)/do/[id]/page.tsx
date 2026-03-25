import { redirect } from "next/navigation"

type Params = {
  params: Promise<{ id: string }>
}

export default async function DORefPage({ params }: Params) {
  const { id } = await params
  const doRef = decodeURIComponent(id).trim()
  redirect(`/do/${encodeURIComponent(doRef)}/fulfill`)
}
