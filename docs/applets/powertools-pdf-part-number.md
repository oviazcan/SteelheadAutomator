# Power Tools `getPdfCustomization` — Ficha de Part Number (`pdf/PART_NUMBER_TEMPLATE.ts`)

Hook low-code que reordena/enriquece `partNumberProcessNodes[]` para que cada nodo tenga **todos** los `specFieldParams` que le aplican (uniendo los del treatment con los del partNumberSpec), y normaliza el array de `stations` para que la plantilla itere sin defenderse contra single-object vs array.

## Lo que devuelve

```ts
result.additionalPayload = partNumberProcessNodes.map(pnpn => ({
  ...pnpn,
  treatment: {
    ...pnpn.treatment,
    specFieldParams: <todos los SFP que matchean este processNode>,
    stations: <siempre array, no objeto>
  }
}))
```

La plantilla del PDF ya no necesita hacer joins; itera por nodo y pinta sus params + stations directo.

## Transformación de SFP

1. `transformedPartNumberSpecs`: aplana `partNumberSpecs[].specFields[]` a un shape compatible con `treatment.specFieldParams[]`. Mapea:
   - `spec.id` ← `pns.id`, `spec.customInputs` ← `pns.customInputs`
   - `specField.{id, name, type, isExternal, sensorInformation}` ← desde `sf.*`
   - `specField.processNodes: [{id: sf.processNodeId, name: sf.processNode}]` (singleton array)
   - `specFieldParam` ← `sf.specFieldParam` (passthrough)
2. `allSpecFieldParams` = `flatMap(pnpn.treatment.specFieldParams)` + `transformedPartNumberSpecs`.
3. Por cada `pnpn`, filtra `allSpecFieldParams` por `sfp.specField.processNodes.some(node => node.id === pnpn.processNode.id)` y los inyecta en `treatment.specFieldParams`.

## Normalización de `stations`

`pnpn.treatment.stations` puede venir como:
- Array de objetos `[{id, name}, ...]`
- Objeto singular `{id, name}`
- `null`/`undefined`

Después del hook: SIEMPRE array (`[]` si era null, `[{}]` si era singleton).

## Gotchas

- **Doble fuente de SFP**: si el mismo `specFieldParam.id` existe en `treatment.specFieldParams` Y en `partNumberSpecs.specFields`, queda duplicado. La plantilla debe dedupear si necesita unicidad.
- **`pnpn.processNode.id` puede ser null**: el filter por `node.id === pnpn.processNode.id` quedaría siempre false. En ese caso el nodo termina con `specFieldParams: []`.
- **Match estricto por `processNode.id`**: si un SFP tiene `processNodes: []` o `processNodes[].id` distinto del nodo current, no aparece. No hay fallback por nombre del nodo.

## Plan de validación pendiente

1. PN con un treatment y un partNumberSpec apuntando al mismo processNode: confirmar que ambos SFPs aparecen en `treatment.specFieldParams` del nodo.
2. PN con `treatment.stations` singleton: confirmar que en el output es array de 1 elemento.
3. PN sin treatments: confirmar `treatment === null` y no truena.

## Oportunidades

- Dedupear `specFieldParams` por `specFieldParam.id` para evitar duplicados entre fuentes.
- Soportar fallback de matching por nombre cuando `processNode.id` es null.
