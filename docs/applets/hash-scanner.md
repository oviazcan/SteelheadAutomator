# `hash-scanner`: lecciones 0.6.22 → 0.6.23 (autosuficiencia de `scan_results_*.json`)

Refactor en 9 fixes para que un solo `scan_results_*.json` sirva para construir applets sin pedir nuevos payloads/responses/hashes al usuario en consola. Antes el scanner tenía gaps silenciosos (truncados, depth caps, denylists, no captura de errors/headers/timing) que forzaban round-trips. Driver del refactor: TDD con tests explícitos en `tools/test/hash-scanner.test.js` (23 tests passing). Detalles por bug:

- **#1 `init()` rebuilding maps from scratch.** `knownHashMap = {}` reasignaba la referencia, así que cualquier consumer que hubiera guardado el ref viejo (incluyendo `_internal.knownHashMap` para tests) leía datos stale. Fix: mutar en place con `Object.keys(map).forEach(k => delete map[k])` antes de repoblar. Aplicable a cualquier singleton con maps que se re-inicializan: si exportas el ref vía `_internal`, mantén la identidad del objeto.
- **#2 Hashes truncados a 12 chars en `api-knowledge.js`.** Líneas 35/52/86 hacían `.slice(0,12) + '…'` "para legibilidad" en consola, lo que rompía cualquier uso programático (re-disparar desde DevTools, copiar a config.json). Fix: devolver el hash completo o `null` cuando no hay. Regla general: si una capa de presentación trunca datos, NUNCA lo haga el data layer — el truncado va en el UI consumer.
- **#3 Op-level redaction era over-blanking.** El regex `SENSITIVE_OP_PATTERN = /email|invoice|send|preview|attach|cfdi/i` borraba TODAS las variables de cualquier op cuyo nombre matcheara, incluyendo IDs, filtros, paginación — datos que no son secretos y que son cruciales para repro. Lo que sí protege secretos es la key-level redaction (que sigue intacta: `body|rawBody|html|token|...`). Quitar el op-level no degrada seguridad; sí mejora utilidad. Lección: las denylists basadas en nombre son demasiado anchas; la redacción por shape (key name + valor) es más quirúrgica.
- **#4 `analyzeSchema` con depth cap 4 + truncado `"..."`.** Schemas reales de Steelhead (ej. `ReceivedOrder` con `lines → lineItems → partTransforms → ...`) tienen 6-7 niveles. El cap los mochaba con `"..."` literal y se perdía la firma de los leaves. Fix: sin cap, con cycle guard via `WeakSet`. Añadido `mergeSchema(a, b)` para enriquecer el schema entre llamadas (la primera respuesta puede traer arrays vacíos `[null]`, una respuesta posterior con `[{id:1}]` enriquece a `[{id:'number'}]`). Marker `[null]` para arrays vacíos en lugar de string `"[]"` (distingue "vacío de tipo desconocido" de "string literal `[]`"). Reconstrucción de `responseFields` desde el schema mergeado cada vez (no append crudo).
- **#5 `variablesSamples` cap 3 + dedup por `JSON.stringify`.** El cap de 3 era miope para ops con paginación o filtros variados. El dedup por stringify trataba `{id:1}` y `{id:2}` como distintos (no útil — misma shape). Fix: cap 10 + dedup por `shapeSignature(value)` (recursive sorted-keys + type signature). `{id:1, name:'foo'}` y `{id:99, name:'bar'}` colapsan a 1 entry; `{id:1, extra:true}` agrega entry distinta. Ahora dedupea por **forma**, que es lo que sirve para "qué shape de variables acepta esta op". El `_sigs` Set se strippea en `getResults()` para no leakear set internals.
- **#6 Raw response samples para repro.** Antes solo había schema (tipos), nunca data real. Para repro en consola hace falta un ID válido. Fix: `responseSamples: []` cap 2 entries, cada una el `responseData.data` sanitizado vía `sanitizeValue` (mismas reglas de key redaction). 2 es suficiente para tener 2 IDs distintos si los hay sin inflar el JSON.
- **#7 Sin captura de errors/HTTP status.** Hashes deprecados (ver lección "Persisted queries deprecadas" arriba) responden con HTTP 400 + `{errors:[{message:"Must provide a query string."}]}`. El scanner antes ignoraba ambos, así que no había forma de detectar deprecaciones desde el JSON. Fix: `lastHttpStatus`, `errorSamples[]` (cap 3, cada uno el array `errs` completo sanitizado), `errorCount` acumulado. Detectar deprecación = `lastHttpStatus === 400 && errorCount > 0`.
- **#8 Sin URL ni Apollo client version.** Algunos debugs requieren confirmar que el header `apollographql-client-version` viaja como `"4.0.8"` y que la URL es el endpoint canónico. Fix: `url` y `apolloVersion` capturados del request. Soporta `Headers` instance (`headers.get(...)`) y plain object (`headers['apollographql-client-version']`).
- **#9 Sin event log cronológico.** Antes `discovered[op]` colapsaba todas las llamadas a una op en una sola entry sin orden ni timing. Algunas investigaciones requieren saber "qué llamada vino antes" (ej. invalidar caché tras una mutation, race conditions, cold start sequence). Fix: `eventLog[]` append-only con `{ts, op, varsSig, ok, status}`, cap 2000 (drop oldest). Se expone vía `getResults()` que ahora devuelve `{ ops, eventLog }` en vez de solo `ops`. Consumers de `background.js` actualizados en 4 callsites.

**Meta-lección del ciclo:** el scanner era "good enough" hasta que vi 4-5 sesiones consecutivas donde le pedía al usuario re-capturar algo que en teoría el scanner ya debía tener. Cada gap silencioso (truncado, depth cap, denylist, "no, eso no lo capturo") cuesta una iteración futura. Un TDD pass disciplinado con tests que afirman explícitamente "el hash completo está aquí", "el responseSamples[0].id existe", "errorSamples está poblado cuando status=400" surfacea esos gaps de golpe. La inversión en cobertura del scanner reduce iteraciones en TODOS los applets futuros, no solo en uno. Política a futuro: cuando un applet necesite un dato que el scanner no tiene, agregar el campo al scanner antes de hardcodear el dato — capitaliza el trabajo en la herramienta, no en el caso de uso.

## 0.6.24 — el backup de recarga tiraba justo los payloads que importan (2026-07-27)

**Síntoma.** El scan `scan_results_2026-07-27_180440.json` capturó 8 operaciones nuevas del
flujo "Agrupar/Serializar Piezas" (`CreateManyPartGroups`, `CreateNewPartGroup`,
`GroupPartsDialogQuery`, `GroupPartsDialogPartLocation`, `GroupMultiplePartsDialogQuery`,
`CombinePartAccountsDialogQuery`, `FindPartGroupQuery`, `WorkPartsInfoWrapperQuery`) con
`count` de 1 a 10 en cada una… y **`variablesSamples: []` + `responseSamples: []` en todas**.
Hash sí, payload no: suficiente para saber que la operación existe, inútil para llamarla.

**Causa raíz.** `slimForBackup()` guardaba a `localStorage` solo `hash + count + status +
configKey + screens` con los arrays de muestras **vacíos** (para no reventar la cuota de ~5 MB).
Al recargar, `start()` restauraba ese backup con `mergeResults`. Como el flujo de agrupación
recarga la página al Guardar y esas ops no se volvieron a disparar después, quedaron
permanentemente huecas. **Prueba dura:** esas entradas tienen exactamente las 9 claves del slim
y les faltan `lastSeen`, `url`, `lastHttpStatus`, `responseSchema` y `responseFields` — campos que
solo agrega `recordOperation` en vivo. El scanner no falló: descartó lo correcto para el criterio
equivocado (tamaño), cuando el criterio útil es **qué se puede recuperar después**.

**Fix.** El backup ahora distingue por `status`:
- **`known`** → sigue sin muestras. Ya están documentadas en `config.json` y son la mayoría del
  volumen; gastar cuota ahí no compra nada.
- **`new` / `changed`** → conserva hasta 2 `variablesSamples`, 1 `responseSample` y 1 `errorSample`.

Con tres salvaguardas: `truncateForBackup` recorta arrays a 8 elementos preservando la **forma**
(un `nodes` de 20k y uno de 8 documentan lo mismo); tope de 120 KB por op y presupuesto global de
1.5 MB; y **dos vueltas** — todas las variables primero, las respuestas después, para que una
respuesta gigante de la primera op no deje al resto sin nada. `persistBackup()` reemplaza el
`setItem` crudo: si la cuota revienta, reintenta con el backup mínimo — perder las muestras es
malo, perder los hashes es peor.

**Tests:** `tools/test/hash-scanner-backup-samples.test.js` (12), incluido el round-trip
`slimForBackup → JSON → mergeResults` que reproduce la recarga.

**Lección.** Un backup que se dimensiona por tamaño y no por **recuperabilidad** sacrifica
exactamente lo irreemplazable. Las ops `known` se re-capturan en cualquier sesión; una op nueva
vista una sola vez, no.

**Verificación rápida del JSON (jq):**
```bash
JSON=~/Downloads/scan_results_*.json
jq '.ops | to_entries | map({op: .key, hash_len: (.value.hash|length), samples: (.value.variablesSamples|length), responseSamples: (.value.responseSamples|length // 0), httpStatus: .value.lastHttpStatus, errs: .value.errorCount}) | .[0:5]' $JSON
jq '.eventLog | length' $JSON  # → 30+ para sesión normal
```

## Fix 2026-07-28 — degradar antes que descartar (el hueco que dejó 0.6.24)

El fix de 0.6.24 salvó las muestras de las ops nuevas, pero **no alcanzó para las PESADAS**:
`take()` hacía UN recorte (arrays a 8) y, si aun así no cabía en `BACKUP_BYTES_PER_OP` (120 KB),
tiraba la muestra **entera**. Es decir, castigaba justo a las ops más caras de recapturar.

**Caso real que lo destapó:** `CreateManyScheduleTasks` —la mutation que crea una tarea de
programación— llevaba desde el **2026-07-23** apareciendo en **9 scans** con hash y `count`,
pero **sin una sola variable**. Su hermana `UpdateManyScheduleTasks` (payload de 245 B) sí
sobrevivía en el mismo scan. Sin variables no se puede escribir la llamada, así que
*"programar donde no hay tarea"* estuvo bloqueado **semanas por una poda de backup**, no por
el ERP — y el síntoma engañaba, porque la entrada tenía hash y `count`: **parecía cubierta**.

**Fix:** escalera de recorte `BACKUP_ARRAY_CAPS = [8, 3, 1]` — se prueba de mayor a menor y se
guarda el **primero que quepa**. Una muestra con arrays de 1 elemento sigue documentando la
**forma** completa de la llamada, que es para lo que sirve; cero muestras no documenta nada.
Y si ni así cabe, la entrada queda **marcada** con `samplesLost:true` en vez de quedarse muda:
una op con hash y sin muestras debe *decir* que perdió las muestras, porque si no se vuelve a
disparar no se rellena sola.

6 tests nuevos, incluido el round-trip que reproduce la recarga con el payload pesado.

**Lección (segunda vuelta de la misma):** no basta con decidir *qué* se guarda por
recuperabilidad — hay que decidir *cómo se degrada* cuando no cabe. Un tope duro sin plan de
degradación es un descarte silencioso disfrazado de límite.
