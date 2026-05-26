# Power Tools `getPdfCustomization` — Etiqueta de Rack (`pdf/RACK_TEMPLATE.ts`)

Hook low-code mínimo: calcula el índice del rack actual dentro del set de racks "hermanos" del mismo WO + mismo tipo, y lo expone como `rackIndexLabel = "{index}/{total}"` para que la plantilla lo imprima en el header.

## Lo que hace

1. Toma `inputs.rack` (current).
2. Si null → return vacío (`additionalPayload: {}`).
3. Determina el WO actual: `currentRack.workOrders[0].idInDomain` o fallback a `currentRack.partLocations[0].workOrder.idInDomain`.
4. Combina `[currentRack, ...inputs.childRacks]`.
5. Filtra por **mismo WO** + **mismo type** (heurística: `r.name === currentRack.name` — el "type" se infiere del name).
6. Sort por `r.rackId ASC`.
7. `index = findIndex(rackId === currentRack.rackId) + 1`; `total = sortedRacks.length`.
8. `additionalPayload.rackIndexLabel = "{index}/{total}"`.

## Gotchas

- **"type" inferido por `name`**: si el cliente etiqueta dos racks distintos con el mismo nombre (ej. "Rack A"), salen como hermanos aunque sean tipos distintos. Para una clasificación real conviene migrar a `r.rackType?.id` o a un `customInputs.type`.
- **`workOrders[0]` arbitrario**: si un rack tiene varios WOs (caso poco común pero válido en Steelhead) toma el primero. Index puede divergir entre racks "hermanos" si interpretan el WO distinto.
- **`childRacks` solo trae hijos directos**: si la jerarquía es de 3+ niveles, el set "hermanos" no incluye nietos. Aceptable para el caso de uso actual (rack contenedor + sus tarimas).
- **`rackId || 0` en sort**: racks sin `rackId` van al inicio. Si todos lo tienen, sin impacto.

## Plan de validación pendiente

1. Set de 3 racks del mismo WO + mismo nombre: confirmar `1/3`, `2/3`, `3/3` al generar PDF en cada uno.
2. Rack sin hermanos del mismo WO: confirmar `1/1`.
3. `inputs.rack === null`: confirmar que no truena (return vacío).

## Oportunidades

- Sustituir heurística `name === name` por `rackType.id === rackType.id` (más robusto contra renombrados).
- Soportar jerarquías profundas: en lugar de `inputs.childRacks` directos, navegar por `parentRack` recursivamente para sacar todos los descendientes.
