// The messages between the page (kernel/client.js) and the worker (kernel/worker.js, kernel/engine.js).
// Their shapes are specified in docs/SPEC.md, section 6.1. This file holds the names.

export const PROTOCOL = 1;

/** Page to worker: the `type` of each message. */
export const REQ = Object.freeze({ rebuild: 'rebuild', export: 'export', clear: 'clear', debug: 'debug' });

/** Worker to page. */
export const RES = Object.freeze({ ready: 'ready', progress: 'progress', result: 'result', exported: 'exported', fatal: 'fatal' });

/** The chain key before the first feature. */
export const ROOT_KEY = '0';
