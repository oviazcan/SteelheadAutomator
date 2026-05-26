# Power Tools `importFile` — CSV de cotizaciones v7.1 (`file-import/QUOTE_IMPORT.ts`)

Hook low-code de la categoría **file-import** con discriminador `fileImportType = QUOTE_IMPORT`. Convierte un CSV pegado al wizard de "Importar Cotización" en `Quote[]` que Steelhead crea como cotización con líneas + posibles PNs nuevos.

## Lo que hace

1. Lee `inputs.fileContents` (string CSV) y lo arregla si vino doble-decodificado (UTF-8 leído como Latin-1).
2. Parser custom (`CSVtoArray`) tolerante a comillas y a separador `;` vs `,` (auto-normaliza si gana `;`).
3. Detecta header keys (bilingüe ES/EN) y data rows por contenido (col A numérico + col B no vacío). NO depende de "Parts List" header ni de `skipRows`.
4. Construye `partLines[]` con `newPartNumber` siempre presente; agrega `uuid` solo cuando hace falta para evitar colisión con PN existente del mismo cliente.
5. Regresa `[{name, customerId, partLines}]` (array de una sola cotización).

## Header keys aceptadas (bilingüe)

| Key (col A, case-insensitive) | Setea | Notas |
|---|---|---|
| `quote name:` / `nombre cotización:` / `nombre cotizacion:` | `quoteName` | Fallback al `inputs.fileName` sin extensión. |
| `customer:` / `cliente:` | `customerName` | Tolera sufijos tipo `"ACME — Planta MTY"`: corta en `—` o `" — "`. |
| `customer idindomain:` | `customerIdInDomainDirect` | Prioritario sobre lookup por nombre. |
| `process (default):` / `proceso (default):` | `defaultProcessName` | Aplica a líneas que no especifiquen proceso. |
| `process id (default):` / `id proceso (default):` | `defaultProcessId` | Prioritario sobre lookup por nombre. |

Valor leído de col C, fallback a col B (algunas plantillas dejan vacía la col B y ponen el valor en C).

## Data row (columnas)

| Idx | Campo | Uso |
|---|---|---|
| 0 | qty | `microQuantity = qty * 1e6` |
| 1 | name (del PN) | Llave para detectar nuevo vs existente |
| 2 | price | `priceMicrodollars = price * 1e6` |
| 3 | description | `descriptionMarkdown` del PN nuevo + `description` de la línea |
| 4 | processNameLine | Override de proceso por línea |
| 5 | processIdLine | Override de proceso por línea (prioritario sobre name) |

`toNumber` tolera `1.000,50` (eu) y `1,000.50` (us) — quita espacios, si hay solo coma la trata como decimal, si hay coma + punto quita las comas (miles).

## UTF-8 fix loop

Steelhead a veces lee CSV UTF-8 como Latin-1, dejando bytes `0xC3 0xA9` visibles como `Ã©`. Si el contents contiene `Ã` aplica un re-decode manual de 2 bytes:

- `0xC3 0x80-0xBF` → `((c & 0x1F) << 6) | (n & 0x3F)` (mayoría de acentos)
- `0xC2 0x80-0xBF` → `n` (símbolos sueltos)
- `0xC5 0x80-0xBF` → mismo bit pattern que `0xC3` (cubre `Š`, `Œ`, etc.)

Log `[encoding] UTF-8→Latin-1 fix aplicado` para confirmar que entró el branch.

## `uuid` para PN colisionando

Si el PN ya existe en el dominio con el mismo `customerId` pero **otro proceso default**, agrega `uuid: makeUuid()` al `newPartNumber` para que Steelhead lo cree como PN nuevo (no merge con el existente). Sin esto, Steelhead haría match por name+customer y la línea quedaría apuntando al PN viejo con proceso ajeno.

## Decisiones intencionales

| Aspecto | Decisión | Razón |
|---|---|---|
| Customer no encontrado | `throw Error(...)` con muestra de 20 customers del dominio | El operador necesita ver candidatos para corregir el CSV. |
| Process no encontrado | NO truena. Si no hay process default ni line process, usa `usePartNumberProcessDefaults: true` | Permite cotizar PNs sin proceso explícito (Steelhead pone el suyo después). |
| `partLines[]` SIEMPRE incluye `newPartNumber` | Aunque el PN ya exista | Steelhead resuelve el match por (`name + customerId`); si existe lo reutiliza, si no lo crea. |
| Detección de "existing" | `existingNames` set normalizado (`NFD` + sin acentos + lowercase) | Tolera variantes ortográficas del operador. |

## Plan de validación pendiente

1. CSV con header `Nombre Cotización:` + algunas líneas con `Proceso (default):` cobertura ES.
2. CSV con encoding latino-incorrecto: que el log `[encoding]` aparezca y los acentos se vean bien en el preview.
3. CSV con PN existente + proceso distinto: confirmar que se crea PN nuevo con UUID.
4. CSV con separador `;`: confirmar que se normaliza a `,`.

## Oportunidades

- Reportar al UI las primeras 5 keys ignoradas con `helpers.addErrorMessage({severity:'info', ...})` para ayudar a debug de plantillas mal formadas (actualmente solo `helpers.log`, que no siempre se ve en el panel).
- Soportar header `descripción:`/`description:` para incluir descripciones de la cotización (hoy se pierde si está fuera del data row).
