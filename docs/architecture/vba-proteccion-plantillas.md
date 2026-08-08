# Protección de hojas en las plantillas de Carga Masiva (VBA)

**2026-08-07.** Las plantillas `.xlsm` se entregan **protegidas** para que el operador sólo pueda
escribir en los campos de captura. Todas las macros que ESCRIBEN truenan con error 1004 sobre una
hoja protegida. Este documento fija cómo se resolvió y qué NO hace la solución.

Guía de instalación para humanos: [`docs/plantilla-proteccion-vba.html`](../plantilla-proteccion-vba.html).

## Reparto de responsabilidades

| Pieza | Quién la gobierna |
|---|---|
| Qué celda va `Locked` / desbloqueada | **A mano sobre el `.xlsm`**, viaja guardada en el archivo |
| Qué hojas están protegidas y con qué banderas | **A mano sobre el `.xlsm`** |
| Levantar y reponer el candado durante una macro | `vbas/ModProteccion.bas` |

El VBA **no decide** qué se bloquea. Se intentó primero (una macro que derivaba `Locked` de la
fila 8 de tipos) y se descartó: duplica en código una decisión que ya vive en el archivo, y crea
dos fuentes de verdad que se desfasan.

## La regla: se restaura lo que había

`SA_Desproteger` toma una **foto** del estado (qué hojas estaban protegidas, con qué banderas
`Allow*`, `EnableSelection`, y la protección de estructura del libro) y `SA_Proteger` repone esa
foto. **Nunca protege con banderas fijas escritas en el código.**

Por qué importa, medido sobre `Plantilla_CargaMasiva_v13.xlsm` (2026-08-07):

- Libro: `workbookProtection lockStructure="1"`.
- Protegidas (5): `Upload`, `Cálculo MP`, `CAT_Specs`, `CAT_Líneas`, `CAT_Productos`,
  todas con `sheet="1" objects="1" scenarios="1"` y **ningún** `Allow*`.
- **Sin proteger (3): `Listas`, `Ayuda`, `CAT_Procesos`.**

Una reprotección "de todas las hojas con mis banderas" habría protegido de más esas tres y borrado
la configuración en cada corrida de `LimpiarDatos`. Con la foto, correr una macro deja el archivo
exactamente como estaba — y si mañana se protege una hoja más, se respeta sola.

**Fail-safe:** sin foto previa, `SA_Proteger` **no hace nada**. Jamás inventa un candado donde no
lo había; un falso "protegido" deja al operador sin capturar y sin explicación.

**"Protegida" es protegida de CUALQUIER forma**, no sólo de contenido: Excel permite proteger
objetos o escenarios sin proteger celdas, y si la señal fuera únicamente `ProtectContents` esa hoja
se leería como abierta y al reponer se le quitaría la protección que sí tenía. `Contents` también se
repone con el valor fotografiado, no con `True` fijo.

**Comprobación en el archivo real: `SA_Diagnostico`.** Captura el estado de todas las hojas y del
libro; se corre la macro que se quiera probar; se vuelve a correr y contesta `IGUAL` o lista qué
bandera cambió y dónde. Existe porque "el diseño respeta tu configuración" es una afirmación que el
usuario no tiene por qué creer sin medirla — y porque la única prueba que vale de esto se hace
dentro de Excel, que es justo donde los tests de este repo no llegan.

## El patrón en cada macro

```vba
On Error GoTo Cleanup
SA_Desproteger
' ... trabajo ...
Cleanup:
    ' se llega TAMBIÉN por error
    SA_Proteger
```

El `Cleanup` no es adorno: sin él, una macro que revienta a media pasada deja el archivo abierto y
nadie se entera hasta que alguien borra una fórmula. **Ningún `Exit Sub` puede quedar entre el
desproteger y el reproteger** — lo verifica el test.

## `UserInterfaceOnly` y por qué hace falta `Workbook_Open`

`Worksheet.Protect ... UserInterfaceOnly:=True` deja escribir al VBA y no al usuario. **Esa bandera
NO se guarda con el archivo**: al reabrir, la hoja queda protegida también para las macros. Por eso
`ThisWorkbook.Workbook_Open` llama `SA_RehabilitarEscrituraVBA`, que repone el mismo candado con la
bandera puesta.

Lo que esto salva es **`Worksheet_SelectionChange` de la hoja Upload**, que escribe en
`CAT_Procesos!I2` y `CAT_Specs!D2` en CADA clic sobre Proceso (col 21) y Spec 1-4 (23/25/27/29) para
alimentar los dropdowns dependientes. Con `CAT_Specs` protegida truena en el primer clic y en todos
los siguientes: **es lo que hace parecer que "todo truena"** cuando la macro que el operador ejecutó
no tiene nada que ver. Ese handler NO desprotege por su cuenta a propósito — desproteger dos hojas
en cada movimiento del cursor es trabajo por clic, y aquí el clic es el flujo normal de captura.

Si el archivo se abre con macros deshabilitadas, `Workbook_Open` no corre y los feeders truenan. No
hay forma de evitarlo desde VBA, y tampoco importa mucho: sin macros la plantilla no sirve. Las
cinco macros siguen funcionando igual, porque cada una desprotege por su cuenta.

## Volver a donde estaba el operador

Al terminar cualquier macro, Excel se quedaba **en otra hoja**. Duele porque `Upload` es donde
viven los botones y donde se estaba capturando: el operador termina una limpieza y aparece en
`CAT_Productos`.

El culpable es el propio ciclo de protección: varias operaciones sobre una hoja —señaladamente
asignar `EnableSelection`— hacen que Excel la **active**, y como el ciclo recorre las 8, gana la
última. Se atacó por los dos lados:

1. **`SA_Reponer` ya no escribe `EnableSelection` si el valor no cambió.** Como se acaba de
   fotografiar de esa misma hoja, en la práctica nunca cambia: la asignación era pura ceremonia con
   un efecto secundario caro.
2. **`SA_Desproteger` guarda hoja activa y selección; `SA_Proteger` las restaura**, y el ciclo corre
   con `ScreenUpdating = False` para que no parpadee.

El (2) existe porque el (1) es una **hipótesis que no se puede verificar sin Excel**. Restaurar la
posición garantiza el resultado sin importar cuál sea la causa real, y sigue siendo correcto si
mañana una macro nueva cambia de hoja por otro motivo. *Cuando no puedes confirmar el diagnóstico,
arregla de forma que la causa deje de importar.*

`SA_RehabilitarEscrituraVBA` lleva el mismo cuidado: ahí dolería el doble, porque el archivo abriría
en una hoja distinta de la que se guardó. Y la restauración **sólo ocurre si `ThisWorkbook` es el
libro activo**: si el operador se fue a otro archivo mientras corría la macro, robarle el foco es
peor que el problema que se arregla.

## Modales en macros disparadas por evento: no

`SombrearModoSoloPN` corre desde `Worksheet_Change`, y terminaba con un `MsgBox` en el camino
normal. Síntoma reportado desde piso: *"jala la primera vez, luego deja de sombrear si sigo
iterando entre COTIZACIÓN y SOLO_PN"* — y minutos después **aparecían todos los avisos de golpe**,
al pasar por la ventana del editor de VBA.

No era el sombreado, era el modal. Con otra ventana al frente el `MsgBox` de Excel queda **detrás**,
y mientras espera respuesta **VBA está bloqueado**: el siguiente cambio de `H1` no se procesa. Los
avisos se encolaban y la macro "dejaba de funcionar".

El aviso además no informaba nada: **el sombreado ES el feedback**, el operador lo tiene enfrente.
Queda sólo el `MsgBox` de error. *Regla: una macro disparada por evento no interrumpe con modales —
se avisa la excepción, no la norma.*

Dos defensas que salieron del mismo diagnóstico:

- **`SA_Desproteger` desprotege SIEMPRE**, fuera del `If` de nivel. Es idempotente, y si el contador
  de anidamiento se descuadrara por cualquier camino la macro **sigue funcionando**. Antes, un
  contador descuadrado dejaba la hoja bloqueada y todas las macros muertas a partir de ahí: fallo
  silencioso y permanente. Ahora lo peor es que una vez no se reproteja — visible y recuperable.
- **`SA_Proteger` reenciende `Application.EnableEvents`.** `Worksheet_SelectionChange` los apaga
  para escribir en los feeders y los enciende en la línea siguiente; si esa escritura falla, el
  reencendido nunca corre y los eventos quedan apagados **toda la sesión** (deja de dispararse el
  sombreado, dejan de filtrarse los dropdowns) sin nada que lo delate. Encenderlos aquí rompe el
  ciclo en la siguiente macro.

## Alcance por macro

| Macro | Módulo | Escribe en | Versión |
|---|---|---|---|
| `LimpiarDatos` | Module5 | Upload (borrado, defaults, placeholders, `Copy/PasteSpecial`) | v20 |
| `LimpiarEspacios` | Module5 | Upload (texto) | v16 |
| `RefrescarListas` | Module2 | Listas + CAT_Procesos | v15 |
| `SombrearModoSoloPN` | Module4 | Upload — **formato** (`.Interior.Color`) | v14 |
| `ExportarCSV` | Module1 / Module1_compat | **nada** (sólo lee) | v15.6 |

`ExportarCSV` es la única que no escribe en el libro: lee `Upload` y `CAT_Productos` y vuelca a un
libro nuevo (o, en la compat, a `ADODB.Stream`). Se envolvió igual porque el libro se entrega con la
estructura protegida y era barato descartar la duda. **Léase al revés: si `ExportarCSV` falla con la
plantilla protegida, la causa no está en esa macro.**

## Entrega: `vbas/entrega-proteccion/`

Los `.bas` importables se generan con `node tools/build-vba-entrega.js`, en **ASCII puro y CRLF**.
No se entregan los archivos de `vbas/` tal cual por tres razones:

1. **Encoding.** El editor de VBA supone codificaciones distintas en Windows y Mac; un comentario
   con "protección" se lee "protecciÃ³n" o "protecci?n" según dónde caiga. Las fuentes de `vbas/`
   conservan acentos porque son lo que se lee y se diffea; la transliteración es empaquetado.
   El generador **falla** si encuentra un carácter no-ASCII dentro de un literal de string — eso
   sería texto de UI que se rompe al importar, y para eso el proyecto ya usa `ChrW()`.
2. **`Attribute VB_Name`.** `Module2`/`Module4` viven como `.txt` y no lo traen.
3. **Dos destinos.** `Module1` normal vs compat son distintos y ambos deben llamarse `Module1`.

`ThisWorkbook.txt` se **pega**, no se importa. Al pegar cualquier módulo hay que **omitir la primera
línea** `Attribute VB_Name` (sirve al importar; pegada, VBA la marca como error).

## Verificación

`tools/test/vba-protection.test.js` (en la suite de `tools/run-tests.sh`):

1. Bloques balanceados, etiquetas de `GoTo` resueltas, cada `SA_Desproteger` con su `SA_Proteger`,
   ningún `Exit Sub` atrapado, y toda `SA_*` invocada existe y es `Public`.
2. Trinquete de sincronía: regenera la carpeta de entrega y compara byte a byte. Si alguien edita
   `vbas/` y no regenera, la plantilla se queda con código viejo y **nada más lo delata**.

Se comprobó que el test **detecta**: cada regla se valida reintroduciendo a propósito el error que
busca.

**La regla 7 también la puso Excel: `eNum` ES `Enum`.** VBA es *case-insensitive*, así que
`Dim eNum As Long` se lee `Dim Enum As Long` y muere con un escueto `Syntax error` que no nombra la
palabra culpable. Estaba en **tres** módulos (`Module2`, `Module4`, `Module5`), renombrado a
`errNum`/`errDesc`. En camelCase —la convención del proyecto— la colisión es invisible: el
identificador se lee distinto y para el compilador es el mismo.

*Y el test cayó en el bug que buscaba.* La primera versión de la regla filtraba con un lookahead
`(?:Dim|Private|…)\s+(?!Sub\b|…|Enum\b|…)`; con el flag `i`, la alternativa `Enum\b` **matcheó
`eNum`** y descartó la línea antes de examinarla — el test pasó en verde con tres módulos rotos.
Por eso la comprobación se duplicó con un script independiente que extrae los identificadores por
otra vía: cuando un test da verde sobre código que sabemos roto, el problema no es el código.

**La regla 6 la puso Excel, no el test.** `Private mHuellaPrevia As String` se declaró junto al `Sub`
que la usa —donde uno la escribiría en cualquier otro lenguaje— y VBA exige **todas** las
declaraciones de módulo en la sección de arriba: una sola línea fuera de lugar tumba la compilación
del módulo entero con *"Only comments may appear after End Sub, End Function, or End Property"*.
El linter revisaba estructura de bloques y no orden de declaraciones, así que lo dejó pasar y el
error salió en la primera compilación real. *La lección no es "faltaba una regla" sino cuál era el
hueco: el test comprobaba que el código estuviera bien FORMADO, no que VBA lo aceptara.* Es el mismo
patrón del incidente de los `.xlsm` editados por XML — **el juez de un formato es la aplicación que
lo consume**, y aquí eso significa que `Depuración → Compilar VBAProject` no es opcional.

**Lo que este test NO prueba:** que el VBA **compile**, que los rangos existan, ni cómo se comporta
`UserInterfaceOnly` en Excel para Mac. *El juez de un `.xlsm` es Excel, no un linter* — la
compilación (`Depuración → Compilar VBAProject`) y la prueba de aceptación en el archivo real son
parte obligatoria de la instalación, no una nota al pie.

## Lo que costó más caro: perseguir el código cuando el problema era el entorno

Durante la puesta a punto, el sombreado y los feeders de los dropdowns "no reaccionaban". Se
hicieron **cinco** intentos de arreglo —quitar un modal que bloqueaba el hilo, acotar las hojas
que se desprotegen, sacar el ciclo de protección de la macro de evento, colgar la
resincronización de `SelectionChange`, y por último un vigilante con `Application.OnTime`— y
**ninguno arregló el síntoma**. Todos mejoraron el código; ninguno tocaba la causa.

La causa se encontró con **una prueba de diez segundos**: un libro NUEVO en blanco con un handler
de una línea (`Worksheet_SelectionChange` → escribir la hora en una celda) **tampoco disparaba**.
Los eventos de hoja estaban muertos en esa instancia de Excel para Mac. No era la plantilla, no
era el código, y no era reproducible en otra máquina.

Tres lecciones, en orden de lo que habría ahorrado más tiempo:

1. **Separar entorno de artefacto ANTES de tocar el artefacto.** El libro en blanco es la prueba
   más barata de toda la sesión y se hizo al final. Cuando algo "no reacciona", la primera
   pregunta no es *¿qué tiene mi código?* sino *¿funciona esto siquiera fuera de mi archivo?*
2. **`Application.EnableEvents = True` NO significa "los eventos funcionan".** El diagnóstico lo
   reportaba en `True` todo el tiempo. Esa bandera no cubre el modo interrupción de VBA ni un
   estado interno sucio tras horas de importar módulos y detener macros.
3. **Un diagnóstico se lee literal.** La prueba decía *"escribiendo H1 DESDE VBA el evento corre"*
   y se leyó como *"los eventos funcionan"*. Decía otra cosa: que corren **cuando los invoca VBA**.
   La diferencia entre las dos lecturas eran cuatro intentos.

El vigilante (`Application.OnTime`) **se descartó** y no va en ninguna plantilla: no arreglaba
nada y traía un riesgo propio — un `OnTime` pendiente sobrevive al cierre y hace que Excel
reabra el archivo solo.

## Hallazgos abiertos (no corregidos, fuera de alcance)

1. **`Hoja2` (= `CAT_Procesos`) tiene un `Worksheet_SelectionChange` legacy** que escribe la fila
   activa en `CAT_Procesos!K2` al hacer clic en la columna U *de esa misma hoja* — y **K2 tiene
   fórmula**. El handler vivo y correcto es el de `Upload`, que escribe en `I2`. Como CAT_Procesos
   no está protegida, el daño es silencioso. Se arregla borrando ese handler.
2. ~~Zona de datos de `Upload` bloqueada casi completa~~ — **DESCARTADO el 2026-08-07.** Se midió el
   `.xlsm` **en disco** (mtime 19:30) mientras el archivo llevaba ~1h40m abierto en Excel con el
   *lock* `~$…` presente: el trabajo real estaba en memoria, sin guardar. **Lección de método: el
   mtime y el archivo de bloqueo son parte de la medición, no metadatos decorativos.** Un `.xlsm`
   abierto no es una fuente de verdad sobre lo que su autor lleva hecho, y afirmar sobre él un
   estado "incompleto" es leer un borrador y llamarlo entrega.
3. **`CAT_Procesos!M2` sin copiar hacia abajo (plantilla de COMPATIBILIDAD).** La lista de
   procesos posibles usa el patrón "FILTER sin FILTER" de Excel 2019:
   `=SI.ERROR(INDICE($G$2:$G$1581;COINCIDIR(FILAS($M$2:M2);$R$2:$R$1581;0));"")`. Ese patrón **no
   desborda**: hay que copiarlo en tantas filas como resultados quepan, porque `FILAS($M$2:M2)`
   es el contador de la k-ésima coincidencia. Estaba **sólo en M2**, así que jamás podía dar más
   de un proceso — cuando el máximo real medido sobre las 1,233 combinaciones del catálogo es
   **4**. Corregido copiando a `M2:M10`.
   Lo delator: en la misma hoja, `O` (specs, mismo patrón) sí estaba copiada a 59 filas y
   `P/Q/R` (los helpers del filtro) a 1580. Quien la armó sabía que había que copiar; **se le
   quedó una columna**. La moderna no tiene el bug porque ahí la lista sale de `FILTER`/`UNIQUE`,
   que desborda solo — y por eso el defecto vivió sin que nadie lo viera.
   Pendiente menor: la validación de `U9:U508` sigue con `CONTARA(CAT_Procesos!$M:$M)-1`, que
   **cuenta las celdas cuya fórmula devuelve `""`**, así que el desplegable muestra 9 opciones
   (4 reales + 5 en blanco). Se limpia con
   `MAX(1;CONTAR.SI(CAT_Procesos!$M$2:$M$10;"?*"))`. Mismo patrón en `CAT_Specs!G`.

4. **Deriva entre las tres copias del mismo módulo.** `Module4` tenía `F3` donde el quoteName vive
   en `G3` (label en `E3`, valor en `G3`, `F3` vacía): en modo SOLO_PN el campo del layout quedaba
   gris —leyéndose como deshabilitado cuando sí aplica— y se despintaba una celda vacía. El `.xlsm`
   **moderno ya traía la corrección; la compat y la copia del repo no**. Se sincronizó a `G3` en las
   tres. *Un módulo que vive en tres archivos distintos se desfasa en dos de ellos sin avisar.*
