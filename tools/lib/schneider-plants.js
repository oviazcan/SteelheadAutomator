// tools/lib/schneider-plants.js
// Fuente de verdad de la validación de etiqueta de planta Schneider vs ship-to.
// El hook Power Tool powertools/synced/received-order/received-order.ts transcribe
// esta lógica inline (no puede importar). Si cambias datos/lógica aquí, espéjalo en el .ts.
// Probado en tools/test/received-order-plant.test.js.
// SQR fue renombrada a SQ1 por el equipo (no usar alias SQR).

const SCHNEIDER_PLANTS = [
  { code: 'STX', name: 'Tlaxcala',     needles: ['acuamanala', 'santa ana', '90860'] },
  { code: 'SXC', name: 'Xicohténcatl', needles: ['ocotitla', '90434'] },
  { code: 'SMY', name: 'Monterrey',    needles: ['apodaca', 'escobedo 317', '66627'] },
  { code: 'SQ1', name: 'Querétaro 1',  needles: ['vesta', 'vpq07', '76294'] },
  { code: 'SQ2', name: 'Querétaro 2',  needles: ['parque industrial aeropuerto', 'lote 56', '76295'] },
  { code: 'SCM', name: 'CDMX',         needles: ['michoacán 20', 'michoacan 20', 'complejo industrial tecnológico', '09208'] },
  { code: 'SRG', name: 'Rojo Gómez',   needles: ['rojo gómez', 'rojo gomez', '09300'] },
];

const SCHNEIDER_PLANT_CODES = new Set(SCHNEIDER_PLANTS.map((p) => p.code));

// Resuelve la planta Schneider desde la dirección de entrega. null si no matchea.
function resolvePlant(shipToAddress) {
  const addr = String(shipToAddress || '').toLowerCase();
  if (!addr) return null;
  return SCHNEIDER_PLANTS.find((p) => p.needles.some((n) => addr.includes(n))) || null;
}

// Veredicto de las etiquetas de un NP vs el código de planta esperado:
// 'ok' (trae la esperada) | 'missing' (no trae ninguna etiqueta de planta) |
// 'mismatch' (trae etiqueta(s) de planta pero no la esperada).
function plantLabelVerdict(partLabelNames, expectedCode) {
  const plantLabels = (partLabelNames || []).filter((n) => SCHNEIDER_PLANT_CODES.has(n));
  if (plantLabels.length === 0) return { verdict: 'missing', plantLabels };
  if (plantLabels.indexOf(expectedCode) !== -1) return { verdict: 'ok', plantLabels };
  return { verdict: 'mismatch', plantLabels };
}

module.exports = { SCHNEIDER_PLANTS, SCHNEIDER_PLANT_CODES, resolvePlant, plantLabelVerdict };
