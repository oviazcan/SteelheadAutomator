# Popup Layout Redesign

## Resumen

Rediseñar el menú principal del popup de la extensión para soportar dos modos de vista (grid 3 columnas y lista agrupada por categorías), con toggle persistente. Agregar botón de grabación rápida en la barra de estado.

## Toggle de vista

- Nuevo botón en la barra de estado, junto a los existentes (🌙 ⚙️ 📋 🔃)
- Muestra el icono del modo opuesto: `▦` cuando está en lista (click → grid), `≡` cuando está en grid (click → lista)
- Persiste en `localStorage` con clave `sa-view-mode`, valores `grid` | `list`
- Default: `grid`

## Vista Grid (3 columnas)

- Tiles cuadrados: icono 26px centrado + nombre corto (9px bold) debajo
- `display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px`
- Sin subtítulo, sin categorías — todas las apps planas
- Padding: 10px
- Tile: `background: var(--bg-card); border: 1px solid var(--border-card); border-radius: 8px; padding: 10px 4px; text-align: center; cursor: pointer`
- Hover: `border-color: #38bdf8` (mismo que app-card actual)

## Vista Lista (agrupada)

- Encabezados de categoría: 9px uppercase bold, color `var(--text-soft)`, letter-spacing 1px, border-bottom
- Filas: icono 16px + nombre 11px bold + chevron `›`
- Sin subtítulo (se ve al entrar al applet)
- Compacto: padding 8px por fila
- Orden de categorías: según orden de primera aparición en el array de apps

## Categorías en config.json

Nuevo campo `category` en cada objeto de `apps[]`:

```json
{ "id": "carga-masiva", "category": "Números de Parte", ... }
{ "id": "archiver", "category": "Números de Parte", ... }
{ "id": "auditor", "category": "Números de Parte", ... }
{ "id": "file-uploader", "category": "Números de Parte", ... }
{ "id": "spec-migrator", "category": "Números de Parte", ... }
{ "id": "wo-deadline", "category": "Órdenes de Trabajo", ... }
{ "id": "inventory-reset", "category": "Inventario & Facturación", ... }
{ "id": "cfdi-attacher", "category": "Inventario & Facturación", ... }
{ "id": "po-comparator", "category": "Inventario & Facturación", ... }
{ "id": "report-liberator", "category": "Herramientas", ... }
{ "id": "hash-scanner", "category": "Herramientas", ... }
```

Apps sin `category` van al final bajo "Otros".

## Botón de grabación rápida

- Ubicación: barra de estado, después de 📋 y antes de 🔃
- Estado inactivo: botón `🔴` con title "Iniciar captura"
- Click → envía mensaje `toggle-scan` al content script (mismo mecanismo que el botón del Explorador API)
- Estado activo (grabando): el botón cambia a `⏹` con animación blink (reutilizar `.scan-indicator` keyframes), title "Detener captura"
- El indicador `● REC` existente junto al texto de estado se mantiene como está — el botón nuevo es independiente pero ambos reflejan el mismo estado

## Archivos a modificar

1. `remote/config.json` — agregar `category` a cada applet
2. `extension/popup.html` — CSS para grid tiles, lista agrupada, botón toggle vista, botón rec
3. `extension/popup.js` — render dual (grid vs lista), persistencia localStorage, handler de rec
