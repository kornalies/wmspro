import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import { DOForm } from '@/components/do/DOForm'

export default function NewDOPage() {
    return (
        <div className="space-y-6">
            <div className="flex items-center gap-4">
                <Link href="/do">
                    <Button variant="ghost" size="sm">
                        <ArrowLeft className="h-4 w-4 mr-2" />
                        Back to DO List
                    </Button>
                </Link>
                <div>
                    <h1 className="text-3xl font-bold">Create Delivery Order</h1>
                    <p className="text-gray-500 mt-1">Create new outbound delivery request</p>
                </div>
            </div>

            <DOForm />
        </div>
    )
}