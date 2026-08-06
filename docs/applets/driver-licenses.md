# `driver-licenses` — Licencias de Choferes

**Versión:** 0.1.0 · **Estado:** **EN PRODUCCIÓN** desde el 2026-08-05 (`config v1.11.88`; el vivo
ya va en 1.11.89 por un deploy posterior ajeno).
**Rutas de hash:** las tres operaciones quedaron con ruta y el trinquete `hash-regen-coverage`
pasa (5/5). La del centinela está **declarada pero no validada en vivo** — ver §Rutas.

Administra las identificaciones de los **choferes externos** y publica el catálogo al hook
low-code `pdf:SHIPMENT_TEMPLATE` de **SteelheadPowerTools**, que pinta la licencia en la lista
de embarque cuando el nombre del chofer aparece en las notas o en el nombre del embarque.

| | |
|---|---|
| Núcleo puro | `remote/scripts/driver-licenses-core.js` |
| UI + red | `remote/scripts/driver-licenses.js` |
| Tests | `tools/test/driver-licenses-core.test.js` — **30 verdes** |
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

## Historial

- **0.1.0** (2026-08-05) — Alta. Núcleo puro con 30 tests, panel de administración, publicación
  con diff y confirmación. Contrato con el hook verificado cross-repo: el bloque que genera el
  applet salió **byte-idéntico** al que había publicado el generador Python, y `replaceBlock`
  sobre el hook real resultó idempotente.
