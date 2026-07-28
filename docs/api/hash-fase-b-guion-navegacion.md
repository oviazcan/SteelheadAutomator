# Guion de navegación — Fase B discovery (hash-autopilot v2)

**Objetivo:** con el hash-scanner **instrumentado** corriendo, navegar el ERP una vez para que el frontend dispare sus queries y el scanner capture, por cada op, **la pantalla + el clic** que la disparó. De ese scan Claude genera `route-catalog.json` (economía de clics) para que el autopilot autocorrija esas queries.

> **Requisito:** el scanner debe ser la versión instrumentada (Fase B). Si el popup no dice "captura pantalla", avísale a Claude — falta el deploy.

## Cómo empezar
1. Abre `app.gosteelhead.com` y entra a tu dominio.
2. Popup de la extensión → **hash-scanner** → **Iniciar captura**.
3. Navega la lista de abajo **sin prisa**: deja cargar cada pantalla ~3 s (para que dispare sus queries) y, donde diga "abre 1", haz clic para entrar al detalle.
4. Al terminar: **Detener** → **Descargar** el `scan_results_*.json` → pásaselo a Claude.

## Recorrido por módulo (marca cada uno)

### 🔴 Prioridad alta — cubren las rotaciones detectadas
- [ ] **Números de parte** — abre la lista de PNs; **abre 1 número de parte** (dispara `GetPartNumber` — rota, toca ~12 applets)
- [ ] **Facturación** — abre una **factura**; abre su detalle (dispara `InvoiceByIdInDomain`, `GetReceivedOrdersWithReceivedOrderLineItems`)
- [ ] **Procesos** — abre un **proceso**; abre su árbol/nodo (dispara `GetProcessNode`)

### Recorrido general (cobertura amplia)
- [ ] **Home / Dominio** — abre `/Domains/{tu-dominio}` (CurrentUser, layout)
- [ ] **Clientes** — abre la lista de Clientes; **abre 1 cliente**
- [ ] **Órdenes Recibidas (OV)** — abre la lista; **abre 1 OV**; abre sus partes / PT
- [ ] **Órdenes de Trabajo (OT)** — abre la lista; **abre 1 OT**; abre su ruteo
- [ ] **Bills / CxP** — busca una PO; **abre 1 bill**
- [ ] **Inventario** — abre la lista de lotes/inventario; **abre 1 lote**
- [ ] **Sensores / Dashboards** — abre Dashboards; **abre 1 dashboard**
- [ ] **Reportes** — abre la lista de reportes; **abre 1 reporte**
- [ ] **Mantenimiento** — abre un nodo de mantenimiento
- [ ] **Almacén / Surtido** — abre la pantalla de surtido/almacén si aplica

## Al terminar
- **Detener captura** → **Descargar** `scan_results_*.json` → entregar a Claude.
- Claude corre `build-catalog.mjs <scan>` → actualiza `route-catalog.json` + reporta **% de cobertura** y qué queries quedaron **sin ruta**.
- Esas faltantes se cubren en una **2ª pasada dirigida** (solo esos módulos) — Claude te dirá cuáles.

## Notas
- **No hace falta video.** El scanner registra pathname + el botón/link que clicaste; el clic y la pantalla quedan guardados solos.
- Entre más detalles abras (no solo listas), más queries se capturan. Las pantallas de **detalle** (abrir 1 objeto) son las que disparan las queries "por id".
- Las **mutations** (guardar/archivar/borrar) NO se capturan navegando — esas son Fase C (ciclo centinela). Este guion es solo para **queries**.
