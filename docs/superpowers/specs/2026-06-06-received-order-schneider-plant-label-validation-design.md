# Validación de etiqueta de planta Schneider vs dirección de entrega (`received-order.ts`)

**Fecha:** 2026-06-06
**Applet/archivo:** Power Tool `received-order` (`powertools/synced/received-order/received-order.ts`), hook `getReceivedOrderCustomization`
**Estado:** Diseño aprobado (pendiente de plan de implementación)

## Problema

Al agregar números de parte (NP) a una OV/OT de Schneider, cada NP debe estar etiquetado con
el **código de la planta** a la que pertenece (etiqueta `SXX`). Esa planta tiene que **coincidir
con la dirección de entrega (`shipToAddress`) de la OV**. Hoy nada valida esto: un NP de Querétaro
podría agregarse a una OV que entrega en Tlaxcala sin que el sistema avise, mandando la pieza a la
planta equivocada.

Mapeo de códigos de etiqueta → planta (7 plantas Schneider):

| Código | Planta | Razón social | Identifier en Steelhead | Substrings discriminantes en `shipToAddress.address` |
|---|---|---|---|---|
| `STX` | Tlaxcala | USA INC | Planta Tlaxcala | `acuamanala`, `santa ana`, `90860` |
| `SXC` | Xicohténcatl | USA INC | Planta Xicohténcatl | `ocotitla`, `90434` |
| `SMY` | Monterrey | USA INC | Planta Monterrey | `apodaca`, `escobedo 317`, `66627` |
| `SQ1` | Querétaro 1 | USA INC | Planta Querétaro | `vesta`, `vpq07`, `76294` |
| `SQ2` | Querétaro 2 | USA INC | Planta 2 Querétaro | `parque industrial aeropuerto`, `lote 56`, `76295` |
| `SCM` | CDMX | MEXICO | Planta CDMX | `michoacán 20`/`michoacan 20`, `complejo industrial tecnológico`, `09208` |
| `SRG` | Rojo Gómez | MEXICO | Planta Rojo Gómez | `rojo gómez`/`rojo gomez`, `09300` |

Notas de datos (de las capturas de Steelhead, 2026-06-06):
- `SQR` fue renombrada a `SQ1` por solicitud del equipo; `SQR` ya se erradicó del repo. **No** se usa
  alias `SQR` en el código. Escape hatch documentado: si aparecieran NPs rezagados con etiqueta `SQR`
  (rename no in-place), se verían como "etiqueta equivocada"; en ese caso reañadir `SQR` como alias de `SQ1`.
- Dos direcciones NO son plantas y nunca deben resolver: *Dirección Fiscal* (5914 San Bernardo, Laredo,
  Texas — solo billing) y *Dirección Fiscal Tlaxcala* (1415 S. Roselle Road, Palatine, **Illinois** — el
  identifier dice "Tlaxcala" pero es de EUA). Los substrings elegidos las esquivan (STX usa
  `acuamanala`/`90860`, no "Tlaxcala" suelto).
- "Querétaro" sale en 2 plantas: se distingue SQ1 por `vesta` y SQ2 por `aeropuerto`/`lote 56`.
- La razón social (MEXICO = {SRG, SCM}; USA INC = el resto) queda cubierta por el `customerName.includes("schneider")`
  que el hook ya usa; la planta se resuelve **solo** del `shipToAddress`, así que no hace falta lógica extra de razón social.

## Restricciones del vehículo (Power Tool hook)

- El hook `getReceivedOrderCustomization` es **advisory**: emite chips vía `helpers.addErrorMessage`
  (`severity: error|warning|info|success`), **no puede bloquear el Save por API**. El patrón existente
  "NP Desconocido" usa `severity:'error'` para instruir al operador a cancelar. La nueva validación
  encaja igual: chip rojo que indica no agregar el NP.
- El runtime transpila a target legacy: **no usar** `??=` ni features ES2021+. Usar
  `result.workOrderLabels!.push(...)` (non-null assertion ES2017-safe).
- El `result` **debe** traer las 6 keys del `LowCodeResult` (arrays vacíos OK); si se omiten, el frontend
  descarta silenciosamente todos los `addErrorMessage`. (Ya está garantizado en el archivo actual.)
- Lectura de etiquetas del NP: `partNumber.partNumberLabels` → `{ id, name, color }[]`. El `name` es el
  código exacto de 3 letras (confirmado en tests del archiver y `config.json`). **Riesgo a verificar
  (Phase-0):** la bitácora 2026-05-15 confirmó que `partNumberLabels` no es *escribible*; falta confirmar
  que el runtime sí lo *puebla* como input en el flujo "Add Parts to Sales Order".

## Diseño

### Constantes (junto a `LOTE_UNIT_ID`, dentro del hook)

```ts
const SCHNEIDER_PLANTS: { code: string; name: string; needles: string[] }[] = [
  { code: "STX", name: "Tlaxcala",     needles: ["acuamanala", "santa ana", "90860"] },
  { code: "SXC", name: "Xicohténcatl", needles: ["ocotitla", "90434"] },
  { code: "SMY", name: "Monterrey",    needles: ["apodaca", "escobedo 317", "66627"] },
  { code: "SQ1", name: "Querétaro 1",  needles: ["vesta", "vpq07", "76294"] },
  { code: "SQ2", name: "Querétaro 2",  needles: ["parque industrial aeropuerto", "lote 56", "76295"] },
  { code: "SCM", name: "CDMX",         needles: ["michoacán 20", "michoacan 20", "complejo industrial tecnológico", "09208"] },
  { code: "SRG", name: "Rojo Gómez",   needles: ["rojo gómez", "rojo gomez", "09300"] },
];
const SCHNEIDER_PLANT_CODES = new Set(SCHNEIDER_PLANTS.map((p) => p.code));
```

### Resolución de planta de la OV (una vez, antes/junto al gating existente)

- Reusar `isSchneider = customerName.includes("schneider")` (ya existe vía `customerName`).
- `shipToLower` ya existe (`shipToAddr`). Resolver:
  `expectedPlant = SCHNEIDER_PLANTS.find((p) => p.needles.some((n) => shipToLower.includes(n))) ?? null`.

### Lógica por NP (dentro del loop existente, dedup por `partNumber.id` con un `Set` nuevo)

Solo si `isSchneider`:
1. **Ship-to no resoluble** (`expectedPlant == null`): marcar bandera `shipToPlantUnresolved = true`
   (OV-level) y **no** validar etiquetas de NPs (no hay contra qué comparar).
2. Si `expectedPlant != null`, por cada NP (dedup):
   - `partPlantLabels = (partNumber.partNumberLabels ?? []).map((l) => l.name).filter((n) => SCHNEIDER_PLANT_CODES.has(n))`
   - **Sin ninguna etiqueta de planta** (`partPlantLabels.length === 0`) → `plantMissingChips.push('PN')`.
   - **Tiene etiqueta(s) pero ninguna === `expectedPlant.code`** → `plantMismatchChips.push("'PN' [SXX...]")`
     (incluye los códigos que sí trae, para que el operador vea a qué planta pertenece).
   - **Alguna coincide** → OK. (Cubre NPs multi-planta: pasa si la planta esperada está entre sus etiquetas.)

### Emisión (respeta el patrón de buckets consolidados)

- Si `shipToPlantUnresolved`: un `addErrorMessage({severity:'error'})` OV-level:
  `Planta Schneider no identificada — el ship-to «{address}» no corresponde a ninguna de las 7 plantas
  (STX/SXC/SMY/SQ1/SQ2/SCM/SRG). Corrige la dirección de entrega de la OV; no validé etiquetas de planta.`
- Si no, y hay `plantMissingChips`/`plantMismatchChips`: un `addErrorMessage({severity:'error'})`:
  `Etiqueta de planta ≠ ship-to ({expectedPlant.code} {expectedPlant.name}) — `
  + `Sin etiqueta de planta: 'A', 'B'. ` (si aplica)
  + `Etiqueta equivocada: 'C' [STX], 'D' [SMY]. ` (si aplica)
  + `No agregues estos NP a la OV/OT hasta corregir su etiqueta de planta SXX.`
- Estos chips de planta van en **su propio** `addErrorMessage`, separados del de "NP Desconocido"
  (son conceptos distintos; el UI apila una row por llamada).

### Supresión del "Todo en Orden"

Agregar las condiciones nuevas a la guarda del chip verde, junto a las existentes
(`errorChips`, `sinPrecioChips`, `schneiderChips`):

```ts
plantMissingChips.length === 0 &&
plantMismatchChips.length === 0 &&
!shipToPlantUnresolved
```

## Decisiones (confirmadas con el usuario)

- Etiqueta Querétaro 1 = `SQ1` (canónica; `SQR` erradicada).
- Severidad: ambos fallos (sin etiqueta / no coincide) = **error rojo** (bloqueante a nivel operador).
- Ship-to no resoluble a planta conocida = **error rojo**.

## Edge cases

- `partNumberLabels` ausente/`null` → cuenta como "sin etiqueta de planta".
- NPs `one-off` (`isOneOffPartNumber`): **también se validan** por default (un one-off a planta Schneider
  igual debería etiquetarse). *Abierto a vetar si genera ruido.*
- NP con varias etiquetas de planta (multi-planta): pasa si la esperada está entre ellas.
- Direcciones trampa fiscales → caen en "no resoluble" (error), que es lo correcto.

## Plan de pruebas

- **Phase-0 (Steelhead Test panel, crítica):** dumpear `partNumber.partNumberLabels` con un
  `addErrorMessage` temporal (`severity:'info'`) para confirmar que el runtime lo puebla en
  "Add Parts to Sales Order". Si viniera vacío, este hook **no** es el vehículo y habría que mover la
  validación a un applet de extensión con GraphQL.
- **Test node** (`tools/test/received-order-plant.test.js`, espejo de la lógica pura): tabla de verdad
  — cada una de las 7 direcciones reales resuelve a su planta y **solo** a ella; las 2 trampas → `null`;
  casos label match / mismatch / missing / multi-planta. Patrón igual a `tools/test/*.test.js`
  (`node --test`).
- Verificación manual en Steelhead con OVs reales de ≥2 plantas distintas.

## Deploy

- Power Tool = pegar el `.ts` en el editor low-code de Steelhead (no toca `config.json` ni `gh-pages`).
- El espejo del repo `powertools/synced/received-order/received-order.ts` se actualiza por git.

## No-objetivos (YAGNI)

- No validar razón social vs planta (ya lo enforza el address-picker de Steelhead).
- No escribir/auto-asignar la etiqueta de planta al NP (canal no existe en `LowCodeResult`; lo hace el
  operador, guiado por el chip).
- No fase 2 del archiver ni otros applets.
