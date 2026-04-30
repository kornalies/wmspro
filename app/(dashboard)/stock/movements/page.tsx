import MovementHistory from "@/components/stock/MovementHistory";

export default function MovementsPage() {
    return (
        <div className="w-full p-6 space-y-6">
            <div>
                <h1 className="text-3xl font-bold">Put Away Movement Log</h1>
                <p className="mt-1 text-gray-500">Audit trail for bin-to-bin reallocation</p>
            </div>
            <MovementHistory />
        </div>
    );
}
