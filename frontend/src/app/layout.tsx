import type { Metadata } from "next";
import { Instrument_Serif, Inter, Space_Grotesk } from "next/font/google";

import "../styles/globals.css";
import { cn } from "@/lib/utils";
import { AppShell } from "@/components/app-shell";
import { ConsoleErrorFilter } from "@/components/console-error-filter";

const display = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-brand",
});

const body = Inter({
  subsets: ["latin"],
  variable: "--font-body",
});

const grotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-grotesk",
});

export const metadata: Metadata = {
  title: "ProjectFlow",
  description: "面向大学生项目小队的主动推进型 AI Agent",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/brand/projectflow-icon-final-1024.png", sizes: "1024x1024", type: "image/png" },
    ],
    apple: [{ url: "/brand/projectflow-icon-final-1024.png", sizes: "1024x1024", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className={cn("font-sans", display.variable, body.variable, grotesk.variable)}>
      <body>
        <ConsoleErrorFilter />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
