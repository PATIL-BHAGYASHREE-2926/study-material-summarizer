"use client";

import type { ReactNode } from "react";

/**
 * Shared visual primitives.
 *
 * Extracted so the summary, diagram and quiz views present themselves
 * consistently without each of them restating a rounded box. Presentation only:
 * there is no state and no data handling here, which keeps it usable from both
 * server and client components.
 */

export function Card({
    children,
    className = "",
}: {
    children: ReactNode;
    className?: string;
}) {
    return (
        <section
            className={`rounded-xl border border-slate-200 bg-white p-6 shadow-sm ${className}`}
        >
            {children}
        </section>
    );
}

export function SectionHeading({
    title,
    hint,
}: {
    title: string;
    hint?: string;
}) {
    return (
        <header className="mb-4 flex flex-col gap-1">
            <h2 className="text-lg font-semibold tracking-tight text-slate-900">
                {title}
            </h2>
            {hint !== undefined && (
                <p className="text-sm text-slate-500">{hint}</p>
            )}
        </header>
    );
}

/** Small status pill, used for the unit count and the diagram source. */
export function Badge({ children }: { children: ReactNode }) {
    return (
        <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
            {children}
        </span>
    );
}

/**
 * Inline note used for non-fatal problems, such as a replaced diagram.
 *
 * `role="status"` so a screen reader announces it once it appears, which a plain
 * paragraph would not.
 */
export function Notice({ children }: { children: ReactNode }) {
    return (
        <p
            role="status"
            className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
            {children}
        </p>
    );
}