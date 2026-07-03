# hash-autopilot

Job desatendido que valida y regenera los hashes session-sensitive de Steelhead
(los que `validate-hashes.py` no puede validar desde Python porque dan falso-stale
al cliente externo). Ver diseño:
`docs/superpowers/specs/2026-07-03-hash-autopilot-design.md`.

- Correr manual (sin deployar): `npm run dry-run`
- Correr real (auto-deploya si rota): `npm start`
- Resultados de corrida: `tools/.hash-autopilot/YYYY-MM-DD.json`
- Recetas de navegación (mapa op → pantalla): `click-recipes.json`

Auth: inyecta `STEELHEAD_COOKIE_STRING` del `.env` de Reportes SH (nunca se
loguea el valor). Motor: Playwright chromium headless.
