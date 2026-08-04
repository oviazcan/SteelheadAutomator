# Modelo de mediciones: DÓNDE se mide vs BAJO QUÉ CRITERIO

> Levantado el 2026-07-30 con datos en vivo del dominio 344, corrigiendo un modelo equivocado
> que ya había costado dos diagnósticos errados. Léelo antes de tocar cualquier cosa que
> relacione specs, specFields, nodos de proceso o parámetros.

## La confusión que este documento existe para evitar

Es tentador pensar que "asignar una spec a un Número de Parte" hace que sus mediciones se
pidan en piso. **No.** Hacen falta **dos cosas independientes**, y la medición solo aparece
cuando ambas coinciden:

| | Pregunta que responde | Dónde vive |
|---|---|---|
| **Eje 1** | **¿DÓNDE se pide** la medición? | `process_node_spec_fields` (nodo → specField) |
| **Eje 2** | **¿BAJO QUÉ CRITERIO** es correcta? | specs con parámetros, por NP o por tratamiento |

> **Un specField que está en el eje 2 pero no en el eje 1 nunca se mide.** El parámetro existe,
> el criterio está definido, y el operador jamás ve la casilla. Falla en silencio.

## Eje 1 — dónde se mide

A cada nodo de proceso se le asocian specFields. Eso declara: *en este nodo se pide la
medición de este campo*. Es **independiente** de cualquier NP y de cualquier tratamiento.

Medido: el nodo `T204-IC00-001 Inspeccionando y Empacando` (id 172502) declara 5 — Espesor,
Adherencia, Primeras Piezas, Apariencia Homogénea, Adherencia - Prueba de impacto (Bala).

**No se puede acotar por tipo de nodo.** Muestra de 3 por tipo:

| Tipo | Total | specFields en la muestra |
|---|---|---|
| QUALITY_ASSURANCE_NODE | 336 | `[2, 7, 0]` |
| **STEP** | **4 586** | `[3, 0, 2]` |
| SUB_PROCESS | 18 | `[0, 4, 0]` |
| PROCESS | 337 | `[0, 0, 0]` |
| SCANNER_NODE | 512 | `[0, 0, 0]` |

Los STEP también declaran, y son la gran mayoría de los nodos: cualquier análisis que solo
mire los nodos de calidad se pierde el grueso.

## Eje 2 — bajo qué criterio

Dos vías, y la segunda existe para no ir NP por NP:

**2a · Vía Número de Parte (spec EXTERNA, la del cliente)**
`part_number_spec` → `spec_field_spec` → `part_number_spec_field_param`.
Se asigna NP por NP. Es la spec que el cliente exige.

**2b · Vía tratamiento (spec INTERNA)**
`process_node.treatment_id` → `treatment_spec_field_param`.
Al nodo se le pone un tratamiento genérico de la línea, y a ese tratamiento una spec interna
con **cientos de parámetros**. Así **cualquier NP que pase por ese proceso hereda** el criterio
sin capturarlo uno por uno. Ejemplos del dominio: el scanner «Listo para procesar» de cada
línea, antitarnish, lavado — todo lo que siempre se mide igual por proceso.

## La regla

```
la medición se pide  ⟺  specField ∈ eje 1 (algún nodo del proceso lo declara)
                     ∧  specField ∈ eje 2 (el NP o el tratamiento del nodo da su criterio)
```

## Qué hay en DuckDB y qué no

| Dato | Tabla | ¿En el snapshot? |
|---|---|---|
| Eje 1: nodo → specField | `process_node_spec_fields` | ❌ **falta** |
| Árbol del proceso (padre→hijo) | `process_node_relationships` | ❌ **falta** |
| Eje 2a: NP → specs | `part_number_spec`, `spec_field_spec` | ✅ |
| Eje 2b: tratamiento → params | `treatment_spec_field_param` | ✅ |
| Proceso default del NP | `part_number.default_process_node_id` | ✅ |
| Nodos y su tratamiento | `process_node` | ✅ |

Faltan **las dos que definen el eje 1**. Sin ellas el hueco es indetectable desde SQL.

**`process_node_go_to`** existe pero NO es la jerarquía: son saltos entre nodos, sin `spec_id`.

## Cómo se saca el eje 1 del ERP

**Una llamada por PROCESO raíz** (337, no 5 789 por nodo):

```
GetProcessNode   hash 3c570c9045a631877f87e94aa196434a299d81e0b4385b3167b796f5bbe7ce32
variables        { id: <raíz>, processNodeOccurrence: 0, rootId: <raíz> }
```

`treeRoot.descendantRelationships` trae el árbol completo (`toId`, `childInd`, `specId`) y en
el mismo payload viene `processNodeSpecFieldsByProcessNodeId` de cada nodo. Medido sobre el
proceso 142583: 44 relaciones y 46 nodos con sus campos, 198 KB.

Queries relacionadas, capturadas el 2026-07-30:

| Operación | Hash | Para qué |
|---|---|---|
| `GetProcessNodeSpecFields` | `119bad0d…` | los specFields de UN nodo, mínimo (`id, specFieldId, orderIndex`) |
| `GetSpecFields` | `2fc23464…` | con `{specId: -1}` devuelve TODOS los specFields del dominio |
| `TreatmentSpecsSummary` | `1d6deeb0…` | el eje 2b de un tratamiento |
| `GetSpecFieldsByIds` | `14b729cd…` | specFields por lista de ids; `includeSpecFieldSpecs` da el eje 2, **no el 1** |

## Dos errores de lectura que ya costaron caro

**`treatment_spec_field_param` NO es declaración.** Es criterio (eje 2b). Usarla como eje 1 da
6 specFields para 162 nodos de calidad, cuando un solo nodo declara 8-15. El número absurdamente
bajo es la señal.

**`part_number_process_node_default` NO es el proceso default del NP.** Son 715 NPs con 24-42
filas cada uno y trae `treatment_id`/`process_node_occurrence`: parece configuración por nodo.
El proceso default está en **`part_number.default_process_node_id`**, que tienen **12 606 NPs
activos** de 17 408 y apunta a un nodo `type='process'`.

## Para pedirle la tabla a Steelhead

Con `process_node_spec_fields` (dos columnas) y las relaciones del árbol en el payload de
reportes, el análisis queda en SQL puro y siempre fresco, sin extractor. Referencia
reproducible: el nodo **172502** del dominio 344 devuelve 5 filas en
`processNodeSpecFieldsByProcessNodeId` por GraphQL y la relación no existe en la base de
reportes.
