// Génère un secret TOTP pour ADMIN_TOTP_SECRET et l'URL à importer dans une application d'authentification.
import { randomBytes } from 'node:crypto';
import { base32Encode } from '../auth.js';

const secret = base32Encode(randomBytes(20));
const user = process.env.ADMIN_USER ?? 'admin';
console.log(`ADMIN_TOTP_SECRET=${secret}`);
console.log(`otpauth://totp/EzMon:${encodeURIComponent(user)}?secret=${secret}&issuer=EzMon`);
console.log("Ajoutez la clé dans votre application d'authentification (saisie manuelle ou QR code depuis l'URL).");
