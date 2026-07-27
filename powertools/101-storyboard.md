# Storyboard — «Steelhead Power Tools 101»

Guión slide por slide para reconstruir el deck en PowerPoint, Keynote o Google Slides (o para
regenerarlo con una herramienta de presentaciones asistida). El deck HTML equivalente vive en
`101-deck.html`; este documento es el guión: dirección de diseño, texto exacto, diagrama, metáfora
y notas del orador.

- **Duración objetivo:** 30–40 minutos + preguntas.
- **Audiencia:** mixta — Key Users/operadores y Jefe de TI/infraestructura. No hay una tercera.
- **Longevidad:** perenne. Las cifras van en relativo (“una veintena de ventanillas”, “~35 módulos probados”);
  los conteos exactos viven en el *Inventario de ventanillas* (documento vivo).

---

## Dirección de diseño (aplica a todo el deck)

| Elemento | Decisión |
|---|---|
| Estética | Manual técnico de campo. Nada de “corporativo genérico”. |
| Fondo | Claro (`#f7f9fb`), papel blanco para tarjetas y figuras. Versión oscura opcional. |
| Tipografía | Sans del sistema. Títulos 800, muy apretados (`letter-spacing:-.02em`). Cuerpo 17 px. |
| Acento | Verde producto `#0f8f61`. |
| Color por audiencia | Key User = terracota `#c0632e`. Jefe de TI = azul acero `#2f6f9f`. Se usa en el *kicker* de la slide, no en el fondo. |
| Diagramas | SVG plano: rectángulos redondeados, líneas de 1.5–2 px, flechas con punta triangular. Sin sombras ni degradados. |
| Densidad | Máximo 4 viñetas por slide, ~46 caracteres de ancho. Una idea por slide. |
| Franja de metáfora | Barra gris con borde izquierdo y el ícono 💡 al pie de la slide. Es donde vive la analogía. |
| Franja de advertencia | Misma forma, en ámbar, ícono ⚠. Solo para límites y riesgos. |

---

## Tabla de metáforas (repetirlas idénticas en todo el paquete)

| Concepto técnico | Metáfora canónica | Dónde se usa |
|---|---|---|
| Hook / punto de extensión low-code | **Ventanilla**: el ERP se detiene y pregunta “¿quieres decir algo?”. La hoja de instrucciones que dejas ahí es el hook. | Slides 3, 4, 16 |
| Versionado sin “actualizar” | **Capa de recubrimiento**: cada guardado deposita una capa encima; la de arriba es la que se ve. Revertir = volver a depositar. | Slide 7 |
| Ids por dominio vs. nombres | **Letrero contra número de casillero**: el letrero («KGM Kilogramo») es igual en las dos plantas; el número interno lo asignó cada planta por su cuenta. | Slides 8, 9 |
| Reparto hook ↔ plantilla PDF | **Surtir no es colocar**: el hook mide y entrega el material; la plantilla decide dónde va. | Slide 6 |
| Lógica probada aparte (`lib/`) | **Calibrador patrón y calibrador de piso**: el patrón vive en el laboratorio, con certificado; las copias de piso salen de él. | Slide 10 |
| Compilador antiguo del editor | **Habla un idioma de hace unos años**: si le hablas con modismos nuevos no protesta, se queda callado. | Slide 11 |
| Persisted query / hash (en el puente de sincronización) | **Llave y cerradura**: la llave abre una operación del ERP; si el proveedor cambia la cerradura, la llave vieja ya no abre. | Manual del Administrador (no aparece en el deck) |
| Slot sin código propio | **Formato de fábrica**: la ventanilla existe pero seguimos usando lo que trae el ERP. | Inventario, slide 3 |

> **Prohibido:** la metáfora de “menú/plato de restaurante” para el hash. Se descartó explícitamente.

---

## Slide 1 — Portada

- **Título:** `Power Tools 101`
- **Bajada:** *Cómo el ERP hace cosas que no venían de fábrica — y quién decide cuáles.*
- **Elementos:** marca `PT` en cuadro acero + “Steelhead Power Tools”; logotipo de Capaz Consultoría
  arriba a la derecha, sobre recuadro blanco; pie con “Presentación · perenne”, “Sesión 30–40 min”
  y el crédito de autoría.
- **Notas del orador:** presentarse, decir que la sesión es de modelo mental, no de manual: los
  manuales vienen después y cada quien lee el suyo.

## Slide 2 — El punto de partida

- **Kicker:** `02 · El punto de partida`
- **Título:** `Ningún ERP viene hecho a la medida de una planta`
- **Viñetas:**
  1. Steelhead trae su forma de facturar, imprimir y calcular — **la forma promedio**.
  2. Ecoplating tiene reglas propias: lote mínimo, descripción para el SAT, plantas Schneider,
     impuestos por renglón.
  3. Pedirle al proveedor cada regla cuesta **meses** y hace el sistema de todos, de nadie.
- **Franja 💡:** *El dilema: o adaptas la planta al sistema, o adaptas el sistema a la planta. La
  segunda es la que conserva la ventaja competitiva.*
- **Notas:** pedir a la sala un ejemplo propio de “así no lo hacemos aquí”. Sirve de ancla el resto
  de la sesión.

## Slide 3 — Qué son los Power Tools

- **Kicker:** `03 · La herramienta`
- **Título:** `Power Tools: una veintena de ventanillas abiertas en el ERP`
- **Viñetas:**
  1. Steelhead dejó **una veintena de puntos** donde se detiene y ejecuta código de Ecoplating antes de continuar.
  2. Cada punto es una **ventanilla**; la hoja de instrucciones que dejamos ahí es un **hook**.
  3. Hoy **casi todas están atendidas** — la mayoría con lógica completa, unas cuantas con el formato de fábrica a
     propósito.
  4. Todo corre **dentro** de Steelhead: no hay servidor aparte que mantener.
- **Franja 💡:** *Una línea de producción prefabricada, con ventanillas donde el fabricante te deja
  meter tu propia hoja de instrucciones.*
- **Notas:** subrayar el “no hay servidor aparte” — es la diferencia con la extensión de navegador,
  que sí tiene su propia infraestructura.

## Slide 4 — El mecanismo (diagrama)

- **Kicker:** `04 · El mecanismo`
- **Título:** `Qué pasa exactamente en una ventanilla`
- **Diagrama (3 cajas, izquierda a derecha):**
  - `Steelhead` — *junta todo el contexto: orden, partes, precios, unidades* (caja gris)
  - `La ventanilla` — *tu código lee los datos, calcula, valida y responde* (caja verde, resaltada;
    debajo, en monoespaciada: `hooks/invoice/invoice.ts`)
  - `Steelhead` — *continúa con tu respuesta: guarda, imprime, avisa* (caja gris)
  - Flechas etiquetadas `inputs` (entrada) y `result` (salida).
  - Pie del diagrama: *Todo ocurre en menos de un segundo, dentro de la misma pantalla del ERP.*
- **Leyenda de la figura:** *El hook nunca sale a buscar datos: Steelhead se los entrega ya resueltos
  y espera una respuesta.*
- **Notas:** este es el diagrama que hay que dejar pegado en la cabeza. Si alguien pregunta “¿de
  dónde saca los datos?”, la respuesta es: no los saca, se los dan.

## Slide 5 — Qué puede y qué no

- **Kicker:** `05 · El alcance`
- **Título:** `Tres cosas que hace un hook — y una que no`
- **Cuadrícula de 4 tarjetas:**
  - 🛡️ **Validar** — avisar al capturista que algo no cuadra, antes de guardar.
  - 🧮 **Calcular** — precios, conversiones, impuestos, dosis químicas.
  - 📄 **Enriquecer** — preparar los datos que se imprimen en un documento.
  - ⛔ **Reescribir el ERP** (tarjeta en rojo) — no puede cambiar cómo Steelhead arma una factura o
    guarda una orden.
- **Franja ⚠:** *El hook manda dentro de la ventanilla y nada más. Cuando algo no se puede hacer, no
  es falta de esfuerzo: es que esa decisión vive fuera de la ventanilla.*
- **Notas:** aquí se previene la pregunta “¿y no se puede hacer que la factura junte renglones?”.
  Respuesta corta: se intentó, con dos experimentos y facturas reales; no se puede desde el hook.
  Está documentado en la ficha de facturación.

## Slide 6 — El reparto (diagrama)

- **Kicker:** `06 · El reparto de responsabilidades`
- **Título:** `El hook surte los datos; la plantilla los coloca`
- **Diagrama (3 cajas):**
  - `El hook` (verde) — *mide, convierte y deja cada dato listo y con nombre* · `additionalPayload`
  - `La plantilla` (azul) — *decide dónde se pinta cada dato, con qué tamaño y color* ·
    `PDFGeneratorAPI · lado Steelhead`
  - `El PDF impreso` (gris) — *factura, remisión, etiqueta, certificado, orden de compra*
  - Pie: *Un cambio visual casi siempre es de dos lados.*
- **Leyenda:** *Si un dato existe pero no se ve, falta el lado de la plantilla. Si se ve mal
  calculado, falta el lado del hook.*
- **Notas:** esta slide ahorra semanas de malentendidos con el proveedor. Cuando la operación pide
  “que salga tal cosa en el PDF”, la primera pregunta es de qué lado falta.

## Slide 7 — Versionado (diagrama de capas)

- **Kicker:** `07 · Cómo se guarda el trabajo`
- **Título:** `Cada cambio es una capa nueva; la última es la que corre`
- **Diagrama:** cuatro rectángulos apilados, del más viejo abajo al más nuevo arriba; el de arriba
  resaltado en verde con la palabra “activa” y una flecha que baja desde el texto *lo que el ERP
  ejecuta hoy*.
- **Viñetas (columna derecha):**
  1. Guardar **no reemplaza**: deposita una capa encima.
  2. La capa de arriba es la que el ERP ejecuta.
  3. Nada se borra: el historial completo queda.
  4. Revertir = **volver a depositar** el contenido de una capa vieja.
- **Franja 💡:** *Como un baño de recubrimiento: no se despega una capa anterior; se deposita otra
  encima. Lo que se ve es siempre la última.*
- **Notas:** decir explícitamente que **no existe un botón de “activar versión anterior”**: revertir
  siempre crea una capa nueva. Es lo que hace que el historial sea confiable.

## Slide 8 — Dos plantas (diagrama)

- **Kicker (azul TI):** `08 · La trampa más cara`
- **Título:** `Dos plantas, un solo código: letreros contra casilleros`
- **Diagrama:** dos marcos, Toluca y Monterrey. En ambos, la misma etiqueta azul
  «KGM Kilogramo». Debajo, el número interno: `3969` en Toluca, `5990` en Monterrey (este en rojo).
  Un signo `≠` grande al centro. Pie: *Buscar por número en la otra planta abre el casillero
  equivocado — y no avisa.*
- **Leyenda:** *Regla de oro: resuelve siempre por el nombre, nunca por el número interno.*
- **Notas:** los números son reales y verificados. Sirve decirlo: no es un ejemplo inventado.

## Slide 9 — Por qué falla callado

- **Kicker (azul TI):** `09 · Por qué esa trampa importa tanto`
- **Título:** `Ese error no truena: miente`
- **Viñetas:**
  1. Si el número no existe en la otra planta, el dato **no sale** en el documento.
  2. Si el número existe pero es **otra cosa**, sale un dato incorrecto en una factura o un
     certificado.
  3. Nadie ve un error rojo: el documento se imprime tan campante.
  4. Por eso hay una regla escrita, una prueba automática por módulo y una lista de verificación
     antes de publicar.
- **Franja ⚠:** *Un kilogramo confundido con otra unidad en un documento fiscal. Es el tipo de falla
  que no se detecta hasta que la detecta el cliente.*

## Slide 10 — El patrón de metrología

- **Kicker (azul TI):** `10 · Cómo se evita`
- **Título:** `Un calibrador patrón para cada regla de negocio`
- **Viñetas:**
  1. Cada regla vive **dos veces**: como pieza patrón probada fuera del ERP y como copia dentro del
     hook.
  2. La pieza patrón trae su **certificado**: una prueba automática que la verifica.
  3. Hoy: **35 piezas patrón, 472 pruebas**, todas en verde antes de publicar.
  4. Varias pruebas existen solo para gritar si alguien vuelve a resolver por número interno.
- **Franja 💡:** *Como en metrología: el patrón vive en el laboratorio y se verifica; los de piso son
  copias suyas. Si cambias el patrón, recalibras las copias — nunca al revés.*
- **Notas:** si preguntan por qué la lógica está duplicada: el editor del ERP recibe **un solo
  archivo**, no puede importar nada. La copia inline es obligatoria; el patrón existe para poder
  probarla.

## Slide 11 — El editor antiguo

- **Kicker (azul TI):** `11 · Una restricción heredada`
- **Título:** `El editor del ERP habla un idioma de hace unos años`
- **Viñetas:**
  1. El compilador que trae Steelhead entiende una versión antigua del lenguaje.
  2. Si le escribes con modismos nuevos, **no protesta: se queda callado** y el hook deja de correr.
  3. El proyecto fija esa versión en su configuración y la revisa antes de publicar.
  4. Cuesta un día encontrarlo la primera vez y cero las siguientes, porque está escrito.
- **Franja 💡:** *Todo lo que se publica se compila primero con esa misma versión. El puente de
  publicación lo hace solo.*

## Slide 12 — El ciclo de trabajo (diagrama)

- **Kicker (azul TI):** `12 · El ciclo de trabajo`
- **Título:** `Cómo se cambia un hook sin sustos`
- **Diagrama:** cinco círculos numerados en línea, con flechas entre ellos:
  1. **Bajar** — *lo que corre hoy*
  2. **Editar** — *patrón + copia*
  3. **Probar** — *472 pruebas en verde*
  4. **Publicar** — *a las dos plantas* (verde)
  5. **Verificar** — *comparar contra el ERP* (verde)
- **Leyenda:** *Publicar a las dos plantas no es opcional: es parte del mismo paso. Un hook publicado
  solo en una planta es una divergencia esperando a doler.*
- **Notas:** el paso 1 no es decorativo. Si alguien editó desde la interfaz del ERP, tu copia local
  está vieja y publicar encima borra su trabajo.

## Slide 13 — Del lado del operador

- **Kicker (terracota Key User):** `13 · Del lado del operador`
- **Título:** `La cara visible: los avisos de colores`
- **Viñetas:**
  1. **Rojo** — algo está mal y hay que corregirlo antes de seguir.
  2. **Amarillo** — merece tu atención pero puede ser normal.
  3. **Azul** — información útil: la especificación aplicada, el tipo de cambio del día.
  4. **Verde “Todo en Orden”** — el sistema revisó y no encontró nada.
- **Franja 💡:** *El verde es un latido: confirma que el sistema sí revisó. Si no aparece ni verde ni
  rojo, algo dejó de correr — repórtalo.*
- **Notas:** esta es la slide más útil para la sala operativa. Vale la pena abrir Steelhead en vivo y
  mostrar los chips reales de una orden de venta.

## Slide 14 — Los planes de baño

- **Kicker:** `14 · Más allá de las ventanillas`
- **Título:** `La química de la planta también es Power Tools`
- **Viñetas:**
  1. **24 planes de baño**, uno por tina de las líneas T205 y T107.
  2. El laboratorio captura la titulación; el plan calcula la **concentración** y la **dosis**.
  3. El operador ve “agrega N kg de tal reactivo”, no una fórmula.
  4. Los factores químicos están escritos dentro de cada plan; hay un camino trazado para
     centralizarlos.
- **Franja 💡:** *Análisis de laboratorio más receta de ajuste del baño, automatizados tina por tina.*

## Slide 15 — Rutas por audiencia

- **Kicker:** `15 · Cómo sigue`
- **Título:** `Después de esta sesión`
- **Dos tarjetas:**
  - **Key User · Operador** (terracota): 1) Manual del Operador · 2) Ficha de Facturación ·
    3) Inventario y Glosario de consulta.
  - **Jefe de TI · Infraestructura** (azul): 1) Manual del Administrador · 2) Ficha “Dos plantas,
    un solo código” · 3) Onboarding de Desarrollo si va a mantener el código.

## Slide 16 — Cierre

- **Kicker:** `16 · Para llevarse`
- **Título:** `Cuatro ideas`
- **Cuatro tarjetas numeradas:**
  1. **Ventanilla** — el ERP se detiene en una veintena de puntos y ejecuta código de Ecoplating.
  2. **Capa** — cada cambio se deposita encima; la última corre, nada se pierde.
  3. **Letrero, no casillero** — un solo código para dos plantas porque busca por nombre.
  4. **Surtir no es colocar** — el hook deja el dato listo; la plantilla decide dónde se pinta.
- **Franja 📘:** *Todo lo demás — avisos, versiones, comandos, incidentes — está en el paquete.
  Empieza por el Mapa.*

---

## Notas de producción

- **Si se rehace en PowerPoint:** conservar el orden y los kickers numerados; son la referencia que
  usan los manuales (“ver slide 6 del 101”).
- **Diagramas:** se pueden redibujar con las formas nativas de la herramienta. Mantener el código de
  color (verde = lo nuestro, azul = lado del proveedor o audiencia TI, gris = el ERP, ámbar = riesgo).
- **Qué NO meter:** capturas de pantalla del código. La sesión es de modelo mental; el código vive en
  las fichas y el onboarding.
- **Ensayo:** las slides 4, 6, 7 y 8 son las que hay que ensayar en voz alta. Las demás se explican
  solas.

---

*Documento elaborado por Omar Viazcán · Capaz Consultoría · Corte de referencia: 27 jul 2026.*
