/**
 * Minimal RS256 JWT signer for the e2e suite. node:crypto only -- deliberately
 * no jsonwebtoken dependency; the suite must stay offline.
 */
import crypto from 'node:crypto';

export const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

/** The PEM the Vault jwt method is configured with (jwt_validation_pubkeys). */
export const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

/** Sign an RS256 JWT over the given claims with the suite's throwaway key. */
export function signJwt(claims) {
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const signingInput = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`;
    const signature = crypto.sign('sha256', Buffer.from(signingInput), privateKey).toString('base64url');
    return `${signingInput}.${signature}`;
}
