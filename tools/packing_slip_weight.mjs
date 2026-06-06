// Lógica pura de peso para la etiqueta/remisión del packing slip.
//
// DEBE quedar IDÉNTICA a la copia inline en
// powertools/synced/pdf/PACKING_SLIP_TEMPLATE.ts (el hook low-code no admite
// imports, así que se mantiene un espejo manual; ver convención en
// docs/applets/powertools-catalog.md).
//
// Contexto del bug que origina este módulo (2026-06-06): el hook asumía que
// `item.weight` SIEMPRE llega en KG y, para clientes que capturan en libras
// (Wieland, UnidadMedidaPeso=true), multiplicaba ×2.2046 → DUPLICABA el peso
// cuando Steelhead ya lo entregaba en libras. El input SÍ trae la unidad de
// origen explícita en `item.unit` / `packingSlip.unit` (id 3972 = LBR/libras,
// 3969 = KGM/kilos): hay que convertir según esa unidad real, no asumir kg.

export const KG_TO_LB = 2.2046226218
const LBR_UNIT_ID = 3972

// ¿La unidad de ORIGEN que entrega Steelhead es libras? Prioriza el id
// (autoritativo); el nombre ("LBR Libra") es respaldo. Default KG (false).
export const unitIsLb = (unit) => {
  if (!unit || typeof unit !== 'object') return false
  if (unit.id != null && Number(unit.id) === LBR_UNIT_ID) return true
  const n = unit.name != null ? String(unit.name).toLowerCase() : ''
  return n.includes('lbr') || n.includes('libra') || n.includes('lb')
}

// Convierte un peso desde su unidad de ORIGEN (sourceIsLb) hacia la unidad de
// DESTINO que el cliente quiere ver (displayInLb). Redondea a 2 decimales
// (el reparto proporcional genera decimales largos). null → null.
export const convertWeight = ({ value, sourceIsLb, displayInLb, kgToLb = KG_TO_LB }) => {
  if (value == null) return null
  let out
  if (displayInLb) {
    out = sourceIsLb ? value : value * kgToLb
  } else {
    out = sourceIsLb ? value / kgToLb : value
  }
  return Math.round(out * 100) / 100
}

// Reparte el peso TOTAL del item entre un grupo (PTA) y lo convierte a la
// unidad de destino:
//   • NETO  → proporcional a las piezas del grupo (PN uniforme).
//   • TARA  → IGUAL entre los grupos del item (el empaque no escala con piezas).
//   • BRUTO → neto + tara (si no hay neto/tara, cae a gross × wFrac).
// Para contenedores físicos (1 PTA/item) wFrac=1 e itemGroups=1 → íntegro.
export const groupWeights = ({
  itemWeight,
  itemPartCount,
  groupPartCount,
  itemGroups,
  sourceIsLb,
  displayInLb,
}) => {
  const wFrac =
    itemPartCount != null && itemPartCount > 0 && groupPartCount != null
      ? groupPartCount / itemPartCount
      : 1
  const groups = itemGroups != null && itemGroups > 0 ? itemGroups : 1
  const netSrc = itemWeight && itemWeight.net != null ? itemWeight.net * wFrac : null
  const tareSrc = itemWeight && itemWeight.tare != null ? itemWeight.tare / groups : null
  const grossSrc =
    netSrc != null && tareSrc != null
      ? netSrc + tareSrc
      : itemWeight && itemWeight.gross != null
        ? itemWeight.gross * wFrac
        : null
  return {
    netWeight: convertWeight({ value: netSrc, sourceIsLb, displayInLb }),
    tareWeight: convertWeight({ value: tareSrc, sourceIsLb, displayInLb }),
    grossWeight: convertWeight({ value: grossSrc, sourceIsLb, displayInLb }),
  }
}
