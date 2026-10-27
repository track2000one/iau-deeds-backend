import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVacantGeometry } from '../src/services/vacantGeometry.service.js';

const polygon = (coordinates) => ({
  type: 'Feature',
  properties: { fromGoogleEarth: true },
  geometry: { type: 'Polygon', coordinates: [coordinates] },
});
const regular = [
  [50.18, 26.39], [50.181, 26.39], [50.181, 26.391], [50.18, 26.391], [50.18, 26.39],
];

test('valid GeoJSON polygon normalizes coordinates and calculates nonzero area and centroid', () => {
  const result = validateVacantGeometry(polygon(regular));
  assert.equal(result.feature.geometry.type, 'Polygon');
  assert.deepEqual(result.feature.properties, {});
  assert.ok(result.calculatedAreaSqm > 5000);
  assert.ok(result.centroid.latitude > 26.39);
  assert.ok(result.centroid.longitude > 50.18);
});
test('missing shape returns null; non-polygon shape is rejected', () => {
  assert.equal(validateVacantGeometry(null), null);
  assert.throws(() => validateVacantGeometry({ type: 'Point', coordinates: [50.18, 26.39] }), /مضلع واحد/);
});
test('open rings, repeated vertices and crossing edges are rejected', () => {
  assert.throws(() => validateVacantGeometry(polygon(regular.slice(0, -1))), /إغلاق/);
  assert.throws(() => validateVacantGeometry(polygon([
    [50.18, 26.39], [50.181, 26.39], [50.181, 26.39], [50.18, 26.391], [50.18, 26.39],
  ])), /مكررة/);
  assert.throws(() => validateVacantGeometry(polygon([
    [50.18, 26.39], [50.181, 26.391], [50.18, 26.391], [50.181, 26.39], [50.18, 26.39],
  ])), /متقاطعة/);
});
test('holes, coordinates outside geographical bounds and zero area are rejected', () => {
  assert.throws(() => validateVacantGeometry({ type: 'Polygon', coordinates: [regular, regular] }), /مضلع واحد/);
  assert.throws(() => validateVacantGeometry(polygon([[181, 26], [50, 26], [50, 27], [181, 26]])), /خارج النطاق/);
  assert.throws(() => validateVacantGeometry(polygon([[50.18, 26.39], [50.181, 26.39], [50.182, 26.39], [50.18, 26.39]])), /أقل من متر/);
});
