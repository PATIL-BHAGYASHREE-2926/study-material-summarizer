"use client";

import { useCallback, useState } from "react";

import { SUPPORTED_FILE_ACCEPT } from "@/lib/constants/limits";
import { sanitizeFileName, validateUploadFile } from "@/lib/validation/upload";

import { Notice } from "./ui";

/**
 * The upload control: drag-and-drop, file picker, and progress.
 *
 * Client-side validation exists only for *feedback*. `validateUploadFile` is the
 * same function the server route calls, so the browser's verdict and the
 * server's verdict cannot disagree - but the browser's answer is never treated
 * as authorisation. The route re-validates the received bytes regardless, which
 * is the check that actually matters, because everything before it is the
 * attacker's own claim.
 */

/** What the picker has accepted so far. */
type SelectedFile = { name: string; sizeBytes: number };

export interface UploadPanelProps {
    /** Disables the control while a request is in flight. */
    busy: boolean;
    /** Called with a validated file to begin processing. */
    onFileSelected: (file: File) => void;
    /** Current error, already reduced to a safe message by the route. */
    error: string | null;
    /** True when the current error is worth retrying. */
    retryable: boolean;
    onRetry: () => void;
    onClear: () => void;
}

/** Human-readable size for the file chip. */
function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function UploadPanel({
    busy,
    onFileSelected,
    error,
    retryable,
    onRetry,
    onClear,
}: UploadPanelProps) {
    const [selected, setSelected] = useState<SelectedFile | null>(null);
    const [localError, setLocalError] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);

    /**
     * Validate a candidate file, then hand it on.
     *
     * Only the first file of a drop is considered: a multi-file drop is a
     * mistake, and silently picking one of twenty uploads would be worse than
     * saying which one was chosen.
     */
    const accept = useCallback(
        async (file: File | undefined) => {
            if (file === undefined) return;

            setLocalError(null);
            const result = await validateUploadFile(file);
            if (!result.ok) {
                setSelected(null);
                setLocalError(result.message);
                return;
            }

            setSelected({ name: sanitizeFileName(file.name), sizeBytes: file.size });
            onFileSelected(file);
        },
        [onFileSelected],
    );

    return (
        <section className="flex flex-col gap-4">
            <div
                role="button"
                tabIndex={0}
                aria-disabled={busy}
                aria-label="Upload a PDF or PPTX file"
                onClick={() => {
                    if (!busy) {
                        document.getElementById("file-input")?.click();
                    }
                }}
                onKeyDown={(event) => {
                    if (busy) return;
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        document.getElementById("file-input")?.click();
                    }
                }}
                onDragOver={(event) => {
                    event.preventDefault();
                    if (!busy) setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    if (busy) return;
                    void accept(event.dataTransfer.files[0]);
                }}
                className={[
                    "rounded-xl border-2 border-dashed p-10 text-center transition",
                    dragging ? "border-slate-500 bg-slate-100" : "border-slate-300 bg-white",
                    busy ? "opacity-60" : "hover:border-slate-400",
                ].join(" ")}
            >
                <p className="text-sm font-medium text-slate-700">
                    Drag a PDF or PPTX here, or click to choose a file
                </p>
                <p className="mt-2 text-sm text-slate-500">
                    Accepted formats: PDF and PPTX. Maximum 50 MB, maximum 100 pages
                    or slides.
                </p>
                <input
                    id="file-input"
                    type="file"
                    accept={SUPPORTED_FILE_ACCEPT}
                    disabled={busy}
                    className="sr-only"
                    onChange={(event) => {
                        void accept(event.target.files?.[0]);
                    }}
                />
            </div>

            {selected !== null && (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
                    <span className="text-sm font-medium text-slate-800">
                        {selected.name}
                    </span>
                    <span className="text-sm text-slate-500">
                        {formatSize(selected.sizeBytes)}
                    </span>
                    {!busy && (
                        <button
                            type="button"
                            onClick={() => {
                                setSelected(null);
                                onClear();
                            }}
                            className="ml-auto text-sm text-slate-500 underline"
                        >
                            Remove
                        </button>
                    )}
                </div>
            )}

            {busy && (
                <p role="status" className="text-sm text-slate-600">
                    Extracting text, then generating the summary, diagram and quiz.
                    Large documents can take up to a minute.
                </p>
            )}

            {(localError ?? error) !== null && (
                <div className="flex flex-col gap-3">
                    <Notice>{localError ?? error}</Notice>
                    <div className="flex gap-3">
                        {error !== null && localError === null && retryable && (
                            <button
                                type="button"
                                onClick={onRetry}
                                disabled={busy}
                                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
                            >
                                Try again
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => {
                                setSelected(null);
                                setLocalError(null);
                                onClear();
                            }}
                            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                        >
                            Choose a different file
                        </button>
                    </div>
                </div>
            )}
        </section>
    );
}