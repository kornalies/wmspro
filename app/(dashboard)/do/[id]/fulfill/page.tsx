import DOFulfillment from "@/components/do/DOFulfillment";
import FIFOPicker from "@/components/do/FIFOPicker";

export default async function DOFulfillPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const doRef = decodeURIComponent(id).trim()

    return (
        <div className="container mx-auto p-6 space-y-6">
            <h1 className="text-3xl font-bold">Fulfill Delivery Order {doRef}</h1>

            <div className="grid gap-6">
                <FIFOPicker doId={doRef} />
                <DOFulfillment doId={doRef} />
            </div>
        </div>
    );
}
