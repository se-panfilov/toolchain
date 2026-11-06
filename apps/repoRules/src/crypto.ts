import sodium from 'libsodium-wrappers';

/**
 * Encrypt a secret value for the GitHub secrets API: a libsodium sealed box with the repository public key.
 * GitHub documents this method. Node.js has no XSalsa20-Poly1305, so the libsodium package does the encryption.
 */
export async function sealSecret(value: string, publicKeyBase64: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  if (key.length !== 32) throw new Error('Некорректный открытый ключ GitHub для секретов.');
  const message = Buffer.from(value, 'utf8');
  try {
    return sodium.to_base64(sodium.crypto_box_seal(message, key), sodium.base64_variants.ORIGINAL);
  } finally {
    message.fill(0);
  }
}
