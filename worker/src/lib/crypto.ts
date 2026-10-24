// AES-GCM encryption for Shopify tokens at rest. Format: base64(iv[12] | ciphertext+tag).

const IV_BYTES = 12;
const keyCache = new Map<string, Promise<CryptoKey>>();

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function getKey(encryptionKey: string): Promise<CryptoKey> {
  let key = keyCache.get(encryptionKey);
  if (!key) {
    const raw = base64ToBytes(encryptionKey);
    if (raw.byteLength !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    key = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyCache.set(encryptionKey, key);
  }
  return key;
}

export async function encryptString(plaintext: string, encryptionKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await getKey(encryptionKey);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_BYTES);
  return bytesToBase64(out);
}

export async function decryptString(encoded: string, encryptionKey: string): Promise<string> {
  const bytes = base64ToBytes(encoded);
  const key = await getKey(encryptionKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) },
    key,
    bytes.slice(IV_BYTES),
  );
  return new TextDecoder().decode(plaintext);
}
