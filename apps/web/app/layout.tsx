import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "@libitu/ui/tokens.css";
import "./globals.css";
import { PracticePersistence } from "@/features/stage-two/persistence/PracticePersistence";

export const metadata: Metadata = {
  title: "Libitu",
  description: "Turn real English input into speaking practice"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <ClerkProvider><PracticePersistence>{children}</PracticePersistence></ClerkProvider>
      </body>
    </html>
  );
}
