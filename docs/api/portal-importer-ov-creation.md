# Portal Importer: flujo de creación de OV (resuelto 2026-04-16, v0.4.23)

`ov-operations.js:createNewOV` crea una OV con líneas en **dos pasos** (el UI de Steelhead hace lo mismo):

1. **`CreateReceivedOrder`** — crea la OV vacía. Devuelve `id` (internal) e `idInDomain` (display `#529`).
2. **`SaveReceivedOrderPartTransforms`** — una llamada **por PN único** (no por línea). La unique constraint `steelhead_received_order_part_transform_unique_constraint` rechaza duplicados por `(receivedOrderId, partNumberId, ...)`, así que si un PO tiene varias líneas con el mismo PN (común en Hubbell = múltiples entregas), hay que **agrupar por `partNumberId` y sumar cantidades**. Input shape:
   ```js
   { input: [{
     isBillable: true,
     receivedOrderId,
     shipToId: formData.shipToAddressId || null,
     partNumberPriceId: null,
     maxPartTransformCount: totalCount,  // total ordenado del PN
     count: 0,                           // recibido (arranca en 0 / TBD)
     partNumberId,
     orderType: 'MAKE_TO_ORDER',
     description: '',
     deadline: formData.deadline,
     children: []
   }] }
   ```
3. **`SaveReceivedOrderLinesAndItems`** — una llamada, `newLines[]` con una entrada por línea del PO (las que comparten PN apuntan al mismo `transform.id`):
   ```js
   { input: { receivedOrderId, newLines: [{
     id: null,
     name: pnString,
     description: '',
     lineItems: [{
       archive: false,
       description: pnString,
       quantity: String(lineQty),     // ← string
       price: String(unitPrice || '0'),// ← string
       productId: null,               // null para Hubbell (no forzar producto)
       unitId: null,
       quoteLineItemId: null,
       receivedOrderLineItemPartTransforms: [{
         receivedOrderPartTransform: {
           id: transformId,           // del paso 2
           partNumberId,
           partNumberPriceId: null,
           maxPartTransformCount: totalCount,  // REPETIR o null-ea el campo
           count: 0,
           description: ''
         }
       }]
     }]
   }] } }
   ```

**Gotchas importantes:**
- `quantity` y `price` son **strings** en la mutación aunque el backend los guarde como números.
- `productId: null` es válido (no forzar con `SearchProducts` — se ve feo en el UI).
- `maxPartTransformCount` debe pasarse en AMBAS llamadas; omitirlo en la segunda null-ea Max Count en la UI.
- `verifyOVLines` usa `GetReceivedOrder` y la respuesta puede venir con raíz `receivedOrder` (hash viejo) o `receivedOrderByIdInDomain` (hash nuevo), con lines en `receivedOrderLines.nodes` o `receivedOrderLinesByReceivedOrderId.nodes`.

