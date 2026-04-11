# CFDI Attacher - Spec de Diseño

## Contexto

Cuando se envía el email de factura desde Steelhead, solo se adjunta el PDF de la factura. El XML CFDI timbrado (requerido fiscalmente) no se adjunta, y el usuario debe descargarlo manualmente de una liga externa y subirlo por separado.

Esta applet automatiza la descarga y adjunto del XML CFDI al email de factura, tanto para envíos individuales como múltiples.

## Escenarios

1. **Factura individual**: Dialog "Send Invoice Email" con una factura
2. **Múltiples facturas**: "SEND N INVOICES" desde vista de facturas seleccionadas

## Diseño

### Arquitectura General

Content script + MAIN world script que:
1. **Intercepta** respuestas GraphQL de `InvoiceByIdInDomain` para cachear los `writeResult` de cada factura
2. **Detecta** el diálogo de envío de email via MutationObserver
3. **Inyecta** un checkbox premarcado "Adjuntar XML(s) CFDI" en la sección de controles del diálogo
4. **Intercepta** la mutación `SendEmailChecked` cuando el checkbox está marcado, descarga/sube los XMLs y los agrega a los adjuntos

### Fuente del XML

El XML se obtiene del campo `XmlBase64File` dentro del `writeResult` interceptado (no del link externo), por dos razones:
- Evita CORS: el MAIN world script corre en `app.gosteelhead.com`, no puede hacer fetch a `proquipaxmlfactura.imarzmx.com`
- Los datos ya están disponibles en la respuesta interceptada, sin fetch adicional

El **nombre del archivo** se extrae del campo `linkxml` del mismo writeResult (e.g., `EKU9003173C9F0000000212.xml`).

### Datos Cacheados por Intercepción

Cuando se intercepta `InvoiceByIdInDomain`, se almacena en un Map:
```
invoiceCache[idInDomain] = {
  id: number,              // invoice internal ID
  idInDomain: number,      // invoice display number
  xmlBase64: string,       // XmlBase64File
  linkxml: string,         // URL para extraer nombre de archivo
  filename: string         // parsed from linkxml (e.g., "EKU9003173C9F0000000212.xml")
}
```

Si `writeResult` o `CustomInput.linkxml` no existen (factura no timbrada), se registra `xmlBase64: null`.

### Flujo Detallado

```
Steelhead carga página de factura(s)
  ↓
background.js auto-inyecta cfdi-attacher.js en MAIN world
  ↓
cfdi-attacher.js parchea window.fetch para interceptar /graphql
  ↓
Steelhead llama InvoiceByIdInDomain → interceptor cachea writeResult
  ↓
Usuario abre "Send Invoice Email" → MutationObserver detecta diálogo
  ↓
Inyecta checkbox "☑ Adjuntar XML(s) CFDI" en zona de controles
  (premarcado por defecto)
  ↓
Si alguna factura en caché no tiene XML → muestra aviso junto al checkbox:
  "⚠ Factura(s) #X sin XML CFDI disponible"
  ↓
Usuario da click a SEND → Steelhead llama SendEmailChecked via fetch
  ↓
Interceptor de fetch detecta SendEmailChecked:
  ¿Checkbox marcado? → NO → dejar pasar sin cambios
                      → SÍ ↓
  1. Para cada factura en caché que tenga XML:
     a. Decodificar XmlBase64 → Blob
     b. POST /api/files (FormData con blob) → obtener generatedName
     c. CreateUserFile(generatedName, originalFilename)
  2. Agregar { filename: generatedName, displayName: originalFilename }
     a cada entry nueva al array attachments del body de SendEmailChecked
  3. Dejar que el fetch modificado proceda
  ↓
Email se envía con PDFs + XMLs adjuntos
```

### Archivos Nuevos

| Archivo | Descripción |
|---------|-------------|
| `remote/scripts/cfdi-attacher.js` | IIFE principal: fetch interceptor + MutationObserver + UI + upload logic |

### Archivos Modificados

| Archivo | Cambio |
|---------|--------|
| `remote/config.json` | Agregar app `cfdi-attacher`, hashes nuevos (`InvoiceByIdInDomain`, `CreateInvoicePdf`, `CreateInvoiceEmailLog`), scripts |
| `extension/background.js` | Auto-inyección de cfdi-attacher.js en cada página de Steelhead + handler para toggle |
| `extension/content.js` | Comunicar estado de habilitación (chrome.storage) al MAIN world via data-attribute |

### Registro en config.json

```json
{
  "id": "cfdi-attacher",
  "name": "Adjuntar CFDI",
  "subtitle": "Auto-adjunta XML CFDI al enviar facturas por email",
  "icon": "📎",
  "scripts": ["scripts/cfdi-attacher.js"],
  "autoInject": true,
  "actions": [
    {
      "id": "toggle-cfdi-attacher",
      "label": "Adjuntar CFDI",
      "sublabel": "Auto-adjunta XML(s) al enviar email de factura",
      "icon": "📎",
      "type": "toggle",
      "handler": "message",
      "message": "toggle-cfdi-attacher"
    }
  ]
}
```

### Auto-inyección (background.js)

Agregar listener de `chrome.tabs.onUpdated` que al detectar `status: 'complete'` + URL de `app.gosteelhead.com`:
1. Lee el estado del toggle de `chrome.storage.local` (default: `true`)
2. Si está habilitado, inyecta `cfdi-attacher.js` en MAIN world (con `steelhead-api.js` como dependencia)

### Comunicación Enabled State

`content.js` al cargar:
```js
chrome.storage.local.get('cfdiAttacherEnabled', (data) => {
  const enabled = data.cfdiAttacherEnabled !== false; // default true
  document.documentElement.dataset.saCfdiEnabled = enabled;
});
```

`cfdi-attacher.js` lee: `document.documentElement.dataset.saCfdiEnabled !== 'false'`

### UI del Checkbox

Inyectar después del último toggle del diálogo (tras "Visible to Others"), con el mismo estilo visual:
- Label: "Adjuntar XML(s) CFDI"
- Checked por defecto
- Si alguna factura no tiene XML, mostrar un texto de aviso debajo: "⚠ Factura(s) #X sin XML disponible" en naranja

### Hashes Requeridos en config.json

```json
{
  "queries": {
    "InvoiceByIdInDomain": "9bfd1fe7ea06bf4b4c497ef0c79b799c5ebd60d6e113d25b5af7f8c0344ae3af"
  },
  "mutations": {
    "CreateInvoicePdf": "aafd22aa663f15839042d71daebcebdba5fc2904554ef18ad09e37f0d4079e49",
    "SendEmailChecked": "821bd8f1144fd29bd972a9471a59d036ad04e8c77003f08ea7b1009e8a640beb",
    "CreateInvoiceEmailLog": "0c1d5e7460009cb489ebf25b0d8500cb441b1fa02addfbab57bc975c8dd4d9aa",
    "CreateUserFile": "9028f6b729fe0cd253b1d47d5f27d84cc15293bbc12381225a7c00a402849ec9"
  }
}
```

Nota: `CreateUserFile` y `SendEmailChecked` ya existen en config.json. Los demás son nuevos.

### Manejo de Errores

| Escenario | Comportamiento |
|-----------|---------------|
| Factura sin writeResult/linkxml | Aviso junto al checkbox, se envía sin XML de esa factura |
| Falla upload de XML | Alert con error, SEND original se cancela para que el usuario reintente |
| Falla decode base64 | Igual que falla de upload |
| Feature deshabilitada | No se inyecta checkbox, fetch interceptor inactivo |

### Dependencias

- `steelhead-api.js` — para `CreateUserFile` mutation
- `config.json` — para hashes

### Patrón IIFE del Script

```js
const CfdiAttacher = (() => {
  'use strict';
  
  const invoiceCache = new Map();
  let checkboxChecked = true;
  
  function init() { /* patch fetch, setup observer */ }
  function patchFetch() { /* intercept InvoiceByIdInDomain responses + SendEmailChecked requests */ }
  function setupObserver() { /* watch for email dialog DOM */ }
  function injectCheckbox(dialog) { /* add toggle to dialog */ }
  async function uploadXml(xmlBase64, filename) { /* blob → /api/files → CreateUserFile */ }
  
  return { init };
})();

if (typeof window !== 'undefined') {
  window.CfdiAttacher = CfdiAttacher;
  CfdiAttacher.init();
}
```

## Verificación

1. Navegar a una factura timbrada → abrir "Send Invoice Email" → verificar que aparece checkbox "Adjuntar XML(s) CFDI"
2. Enviar con checkbox marcado → verificar que el XML aparece como adjunto en el email recibido
3. Enviar con checkbox desmarcado → verificar que no se adjunta XML
4. Probar con múltiples facturas seleccionadas → verificar que se adjunta un XML por cada factura timbrada
5. Probar con una factura sin timbrar → verificar aviso y envío sin XML
6. Deshabilitar desde popup → verificar que no aparece checkbox
7. Verificar que el nombre del archivo es el original del linkxml (e.g., `EKU9003173C9F0000000212.xml`)
