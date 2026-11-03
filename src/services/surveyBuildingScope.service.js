import { prisma } from '../prisma.js';

// Canonical campus names for the university field-survey team.
export const SURVEY_CAMPUSES = Object.freeze({
  WEST: 'الحرم الغربي',
  EAST: 'الحرم الشرقي',
  RAYYAN: 'كلية الريان',
});

const campusAliases = {
  WEST: ['الحرم الغربي', 'الحرم الجامعي الغربي'],
  EAST: ['الحرم الشرقي', 'الحرم الجامعي الشرقي'],
  RAYYAN: ['كلية الريان', 'الريان'],
};

const normalizeArabic = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/[\u064B-\u065F\u0670]/g, '')
  .replace(/[أإآ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .replace(/\s+/g, ' ')
  .trim();

export const surveyCampusMatches = (campusCode, input) =>
  (campusAliases[campusCode] || []).some((name) => normalizeArabic(name) === normalizeArabic(input));

const surveyError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

// The real authenticated user ID, not a hand-entered name, is the assignment authority.
export const getSurveyBuildingMember = async (user) => {
  if (!user || user.role === 'admin') return null;
  return prisma.surveyTeamAssignment.findFirst({
    where: { userId: user.id, role: 'member' },
  });
};

// Scope controls for survey-team members only; existing non-team building flows stay unchanged.
// Future GIS polygon checks must be added when the official campus boundary is available.
export const validateSurveyBuilding = ({ input, assignment, existingCampus }) => {
  if (!assignment) return input;
  const campusName = SURVEY_CAMPUSES[assignment.campusCode];
  if (!campusName) throw surveyError('الحرم المكلف غير معرّف. تواصل مع مسؤول المنصة.', 403);
  if (existingCampus !== undefined && !surveyCampusMatches(assignment.campusCode, existingCampus)) {
    throw surveyError('لا يسمح بتعديل مبنى خارج الحرم المكلف به', 403);
  }
  if (!surveyCampusMatches(assignment.campusCode, input.campusLocation)) {
    throw surveyError('لا يسمح بتسجيل مبنى خارج الحرم المكلف به: ' + campusName, 403);
  }
  if (!String(input.name || '').trim()) throw surveyError('اسم المبنى / الموقع إلزامي لأعضاء فريق الحصر');
  if (!String(input.district || '').trim()) throw surveyError('اسم الحي إلزامي لأعضاء فريق الحصر');
  if (!Number.isInteger(input.floorsCount) || input.floorsCount < 1) {
    throw surveyError('عدد أدوار المبنى إلزامي ويجب أن يكون عددًا صحيحًا لا يقل عن دور واحد');
  }
  if (input.latitude == null || input.longitude == null ||
      !Number.isFinite(input.latitude) || !Number.isFinite(input.longitude) ||
      input.latitude < -90 || input.latitude > 90 || input.longitude < -180 || input.longitude > 180 ||
      (input.latitude === 0 && input.longitude === 0)) {
    throw surveyError('يلزم تحديد إحداثيات صحيحة (خط العرض وخط الطول) للمبنى');
  }
  return { ...input, name: input.name.trim(), district: input.district.trim(), campusLocation: campusName };
};
