import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "@libitu/ui/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Libitu Stage 1",
  description: "Libitu ingest and blueprint reader"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <ClerkProvider>{children}</ClerkProvider>
      </body>
    </html>
  );
}
