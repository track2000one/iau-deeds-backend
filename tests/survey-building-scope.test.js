import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSurveyBuilding,
  surveyCampusMatches,
  assertSurveyCampusAccess,
} from '../src/services/surveyBuildingScope.service.js';

const assigned = { code: 'WEST', campusCode: 'WEST', campusName: 'الحرم الغربي', role: 'member' };
const valid = {
  buildingNumber: 'W-B001',
  name: 'مبنى إداري',
  district: 'حي الجامعيين',
  campusLocation: 'الحرم الجامعي الغربي',
  floorsCount: 3,
  latitude: 26.45,
  longitude: 50.12,
  deedId: 'deed-ref-id',
};

test('survey building assigns the canonical campus and retains valid field data', () => {
  const result = validateSurveyBuilding({ input: valid, assignment: assigned });
  assert.equal(result.campusLocation, 'الحرم الغربي');
  assert.equal(result.floorsCount, 3);
  assert.equal(result.district, valid.district);
});

test('survey members cannot submit buildings outside the assigned campus', () => {
  assert.throws(
    () => validateSurveyBuilding({ input: { ...valid, campusLocation: 'الحرم الشرقي' }, assignment: assigned }),
    (error) => error.statusCode === 403
  );
});

test('missing required survey fields fail at the server, not only in the browser', () => {
  for (const change of [
    { name: '' },
    { district: null },
    { floorsCount: null },
    { floorsCount: 0 },
    { floorsCount: 1.5 },
    { latitude: null },
    { longitude: null },
    { latitude: 0, longitude: 0 },
  ]) {
    assert.throws(() => validateSurveyBuilding({ input: { ...valid, ...change }, assignment: assigned }));
  }
});

test('existing buildings outside the member campus are not editable', () => {
  assert.throws(
    () => validateSurveyBuilding({
      input: valid, assignment: assigned, existingCampus: 'الحرم الشرقي',
    }),
    (error) => error.statusCode === 403
  );
  assert.doesNotThrow(
    () => assertSurveyCampusAccess(assigned, 'الحرم الجامعي الغربي')
  );
  assert.throws(
    () => assertSurveyCampusAccess(assigned, 'كلية الريان'),
    (error) => error.statusCode === 403
  );
});

test('aliases and non-survey legacy flows remain compatible', () => {
  assert.equal(surveyCampusMatches('WEST', 'الحرم الجامعي الغربي'), true);
  assert.equal(surveyCampusMatches('EAST', 'الحرم الغربي'), false);
  assert.deepEqual(
    validateSurveyBuilding({ input: { name: null }, assignment: null }),
    { name: null }
  );
});
