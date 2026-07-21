# file-uploader — display image automático (diseño)

**Fecha:** 2026-06-29
**Applet:** `file-uploader` (sube fotos/planos y los vincula a Part Numbers)
**Versión objetivo:** 0.5.0
**Estado:** diseño aprobado por el usuario (2026-06-29). Pendiente: implementación + tests + deploy.

## Problema

El applet sube fotos y las vincula al PN (`CreateUserFile` → `CreatePartNumberUserFile`),
pero **nunca marca una como "display image"**. En Steelhead, un PN sin display image
**no muestra foto en los tableros**. Hoy ~todos los PNs cargados por el dump quedan sin
portada. Se necesita elegir y marcar una foto principal **en automático** durante la carga.

## Mecanismo de la API (confirmado contra scan 2026-06-29 + validación en vivo)

Marcar la foto principal es **una sola mutación más**, reusando lo que ya existe:

```
UpdatePartNumber({ id: <partNumberId>, displayImageId: <partNumberUserFile.id> })
```

- `displayImageId` apunta al **`id` del registro de vínculo** `partNumberUserFile`
  (NO al `userFile`). Ese `id`:
  - lo **devuelve `CreatePartNumberUserFile`** al vincular (`createPartNumberUserFile.partNumberUserFile.id`), o
  - se **lee de `GetPartNumber`** en re-corridas: `partNumberById.partNumberUserFilesByPartNumberId.nodes[].id`
    (junto con `userFileByUserFileName.originalName` para mapear nombre→id).
- El hash de `UpdatePartNumber` en `config.json` (`af584fa8…`) **ya está vigente** y la
  persisted query **soporta `displayImageId`** (es la misma que ya usamos para archivar
  con `archivedAt`). → **cero hashes nuevos**.
- Leer el display image actual: `GetPartNumber.partNumberById.displayImageId`
  (`null`/ausente = el PN no tiene portada).

## Decisiones (acordadas con el usuario)

1. **Cuándo aplicar:** solo si el PN **no** tiene `displayImageId`. Respeta la existente
   (manual o de corridas previas). Idempotente: re-correr no pisa nada.
2. **Criterio "más grande": por bytes** (`File.size`, ya en memoria, sin decodificar).
   Gratis y sin costo de memoria en el full run de miles.
3. **PN con una sola foto → esa es la display image** (caso trivial del criterio).
4. **Gancho para Cowork — descriptor en el nombre:** si el grupo trae un archivo cuyo
   descriptor (la parte tras `__`) marca explícitamente "principal", esa gana sobre el
   criterio de bytes. Cowork comunica su veredicto **nombrando** así la foto; el applet
   ya matchea por nombre → cero fricción (sin leer CSV ni API extra).
   - Tokens reconocidos (case-insensitive): `principal`, `ppal`, `di`, `foto`, `photo`,
     `main`, `portada`, `display`, `cover`.
   - Match por **token con frontera**: el descriptor es igual al token, o empieza con el
     token seguido de un no-letra (dígito/separador/fin). Así `__DI` y `__foto1` matchean,
     pero `__difuminado` (empieza con "di" + letra) **no**.
   - Si hay **varias** fotos con descriptor de principal en el mismo grupo → desempata por
     **bytes** (la más grande de las marcadas).
5. **Solo imágenes.** Se eligen únicamente archivos de imagen
   (`.jpg/.jpeg/.png/.webp/.gif/.heic/.heif/.bmp/.tif/.tiff`). Se excluyen PDFs/planos y
   cualquier no-imagen. Si el grupo **no trae ninguna imagen** (solo PDFs) → no se marca
   display image.
6. **Homónimos:** la foto elegida se marca como principal en **todos** los PNs homónimos
   que no tengan display (cada PN tiene su propio `partNumberUserFile.id` para esa foto).
7. **CSV de Cowork** (lo pasará el usuario): integración opcional posterior. El descriptor
   en el nombre es suficiente para arrancar; si el CSV aporta una marca más fiable, se
   evalúa ingestarlo en una iteración aparte. **Fuera de alcance de esta versión.**

## Arquitectura del cambio

### `file-uploader-core.js` (núcleo puro + golden tests)

Funciones nuevas/extendidas (puras, sin DOM ni red):

- `isImageFile(name) → boolean` — extensión de imagen reconocida.
- `isPrincipalDescriptor(name) → boolean` — el descriptor tras `__` matchea un token de
  principal con frontera (ver decisión 4).
- `selectDisplayImage(files) → file | null` — recibe la lista de archivos del grupo
  (cada uno con al menos `{name, size}`). Aplica precedencia:
  1. filtra a imágenes (`isImageFile`); si no hay → `null`.
  2. entre las que tienen descriptor de principal (`isPrincipalDescriptor`), la de mayor
     `size`; si no hay ninguna marcada, la de mayor `size` de todas las imágenes.
  3. desempate determinista por `size` desc, luego `name` asc (estable para tests).
- `readDisplayState(pnNode) → { displayImageId, fileIdByName: Map<normName, id> }` —
  extrae el `displayImageId` actual y el mapa `originalName(normalizado) → partNumberUserFile.id`
  desde `partNumberUserFilesByPartNumberId.nodes[]`. Lee **exclusivamente** el bucket del
  PN (misma disciplina que `existingOriginalNames`).

`selectDisplayImage` opera sobre `{name, size}` → se puede testear con objetos planos
(no necesita `File` real).

### `file-uploader.js` (orquestador, efectos)

- `getPNDetail(pnId)` retorna además `displayImageId` y `fileIdByName` (vía `readDisplayState`).
- `linkToPN(...)` ya devuelve el `partNumberUserFile`; capturar su `.id` y, en
  `linkGroupToPNs`, poblar `detail.fileIdByName.set(norm(file.name), id)` al vincular
  (para que la foto recién subida sea resoluble como display image sin re-leer).
- Tras vincular el grupo, **fase de display image** por PN:
  - si `detail.displayImageId` ya existe → saltar (respetar).
  - calcular `chosen = selectDisplayImage(group)`; si `null` → saltar (solo PDFs).
  - resolver `fileId = detail.fileIdByName.get(norm(chosen.name))`.
    - **Fallback robusto:** si `fileId` es `undefined` (p.ej. `CreatePartNumberUserFile`
      no devolvió `.id`, o la foto fue saltada por preexistente sin id en el mapa),
      **releer `GetPartNumber` una vez** para ese PN — la foto ya está vinculada, así que
      aparece en `partNumberUserFilesByPartNumberId.nodes[].id` → re-resolver vía
      `readDisplayState`. Esto NO depende de qué devuelva el create (no confirmado por scan).
    - si tras el fallback sigue sin resolverse → saltar y registrar en `errors`.
  - `setDisplayImage(pnId, fileId)` = `UpdatePartNumber({ id: pnId, displayImageId: fileId })`,
    envuelto en `withRetry`/`gate` (mismo rate-limit/back-off que el resto).
  - éxito → `results.displaySet++`.

> **Nota de implementación:** durante la validación en vivo, inspeccionar el retorno de
> `CreatePartNumberUserFile` (`createPartNumberUserFile.partNumberUserFile.id`). Si trae el
> `id`, el fallback de re-lectura casi nunca se dispara (camino feliz, sin GetPartNumber extra).
- Aplica también en `processArchivedGroup` (PN archivado → desarchivar → vincular →
  marcar display → re-archivar). La marca va **antes** del re-archivado, dentro del `try`.
- Resumen: nueva línea **"Display image marcada"** = `results.displaySet`.

### Memory hardening

Sin cambios estructurales: la fase de display image agrega ≤1 mutación por PN sin portada,
ya cubierta por `gate()`/`withRetry()`/`cancelRun`. No retiene estado nuevo más allá del
`fileIdByName` por grupo (se descarta con `detailById` por grupo, igual que hoy).

## Tests (golden, `tools/test/file-uploader-core.test.js`)

- `isImageFile`: jpg/png/webp/heic → true; pdf/dwg/xlsx/sin-ext → false.
- `isPrincipalDescriptor`: `__principal`/`__DI`/`__foto`/`__foto1`/`__PORTADA` → true;
  `__front`/`__back`/`__plano`/`__difuminado` (no boundary) → false; sin `__` → false.
- `selectDisplayImage`:
  - una sola imagen → esa.
  - varias imágenes, ningún descriptor → la de más bytes.
  - imagen + PDF → la imagen (PDF ignorado aunque pese más).
  - solo PDFs → `null`.
  - descriptor de principal gana aunque no sea la más grande.
  - varios descriptores de principal → la más grande de las marcadas.
  - desempate determinista (mismos bytes → nombre asc).
- `readDisplayState`: extrae `displayImageId`; mapea originalName→id; bucket de
  nodo/instrucciones nunca contamina (misma garantía que `existingOriginalNames`).

## Plan de validación en vivo

- [ ] Prueba chica: 3 PNs sin display image —
  (a) 1 sola foto, (b) front+back+plano.pdf (debe ganar la imagen más grande, no el PDF),
  (c) uno con `__PRINCIPAL` que no sea la más grande (debe ganar el descriptor).
- [ ] Confirmar que el tablero muestra la foto tras la marca.
- [ ] Re-correr: `displaySet == 0` (idempotencia, respeta lo ya marcado).
- [ ] PN con homónimos: la principal se marca en todos los que no tenían.

## Pendientes derivados

- Ingestión del CSV de Cowork como fuente alternativa/preferente de "cuál es la principal"
  (si el descriptor en nombre resulta insuficiente).
- ¿Resolución (píxeles) como desempate fino cuando los bytes empatan? (YAGNI por ahora.)
