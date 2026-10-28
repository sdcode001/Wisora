import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wisora",
  description: "Smarter purchasing decisions, backed by evidence.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* Browser extensions (e.g. Grammarly) inject body attributes; ignore those. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
