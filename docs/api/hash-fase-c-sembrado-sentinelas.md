# Runbook — Sembrado de centinelas (hash-autopilot v2, Fase C)

**Qué es:** un **centinela** es un objeto canario en el ERP, marcado inequívocamente, que el autopilot puede **desarchivar → mutar → capturar el hash → re-archivar** para regenerar el hash de una mutation rotada, **sin tocar datos reales**. Este runbook explica cómo sembrarlos con seguridad.

> ⚠️ **Por qué importa la precisión:** el ciclo corre **desatendido en producción**. Si un centinela se confunde con un objeto real, el autopilot mutaría datos productivos. Las salvaguardas de código (`isSentinel` fail-closed, blast-radius, journal) son la última línea; **el sembrado correcto es la primera**.

## Principios de seguridad (no negociables)

1. **Nunca uses un objeto real.** Crea uno **nuevo** dedicado, que no participe en ninguna operación.
2. **Marca inequívoca:** el objeto debe llevar el literal `__SA_SENTINEL__` en su **nombre** (o `displayName`, `tags`, o un `customInput`). `isSentinel()` (en `sentinels.mjs`) exige esa marca — sin ella, el runner **se rehúsa a mutar** (fail-closed).
3. **Uno por tipo de entidad.** El blast-radius del ciclo es ≤1; no siembres varios del mismo tipo.
4. **En reposo = archivado.** El estado base del centinela es `archived`. El ciclo lo desarchiva, muta y re-archiva; entre corridas siempre debe quedar archivado.
5. **Sin dependencias.** El centinela no debe estar ligado a otras entidades (una OV centinela sin partes reales, un PN centinela sin inventario, etc.) para que archivar/mutar no arrastre efectos.
6. **Solo mutations reversibles.** Fase C v1 cubre `Save*/Update*/Archive*/Set*/Create*/Add*` (estrategia *archived-mutate-restore*). Las **destructivas** (`Delete*/Remove*`) **escalan** — NO se siembra centinela para ellas (no hay forma segura de re-archivar algo borrado).

## Procedimiento por entidad

Para cada `entityType` que quieras cubrir:

1. **Identifica la entidad y una mutation reversible que la toque.**
   Ej.: entidad `ReceivedOrder` ← mutation `SaveReceivedOrderLinesAndItems`.
2. **Crea el objeto canario en el ERP** con la marca en el nombre:
   ```
   Nombre: ZZZ __SA_SENTINEL__ no-tocar (hash-autopilot)
   ```
   El prefijo `ZZZ` lo manda al fondo de los listados; el texto deja claro que no se toca.
3. **Déjalo archivado** (estado base).
4. **Regístralo en `tools/hash-autopilot/sentinels-config.json`:**
   ```json
   {
     "entities": {
       "ReceivedOrder": {
         "id": "<idInDomain-o-nano-del-centinela>",
         "marker": "__SA_SENTINEL__",
         "baseState": "archived",
         "module": "ReceivedOrders"
       }
     }
   }
   ```
5. **Verifica identidad** — carga el objeto por su id y confirma que `isSentinel` da `true`:
   ```bash
   node -e "import('./tools/hash-autopilot/sentinels.mjs').then(m => \
     console.log('isSentinel:', m.isSentinel({ name: 'ZZZ __SA_SENTINEL__ no-tocar' })))"
   # → isSentinel: true
   ```
   (En integración real, `loadObject` trae el objeto del ERP y se corre el mismo check antes de mutar.)

## Qué entidades sembrar primero

Prioriza por las mutations que **rotan más** o cuyos applets son críticos. Para saber qué `entityType` corresponde a cada mutation del `config.steelhead.hashes.mutations`, se hace el mapeo `mutation → entidad → pantalla` en la integración (Task 7) o como análisis previo (Claude puede extraer las 69 mutations y proponer el agrupamiento por entidad). Candidatas típicas: `ReceivedOrder`, `PartNumber`, `Quote`, `WorkOrder`, `InventoryBatch`, `Spec`, `MaintenanceEvent`.

> No hace falta sembrar las 69 de golpe. Empieza por 3-5 entidades de alto impacto; las demás **escalan** por correo hasta tener centinela (comportamiento seguro por defecto).

## Verificación post-sembrado

- `sentinels-config.json` parsea y cada entrada tiene `id/marker/baseState/module`.
- Cada objeto centinela existe, está **archivado**, y `isSentinel` da `true`.
- Corrida en seco del motor: con centinela declarado, la mutation correspondiente pasa de `escalate` a `run` en el plan (sin ejecutar aún).

## Mantenimiento

- **Tras cada corrida real**, confirma que el centinela quedó **archivado** (el ciclo lo re-archiva; la verificación post-ciclo alerta si no).
- Si el journal (`tools/.hash-autopilot/sentinel-journal.json`) muestra una entrada `dirty` persistente, hubo un ciclo interrumpido: el siguiente run **repara** primero (desarchiva/re-archiva) antes de nada. Si no se auto-repara, revisa el objeto a mano.
- Si Steelhead cambia el flujo de una pantalla de mutación, el helper DOM (`doMutate`/`doRestore`) puede romperse → esa mutation vuelve a `escalate` (no se fuerza).

## Qué NO hacer

- ❌ No marques un objeto real como centinela "temporalmente".
- ❌ No siembres centinela para `Delete*/Remove*` (escalan por diseño).
- ❌ No dejes el centinela desarchivado ni con relaciones a datos reales.
- ❌ No reutilices un centinela entre tipos de entidad distintos.
