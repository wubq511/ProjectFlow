import type { Metadata } from "next";
import { Inter, Instrument_Serif } from "next/font/google";

import "../styles/globals.css";
import { cn } from "@/lib/utils";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-brand",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ProjectFlow",
  description: "主动推进型项目 Agent — 让项目自己告诉你下一步做什么",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className={cn(inter.variable, instrumentSerif.variable)}
    >
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
