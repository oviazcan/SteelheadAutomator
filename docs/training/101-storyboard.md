# Storyboard — Presentación “SteelheadAutomator 101”

> **Para quién es este archivo:** es el **guión de diseño** de la presentación, pensado para que
> **Cowork o Claude PowerPoint** lo conviertan en un deck con acabado profesional. Cada slide trae
> el mensaje único, el texto exacto, el visual a dibujar (con referencia Mermaid cuando es un flujo),
> la metáfora y las notas del orador. El deck HTML de primer borrador ya construido vive en
> `101-deck.html` — úsalo como referencia visual viva.
>
> **Documento perenne.** Enseña conceptos estables. Las cifras van en *relativo* (“~41 applets”); el
> conteo exacto vive en el `inventario-applets.html` (documento vivo).

---

## Dirección de diseño (para el diseñador)

- **Tono:** manual técnico de campo / plano de ingeniería. Serio, claro, con un toque industrial (el
  cliente es de acabado de metales: Steelhead = acero, Ecoplating = electroplateado).
- **Paleta:** neutros acero (fondo casi blanco `#f7f9fb`, tinta `#182231`, acero estructural `#2b3f52`),
  **acento verde del producto `#0f8f61`** (amarra el deck a la propia UI de la extensión). Codificación por
  audiencia: Key User = clay `#c0632e`, Jefe de TI = azul acero `#2f6f9f`.
- **Tipografía:** sans humanista para títulos y cuerpo; **monoespaciada** para códigos/identificadores
  (hashes, nombres de operación) — son parte del contenido, no decoración.
- **Regla de oro:** un mensaje por slide, mucho diagrama, poco texto. Prioriza lo visual sobre la longitud.

## Audiencia y duración

Mixta (Key User y Jefe de TI) en una sola sesión de **30–40 min**. Arranca a todos con el
mismo modelo mental; al final cada quien sigue por su ruta (ver slide 14 y el Mapa “Empieza aquí”).

## Arco narrativo (por qué este orden)

Problema → solución de una frase → **la gran idea** (cascarón+cerebro) → sus consecuencias (deploy,
hashes, seguridad) → de qué está hecho (applet) → los dos temas complejos como *teaser* → panorama →
cómo seguir. Se sube de lo concreto (dolor del operador) a lo abstracto (arquitectura) y se aterriza.

---

## Slide 1 — Portada

- **Mensaje único:** este es el mapa mental de cómo funciona SteelheadAutomator.
- **Texto:**
  - Título: **SteelheadAutomator 101**
  - Subtítulo: *Cómo funciona por fuera y por dentro.*
  - Pie: logo/marca · fecha de la sesión.
- **Visual:** portada limpia, marca “SA” en un cuadro acero, mucho aire. Sin diagramas.
- **Notas del orador:** “En los próximos 30 minutos van a entender qué es esta herramienta, cómo se
  construye y por qué está hecha así. No necesitan saber de programación; vamos con analogías.”

## Slide 2 — El problema

- **Mensaje único:** capturar miles de datos a mano en el ERP es lento y propenso a error.
- **Texto:**
  - Título: **El dolor: captura manual, miles de veces**
  - Bullets: “Dar de alta cientos o miles de números de parte, uno por uno” · “Cotizaciones, precios,
    specs, facturas… en pantallas repetitivas” · “Un error se cuela sin que nadie lo note”.
- **Visual:** ilustración de una fila interminable de formularios idénticos; una pila que no baja.
- **Metáfora:** llenar 8,000 formularios en un mostrador, uno por uno.
- **Notas:** aterriza con un caso real (“una carga típica son miles de números de parte”).

## Slide 3 — Qué es

- **Mensaje único:** SteelheadAutomator automatiza esas tareas dentro del navegador.
- **Texto:**
  - Título: **Qué es SteelheadAutomator**
  - Bullets: “Una **extensión de Chrome** que se instala en el navegador” · “Automatiza ~41 tareas dentro
    del ERP Steelhead (`app.gosteelhead.com`)” · “Desde carga masiva hasta autocompletar facturas”.
- **Visual:** captura estilizada del navegador con el panel de la extensión (dark mode) encima de la UI
  clara de Steelhead. *(Placeholder: pedir screenshot real al operador.)*
- **Notas:** “Nótese: nuestra UI es oscura a propósito, para que el operador sepa de un vistazo que
  es la extensión y no una pantalla nativa de Steelhead.”

## Slide 4 — LA GRAN IDEA: cascarón + cerebro remoto  ⭐

- **Mensaje único:** la extensión instalada es “tonta”; su inteligencia vive en un servidor y se
  descarga cada vez.
- **Texto:**
  - Título: **La idea clave: cascarón + cerebro remoto**
  - Bullets: “La caja instalada casi nunca cambia” · “Toda la lógica vive en GitHub Pages (un sitio web)”
    · “La extensión la **descarga y ejecuta** cada vez que la usas”.
- **Visual (Mermaid de referencia):**
  ```mermaid
  flowchart LR
    U[Operador] --> E[Extensión<br/>“cascarón”]
    E -- 1 descarga config + scripts --> G[(GitHub Pages<br/>“cerebro”)]
    G -- 2 código + firma --> E
    E -- 3 ejecuta sobre --> S[ERP Steelhead]
  ```
- **Metáfora:** un **decodificador de TV** que baja su firmware/app del servidor; la caja física no
  cambia, el contenido sí. (La app de Netflix en tu tele es un cascarón; las pelis y hasta la interfaz
  llegan del servidor.)
- **Notas:** este es el concepto más importante del deck. Deténte aquí. Todo lo demás se deriva de esto.

## Slide 5 — Por qué importa

- **Mensaje único:** se corrige y mejora sin reinstalar; todos reciben al instante.
- **Texto:**
  - Título: **Por qué se construyó así**
  - Bullets: “Corregir un bug = editar el ‘cerebro’, no reinstalar 20 navegadores” · “Todos reciben la
    mejora al instante” · “Se puede iterar varias veces por semana”.
- **Visual:** un cambio en el centro (servidor) irradiando a muchos navegadores a la vez.
- **Notas:** contrasta con el modelo tradicional (“publicar en la tienda de extensiones y esperar días”).

## Slide 6 — Cómo se publica: cocina de pruebas vs. menú servido

- **Mensaje único:** editar el borrador no afecta a nadie hasta que se “publica”.
- **Texto:**
  - Título: **Del borrador a producción, en un paso seguro**
  - Bullets: “`main` = cocina de pruebas (borrador privado)” · “`gh-pages` = el menú que sí se sirve” ·
    “Un script de deploy: corre pruebas → firma → publica → deja un punto de restauración”.
- **Visual (Mermaid de referencia):**
  ```mermaid
  flowchart LR
    M[main<br/>cocina de pruebas] -- deploy.sh:<br/>tests · firma · espejo --> P[gh-pages<br/>menú servido]
    P --> CDN[GitHub Pages] --> Ext[Extensiones de todos]
  ```
- **Metáfora:** la **cocina de pruebas** vs. el **menú del comensal**. Experimentas en la cocina todo el
  día; el comensal solo recibe lo publicado.
- **Notas:** clave para TI: “editar el borrador NO afecta usuarios; solo el deploy lo hace”.

## Slide 7 — La conexión con el ERP: los “hashes”

- **Mensaje único:** la extensión le habla al ERP con códigos cortos, no con preguntas completas.
- **Texto:**
  - Título: **Cómo le hablamos al ERP: llaves y cerraduras**
  - Bullets: “Cada consulta al ERP se abre con una **llave**: un código de 64 caracteres (el ‘hash’)” · “Es más
    rápido y el detalle de la petición queda del lado del servidor” · “La técnica se llama *persisted queries*”.
- **Visual:** extensión → “uso mi llave” → servidor con la cerradura (llave → GetPartNumber).
- **Metáfora:** la **llave y la cerradura**: usas una llave (código corto) en vez de describir la petición completa.
- **Notas:** siembra la semilla para el slide 8 (qué pasa cuando cambian la cerradura).

## Slide 8 — Cuando cambian la cerradura: rotación (teaser de la ficha)

- **Mensaje único:** Steelhead cambia la cerradura sin avisar, y un robot deduce la nueva llave solo.
- **Texto:**
  - Título: **Cuando Steelhead cambia la cerradura**
  - Bullets: “Una actualización de Steelhead cambia la cerradura → la llave vieja deja de servir (`HTTP 400`)” ·
    “Un robot, **Hash-Autopilot**, lo detecta y deduce la nueva llave” · “Lo publica solo, en 3 proyectos
    a la vez, cada hora”.
- **Visual:** mini-versión del ciclo de 5 etapas (Detectar → Recapturar → Validar → Publicar → Notificar).
- **Metáfora:** un **cerrajero automático** que nota que la llave ya no abre y deduce la nueva sin que
  muevas un dedo.
- **Notas:** “Si quieren el detalle fino, hay una **ficha profunda** dedicada a esto.” (No profundizar aquí.)
- **Human-in-the-loop (agregar como bullet extra o slide corta):** aclarar que Hash-Autopilot repara el **caso común** pero **no el 100%** — hay casos (rutas de captura no probadas, deprecaciones, objetos de prueba rotos, demasiadas rotaciones de golpe) donde **entra un humano**: recupera la nueva llave con el **escáner de Steelhead** y se la pasa a **Claude**, que hace el ajuste y lo despliega. (Ver el Runbook — recuperar hashes a mano.)

## Slide 9 — La seguridad: el sello de lacre

- **Mensaje único:** la extensión solo ejecuta código con un sello auténtico que nadie más puede fabricar.
- **Texto:**
  - Título: **Seguridad: el sello que nadie puede falsificar**
  - Bullets: “Cada publicación se **firma criptográficamente** (ECDSA P-256)” · “La llave privada vive en
    una bóveda de Google (KMS), nunca en el código” · “La extensión rechaza cualquier script sin el sello
    correcto — *fail-closed*”.
  - **Nota en la slide (caveat, ámbar):** *Aplica desde la extensión **v1.6.6**. Cada equipo queda protegido al **actualizar** a esa versión (o posterior); los que sigan en una anterior aún no tienen la verificación activada.*
- **Visual (Mermaid de referencia):**
  ```mermaid
  flowchart LR
    K[(Bóveda KMS<br/>llave privada)] -- firma --> C[config + firma]
    C --> Ext[Extensión]
    Ext -- verifica con<br/>llave pública embebida --> D{¿sello válido?}
    D -- sí --> R[ejecuta]
    D -- no --> X[rechaza · no ejecuta nada]
  ```
- **Metáfora:** un **sello de lacre / holograma anti-manipulación**. Aunque un atacante entrara a GitHub
  y cambiara el script, el falso no llevaría el sello genuino (que vive en la bóveda de Google).
- **Notas:** para TI: “es el mismo patrón de firma de código que usan Windows/macOS para validar
  instaladores, aplicado a nuestro sistema de recarga en caliente.”

## Slide 10 — Qué es un “applet”

- **Mensaje único:** cada herramienta está hecha de una parte “pura” testeable y un orquestador.
- **Texto:**
  - Título: **De qué está hecha cada herramienta**
  - Bullets: “**Núcleo puro**: reglas de negocio sin tocar la red; se prueba solo (cientos de tests)” ·
    “**Orquestador**: conecta el núcleo con el ERP y la pantalla” · “Una entrada en el catálogo (`config.json`)
    lo registra”.
- **Visual:** diagrama de anatomía: [core puro + golden test] + [orquestador] + [entrada en config].
- **Metáfora:** el **golden test** = una foto de referencia contra la que se compara (“debe dar
  exactamente estos números que verificamos a mano”).
- **Notas:** subrayar que esto es lo que permite cambiar rápido sin romper reglas viejas.

## Slide 11 — El más complejo: Carga Masiva (teaser de la ficha)

- **Mensaje único:** la carga masiva clasifica la intención de cada corrida y tiene un “carril express”.
- **Texto:**
  - Título: **El applet estrella: Carga Masiva**
  - Bullets: “Toma un Excel con miles de filas → lo carga al ERP” · “**Clasifica la intención** de la corrida
    (triage): ¿solo precio? ¿enriquecimiento? ¿alta?” · “Si es solo-precio, toma un **carril express** más
    rápido y seguro; ante ambigüedad, **pregunta** antes de escribir”.
- **Visual:** mini-flujo Excel → triage → (express | completo) → ERP.
- **Metáfora:** **triage médico** + **carril express de aduana** (“nada que declarar más que el precio”).
- **Notas:** “Tiene su **ficha profunda** con un incidente real y cómo se resolvió.” (No profundizar aquí.)

## Slide 12 — Panorama de lo que hace

- **Mensaje único:** son ~41 herramientas en 8 familias funcionales.
- **Texto:**
  - Título: **Todo lo que sabe hacer, de un vistazo**
  - Bullets (8 familias): Carga y datos masivos · Ciclo de vida de PNs · Órdenes y ruteo · Facturación ·
    Inventario y programación · Procesos y producción · Sensores y reportes · Mantenimiento del sistema.
- **Visual:** 8 tarjetas/íconos, una por familia; nota “~41 applets — lista completa en el Inventario vivo”.
- **Notas:** NO leer los 41; solo mostrar la amplitud. Remitir al Inventario para el detalle.

## Slide 13 — Cómo se lee este paquete (recap del Mapa)

- **Mensaje único:** cada rol tiene una ruta de lectura y un color.
- **Texto:**
  - Título: **Tu ruta según tu rol**
  - 2 columnas: **Key User** → Manual del Operador + ficha Carga Masiva + 101 · **Jefe de TI** → 101 + Manual del
    Administrador + ficha Hash-Autopilot. De consulta para ambos: Inventario y Glosario.
- **Visual:** 2 tarjetas con el color de cada audiencia (como en el Mapa).
- **Notas:** “Todo esto está en el documento ‘Empieza aquí’, que es su índice.”

## Slide 14 — Cierre: 4 ideas para llevarse

- **Mensaje único:** los cuatro conceptos que resumen todo.
- **Texto:**
  - Título: **Cuatro ideas para llevarse**
  - Bullets: 1) **Cascarón + cerebro**: la inteligencia vive en el servidor, se actualiza sola. 2) **Llaves y
    cerraduras**: le hablamos al ERP con llaves; cuando cambian la cerradura, un robot deduce la nueva. 3) **Sello de lacre**: nada
    se ejecuta sin firma válida. 4) **Ante la duda, pregunta**: la política de seguridad de la carga masiva.
- **Visual:** los 4 íconos/metáforas juntos.
- **Notas:** cerrar invitando a las fichas profundas y los manuales; abrir preguntas.

---

## Apéndice — Metáforas maestras (consistencia de vocabulario)

| Concepto técnico | Metáfora del deck |
|---|---|
| Remote script loader / cascarón | Decodificador de TV que baja su firmware; Netflix en la tele |
| `main` vs `gh-pages` | Cocina de pruebas vs. menú servido |
| Persisted query / hash | La llave que abre una puerta (operación) |
| Rotación de hash (HTTP 400) | Steelhead cambia la cerradura; “esta llave ya no abre” |
| Hash-Autopilot | Cerrajero automático que deduce la nueva llave |
| Centinela / captura-y-aborta | Maniquí “PRUEBA” que se pasa por caja y se anula antes de cobrar |
| Firma ECDSA / KMS | Sello de lacre / holograma; llave en la bóveda de Google |
| classifyRunIntent | Triage médico |
| Fast-path SOLO_PRECIO | Carril express de aduana |
| Golden test | Foto de referencia contra la que comparas |

> Mantén estas metáforas idénticas entre el deck, los manuales y las fichas: la repetición del mismo
> vocabulario es lo que hace que el modelo mental “pegue”.

---

_Documento elaborado por [Omar Viazcán](mailto:oviazcan@capazconsultoria.com) · [Capaz Consultoría](https://capazconsultoria.com)._
