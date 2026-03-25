"use client"

import type { ComponentProps } from "react"
import { useId, useMemo } from "react"

import { Input } from "@/components/ui/input"

type TypeaheadInputProps = Omit<
  ComponentProps<typeof Input>,
  "value" | "onChange"
> & {
  value: string
  onValueChange: (value: string) => void
  suggestions?: string[]
  maxSuggestions?: number
  listId?: string
}

export function TypeaheadInput({
  value,
  onValueChange,
  suggestions = [],
  maxSuggestions = 50,
  listId,
  ...props
}: TypeaheadInputProps) {
  const generatedId = useId()
  const resolvedListId = listId ?? `typeahead-${generatedId}`

  const normalizedSuggestions = useMemo(() => {
    const seen = new Set<string>()
    const values: string[] = []
    for (const item of suggestions) {
      const text = item.trim()
      if (!text) continue
      const key = text.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      values.push(text)
      if (values.length >= maxSuggestions) break
    }
    return values
  }, [maxSuggestions, suggestions])

  return (
    <>
      <Input
        {...props}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        list={normalizedSuggestions.length > 0 ? resolvedListId : undefined}
        autoComplete="off"
      />
      {normalizedSuggestions.length > 0 && (
        <datalist id={resolvedListId}>
          {normalizedSuggestions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      )}
    </>
  )
}
