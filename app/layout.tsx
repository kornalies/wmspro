import type { Metadata } from "next";
import { Toaster } from "sonner";
import { Toaster as ShadcnToaster } from "@/components/ui/toaster";
import { Providers } from "@/app/providers";
import { ErrorBoundary } from "@/components/error-boundary";
import "./globals.css";

export const metadata: Metadata = {
  title: "WMS Pro",
  description: "Warehouse Management System",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <Providers>
          <ErrorBoundary>{children}</ErrorBoundary>
          <Toaster richColors />
          <ShadcnToaster />
        </Providers>
      </body>
    </html>
  );
}
