import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "deepsec Runner — Continuous security reviews",
  description:
    "Durable, isolated deepsec reviews for GitHub repositories, powered by Vercel Workflow and Sandbox.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
