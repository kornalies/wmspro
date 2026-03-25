import { redirect } from "next/navigation"

export default function WorkflowPoliciesRedirectPage() {
  redirect("/admin/tenant-settings")
}

