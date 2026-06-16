# Split de Power Tools a repo propio — diseño (2026-06-16)

> **Objetivo.** Separar el código TypeScript de Power Tools / Low-Code (lo que se "pushea desde
> acá" al editor de Steelhead vía `Create*LowCode`) a un **repo git nuevo e independiente**,
> para poder trabajar en paralelo sin chocar con los applets de la extensión (`remote/scripts/*.js`
> + `extension/`). Decisiones cerradas con el usuario 2026-06-16: repo nuevo aparte · cortar de
> verdad (no copia) · preservar historia · respaldar en GitHub para distribuir a otros usuarios.

## Contexto / problema

`SteelheadAutomator` mezcla dos cuerpos de código sin acoplamiento real entre sí:

1. **Applets** de la extensión Chrome — `remote/scripts/*.js` + `extension/`, deploy a `gh-pages`,
   hashes en `remote/config.json`.
2. **Power Tools low-code** — hooks `.ts` que se pegan/pushean al editor de Steelhead; su lógica
   pura vive espejada en helpers `.mjs` con tests `node:test`; el bridge `lowcode_sync.py` hace
   pull/push vía GraphQL. **No tocan `gh-pages` ni `config.json`.**

El único roce es que comparten repo y `CLAUDE.md` (índice + reglas). Dos sesiones de Claude en
paralelo chocan en *hot files* (`CLAUDE.md`, `config.json`, rama `gh-pages`). Verificado:
`grep` sobre `remote/` y `extension/` **no** referencia nada de powertools → corte limpio.

## Repo nuevo

`SteelheadPowerTools/` como hermano de `SteelheadAutomator` y `Reportes SH`:
`/Users/oviazcan/Projects/Ecoplating/SteelheadPowerTools`. Respaldo en GitHub **privado**
(`gh repo create --private`) para invitar colaboradores y distribuir; el push a Steelhead va por
GraphQL, no por GitHub, así que el remoto es solo respaldo/colaboración.

## Manifiesto a mover (verificado)

| Bloque | Origen | Destino en repo nuevo |
|---|---|---|
| Hooks (artefacto) | `powertools/` (`synced/**/*.ts` + `*.meta.json`) | `hooks/` |
| Lógica pura ESM + tests | `tools/{invoice_description,packing_slip_body,packing_slip_weight,pdf_description_fusion,wo_label_consolidation}.{mjs,test.mjs}` | `lib/` |
| Lógica pura CJS + test | `tools/lib/schneider-plants.js`, `tools/test/received-order-plant.test.js` | `lib/` |
| Bridge de sync | `tools/lowcode_sync.py` | `sync/` |
| Docs | `docs/applets/powertools-*.md` (11), specs/plans de `docs/superpowers/` relacionados (remisión-cuerpo-ts, descripción-cfdi ×3, np-facturación, schneider-plant ×2) | `docs/` |

**Por qué impl + tests juntos en `lib/`:** los `.mjs` se importan entre sí con paths relativos
`./` (p.ej. `packing_slip_body.mjs` → `./packing_slip_weight.mjs`; cada test → `./<modulo>.mjs`).
Mantenerlos en el mismo directorio evita reescribir imports. `node --test lib/` corre todo.

## Estructura resultante

```
SteelheadPowerTools/
  hooks/        ← powertools/synced/  (received-order, invoice, pdf, schedule, file-import, inventory-usage)
  lib/          ← *.mjs (impl+test) + schneider-plants.js + received-order-plant.test.js
  sync/         ← lowcode_sync.py
  docs/         ← catalog.md + per-tool + specs/ plans/
  package.json  ← SIN "type":"module" (deja convivir .mjs ESM con .js CJS); "test":"node --test lib/"
  tsconfig.json ← target ES2017 (restricción del editor de Steelhead; lección `??=` = ES2021 rompe)
  CLAUDE.md     ← índice propio + flujo de push + hashes lowcode + dependencia cred Reportes SH
  .gitignore    ← scan_results_*.json, ~$*.xlsm/xlsx, node_modules/
  README.md
```

## Procedimiento

### Fase A — Repo nuevo con historia preservada
1. Clone fresco de `SteelheadAutomator` (rama `main`) a `/tmp/shpt-filter` — **filter-repo nunca
   corre sobre el repo vivo** (es destructivo).
2. `git filter-repo --path <cada path del manifiesto>` (+ `--path-glob 'docs/applets/powertools-*.md'`)
   → repo con solo esos archivos y su historia, paths viejos intactos.
3. `git mv` masivo al layout nuevo + commit `chore: restructura a layout de repo dedicado`.
   (Rename-detection de git deja `log --follow`/blame cruzando el rename — historia legible.)

### Fase B — Scaffolding + fixups
4. `sync/lowcode_sync.py`: `SYNCED_DIR = REPO_ROOT / "hooks"`; ajustar docstrings de paths;
   mantener `REPORTES_SH_SCRIPTS` (sys.path a `Reportes SH/scripts` para `SteelheadClient` —
   dependencia cruzada por cookie/JWT, **no cambia**).
5. `lib/received-order-plant.test.js`: `require('../lib/schneider-plants')` → `require('./schneider-plants')`.
6. Crear `package.json`, `tsconfig.json`, `.gitignore`, `CLAUDE.md`, `README.md`.
7. **Verificar `node --test lib/` pasa** (los ~100 tests existentes) antes de seguir.
8. Mover de `/tmp` a `/Users/oviazcan/Projects/Ecoplating/SteelheadPowerTools`; commit scaffolding.

### Fase C — Respaldo GitHub
9. `gh repo create SteelheadPowerTools --private --source . --remote origin --push`.

### Fase D — Corte en SteelheadAutomator (rama `workbench`)
10. `git rm -r` del manifiesto.
11. `CLAUDE.md`: reemplazar las ~11 filas de Power Tools del índice por **un puntero** al repo
    nuevo; limpiar refs en §"API de Steelhead". Hot file → pasada corta (read→edit→commit).
12. Commit en `workbench`. **No impacta `gh-pages`/usuarios.** El merge a `main` es paso aparte
    que controla el usuario.

## Riesgos / notas

- **Dependencia cruzada `Reportes SH/.env`**: idéntica, solo se documenta en el `CLAUDE.md` nuevo.
- **Hashes lowcode**: hardcodeados en `lowcode_sync.py` → se van con él, no se duplican.
- **Corte aislado**: el `git rm` vive en `workbench`; no llega a `main` ni a usuarios hasta merge.
- **`type:module` evitado a propósito**: `schneider-plants.js`/su test son CommonJS; forzar ESM
  global los rompería. Los `.mjs` son ESM intrínsecamente, así que conviven.
- **tsconfig es para type-check/IntelliSense local + documentar target ES2017**, no un build gate;
  el gate real de lógica son los tests `.mjs`. Tipos ambientales del editor de Steelhead quedan
  como nice-to-have futuro (no bloquea).
