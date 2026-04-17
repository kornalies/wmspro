"use client"

import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Loader2 } from "lucide-react"

import { useLogin } from "@/hooks/use-auth"
import { handleError } from "@/lib/error-handler"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const schema = z.object({
  company_code: z.string().min(1, "Company code is required"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
})

type FormValues = z.infer<typeof schema>

export default function LoginPage() {
  const router = useRouter()
  const loginMutation = useLogin()

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      company_code: "",
      username: "",
      password: "",
    },
  })

  const onSubmit = async (values: FormValues) => {
    try {
      const loginResult = await loginMutation.mutateAsync(values)
      const nextParam =
        typeof window !== "undefined"
          ? String(new URLSearchParams(window.location.search).get("next") || "")
          : ""
      const user = loginResult?.data
      const role = String(user?.role || "").toUpperCase()
      const isPortalOnlyRole =
        role === "CLIENT" ||
        role === "VIEWER" ||
        role === "CUSTOMER" ||
        role === "CLIENT_USER" ||
        role === "READONLY" ||
        role === "READ_ONLY"
      const defaultRoute = isPortalOnlyRole ? "/portal" : "/dashboard"
      const safeNext =
        nextParam.startsWith("/") && !nextParam.startsWith("//") && !nextParam.startsWith("/login")
          ? nextParam
          : defaultRoute
      router.push(safeNext)
    } catch (error) {
      handleError(error, "Login failed")
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-600 via-purple-600 to-pink-600 p-4">
      <Card className="w-full max-w-md shadow-2xl">
        <CardHeader className="space-y-3 pb-6 text-center">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg">
            <span className="text-4xl font-bold text-white">W</span>
          </div>
          <CardTitle className="text-3xl font-bold">WMS Pro</CardTitle>
          <p className="text-gray-500">GWU Software Solutions</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">Company Code</label>
              <Input type="text" className="h-12" {...register("company_code")} />
              {errors.company_code && (
                <p className="text-sm text-red-600">{errors.company_code.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">Username</label>
              <Input type="text" className="h-12" {...register("username")} />
              {errors.username && <p className="text-sm text-red-600">{errors.username.message}</p>}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">Password</label>
              <Input type="password" className="h-12" {...register("password")} />
              {errors.password && <p className="text-sm text-red-600">{errors.password.message}</p>}
            </div>

            <Button
              type="submit"
              className="h-12 w-full bg-gradient-to-r from-blue-600 to-purple-600 text-lg font-medium hover:from-blue-700 hover:to-purple-700"
              disabled={loginMutation.isPending}
            >
              {loginMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Logging in...
                </>
              ) : (
                "Login"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
