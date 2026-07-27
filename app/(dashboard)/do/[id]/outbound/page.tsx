import OutboundTail from "@/components/do/OutboundTail"

export default async function DOOutboundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const doRef = decodeURIComponent(id).trim()

  return (
    <div className="container mx-auto space-y-6 p-6">
      <h1 className="text-3xl font-bold">Outbound {doRef}</h1>
      <OutboundTail doRef={doRef} />
    </div>
  )
}