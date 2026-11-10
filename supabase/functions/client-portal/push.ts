// Web push (phone / browser notifications) with nothing but WebCrypto:
// VAPID (RFC 8292) to say it's us, and aes128gcm (RFC 8291) to encrypt the
// message so only that device can read it. Tested against the http_ece
// reference decrypt.

const te = new TextEncoder();
const subtle = crypto.subtle;

export const b64u = {
  enc(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str: string): Uint8Array {
    const s = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const arrs = parts.map((p) => p instanceof Uint8Array ? p : Uint8Array.from(p));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, data as BufferSource));
}

export type VapidKeys = { publicKey: string; privateJwk: JsonWebKey };

export async function makeVapidKeys(): Promise<VapidKeys> {
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  return { publicKey: b64u.enc(raw), privateJwk: await subtle.exportKey("jwk", kp.privateKey) };
}

export async function vapidAuth(endpoint: string, keys: VapidKeys, subject: string): Promise<string> {
  const head = b64u.enc(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u.enc(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto signs as raw r||s, which is what a JWT wants.
  const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64u.enc(sig)}, k=${keys.publicKey}`;
}

// RFC 8291: one record, aes128gcm.
export async function encryptPayload(payload: Uint8Array, p256dh: string, authSecret: string, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array> {
  const uaPub = b64u.dec(p256dh), auth = b64u.dec(authSecret);
  const as = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPub = new Uint8Array(await subtle.exportKey("raw", as.publicKey));
  const uaKey = await subtle.importKey("raw", uaPub as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(auth, shared);
  const ikm = await hmac(prkKey, concat(te.encode("WebPush: info\0"), uaPub, asPub, [1]));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(te.encode("Content-Encoding: aes128gcm\0"), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(te.encode("Content-Encoding: nonce\0"), [1]))).slice(0, 12);
  const key = await subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, concat(payload, [2]) as BufferSource));
  const rs = 4096;
  const header = concat(salt, [(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255], [asPub.length], asPub);
  return concat(header, ct);
}

export type PushSub = { endpoint: string; p256dh: string; auth: string };

// status 201/200 = delivered to the push service; 404/410 = that device has gone.
export async function sendPush(sub: PushSub, message: unknown, keys: VapidKeys, subject: string, ttl = 86400): Promise<{ status: number; gone: boolean; ok: boolean }> {
  const body = await encryptPayload(te.encode(JSON.stringify(message)), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(sub.endpoint, keys, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "high",
    },
    body: body as BodyInit,
  });
  await res.body?.cancel().catch(() => {});
  return { status: res.status, ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410 };
}
