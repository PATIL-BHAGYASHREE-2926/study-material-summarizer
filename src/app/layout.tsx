import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
    title: "AI Study Material Summarizer",
    description:
        "Upload PDF or PPTX study material and get a structured summary, a conceptual diagram, and a 20-question quiz.",
};

export default function RootLayout({
    children,
}: Readonly<{ children: ReactNode }>) {
    return (
        <html lang="en">
            <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
                {children}
            </body>
        </html>
    );
}