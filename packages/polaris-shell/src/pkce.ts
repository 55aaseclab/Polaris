export type PkceChallenge = {
  method: "S256" | "plain";
  value: string;
};

function base64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) {
    value += String.fromCharCode(byte);
  }
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * `crypto.subtle` is unavailable on plain-http IP origins.
 * Fall back to `plain` PKCE there so Authing sign-in can still start.
 */
export async function createPkceChallenge(
  verifier: string,
  subtle: {
    digest?: ((algorithm: AlgorithmIdentifier, data: BufferSource) => PromiseLike<ArrayBuffer>) | undefined;
  } | null | undefined = globalThis.crypto?.subtle,
): Promise<PkceChallenge> {
  if (typeof subtle?.digest !== "function") {
    return { method: "plain", value: verifier };
  }
  try {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return {
      method: "S256",
      value: base64Url(new Uint8Array(digest)),
    };
  } catch {
    return { method: "plain", value: verifier };
  }
}
