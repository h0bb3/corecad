// Reading the QR code of the Connect dialog with a camera of the device this page is on: a headset
// looks at the screen of the computer. The picture never leaves the page: it is looked at here, frame
// by frame, until a code of a CoreCAD tab is in it.
//
// A headset's browser may give a page two kinds of camera: the real ones, and one that shows the
// person's avatar. Only the first can see a screen: next() goes on to the next camera there is.

const CODE = /^[A-Za-z0-9_-]{20,64}$/;

/** The code of a CoreCAD tab in a text: the address of the watching page (…/view.html#code), the address
 *  for an MCP client (…/mcp/code), or the code alone. null when it is none of these. */
export function codeFrom(text) {
  const t = String(text ?? '').trim();
  if (CODE.test(t)) return t;
  let u;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  const hash = decodeURIComponent(u.hash.slice(1));
  if (/\/view\.html$/.test(u.pathname) && CODE.test(hash)) return hash;
  const m = u.pathname.match(/\/mcp\/([^/]+)\/?$/);
  return m && CODE.test(m[1]) ? m[1] : null;
}

let reader = null;
/** What reads a QR code out of a picture: the browser's own detector where it has one, else jsQR from the CDN.
 *  @returns {Promise<(source: HTMLVideoElement | HTMLCanvasElement) => Promise<string | null>>} */
export function qrReader() {
  reader ??= (async () => {
    try {
      if ('BarcodeDetector' in globalThis && (await globalThis.BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
        const detector = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
        return async (source) => (await detector.detect(source))[0]?.rawValue ?? null;
      }
    } catch {
      /* it is there and does not work: the other way */
    }
    const { default: jsQR } = await import('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm');
    const canvas = document.createElement('canvas'),
      g = canvas.getContext('2d', { willReadFrequently: true });
    return async (source) => {
      const w = source.videoWidth || source.width,
        h = source.videoHeight || source.height;
      if (!w || !h) return null;
      // as it is, up to 1600 across: the code is small in what a headset sees
      const k = Math.min(1, 1600 / Math.max(w, h));
      canvas.width = Math.round(w * k);
      canvas.height = Math.round(h * k);
      g.drawImage(source, 0, 0, canvas.width, canvas.height);
      const d = g.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(d.data, d.width, d.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
    };
  })();
  return reader;
}

/** A camera that sees the room, by its name: not the one that shows the person's avatar. */
const REAL = /passthrough|headset|environment|back|rear|world|rgb/i,
  AVATAR = /avatar|virtual|selfie|front|user/i;
const HOW_QUEST =
  ' In a Quest: press the lock at the left of the address bar and allow "Headset cameras" for this site, then try again. If that is not there: Settings, Privacy and safety, App permissions, Headset cameras, on for Browser; and the Browser app has to be version 40.1 or newer.';
/** Why no camera could be had, for the person. listed: the cameras the browser names (it may name none it will not give). */
export function whyNot(error, listed = []) {
  const name = error?.name ?? '',
    seen = listed.length ? ` It lists ${listed.length} camera${listed.length === 1 ? '' : 's'}${listed.some((c) => c.label) ? ': ' + listed.map((c) => c.label || 'unnamed').join(', ') : ''}.` : ' It lists no camera at all.';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The browser did not let this page use a camera.' + HOW_QUEST;
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NoCamera') return `This browser gave the page no camera (${name}).` + seen + HOW_QUEST;
  if (name === 'NotReadableError' || name === 'AbortError') return `The camera could not be opened (${name}): something else may be using it.` + seen;
  return `The camera could not be started: ${error?.message ?? error} (${name || 'no name'}).` + seen;
}

/**
 * Looks through a camera for the code of a CoreCAD tab.
 * @param {object} o
 * @param {HTMLVideoElement} o.video   where the camera's picture is shown, so that the person can aim
 * @param {(code: string) => void} o.found
 * @param {(text: string, kind?: string) => void} o.say   what is going on, for the person
 * @param {MediaDevices} [o.devices]
 */
export function createScanner({ video, found, say, devices = navigator.mediaDevices }) {
  let stream = null,
    timer = 0,
    cameras = [],
    which = 0,
    running = false;
  const stop = () => {
    running = false;
    clearTimeout(timer);
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    video.srcObject = null;
  };
  const listed = async () => (await devices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'videoinput');
  /** A camera, asked for in every way there is: browsers differ in what they refuse. */
  async function ask(deviceId) {
    if (deviceId) return devices.getUserMedia({ audio: false, video: { deviceId: { exact: deviceId }, width: { ideal: 1920 } } });
    let last = null;
    for (const video of [{ facingMode: { ideal: 'environment' }, width: { ideal: 1920 } }, true]) {
      try {
        return await devices.getUserMedia({ audio: false, video });
      } catch (e) {
        last = e;
        if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') throw e; // the person said no: not asked again
      }
    }
    for (const camera of await listed()) {
      if (!camera.deviceId) continue;
      try {
        return await devices.getUserMedia({ audio: false, video: { deviceId: { exact: camera.deviceId } } });
      } catch (e) {
        last = e;
      }
    }
    throw last ?? Object.assign(new Error('no camera'), { name: 'NoCamera' });
  }
  async function open(deviceId) {
    const next = await ask(deviceId);
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = next;
    video.srcObject = stream;
    await video.play().catch(() => {});
    cameras = await listed(); // their names are only told once a camera has been allowed
    const now = stream.getVideoTracks()[0]?.getSettings?.().deviceId;
    which = Math.max(0, cameras.findIndex((c) => c.deviceId === (deviceId ?? now)));
    return cameras[which]?.label || stream.getVideoTracks()[0]?.label || 'the camera';
  }
  /** The camera that sees the room, when the one that was given shows the avatar. */
  async function real(name) {
    const better = cameras.findIndex((c, i) => i !== which && c.deviceId && REAL.test(c.label) && !AVATAR.test(c.label));
    if (better < 0 || (REAL.test(name) && !AVATAR.test(name))) return name;
    try {
      return await open(cameras[better].deviceId);
    } catch {
      return name; // the first one, then: the person can go on to another
    }
  }
  async function look(read) {
    if (!running) return;
    let text = null;
    try {
      if (video.readyState >= 2) text = await read(video);
    } catch {
      /* a frame that could not be read: the next one */
    }
    if (!running) return;
    const code = text && codeFrom(text);
    if (code) {
      stop();
      return found(code);
    }
    if (text) say('That is a code, but not one of a CoreCAD tab. Look at the code in the Connect dialog.', 'bad');
    timer = setTimeout(() => look(read), 180);
  }
  return {
    get running() {
      return running;
    },
    get cameras() {
      return cameras.length;
    },
    /** @returns {Promise<boolean>} whether a camera is looking now */
    async start() {
      if (running) return true;
      if (!devices?.getUserMedia) {
        say(whyNot({ name: 'NoCamera' }), 'bad');
        return false;
      }
      running = true;
      say('Asking for the camera…');
      try {
        const [first, read] = await Promise.all([open(), qrReader()]),
          name = await real(first);
        if (!running) {
          stop();
          return false;
        }
        say(`Looking through ${name}. Look at the code in the Connect dialog of CoreCAD: click the code there to make it big.`);
        look(read);
        return true;
      } catch (e) {
        stop();
        say(whyNot(e, await listed()), 'bad');
        return false;
      }
    },
    /** The next camera of the device: a headset has one that shows an avatar, which sees no screen. */
    async next() {
      if (!running || cameras.length < 2) return;
      try {
        const name = await open(cameras[(which + 1) % cameras.length].deviceId);
        say(`Looking through ${name}.`);
      } catch (e) {
        say(whyNot(e, cameras), 'bad');
      }
    },
    stop,
  };
}
