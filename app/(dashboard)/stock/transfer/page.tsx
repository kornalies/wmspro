import { Suspense } from "react";

import TransferForm from "@/components/stock/TransferForm";

export default function TransferPage() {
    return (
        <div className="container mx-auto p-6 space-y-6">
            <div>
                <h1 className="text-3xl font-bold">Put Away Operation</h1>
                <p className="mt-1 text-gray-500">Reassign received stock between bins</p>
            </div>
            <Suspense fallback={<p className="text-sm text-gray-500">Loading transfer filters...</p>}>
                <TransferForm />
            </Suspense>
        </div>
    );
}
