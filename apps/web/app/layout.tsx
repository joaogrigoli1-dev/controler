import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Controler — NOC",
  description: "Network Operations Center — gestão de toda a infraestrutura SRV1",
  icons: { icon: "/favicon.ico" }
};

export const viewport: Viewport = {
  themeColor: "#05060d",
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className="dark">
      <head>
        {/* dark-v2 v4: Inter (UI) + JetBrains Mono (dados) — Clash Display/Plus Jakarta removidos */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;650;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="relative" style={{ ["--font-body" as string]: "'Inter'", ["--font-mono" as string]: "'JetBrains Mono'" }}>
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
