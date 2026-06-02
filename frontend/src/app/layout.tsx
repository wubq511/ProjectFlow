import type { Metadata } from "next";
import { Merriweather, Source_Sans_3, Geist } from "next/font/google";

import "../styles/globals.css";
import { cn } from "@/lib/utils";
import { AppShell } from "@/components/app-shell";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

const display = Merriweather({
  subsets: ["latin"],
  weight: ["700", "900"],
  variable: "--font-display",
});

const body = Source_Sans_3({
  subsets: ["latin"],
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: "ProjectFlow",
  description: "Active project agent workspace for college teams.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className={cn("font-sans", geist.variable)}>
      <body className={`${display.variable} ${body.variable}`}>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
