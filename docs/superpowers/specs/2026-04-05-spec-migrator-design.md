# Migrador de Specs — Spec

## Objetivo

Nueva app que migra masivamente los PNs de una spec (archivada o no) a otra spec, seleccionando un parametro de espesor.

## Flujo

### Fase 1 — Lectura de spec actual desde URL

- El usuario esta en la pagina de una spec en Steelhead: `/specs/{idInDomain}/revisions/{revision}`
- La app parsea la URL para obtener `idInDomain` y `revision`
- Query `GetSpec` (hash: `88dad363...`) con `{ idInDomain, revision }`
- Extrae `partNumberSpecsBySpecId.nodes` → lista de PNs con esa spec
- Cada nodo tiene `{ id (partNumberSpecId), partNumberId, partNumberByPartNumberId: { name } }`

### Fase 2 — Seleccion de spec destino y parametro

Modal con:
1. Info de spec actual: nombre, cantidad de PNs
2. Buscador de spec destino: `SearchSpecsForSelect` (hash ya en config: `8e7723b3...`)
   - Variables: `{ like: "%search%", locationIds: [], alreadySelectedSpecs: [], orderBy: ["NATURAL"] }`
   - Dropdown con resultados
3. Al seleccionar spec destino, cargar parametros: `SpecFieldsAndOptions` (hash: `fc6242c2...`)
   - Variables: `{ specId }`
   - Response: `specById.specFieldSpecsBySpecId.nodes[]` con `defaultValues` que contiene los parametros
   - Cada specFieldSpec tiene params con id y nombre
4. Radio buttons para seleccionar UN parametro de espesor
5. Boton MIGRAR

### Fase 3 — Migracion masiva

Para cada PN de la lista:
1. `PartNumberSpecsSummary` (hash: `7f0434ef...`) con `{ partNumberId }`
   - Verificar `partNumberSpecsByPartNumberId.nodes` si la spec vieja tiene `archivedAt` null
2. Si la spec vieja NO esta archivada a nivel PN:
   - `SavePartNumber` (hash ya en config: `31a6c7d9...`) con `partNumberSpecsToArchive: [partNumberSpecId]`
   - El partNumberSpecId viene de la respuesta de PartNumberSpecsSummary (el id del PartNumberSpec que vincula el PN con la spec vieja)
3. `ApplySpecsToPartNumber` (hash: `91f6c915...`) con:
   ```json
   {
     "input": {
       "partNumberId": <pnId>,
       "specsToApply": [{
         "specId": <newSpecId>,
         "classificationSetId": null,
         "classificationIds": [],
         "defaultSelections": [{
           "defaultParamId": <selectedParamId>,
           "geometryTypeSpecFieldId": null,
           "locationId": null,
           "processNodeId": null,
           "processNodeOccurrence": null
         }],
         "genericSelections": []
       }]
     }
   }
   ```
4. Progreso en tiempo real

### Fase 4 — Resumen

Modal con conteos + boton copiar log (mismo patron que inventory-reset)

## Hashes a agregar en config.json

```
queries:
  GetSpec: 88dad36300dba70363eb14571de7eef68a1a26685131c87c762b72ccb48eb54e
  SpecFieldsAndOptions: fc6242c2e83c84eee75b421f3cfc353c65719f2868e7299234bfab38fd5da5ee
  PartNumberSpecsSummary: 7f0434efa3bb397028356ae04c8431646a7c9b2e5cb1114ed7f53b4d81c1084f

mutations:
  ApplySpecsToPartNumber: 91f6c915be5ef1fcb0fffb8fff02933d5bc681174c4d31127b14b87f2720bf8b
```

(SearchSpecsForSelect y SavePartNumber ya estan en config)

## Arquitectura

### Archivos nuevos
- `remote/scripts/spec-migrator.js` — logica principal (IIFE `SpecMigrator`)

### Archivos modificados
- `remote/config.json` — nueva app entry + hashes
- `extension/background.js` — handler para `run-spec-migrator` + global

## Manejo de errores

- PN sin la spec vieja en su lista (ya fue migrado?): skip, registrar en log
- Fallo de archivado de spec vieja: registrar error, continuar
- Fallo de ApplySpecs: registrar error, continuar
- Resumen final con: migrados, ya archivados, errores
