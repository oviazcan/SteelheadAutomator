// extension/integrity-pubkey.js
// Llave pública ECDSA P-256 (SPKI base64) para verificar config.sig.
// Pública real de KMS (proyecto steelhead-ecoplating, keyRing steelhead-automator,
// key config-signing v1, EC_SIGN_P256_SHA256). Fase 2: la verificación fail-closed queda
// ACTIVA para quien instale este zip; config.sig ya vive en gh-pages (Fase 1, verificado).
self.SA_INTEGRITY_PUBKEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEhoH81jmmh5d0Lg+GBmqlMMm39gLEyMJDRX+fKcGYNfsg/Uc9uUT9ri+CK/7aKF0gt9MPKqj/yH6Y4P6XGqFayw==';
