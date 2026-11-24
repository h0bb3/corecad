// The two kinds of error that carry a sentence for the user. Everything else is a bug.

/** A feature cannot be built. Thrown by the evaluators, the kernel layer and doc/features.js.
 *  `code` is one of the codes of docs/SPEC.md 6.9; `message` is a full English sentence;
 *  `data` is merged into the feature's FeatureResult (for example { culprits: ['k2'] }). */
export class FeatureError extends Error {
  constructor(code, message, data = {}) {
    super(message);
    this.name = 'FeatureError';
    this.code = code;
    this.data = data;
  }
}

/** A project file cannot be read. `message` is a sentence that names the feature and the field. */
export class DocError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocError';
  }
}
