import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Digolos D.K.K",
  description: "Your personal AI agent",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-white text-gray-900 antialiased">
        {children}
      </body>
    </html>
  );
}
