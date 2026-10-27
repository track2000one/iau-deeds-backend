// Validation on the API boundary, not only in the browser.
// GeoJSON uses [longitude, latitude] and an explicitly closed outer ring.
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const rounded = (number) => Number(number.toFixed(7));
const radians = (degrees) => degrees * Math.PI / 180;

const orient = (a, b, c) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

const between = (value, left, right) =>
  value >= Math.min(left, right) - 1e-12 && value <= Math.max(left, right) + 1e-12;

const intersects = (a, b, c, d) => {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if ((o1 > 1e-12 && o2 < -1e-12 || o1 < -1e-12 && o2 > 1e-12)
    && (o3 > 1e-12 && o4 < -1e-12 || o3 < -1e-12 && o4 > 1e-12)) return true;
  if (Math.abs(o1) <= 1e-12 && between(c[0], a[0], b[0]) && between(c[1], a[1], b[1])) return true;
  if (Math.abs(o2) <= 1e-12 && between(d[0], a[0], b[0]) && between(d[1], a[1], b[1])) return true;
  if (Math.abs(o3) <= 1e-12 && between(a[0], c[0], d[0]) && between(a[1], c[1], d[1])) return true;
  if (Math.abs(o4) <= 1e-12 && between(b[0], c[0], d[0]) && between(b[1], c[1], d[1])) return true;
  return false;
};

export function validateVacantGeometry(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw bad('حدود الأرض يجب أن تكون Polygon بصيغة GeoJSON');
  }
  const geometry = value.type === 'Feature' ? value.geometry : value;
  if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)
    || geometry.coordinates.length !== 1) {
    throw bad('يلزم مضلع واحد بحد خارجي واحد؛ لا تُقبل المضلعات المتعددة أو الفتحات الداخلية');
  }
  const ring = geometry.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > 501) {
    throw bad('يجب تحديد من 3 إلى 500 نقطة مع إغلاق المضلع');
  }
  const points = ring.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) throw bad('إحداثيات المضلع غير صالحة');
    const [longitude, latitude] = entry;
    if (typeof longitude !== 'number' || typeof latitude !== 'number'
      || !Number.isFinite(longitude) || !Number.isFinite(latitude)
      || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
      throw bad('إحداثيات المضلع خارج النطاق الجغرافي المسموح');
    }
    return [rounded(longitude), rounded(latitude)];
  });
  const first = points[0];
  const last = points[points.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw bad('يجب إغلاق المضلع بتكرار النقطة الأولى');
  }
  const vertices = points.slice(0, -1);
  if (new Set(vertices.map((point) => point.join(','))).size !== vertices.length) {
    throw bad('المضلع يحتوي على نقاط متطابقة مكررة');
  }
  for (let i = 0; i < vertices.length; i++) {
    const next = (i + 1) % vertices.length;
    if (vertices[i][0] === vertices[next][0] && vertices[i][1] === vertices[next][1]) {
      throw bad('المضلع يحتوي على ضلع بلا طول');
    }
    for (let j = i + 1; j < vertices.length; j++) {
      const after = (j + 1) % vertices.length;
      if (j === i || j === next || after === i) continue;
      if (intersects(vertices[i], vertices[next], vertices[j], vertices[after])) {
        throw bad('المضلع يحتوي على حدود متقاطعة، عدّل النقاط قبل الحفظ');
      }
    }
  }
  const lat = vertices.reduce((sum, point) => sum + point[1], 0) / vertices.length;
  const lon = vertices.reduce((sum, point) => sum + point[0], 0) / vertices.length;
  const radius = 6371008.8;
  const cosine = Math.cos(radians(lat));
  const projected = vertices.map(([x, y]) => [radius * radians(x) * cosine, radius * radians(y)]);
  let twiceArea = 0;
  for (let i = 0; i < projected.length; i++) {
    const a = projected[i], b = projected[(i + 1) % projected.length];
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  const area = Math.abs(twiceArea) / 2;
  if (!Number.isFinite(area) || area < 1) throw bad('مساحة المضلع أقل من متر مربع أو غير صالحة');
  return {
    feature: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [points] } },
    centroid: { latitude: rounded(lat), longitude: rounded(lon) },
    calculatedAreaSqm: Number(area.toFixed(2)),
  };
}
