"use client"

import { useMemo, useState } from "react"
import { Edit, Package, Plus, Search } from "lucide-react"

import { useAdminResource, useSaveAdminResource } from "@/hooks/use-admin"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { TypeaheadInput } from "@/components/ui/typeahead-input"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

type ItemRow = {
  id: number
  item_code: string
  item_name: string
  hsn_code?: string
  uom: string
  standard_mrp?: number
  min_stock_alert?: number
  is_active: boolean
}

export default function ItemsPage() {
  const itemsQuery = useAdminResource("items")
  const saveMutation = useSaveAdminResource("items")

  const [search, setSearch] = useState("")
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editItem, setEditItem] = useState<ItemRow | null>(null)
  const [form, setForm] = useState({
    item_code: "",
    item_name: "",
    hsn_code: "",
    uom: "PCS",
    standard_mrp: 0,
    min_stock_alert: 0,
  })

  const items = (itemsQuery.data as ItemRow[] | undefined) ?? []
  const searchSuggestions = useMemo(
    () => items.flatMap((item) => [item.item_code, item.item_name]),
    [items]
  )
  const filtered = items.filter(
    (i) =>
      i.item_name.toLowerCase().includes(search.toLowerCase()) ||
      i.item_code.toLowerCase().includes(search.toLowerCase())
  )

  const openCreate = () => {
    setEditItem(null)
    setForm({ item_code: "", item_name: "", hsn_code: "", uom: "PCS", standard_mrp: 0, min_stock_alert: 0 })
    setIsDialogOpen(true)
  }

  const openEdit = (item: ItemRow) => {
    setEditItem(item)
    setForm({
      item_code: item.item_code,
      item_name: item.item_name,
      hsn_code: item.hsn_code || "",
      uom: item.uom,
      standard_mrp: item.standard_mrp || 0,
      min_stock_alert: item.min_stock_alert || 0,
    })
    setIsDialogOpen(true)
  }

  const handleSave = async () => {
    const payload = editItem ? { id: editItem.id, ...form } : form
    await saveMutation.mutateAsync(payload)
    setIsDialogOpen(false)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Item Master</h1>
          <p className="mt-1 text-gray-500">Manage product catalog</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700" onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" /> Add Item
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{editItem ? "Edit Item" : "Add New Item"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Item Code *</Label>
                  <Input value={form.item_code} onChange={(e) => setForm({ ...form, item_code: e.target.value })} className="uppercase" />
                </div>
                <div className="space-y-2">
                  <Label>UOM *</Label>
                  <Input value={form.uom} onChange={(e) => setForm({ ...form, uom: e.target.value })} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Item Name *</Label>
                <Input value={form.item_name} onChange={(e) => setForm({ ...form, item_name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>HSN Code</Label>
                <Input value={form.hsn_code} onChange={(e) => setForm({ ...form, hsn_code: e.target.value })} className="font-mono" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Standard MRP</Label>
                  <Input type="number" value={form.standard_mrp} onChange={(e) => setForm({ ...form, standard_mrp: Number(e.target.value) })} />
                </div>
                <div className="space-y-2">
                  <Label>Min Stock Alert</Label>
                  <Input type="number" value={form.min_stock_alert} onChange={(e) => setForm({ ...form, min_stock_alert: Number(e.target.value) })} />
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <Button onClick={handleSave} className="flex-1 bg-blue-600">
                  Save Item
                </Button>
                <Button variant="outline" onClick={() => setIsDialogOpen(false)} className="flex-1">
                  Cancel
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
            <TypeaheadInput
              className="pl-9"
              value={search}
              onValueChange={setSearch}
              suggestions={searchSuggestions}
              placeholder="Search items..."
            />
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50">
                <TableHead>Code</TableHead>
                <TableHead>Item Name</TableHead>
                <TableHead>HSN</TableHead>
                <TableHead>UOM</TableHead>
                <TableHead className="text-right">MRP</TableHead>
                <TableHead className="text-right">Min Alert</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-mono font-medium">{item.item_code}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Package className="h-4 w-4 text-gray-400" />
                      <span className="font-medium">{item.item_name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{item.hsn_code}</TableCell>
                  <TableCell>{item.uom}</TableCell>
                  <TableCell className="text-right">{item.standard_mrp ?? 0}</TableCell>
                  <TableCell className="text-right">{item.min_stock_alert ?? 0}</TableCell>
                  <TableCell>
                    <Badge className={item.is_active ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                      {item.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(item)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
