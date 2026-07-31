import type { Metadata } from "next";
import { Inter, Roboto_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { Toaster as ShadcnToaster } from "@/components/ui/toaster";
import { Providers } from "@/app/providers";
import { ErrorBoundary } from "@/components/error-boundary";
import "./globals.css";

/**
 * Document typography (EDDS non-functional requirements). Self-hosted by
 * next/font at build time rather than linked from Google, because proxy.ts sets
 * a strict CSP and a printed document must not depend on a font that failed to
 * fetch. Exposed as CSS variables so components/documents/document-sheet.tsx
 * can reference them without importing anything.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const robotoMono = Roboto_Mono({
  subsets: ["latin"],
  variable: "--font-roboto-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "GWU WMS | GWU Tech",
  description: "GWU Tech supply chain operating system for warehouse execution, 3PL billing, and client portal workflows.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${robotoMono.variable}`}
    >
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
