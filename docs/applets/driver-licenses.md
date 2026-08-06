# `driver-licenses` — Licencias de Choferes

**Versión:** 0.1.2 · **Estado:** **EN PRODUCCIÓN** desde el 2026-08-05 (`config v1.11.88`).
El 2026-08-06 se corrigieron DOS bugs que impedían usarlo: el HTTP 400 de `PdfLowCode` y el
barrido del catálogo completo que **tumbaba la sesión del ERP**.
**Rutas de hash:** las tres operaciones quedaron con ruta y el trinquete `hash-regen-coverage`
pasa (5/5). La del centinela está **declarada pero no validada en vivo** — ver §Rutas.

Administra las identificaciones de los **choferes externos** y publica el catálogo al hook
low-code `pdf:SHIPMENT_TEMPLATE` de **SteelheadPowerTools**, que pinta la licencia en la lista
de embarque cuando el nombre del chofer aparece en las notas o en el nombre del embarque.

| | |
|---|---|
| Núcleo puro | `remote/scripts/driver-licenses-core.js` |
| UI + red | `remote/scripts/driver-licenses.js` |
| Tests | `tools/test/driver-licenses-core.test.js` — **46 verdes** |
| Contrato | `SteelheadPowerTools/docs/specs/2026-08-05-applet-licencias-choferes.md` |
| Hook que consume | `SteelheadPowerTools/hooks/pdf/SHIPMENT_TEMPLATE.ts` (TLC `11471` · MTY `11472`) |

---

## Por qué existe

La foto del chofer externo vivía en la plantilla de PDFGeneratorAPI como **una imagen y un
condicional por persona** (`!(lowercase({notes}) contains "jesus") && …`). No escalaba, y dar de
alta a un chofer exigía editar la plantilla a mano en cada dominio — trabajo de un consultor
externo. **El applet existe para que ese alta no dependa de nadie con el repo clonado.**

## Qué hace

1. **Sube** una identificación pidiendo *con qué nombre se va a nombrar al chofer* en el embarque.
2. **Lista** las licencias cargadas, marcando cuáles faltan publicar, cuáles cambiaron y cuáles
   quedaron huérfanas (publicadas sin archivo).
3. **Publica** el catálogo dentro del hook, con aviso y diff en pantalla.

## Decisión de diseño: el prefijo, no la carpeta

`CreateUserFile` sólo acepta `name` y `originalName`. **No hay mutation disponible para asignar
la carpeta**, así que el applet no puede dejar el archivo dentro de «Licencias» por sí mismo.

En vez de capturar un hash más para eso, el criterio de pertenencia es un **prefijo en el
nombre registrado**: `licencia-<nombre>.<ext>`. Sale ganando por tres lados: no depende de que
exista una carpeta, ni de su `folderId` —que es distinto en cada dominio—, ni de que alguien se
acuerde de elegirla en el combo.

`keyFromOriginalName` acepta **las dos formas** a propósito: las 8 licencias que ya vivían en la
carpeta se subieron sin prefijo y tienen que seguir resolviendo a la misma llave que el hook
busca. La lectura hace **dos pasadas** de `SearchUserFilesQuery` porque `fetchFolderless` es
excluyente: con `false` sólo llegan las que están en carpeta, con `true` sólo las sueltas.

## Por qué el bloque va en el nivel raíz del `.ts`

El applet **no compila TypeScript en el navegador**. No le hace falta: con el bloque en el nivel
raíz del archivo y el formato canónico (4 espacios, un espacio tras los dos puntos, comillas
dobles, orden alfabético), `tsc` lo emite **byte-idéntico** en el JS, así que la misma
sustitución sirve para `code` y para `compiled`.

⚠️ **Dentro de una función, `tsc` lo reindenta (2 → 4) y colapsa la alineación de los valores** —
los dos bloques dejan de coincidir y se publicaría un `compiled` desalineado del `code`. Medido
el 2026-08-05 en las dos variantes. Si alguien mueve el bloque, esto se rompe **en silencio**;
por eso `blocksMatch()` corre antes de cada publicación.

## Publicar: el camino tiene candados

Este applet **publica código productivo**. La secuencia no es negociable:

1. **Relee el hook del servidor** (`PdfLowCode`), nunca una copia local ni la que se leyó al
   abrir el panel — entre medias alguien pudo publicar.
2. **Aborta** si los marcadores faltan o están duplicados. No sustituye a ciegas.
3. **Muestra el diff** en dos niveles: catálogo en lenguaje de negocio (`+ alta`, `~ cambia`,
   `− baja`) y el bloque de código tal como quedará.
4. **Exige confirmación explícita.** Subir un archivo y publicar son **dos acciones separadas**:
   publicar nunca ocurre como efecto secundario de subir.
5. **Verifica `blocksMatch(code, compiled)`** antes de mandar.

### Limitación conocida: un dominio por corrida

El applet publica **en el dominio donde corre**. La extensión trabaja contra un dominio a la vez
y no hay forma de escribir en el otro desde la misma sesión. Al terminar, el panel **lo dice con
todas sus letras** y advierte que los dominios quedan desalineados hasta repetir la operación
desde el otro. La alternativa para cerrar los dos de un golpe es el generador por CLI del repo
hermano (`sync/gen_driver_licenses.py` + `lowcode_sync.py push`).

## Colisiones de nombre

Dos choferes con el mismo nombre de pila son dos personas: sobrescribir dejaría a una **sin
licencia impresa y en silencio**. `validateDriverName` bloquea la colisión y pide un nombre
alternativo (la convención acordada con el cliente es agregar la inicial del apellido). Sólo se
reemplaza si alguien marca la casilla explícitamente.

También se rechazan nombres de menos de 3 letras: se confundirían con palabras sueltas de las
notas del embarque.

## Privacidad

Lo que había cargado al construir esto **eran credenciales INE completas** —domicilio, CURP,
clave de elector, fecha de nacimiento— de personas que no son personal de la empresa. Y
`/api/files/<name>` **no autentica**: HTTP 200 sin cookie ni token (Hallazgo de seguridad #1).
Esa liga queda embebida en un PDF que se manda al cliente.

El panel lo advierte al subir y recomienda **foto y nombre** o el **gafete laboral** de la
transportista. No lo bloquea —no es decisión del applet— pero no deja que pase inadvertido.

## Rutas de regeneración de hash

El applet introduce tres operaciones. Las tres quedaron con ruta y el trinquete
`tools/test/hash-regen-coverage.test.js` pasa (5/5):

| Operación | Tipo | Ruta |
|---|---|---|
| `SearchUserFilesQuery` | query | ✅ Ya existía — `captures` de la pantalla *UploadedFiles* |
| `PdfLowCode` | query | ✅ `quote-pdf-powertools-editor` en `route-catalog.json` |
| `CreatePdfLowCode` | mutation | ✅ `pdfLowCodeSave` en `sentinels-config.json`, **capture-abort** |

### El camino: cuatro modales y ninguna URL

El editor low-code **no tiene URL propia**. Se llega por modales anidados desde la Cotización
Centinela 288, y la barra de direcciones nunca cambia:

```
/Domains/{domain}/Quotes/288
  → «Open PDF»
    → icono «Editar PDFs con estos Datos»
      → «Edit Power Tools»          ← aquí carga PdfLowCode
        → «Save»                    ← aquí dispara CreatePdfLowCode
```

Los clics intermedios llevan `once: true`: re-clicar **cerraría** el modal.

Las anclas van por **la forma del icono** (prefijo del `path` del SVG), no por texto ni por
`data-testid` —estos SVG de MUI no lo traen— ni por el `aria-label`, que está en español.

### Por qué abortar no es opcional aquí

Cada save del editor low-code **crea una versión nueva del hook y la última es la activa**: no
existe `Update` ni mutation de «activar». Un centinela que dejara pasar el request **publicaría
código productivo en cada corrida del autopilot**. Por eso `_estrategia: capture-abort`: se marca
la op en `abortOps` antes de clicar Save, el interceptor registra el `sha256Hash` y aborta.

### ⚠️ Declarada, no validada en vivo

La receta está escrita y el trinquete la cuenta, pero **no se ha corrido el headless contra ella**.
Dos cosas pueden faltar:

1. **El handler de navegación por modales anidados en el motor.** Los sentinels existentes llegan
   por `screenPath` + un clic; éste necesita tres antes del Save.
2. **La corrida de validación.** Hasta que el autopilot capture el hash por este camino, la
   cobertura es *declarativa*: el test mide que la ruta exista, no que funcione.

Mientras tanto, si `CreatePdfLowCode` rota, el applet deja de publicar hasta actualizar el hash a
mano en `remote/config.json` (el valor vive también en
`SteelheadPowerTools/sync/lowcode_sync.py`, que sirve de referencia cruzada).

## Pendientes

- [ ] **Validar en vivo** la receta del centinela `pdfLowCodeSave`: está escrita y el trinquete la
      cuenta, pero falta una corrida del autopilot y posiblemente el handler de navegación por
      modales anidados en el motor (§Rutas). Las rutas en sí ya están.
- [x] ~~Deploy~~ — hecho el 2026-08-05 (bump 1.11.87→1.11.88). Nota: `deploy.sh` commitea y
      espeja pero **no pushea**, y deja el worktree en `gh-pages`; hay que empujar a mano y volver.
- [ ] Sustituir las INE por versión recortada o gafete laboral antes de usarlo en producción.
- [x] ~~Plantilla de PDFGeneratorAPI~~ — hecha y **verificada en producción** el 2026-08-05: UNA
      imagen con `{additionalPayload::driverLicenseUrl}` y **cero condicionales**. Medido que con
      URL vacía el motor **no pinta nada**, así que ni el genérico
      `!({additionalPayload::hasDriverLicense})` hizo falta. Pendiente sólo la plantilla de **MTY**,
      cuando ese formato se active allá (el hook ya está publicado en los dos dominios).

## Safari / iPad

**En el bundle desde v0.6.32** (2026-08-05, 34 applets) · **corregido en v0.6.33** (2026-08-06).

⚠️ El HTTP 400 de `PdfLowCode` **también estaba embebido en el bundle**, así que el panel tampoco
abría en el iPad — y ahí dolía más: el iPad es donde se toma la foto de la identificación en el
andén. El bundle es **estático**, así que el deploy a `gh-pages` NO lo arregla; hizo falta
`tools/build-safari.sh` (v0.6.33) y **recompilar en Xcode**. Verificado en el ARTEFACTO, no en el
log: `hookQueryVariables` y `pickActiveHook` pasaron de 0 a 3 ocurrencias, el patrón viejo
`query('PdfLowCode', { pdfType: PDF_TYPE })` quedó en **0**, y `node --check` pasa. Es de los pocos applets donde el iPad no
es una comodidad sino **el lugar correcto**: dar de alta a un chofer externo pide la foto de su
identificación, y el `<input type="file" accept="image/*">` abre la **cámara** directo en el andén
— sin pasar por una computadora ni por el consultor.

Pasa el criterio de curación porque su única interacción con archivos es **SUBIR**. El criterio que
excluye a `auditor`, `carga-masiva` y `file-uploader` es la **descarga** (`a.download` /
`URL.createObjectURL`), que en iOS Safari no funciona; aquí no hay ninguna.

Como `autoInject:false`, **no tiene FAB: el popup es su única puerta**, así que necesitó el
lanzador cableado en los tres archivos —
`safari/extension/popup.js` (`LAUNCHERS`) · `safari/sa-dispatcher.js`
(`'open-driver-licenses': 'DriverLicenses.open'`) · `safari/bundle.json` (`applets[]`) —
más su global en el mapa de `tools/test/build-safari.test.js`. Ese test es el trinquete del canal
y **se puso rojo** al agregar el lanzador sin registrar el global (`global DriverLicenses sin
script conocido en el test`): hizo exactamente su trabajo.

⚠️ **El bundle es estático: falta recompilar en Xcode** para que llegue al iPad. Los artefactos ya
están sincronizados en `safari/xcode/.../Resources/`.

## El bug que rompió el panel: `PdfLowCode` es un LISTADO, no un fetch por tipo

**2026-08-06, reportado desde producción.** El panel abría con el listado vacío y este mensaje:

```
No se pudo cargar: HTTP 400 en PdfLowCode:
  [1] Variable "$first" of required type "Int!" was not provided.
  [2] Variable "$offset" of required type "Int!" was not provided.
```

**No era un hash rotado** — ése habría dado `"Must provide a query string."` (ver
[`persisted-queries-playbook.md`](../api/persisted-queries-playbook.md)). El hash estaba vivo y
además es **byte-idéntico** al que usa `SteelheadPowerTools/sync/lowcode_sync.py`. Lo que estaba
mal eran **las variables**: se copió el hash sin copiar el contrato de llamada.

`PdfLowCode` no lee *el* hook de un tipo: enumera **todas las versiones** del slot, paginado.
El contrato real, tomado de la implementación de referencia que sí funciona
(`lowcode_sync.py::_fetch_single_slot`):

| | Lo que hacía el applet | Lo correcto |
|---|---|---|
| Variables | `{pdfType}` | **`{first, offset, pdfType}`** — los dos primeros son `Int!` |
| Key de respuesta | `pdfLowCode` / `PdfLowCode` / la raíz | **`allPdfLowCodes.nodes`** |
| Versión elegida | `nodes[0]` crudo | **la más reciente por `createdAt`** |

**Eran tres defectos, y los dos últimos estaban TAPADOS por el primero**: el 400 ocurría antes,
así que nunca se llegó a ejercitar el parseo. El tercero es el peligroso — no da error, da la
versión equivocada, y como este applet **publica código productivo**, leer una versión vieja
significa **republicarla encima de la buena, en silencio**. Cada save crea una versión nueva y
no existe mutation de «activar»: la activa es, por convención, la más reciente.

La decisión se movió al núcleo puro (`hookQueryVariables`, `pickActiveHook`) con **7 tests**
nuevos. `CreatePdfLowCode` se revisó en la misma pasada y **estaba bien**: `{code, compiled,
pdfType}` es exactamente lo que manda PowerTools.

### Por qué los 30 tests no lo cazaron

Porque `fetchHook()` vivía **en el glue**, que no tiene test, y el core solo cubría el bloque de
texto. La verificación cross-repo del alta comparó **el bloque generado** —que salió
byte-idéntico— pero **nunca la llamada GraphQL de lectura**. Un contrato entre dos repos tiene
dos mitades: el formato del dato y **cómo se pide**. Se verificó una.

## El segundo bug: leer la carpeta TUMBABA la sesión del ERP

**2026-08-06.** Con el HTTP 400 ya corregido, el panel se quedaba en *«Leyendo licencias…»* y
terminaba en **HTTP 502 de nginx**, con `SearchUserFilesQuery` en `offset: 11900`.

`fetchLicenseFiles()` paginaba **el catálogo COMPLETO de archivos del ERP** —`searchQuery: ''`,
`for(;;)` sin tope— de 100 en 100, en **dos pasadas** (`fetchFolderless` es excluyente), para
quedarse con 8 licencias. Al corte había **23,147 archivos**: ≈ **460 peticiones**.

El `/graphql` de SH **se cuelga a las ~40-45 peticiones y el límite es por SESIÓN**
(CLAUDE.md §API de Steelhead): no se recupera recargando la pestaña y **tumba también las
pantallas nativas**. Es decir: abrir este panel dejaba al operador sin ERP.

### El arreglo: que filtre el servidor

`SearchUserFilesQuery` **acepta `searchQuery`** y el applet lo mandaba vacío. Medido en TLC el
2026-08-06, con una petición por sondeo:

| Sondeo | Resultado |
|---|---|
| `searchQuery:'licencia'` | `totalCount` **23,147 → 1**. Filtra, es **case-insensitive** y por **substring** |
| `searchQuery:'1785961684774-295104609.png'` | encuentra `Hector.png`, carpeta `Licencias` |

El segundo es el que importa: **`searchQuery` matchea también el `name` generado**, no sólo el
`originalName`. Sin eso, las 8 viejas —que se llaman `Renan.png`, `Hector.png`… y **no
contienen la palabra «licencia»**— serían inalcanzables por búsqueda.

De ahí las dos etapas:

1. **Prefijo `licencia`** → todas las que siguen la convención. Toda alta nueva cae aquí.
2. **Nombre exacto**, sólo de lo publicado que NO apareció en (1) → las 8 viejas. Este número
   **no crece con el catálogo**, y en cuanto el archivo aparece se corta la segunda pasada.

**≈460 → ~10 peticiones**, con `MAX_REQUESTS = 24` como presupuesto duro. Si se agota, la UI lo
dice en ámbar y advierte no publicar: una lista incompleta que se sabe incompleta es aceptable;
dejar sin ERP al operador, no.

⚠️ **La búsqueda trae ruido y el core debe seguir filtrando.** `searchQuery:'licencia'` devuelve
`LAPTOP.LICENCIA _PROQUIPA_05 NMAYO.pdf` —un PDF administrativo— porque el match es por
substring. No lleva prefijo ni vive en la carpeta, así que `isLicenseFile` lo descarta; el caso
real está fijado en los tests. Si el core lo aceptara, se publicaría la liga a un documento
interno **dentro de la remisión que se manda al cliente**.

### Candado: una lista vacía no autoriza bajas

Si la lectura fallara, la lista llegaría vacía y el diff diría «dar de baja las 8 licencias».
Publicar eso **borra el catálogo** y deja a los choferes sin foto, sin un solo error en pantalla.
`looksLikeFailedSearch()` **bloquea el botón de publicar** cuando no se leyó ningún archivo y sí
hay catálogo publicado. Sin catálogo el vacío es legítimo — es el primer alta.

## Verificar releyendo (2026-08-06)

`CreatePdfLowCode` responde `{clientMutationId:null}` — ni el id ni el valor — así que el
`await publishHook()` sin excepción **no probaba que se hubiera escrito**, y aun así el panel
afirmaba «Catálogo publicado» en verde. Ahora **relee el hook y compara el catálogo vivo**
contra el que se mandó (`parseBlockCatalog` + `diffCatalogs(...).isEmpty`).

Si no se puede confirmar, la UI lo dice en **ámbar** («Se mandó, pero no pude verificarlo»),
nunca en verde: no tener la confirmación es *«no sé»*, no *«falló»* ni *«listo»*. PowerTools ya
hacía esta relectura tras el push; el applet no.

## Historial

- **0.1.2** (2026-08-06) — **Fix de producción #2 + miniaturas.** `fetchLicenseFiles` paginaba
  los 23,147 archivos del ERP (~460 peticiones) y **tumbaba la sesión** (límite ~40-45, por
  SESIÓN). Ahora filtra el SERVIDOR vía `searchQuery`, en dos etapas, con presupuesto duro de
  24 peticiones: **≈460 → ~10**. Nuevo candado `looksLikeFailedSearch` — una lectura vacía ya
  no puede publicarse como «bajas» y borrar el catálogo. Miniatura de la foto en el listado
  (lazy, con degradación explícita). +9 tests (37 → **46**).
- **0.1.1** (2026-08-06) — **Fix de producción.** `PdfLowCode` se llamaba sin `$first`/`$offset`
  (HTTP 400: el panel no abría) y, por debajo, leía la key equivocada y no ordenaba por
  `createdAt`. Nuevos en el core: `hookQueryVariables` y `pickActiveHook` (+7 tests, **37**).
  Además, la publicación ahora **verifica releyendo** en vez de confiar en el `await`.
- **0.1.0** (2026-08-05) — Alta. Núcleo puro con 30 tests, panel de administración, publicación
  con diff y confirmación. Contrato con el hook verificado cross-repo: el bloque que genera el
  applet salió **byte-idéntico** al que había publicado el generador Python, y `replaceBlock`
  sobre el hook real resultó idempotente.
