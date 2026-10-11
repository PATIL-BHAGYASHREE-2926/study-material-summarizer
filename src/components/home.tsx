"use client";

import { useCallback, useState } from "react";

import type { SummarizeResponse } from "@/types/summarize-response";

import { ResultsView } from "@/components/results-view";
import { UploadPanel } from "@/components/upload-panel";

/**
 * The application shell: upload, then results.
 *
 * The whole flow is one client component so the request lifecycle - idle,
 * uploading, done, failed - is visible in one place. Everything expensive
 * (extraction, the model call, the Mermaid layer) happens on the server; this
 * component's only job is to post the file, read a typed response, and show it.
 *
 * ## Rendering safety
 *
 * The response is treated as untrusted even though this app produced it: the
 * JSON is parsed and every field is rendered as an escaped React text node, and
 * nothing in the results path uses `dangerouslySetInnerHTML`. The diagram is the
 * one exception path and it is gated separately (see `mermaid-diagram.tsx`).
 */

/** Request lifecycle. Only one of these is active at a time. */
type AppState =
    | { phase: "idle" }
    | { phase: "processing" }
    | { phase: "done"; data: Extract<SummarizeResponse, { ok: true }>["data"] }
    | { phase: "failed"; message: string; retryable: boolean };

/** Parse the response body defensively. */
async function readResponse(response: Response): Promise<SummarizeResponse> {
    try {
        return (await response.json()) as SummarizeResponse;
    } catch {
        // A body that is not JSON means something between here and the route
        // answered instead - a proxy, a platform error page. It is not a
        // document problem and there is nothing to recover from it.
        return {
            ok: false,
            error: {
                code: "INVALID_RESPONSE",
                message: "The server returned an unexpected response. Please try again.",
                retryable: true,
            },
        };
    }
}

export function Home() {
    const [state, setState] = useState<AppState>({ phase: "idle" });
    const [lastFile, setLastFile] = useState<File | null>(null);

    const submit = useCallback(async (file: File) => {
        setLastFile(file);
        setState({ phase: "processing" });

        const body = new FormData();
        body.append("file", file);

        try {
            const response = await fetch("/api/summarize", { method: "POST", body });
            const payload = await readResponse(response);

            setState(
                payload.ok
                    ? { phase: "done", data: payload.data }
                    : {
                          phase: "failed",
                          message: payload.error.message,
                          retryable: payload.error.retryable,
                      },
            );
        } catch {
            // The request never completed, so the file is still in hand and a
            // retry is meaningful.
            setState({
                phase: "failed",
                message:
                    "The upload could not be completed. Check your connection and try again.",
                retryable: true,
            });
        }
    }, []);

    const reset = useCallback(() => {
        setState({ phase: "idle" });
        setLastFile(null);
    }, []);

    const retry = useCallback(() => {
        if (lastFile !== null) void submit(lastFile);
    }, [lastFile, submit]);

    return (
        <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-8 px-6 py-16">
            <header className="flex flex-col gap-3">
                <h1 className="text-3xl font-semibold tracking-tight">
                    AI Study Material Summarizer
                </h1>
                <p className="text-slate-600">
                    Upload a PDF or PPTX file to generate a structured summary, a
                    conceptual Mermaid diagram, and a 20-question quiz with
                    explanations.
                </p>
            </header>

            <UploadPanel
                busy={state.phase === "processing"}
                onFileSelected={submit}
                error={state.phase === "failed" ? state.message : null}
                retryable={state.phase === "failed" ? state.retryable : false}
                onRetry={retry}
                onClear={reset}
            />

            {state.phase === "done" && (
                <ResultsView data={state.data} />
            )}
        </main>
    );
}