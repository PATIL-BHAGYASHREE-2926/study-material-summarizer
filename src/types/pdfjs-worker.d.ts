/**
 * Ambient types for the pdf.js worker bundle.
 *
 * `pdfjs-dist` ships declarations for the api entry point (`pdf.d.mts`) but
 * none for `pdf.worker.mjs`, which is imported only for its side effect of
 * registering itself on `globalThis.pdfjsWorker`. Declaring the module here -
 * rather than casting at every use - keeps that import type-safe and lets the
 * resolution follow the same specifier the bundler resolves.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
    /**
     * pdf.js wires this into the loading task. The app never calls it, so it is
     * typed as opaque rather than mirrored from pdf.js's internal API.
     */
    export const WorkerMessageHandler: unknown;
}