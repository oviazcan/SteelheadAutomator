# Storyboard — Presentación “Reportes SH 101”

> **Para quién es este archivo:** es el **guión de diseño** de la presentación, pensado para que
> **Cowork o Claude PowerPoint** lo conviertan en un deck con acabado profesional. Cada slide trae
> el mensaje único, el texto exacto, el visual a dibujar (con referencia de flujo cuando aplica),
> la metáfora y las notas del orador. El deck HTML de primer borrador ya construido vive en
> `101-deck.html` — úsalo como referencia visual viva.
>
> **Documento perenne.** Enseña conceptos estables. Las cifras van en *relativo* (“~102 reportes”); el
> conteo exacto vive en el `inventario-reportes.html` (documento vivo).

---

## Dirección de diseño (para el diseñador)

- **Tono:** manual técnico de campo / plano de ingeniería. Serio, claro, con un toque industrial (el
  cliente es de acabado de metales: Steelhead = acero, Ecoplating = electroplateado).
- **Paleta:** neutros acero (fondo casi blanco `#f7f9fb`, tinta `#182231`, acero estructural `#2b3f52`),
  **acento verde del producto `#0f8f61`**. Codificación por audiencia: Key User / Consumidor de reportes =
  clay `#c0632e`, Jefe de TI / Administrador del sistema = azul acero `#2f6f9f`.
- **Tipografía:** sans humanista para títulos y cuerpo; **monoespaciada** para códigos/identificadores
  (placas `RPT-…`, nombres de tabla) — son parte del contenido, no decoración.
- **Regla de oro:** un mensaje por slide, mucho diagrama, poco texto. Prioriza lo visual sobre la longitud.

## Audiencia y duración

Mixta (Consumidor de reportes y Jefe de TI) en una sola sesión de **30–40 min**. Arranca a todos con el
mismo modelo mental; al final cada quien sigue por su ruta (ver slide 13 y el Mapa “Empieza aquí”).

## Arco narrativo (por qué este orden)

Problema → solución de una frase → **la gran idea** (la fotografía semanal + banco vs. línea) → sus
consecuencias (el ciclo, las placas, las plantas gemelas) → de qué está hecho (reporte → vista →
dashboard) → los temas delicados como *teaser* → panorama → cómo seguir. Se sube de lo concreto (el
dolor de cruzar datos a mano) a lo abstracto (la arquitectura) y se aterriza.

---

## Slide 1 — Portada

- **Mensaje único:** este es el mapa mental de cómo funciona Reportes SH.
- **Texto:**
  - Título: **Reportes SH 101**
  - Subtítulo: *Cómo nacen, corren y se publican los reportes de Steelhead.*
  - Pie: marca Capaz Consultoría · fecha de la sesión.
- **Visual:** portada limpia, marca “RSH” en un cuadro acero, wordmark de Capaz arriba a la derecha, mucho aire.
- **Notas del orador:** “En los próximos 30 minutos van a entender de dónde salen los reportes que usan, cómo se
  mantienen y por qué están hechos así. Vamos con analogías de planta.”

## Slide 2 — El problema

- **Mensaje único:** los datos del ERP están ahí, pero cruzarlos a mano para decidir es lento y frágil.
- **Texto:**
  - Título: **El dolor: los datos están, pero encerrados**
  - Bullets: “Producción, ventas, calidad, inventario… todo vive dentro de Steelhead” · “Cruzar dos áreas
    para una sola pregunta obliga a exportar, pegar en Excel y cuadrar a mano” · “Cada quien arma su propio
    número, y no siempre coinciden”.
- **Visual:** islas de datos separadas (Producción, Ventas, Calidad…) con puentes de Excel improvisados entre ellas.
- **Metáfora:** cada área guarda su información en su propia bodega, con candado distinto.
- **Notas:** aterriza con un caso real (“¿cuánto facturamos de lo que produjo la línea 3 el mes pasado?” cruza 3 áreas).

## Slide 3 — Qué es

- **Mensaje único:** Reportes SH es la capa de reportería a la medida de Steelhead.
- **Texto:**
  - Título: **Qué es Reportes SH**
  - Bullets: “~102 reportes escritos a la medida sobre los datos del ERP” · “Cada uno responde una pregunta de
    negocio concreta y se abre dentro de Steelhead” · “Con filtros propios: fechas, cliente, línea, turno…”.
- **Visual:** el mismo mapa de islas de la slide 2, ahora conectadas por un solo puente rotulado “Reportes SH”.
- **Notas:** “No es otro sistema que abrir: los reportes viven dentro de Steelhead, donde ya trabajan.”

## Slide 4 — LA GRAN IDEA: la fotografía semanal  ⭐

- **Mensaje único:** los reportes no corren sobre el ERP vivo; corren sobre una copia congelada que se
  baja cada semana.
- **Texto:**
  - Título: **La idea clave: la fotografía semanal**
  - Bullets: “Cada semana se baja una **fotografía completa** de los datos del ERP a un solo archivo” ·
    “Los reportes corren sobre esa foto, no sobre el ERP en vivo” · “Consultar la foto **no molesta** a la
    operación en tiempo real”.
- **Visual (flujo de referencia):**
  ```
  [ERP Steelhead en vivo] --(1) fotografía semanal--> [Copia congelada (un archivo)]
  [Copia congelada] --(2) corren--> [Los ~102 reportes]
  ```
- **Metáfora:** un supervisor toma una **foto del estado de las tinas** al cierre de turno para su bitácora;
  después analiza la foto con calma, sin tener que parar la línea para medir otra vez.
- **Notas:** este es el concepto más importante del deck. Deténte aquí. La consecuencia clave: un dato “de
  hoy” no aparece hasta la **próxima** fotografía. Es un intercambio a propósito: frescura semanal a cambio
  de no cargar el ERP en vivo.

## Slide 5 — Por qué se construyó así

- **Mensaje único:** trabajar sobre la copia permite consultas pesadas, seguras y repetibles.
- **Texto:**
  - Título: **Por qué sobre una copia y no en vivo**
  - Bullets: “Consultas pesadas sin frenar la operación” · “La copia es de **solo lectura**: imposible alterar
    un dato del ERP por accidente” · “Todos ven exactamente la misma foto: los números coinciden entre áreas”.
- **Visual:** un candado sobre la foto (solo lectura) y varias personas mirando la misma foto.
- **Notas:** contrasta con exportar a Excel cada quien por su lado (cada copia envejece distinto).

## Slide 6 — El ciclo: bajar la foto, escribir, publicar

- **Mensaje único:** el reporte nace en tres pasos: se baja la foto, se escribe la consulta, se publica de vuelta.
- **Texto:**
  - Título: **De la foto al reporte publicado**
  - Bullets: “**Bajar** la fotografía del ERP (*pull*)” · “**Escribir y afinar** la consulta contra la foto,
    verificando que dé lo correcto” · “**Publicar** el reporte de vuelta dentro de Steelhead (*push*), para
    que cualquiera lo abra”.
- **Visual (flujo de referencia):**
  ```
  Bajar la foto (pull) --> Escribir/afinar la consulta --> Publicar en Steelhead (push)
  ```
- **Metáfora:** *pull* = recoger las fotos reveladas del laboratorio; *push* = colgar el reporte terminado
  en el tablero de la línea, para que todos lo consulten.
- **Notas:** el reporte final corre **dentro de Steelhead** sobre la foto; el usuario no ve nada de esto, solo abre y filtra.

## Slide 7 — La placa del reporte

- **Mensaje único:** cada reporte tiene una placa que dice de quién es, de qué tipo y su número.
- **Texto:**
  - Título: **Cómo se nombra cada reporte**
  - Bullets: “Placa de 4 segmentos: `RPT-PRD-ANL-17`” · “`PRD` = departamento dueño · `ANL` = tipo · `17` =
    consecutivo” · “Tres tipos: **Catálogo** (una lista), **Analítica** (un cubo por fechas), **Control** (cumple/no cumple)”.
- **Visual:** la placa `RPT-PRD-ANL-17` descompuesta en sus 4 segmentos con color por segmento.
- **Metáfora:** la **placa/matrícula** del reporte — igual que una tina o un rack lleva su placa
  (`T203-TI00-011`), cada reporte lleva la suya y se ubica sin abrirlo.
- **Notas:** remitir al Inventario para la lista completa de placas.

## Slide 8 — De qué está hecho: reporte, vista, dashboard

- **Mensaje único:** un reporte es el dato; encima se le ponen vistas (tablas/gráficas) y varias vistas arman un dashboard.
- **Texto:**
  - Título: **Las capas de lo que ves**
  - Bullets: “El **reporte** es el cubo de datos (la consulta)” · “Una **vista** es una forma de mirarlo:
    una tabla, una gráfica de barras, un mapa de calor” · “Un **dashboard** junta varias vistas en un tablero”.
  - Nota al pie: “Un **filtro** (dropdown: cliente, línea, turno…) acota lo que muestra el reporte.”
- **Visual (flujo de referencia):**
  ```
  Reporte (cubo) --> Vista (tabla / gráfica) --> Dashboard (varias vistas en un tablero)
  ```
- **Metáfora:** el **cubo de datos** es la materia prima; la **vista** es cómo la presentas; el **tablero**
  reúne varias presentaciones en una sola pantalla directiva.
- **Notas:** hoy hay ~73 vistas y 3 dashboards; ver el Inventario.

## Slide 9 — Plantas gemelas: TLC y MTY

- **Mensaje único:** hay dos plantas en el sistema y todo reporte debe existir igual en ambas.
- **Texto:**
  - Título: **Dos plantas, los mismos reportes**
  - Bullets: “**TLC** (Tlalnepantla): la planta veterana, con años de historial” · “**MTY** (Monterrey):
    la planta nueva, apenas en arranque” · “Cada reporte se mantiene **espejado** en las dos”.
- **Visual:** dos plantas gemelas lado a lado; el mismo reporte reflejado en ambas.
- **Metáfora:** **plantas gemelas** de diseño idéntico — una con años de operación, otra recién instalada.
  Un reporte “vacío” en MTY casi siempre no es un error: es que la planta apenas arranca.
- **Notas:** clave para TI: un cambio en una planta se aplica también en la otra, siempre.

## Slide 10 — La conexión con el ERP: la llave y la cerradura

- **Mensaje único:** para bajar la foto y publicar reportes, el sistema le habla al ERP con llaves; a veces Steelhead cambia la cerradura.
- **Texto:**
  - Título: **Cómo le hablamos al ERP: llaves y cerraduras**
  - Bullets: “Cada operación contra Steelhead se abre con una **llave** (un código; en lo técnico, un *hash*)” ·
    “Cuando Steelhead se actualiza, **cambia la cerradura**: la llave vieja deja de abrir” · “Se recupera la
    nueva llave y se sigue trabajando”.
- **Visual:** el sistema usando una llave sobre una cerradura del ERP; una cerradura cambiada con la llave vieja rechazada.
- **Metáfora:** la **llave y la cerradura** (metáfora compartida con los otros sistemas de la familia
  Steelhead). Rotación = “Steelhead cambia la cerradura; esta llave ya no abre”.
- **Notas:** es mantenimiento de rutina, invisible para el consumidor de reportes; el detalle lo cubre el Manual del Administrador.

## Slide 11 — Los temas delicados: banco de pruebas vs. línea real (teaser)

- **Mensaje único:** un reporte puede salir perfecto en el banco de pruebas y fallar en la línea real; por eso se verifica en vivo.
- **Texto:**
  - Título: **Cuando el banco de pruebas engaña**
  - Bullets: “Un reporte corre perfecto en la copia local (**banco de pruebas**)… y sale vacío en Steelhead
    (**línea real**)” · “Dos causas típicas: la **ventana de fechas** corría un día de más; ciertos números
    “demasiado grandes” no viajaban al reporte en vivo” · “Se cazan verificando **en la línea real**, no solo en el banco”.
- **Visual:** dos tableros: “banco de pruebas ✓” y “línea real ✗”, con una lupa sobre el segundo.
- **Metáfora:** **banco de pruebas vs. línea real** — el banco no reproduce todas las condiciones de planta;
  algunas fallas solo aparecen al calibrar en producción.
- **Notas:** “Hay una **ficha profunda** dedicada a la ventana de fechas (el bug que tocó 53 reportes).” No profundizar aquí.

## Slide 12 — Panorama de lo que hace

- **Mensaje único:** son ~102 reportes en 14 departamentos.
- **Texto:**
  - Título: **Todo lo que cubre, de un vistazo**
  - Bullets (departamentos con más reportes): Producción · Ingeniería · Ventas · Almacén · Calidad · Compras ·
    Mantenimiento · Contabilidad · y más (RRHH, Sistemas, CxC/CxP, Laboratorio, Procesos).
- **Visual:** mosaico de tarjetas, una por departamento, con su conteo; nota “~102 reportes — lista completa en el Inventario vivo”.
- **Notas:** NO leer los 102; solo mostrar la amplitud. Remitir al Inventario para el detalle.

## Slide 13 — Cómo se lee este paquete (recap del Mapa)

- **Mensaje único:** cada rol tiene una ruta de lectura y un color.
- **Texto:**
  - Título: **Tu ruta según tu rol**
  - 2 columnas: **Consumidor de reportes** → Manual del Operador + ficha Cliente combinado + 101 ·
    **Jefe de TI** → 101 + Manual del Administrador + ficha La ventana de fechas. De consulta para ambos: Inventario y Glosario.
- **Visual:** 2 tarjetas con el color de cada audiencia (como en el Mapa).
- **Notas:** “Todo esto está en el documento ‘Empieza aquí’, que es su índice.”

## Slide 14 — Cierre: 4 ideas para llevarse

- **Mensaje único:** los cuatro conceptos que resumen todo.
- **Texto:**
  - Título: **Cuatro ideas para llevarse**
  - Bullets: 1) **La fotografía semanal**: los reportes corren sobre una copia congelada del ERP, de solo
    lectura. 2) **Bajar → escribir → publicar**: el ciclo con que nace cada reporte. 3) **Plantas gemelas**:
    todo reporte existe igual en TLC y MTY. 4) **Banco vs. línea real**: se verifica en vivo, porque el banco
    de pruebas a veces engaña.
- **Visual:** los 4 íconos/metáforas juntos (foto · ciclo · plantas gemelas · banco/línea).
- **Notas:** cerrar invitando a las fichas profundas y los manuales; abrir preguntas.

---

## Apéndice — Metáforas maestras (consistencia de vocabulario)

| Concepto técnico | Metáfora del deck |
|---|---|
| Snapshot / copia DuckDB | La fotografía semanal de la planta |
| Copia de solo lectura | La foto con candado: se mira, no se altera |
| Bajar definiciones y foto (*pull*) | Recoger las fotos reveladas del laboratorio |
| Publicar el reporte (*push*) | Colgar el reporte en el tablero de la línea |
| Placa `RPT-DEP-TIPO-NN` | La placa/matrícula del reporte |
| Copia local (banco) vs. Steelhead (vivo) | Banco de pruebas vs. línea real |
| Trampas server-side (fechas, números grandes) | Fallas que solo aparecen en la línea real |
| Dos dominios TLC / MTY | Plantas gemelas: la veterana y la de arranque |
| Cascada de precio / tipo de cambio | Cadena de repuestos de respaldo del almacén |
| Persisted query / hash | La llave que abre una operación del ERP |
| Rotación de hash | Steelhead cambia la cerradura; “esta llave ya no abre” |
| Reporte → Vista → Dashboard | Cubo de datos → forma de mirarlo → tablero directivo |

> Mantén estas metáforas idénticas entre el deck, los manuales y las fichas: la repetición del mismo
> vocabulario es lo que hace que el modelo mental “pegue”. **No** uses metáforas de “menú/plato de
> restaurante”. La metáfora **llave/cerradura** se reserva para la conexión con el ERP (slide 10).

---

_Documento elaborado por [Omar Viazcán](mailto:oviazcan@capazconsultoria.com) · [Capaz Consultoría](https://capazconsultoria.com)._
