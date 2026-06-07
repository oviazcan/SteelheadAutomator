# `wb-produccion-access` — bitácora

Tool standalone (`tools/grant-wb-produccion-access.js`) que se pega en la
consola de DevTools sobre `app.gosteelhead.com` e **inyecta un panel flotante**
para dar acceso a la etiqueta de workboard **"WB Producción"** a una lista de
usuarios pegada por nombre. NO es parte de la extensión; corre ad-hoc en la
sesión del navegador (cookies same-origin).

## Qué resuelve

"WB" = **Workboard**. "WB Producción" no es un permiso de sistema, es un
*label* de tablero dentro de una carpeta de workboard. El acceso de usuarios a
ese label se gobierna con la mutación `updateWorkboardLabelUsers`. La UI solo
permite marcarlos uno por uno; este tool resuelve una lista masiva por nombre.

## Coordenadas (descubiertas del scan `scan_results_2026-06-02_092021.json`, dominio Ecoplating)

| Cosa | Valor |
|---|---|
| Carpeta de workboard | `workboardFolderId: 1469` |
| Label **WB Producción** | `labelId: 9746`, `workboardFolderLabelId: 419` |
| Mutación | `updateWorkboardLabelUsers` — hash `d598e0dd884c9caefaee84a29e4ecd796508f9ed660d7b980821253334de8636` → devuelve `boolean` |
| Query usuarios (paginada) | `UsersForFolderLabelConfig` — hash `573d0e692ad465821cd39639cf0c1b7d7a3c4e846e18bc31fde52f750fcbba05`, variables `{offset}` |

Otras labels de la misma carpeta (estado al 2026-06-02): `WB Ingeniería`
(`labelId 15168`), `WB Calidad` (`10104`), `WB Almacén` (`10106`). Las tres
tenían `workboardFolderLabelId: null` (nunca se les ha asignado usuarios; el
server crea el registro en la primera asignación).

## Mecanismo (3 pasos)

1. **Paginar usuarios en vivo** con `UsersForFolderLabelConfig` (`offset` 0,
   100, 200… hasta que una página devuelve <100 nodos — no hay `totalCount`).
   Cada nodo trae `id`, `name` y `workboardLabelUsersByUserId.nodes[]` con las
   labels que el usuario YA tiene (vía
   `workboardFolderLabelByWorkboardFolderLabelId.labelId`).
2. **Resolver** la lista de nombres pegada contra el mapa `nombre normalizado →
   userId`.
3. **Una sola mutación** `updateWorkboardLabelUsers` con un input para WB
   Producción que contiene la **lista COMPLETA** de `userIds`:
   ```js
   { input: [{ workboardFolderLabelId: 419, userIds: [...], workboardFolderId: 1469, labelId: 9746, selected: true }] }
   ```

## Shape exacto observado de la mutación (del scan)

```json
{"input":[
  {"workboardFolderLabelId":419,"userIds":[12899,12907,...],"workboardFolderId":1469,"labelId":9746,"selected":true},
  {"workboardFolderLabelId":null,"userIds":[],"workboardFolderId":1469,"labelId":15168,"selected":false},
  {"workboardFolderLabelId":null,"userIds":[],"workboardFolderId":1469,"labelId":10104,"selected":false},
  {"workboardFolderLabelId":null,"userIds":[],"workboardFolderId":1469,"labelId":10106,"selected":false}]}
```
Respuesta: `{"updateWorkboardLabelUsers": true}`.

## 1.0.0 — 2026-06-02 — Implementación inicial (panel UI)

### Decisiones de diseño

- **La mutación REEMPLAZA, no agrega.** El `userIds` enviado es la lista final
  exacta del label. Por eso el tool lee el estado actual en vivo y por defecto
  hace **UNIÓN** (actuales + resueltos) → nadie pierde acceso. Hay checkbox
  "Reemplazar lista completa" que, en ese modo, muestra en rojo a **quién
  quitaría** antes de confirmar.
- **Solo manda el input de WB Producción** (array de 1 elemento). Aunque la UI
  manda las 4 labels (las otras con `userIds: []`, `selected: false`), replicar
  eso es PELIGROSO: enviaría `userIds: []` a `WB Ingeniería`, que sí tiene
  usuarios, y los **borraría**. Cada elemento del input es autónomo (su propio
  `labelId`/`workboardFolderLabelId`), así que mandar solo WB Producción no
  toca las demás.
- **Match por nombre.** `UsersForFolderLabelConfig` no trae correo. El match es
  por nombre normalizado: `NFD` → quita acentos → `toUpperCase` → puntuación a
  espacio → colapsa espacios. Riesgo de homónimos/typos: el panel reporta
  **no-encontrados** (con sugerencias por tokens) y **ambiguos** (homónimos, a
  resolver por `id` a mano). No ejecuta hasta que el operador da "Aplicar".
- **DRY-RUN primero.** "Analizar" pagina + resuelve + renderiza, nunca escribe.
  "Aplicar" pide `confirm()` con el resumen y solo entonces llama la mutación.
- **Anti-XSS.** El panel se construye con `createElement` + `textContent` en
  todos los datos dinámicos (nombres de GraphQL / lista pegada), siguiendo el
  pendiente MEDIO del audit (`CLAUDE.md` → Seguridad).

### Fetch (patrón de `remote/scripts/steelhead-api.js`)

`POST /graphql`, `credentials:'include'`, `content-type:application/json`,
extensions con `clientLibrary {@apollo/client, 4.0.8}` + `persistedQuery
{version:1, sha256Hash}`. No requiere `domainNanoId` ni
`x-steelhead-idp-token` (eso es del cliente Python externo; aquí la cookie de
sesión same-origin basta).

### Estado del scan (por qué no dependemos de él en runtime)

El hash-scanner solo conserva **2 `responseSamples`** por operación. El scan de
hoy capturó 6 llamadas paginadas pero guardó 200 usuarios (ids 11971–16009). El
tool **no usa esas muestras**: pagina en vivo, así que trae a todos los usuarios
actuales sin importar cuántas páginas guardó el scan. El scan solo sirvió para
descubrir hashes, IDs y shapes.

### Validación / uso real

- Sintaxis validada con `node --check`. Normalización probada
  (`JÉSÚS Ñoño Pérez-García` → `JESUS NONO PEREZ GARCIA`).
- Pendiente: correr el flujo real (analizar lista del operador → aplicar) y
  spot-check post-aplicación de 2-3 usuarios en la UI de workboard.

### Pendientes derivados

- [ ] Si se necesita el mismo flujo para WB Ingeniería/Calidad/Almacén: cambiar
  `LABEL_ID` y `WORKBOARD_FOLDER_LABEL_ID` (las tres aún en `null` → primera
  asignación crea el registro; en ese caso mandar `workboardFolderLabelId: null`).
- [ ] Botón "exportar CSV" de no-encontrados/ambiguos para corregir aparte
  (ofrecido, no implementado — el operador dijo "ya quedó").
- [ ] Si Steelhead rota los hashes, actualizarlos en el tool (no vive en
  `config.json` porque es standalone). Cruzar con el validador diario de hashes.
- [ ] Considerar parametrizar `labelId`/`folderId` en el panel (dropdown de
  labels vía `AllLabelsForWorkboardFolder`) para generalizarlo a cualquier
  etiqueta sin editar código.
