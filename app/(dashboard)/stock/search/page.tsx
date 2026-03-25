import { StockSearch } from '@/components/stock/StockSearch'

export default function StockSearchPage() {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold">Stock Search</h1>
                <p className="text-gray-500 mt-1">Search and filter inventory</p>
            </div>
            <StockSearch />
        </div>
    )
}