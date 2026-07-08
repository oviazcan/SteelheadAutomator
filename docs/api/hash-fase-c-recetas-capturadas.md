# Recetas de captura de mutations por sentinela (Fase C)

_Validado con el proceso real del usuario · scan 2026-07-08 · 19 mutations confirmadas (hash idéntico al config)._

## Patrón general — capturar hashes de mutations SIN afectar datos reales

Una mutation solo revela su hash cuando se **ejecuta**. Para hacerlo sin ensuciar datos productivos, se usa un **sentinela** (objeto de prueba dedicado) y un ciclo reversible:

- **Objetos persistentes (PartNumber):** viven **archivados** (fuera de la operación diaria). Ciclo: **desarchivar → ejecutar las mutations (modificar) → re-archivar**. El objeto vuelve a su estado; los cambios quedan en un PN de prueba, nunca en datos reales.
- **Objetos efímeros (Maintenance Event, Folder, WO label):** **crear** de prueba → mutar → **borrar**.
- **Mutations "gratis"** (no tocan datos de negocio): logs de correo, `GenerateDuckDb` (regenera el snapshot). Se ejecutan directo.
- **Batch sobre WO sentinela:** `CreateUpdateDeleteRoutes` re-rutea una WO de prueba (se ejecutó ×50 en una pasada).

> Regla de oro: la mutation se ejecuta sobre un **sentinela marcado**, nunca sobre un objeto real. Verificar hash capturado == config → vigente. Si difiere → rotó (actualizar config).

## Recetas confirmadas (hash 2026-07-08 — todas IGUAL al config → vigentes)

### Evento de mantenimiento (sentinela efímero: crear → comentar → actualizar)
| Mutation | Hash |
|---|---|
| `CreateMaintenanceEvent` | `0dc541a9a52a4dfb7b17043d46875bfe6f104a009779a4cf4f442dd909d6fcf3` |
| `CreateMaintenanceEventComment` | `c49db28d64861e3e91d33d1de7412d019f08f7b0700e9668c86a26579f8a8f84` |
| `UpdateMaintenanceEvent` | `29078aa7bb90d3a505324eff7ef149cf699975ef3d3337e207472e121ef5da54` |

### PartNumber sentinela (desarchivar → modificar → re-archivar)
| Mutation | Hash |
|---|---|
| `SavePartNumber` | `27adc1143653e87fbd0c8a763eaa4f3e3a2a6541bbddce47010cdbd1b0365f40` |
| `UpdatePartNumber` | `af584fa8ebb7487fc84de18fa3a5e360e99699a3280185fe98b840c157bbf2c7` |
| `CreatePartNumberUserFile` | `8588664e0071f4bec1bfd4ac11fc16371210c57ae3c501a56185c81f666de953` |
| `CreatePartNumberGroup` | `81edc50920e0ab37d470720a29160d74c6856aea6498b02543707dedfc405202` |
| `UpdatePartNumberSpecParam` | `3540e67906f7206f45584df82659b3eaa0fa41be489864009c819ecdf171c4ce` |
| `AddParamsToPartNumber` | `fab74fec6313b709fcd2ecfc9b219c3428983011c1a830563a06b2c9e66524c4` |
| `DeletePartNumberRackType` | `4cec965c46a9c30c1db64eee1b24566229b6b73f6fe69bf206253c63ac97bbd4` |
| `UpdatePartNumberPerPerRackType` | `fb6e7902d18ce00c831873c8dd32153e7bb6e2dfa44936c85a4ef67575b07de3` |
| `UnsetPartNumberPriceAsDefaultPrice` | `95ac52298b1237b96fb2aa3e223975c5e15b088f8b75b29d6981ee7e896f8ac8` |

### WO sentinela (re-rutear en batch)
| Mutation | Hash |
|---|---|
| `CreateUpdateDeleteRoutes` | `0597ad9896d1c2b87980183ac54835cf0c3fc68d777e55ade8950558f5d9a76e` |

### Logs de correo (no tocan datos de negocio → ejecutar directo)
| Mutation | Hash |
|---|---|
| `CreateEmailLogReceivedOrder` | `ccd2065a419aea4a747eca0426bd14ac383323fa0cba1d7d55102f69b08d1163` |
| `CreateInvoiceEmailLog` | `0c1d5e7460009cb489ebf25b0d8500cb441b1fa02addfbab57bc975c8dd4d9aa` |

### Estación / inventario / carpeta / snapshot
| Mutation | Hash | Sentinela |
|---|---|---|
| `CreateStationInputSchema` | `2abe86f7d8205cfd3c356e4cfeea91d857ee7820567fb82ecd9fa2688cabfa00` | estación de prueba |
| `UpdateInventoryItemUnitConversion` | `ffc8db6cd8edaa9355b904fac38f8e5fc116ce1d597f076026c38ef09420a16c` | item inventario sentinela |
| `DeleteFolderById` | `282f83cf9d56c8cb1c00308288cee23269c09c9d941e90624edfdcaed7affa15` | carpeta de prueba (crear+borrar) |
| `GenerateDuckDb` | `8f29d420e186dce3f1617c80e2b890a18fe3db49288c44f38345a7d26a65eaa0` | ninguno (regenera snapshot) |

## Faltantes (7) — receta pendiente de ejecutar

| Mutation | Sentinela + ciclo | Riesgo |
|---|---|---|
| `SavePartNumberRackTypes` | PN sentinela → guardar rack types | reversible |
| `CreatePartNumberInputSchema` | PN sentinela → crear input schema | reversible |
| `ApplySpecsToPartNumber` | PN sentinela → aplicar specs | reversible (revertir con Archive/quitar) |
| `ArchivePartNumberSpecAndParams` | PN sentinela → archivar specs | ⚠️ **destructiva** — archiva specs; revertir a mano |
| `CreateWorkOrderLabel` | etiqueta de WO de prueba → crear | par con Delete |
| `DeleteWorkOrderLabels` | la etiqueta recién creada → borrar | cierra el par |
| `CreateInventoryItemUnitConversion` | item inventario sentinela → crear conversión | par con Update (ya capturada) |

Al capturarlas: verificar hash == config. Si todas IGUAL → las 22 mutations quedan confirmadas vigentes.
