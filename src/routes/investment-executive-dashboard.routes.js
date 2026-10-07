import { Router } from 'express';
import { prisma } from '../prisma.js';

const router = Router();

const blockerDefinitions = {
  MISSING_DEED: {
    label: 'الموقع الرئيسي غير مرتبط بصك',
    severity: 'critical',
  },
  MISSING_SITE_BOUNDARY: {
    label: 'حدود الموقع الرئيسي غير متوفرة',
    severity: 'warning',
  },
  SITE_BOUNDARY_NOT_APPROVED: {
    label: 'حدود الموقع الرئيسي غير معتمدة',
    severity: 'warning',
  },
  AREA_NOT_AVAILABLE: {
    label: 'المساحة ليست متاحة',
    severity: 'critical',
  },
  READINESS_NOT_READY: {
    label: 'جاهزية الاستثمار غير مكتملة',
    severity: 'warning',
  },
  MISSING_AREA_BOUNDARY: {
    label: 'حدود المساحة غير متوفرة',
    severity: 'warning',
  },
  AREA_BOUNDARY_NOT_APPROVED: {
    label: 'حدود المساحة غير معتمدة',
    severity: 'warning',
  },
  MISSING_SURVEYED_AREA: {
    label: 'المساحة المساحية المعتمدة غير مدخلة',
    severity: 'warning',
  },
  MISSING_PROPOSED_USE: {
    label: 'الاستخدام المقترح غير محدد',
    severity: 'warning',
  },
};

const readinessLabels = {
  NOT_ASSESSED: 'لم تُقيّم',
  UNDER_REVIEW: 'تحت المراجعة',
  READY: 'جاهزة',
  NOT_SUITABLE: 'غير مناسبة',
};

const occupancyLabels = {
  AVAILABLE: 'متاحة',
  OCCUPIED: 'مشغولة',
  PARTIALLY_OCCUPIED: 'مشغولة جزئيًا',
  RESERVED: 'محجوزة',
  ALLOCATED: 'مخصصة',
  UNAVAILABLE: 'غير متاحة',
};

const geometryApprovalLabels = {
  DRAFT: 'مسودة',
  REVIEWED: 'تمت المراجعة',
  APPROVED: 'معتمدة',
  CHANGE_REQUESTED: 'طلب تعديل',
};

const decimalNumber = (value) => {
  if (value == null || value === '') return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const hasPolygon = (value) => {
  if (!value || typeof value !== 'object') return false;

  const geometry =
    value.type === 'Feature' && value.geometry
      ? value.geometry
      : value;

  return (
    geometry?.type === 'Polygon' &&
    Array.isArray(geometry?.coordinates?.[0]) &&
    geometry.coordinates[0].length >= 4
  );
};

const hasText = (value) => String(value || '').trim().length > 0;

const getDeedCount = (site) => {
  const linkedIds = new Set(
    (site.deedLinks || []).map((link) => link.deedId)
  );

  if (site.deedId) linkedIds.add(site.deedId);
  return linkedIds.size;
};

const getAreaBlockers = (area, site) => {
  const blockers = [];
  const deedCount = getDeedCount(site);

  if (deedCount === 0) blockers.push('MISSING_DEED');

  if (!hasPolygon(site.geoJson)) {
    blockers.push('MISSING_SITE_BOUNDARY');
  } else if (site.geometryApprovalStatus !== 'APPROVED') {
    blockers.push('SITE_BOUNDARY_NOT_APPROVED');
  }

  if (area.occupancyStatus !== 'AVAILABLE') {
    blockers.push('AREA_NOT_AVAILABLE');
  }

  if (area.investmentReadiness !== 'READY') {
    blockers.push('READINESS_NOT_READY');
  }

  if (!hasPolygon(area.geoJson)) {
    blockers.push('MISSING_AREA_BOUNDARY');
  } else if (area.geometryApprovalStatus !== 'APPROVED') {
    blockers.push('AREA_BOUNDARY_NOT_APPROVED');
  }

  if (decimalNumber(area.surveyedArea) <= 0) {
    blockers.push('MISSING_SURVEYED_AREA');
  }

  if (!hasText(area.proposedUse)) {
    blockers.push('MISSING_PROPOSED_USE');
  }

  return blockers;
};

const completionPercent = (blockers) => {
  const totalChecks = 9;
  const passed = Math.max(0, totalChecks - blockers.length);
  return Number(((passed / totalChecks) * 100).toFixed(1));
};

const countBy = (items, keySelector) => {
  const result = {};

  for (const item of items) {
    const key = keySelector(item);
    result[key] = (result[key] || 0) + 1;
  }

  return result;
};

router.get('/', async (_req, res, next) => {
  try {
    const sites = await prisma.investmentSite.findMany({
      where: { isActive: true },
      include: {
        deed: {
          select: {
            id: true,
            deedNumber: true,
            area: true,
            propertyDescription: true,
          },
        },
        deedLinks: {
          include: {
            deed: {
              select: {
                id: true,
                deedNumber: true,
                area: true,
                propertyDescription: true,
              },
            },
          },
        },
        areas: {
          where: { isActive: true },
          orderBy: { areaNumber: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });

    const allAreas = [];
    const blockerCounts = Object.fromEntries(
      Object.keys(blockerDefinitions).map((key) => [key, 0])
    );

    const siteSummaries = sites.map((site) => {
      const deedCount = getDeedCount(site);
      const siteHasBoundary = hasPolygon(site.geoJson);
      const siteBoundaryApproved =
        site.geometryApprovalStatus === 'APPROVED';

      const analyzedAreas = site.areas.map((area) => {
        const blockers = getAreaBlockers(area, site);

        for (const blocker of blockers) {
          blockerCounts[blocker] += 1;
        }

        const approximateArea = decimalNumber(area.approximateArea);
        const surveyedArea = decimalNumber(area.surveyedArea);
        const referenceArea =
          surveyedArea > 0 ? surveyedArea : approximateArea;

        const analyzed = {
          id: area.id,
          siteId: site.id,
          siteCode: site.code,
          siteName: site.name,
          areaCode: area.areaCode,
          name: area.name,
          approximateArea,
          surveyedArea,
          referenceArea,
          occupancyStatus: area.occupancyStatus,
          investmentReadiness: area.investmentReadiness,
          geometryApprovalStatus: area.geometryApprovalStatus,
          geometryAccuracy: area.geometryAccuracy,
          hasPolygon: hasPolygon(area.geoJson),
          proposedUse: area.proposedUse,
          blockers,
          blockerCount: blockers.length,
          completionPercent: completionPercent(blockers),
          opportunityCandidate: blockers.length === 0,
          updatedAt: area.updatedAt,
        };

        allAreas.push(analyzed);
        return analyzed;
      });

      const totalApproximateArea = analyzedAreas.reduce(
        (sum, area) => sum + area.approximateArea,
        0
      );
      const totalReferenceArea = analyzedAreas.reduce(
        (sum, area) => sum + area.referenceArea,
        0
      );

      const candidateAreas = analyzedAreas.filter(
        (area) => area.opportunityCandidate
      );
      const readyAreas = analyzedAreas.filter(
        (area) => area.investmentReadiness === 'READY'
      );
      const availableAreas = analyzedAreas.filter(
        (area) => area.occupancyStatus === 'AVAILABLE'
      );
      const approvedGeometryAreas = analyzedAreas.filter(
        (area) => area.geometryApprovalStatus === 'APPROVED'
      );
      const polygonAreas = analyzedAreas.filter((area) => area.hasPolygon);

      const passedChecks = analyzedAreas.reduce(
        (sum, area) =>
          sum + Math.max(0, 9 - area.blockerCount),
        0
      );
      const totalChecks = analyzedAreas.length * 9;
      const completion =
        totalChecks > 0
          ? Number(((passedChecks / totalChecks) * 100).toFixed(1))
          : 0;

      const siteBlockerCounts = {};
      for (const area of analyzedAreas) {
        for (const blocker of area.blockers) {
          siteBlockerCounts[blocker] =
            (siteBlockerCounts[blocker] || 0) + 1;
        }
      }

      return {
        id: site.id,
        code: site.code,
        name: site.name,
        deedCount,
        deedLinked: deedCount > 0,
        siteHasBoundary,
        siteBoundaryApproved,
        geometryApprovalStatus: site.geometryApprovalStatus,
        geometryAccuracy: site.geometryAccuracy,
        areaCount: analyzedAreas.length,
        availableCount: availableAreas.length,
        readyCount: readyAreas.length,
        polygonCount: polygonAreas.length,
        approvedGeometryCount: approvedGeometryAreas.length,
        candidateCount: candidateAreas.length,
        candidateArea: candidateAreas.reduce(
          (sum, area) => sum + area.referenceArea,
          0
        ),
        totalApproximateArea,
        totalReferenceArea,
        completionPercent: completion,
        blockerCount: Object.values(siteBlockerCounts).reduce(
          (sum, count) => sum + count,
          0
        ),
        blockerCounts: siteBlockerCounts,
      };
    });

    const totalApproximateArea = allAreas.reduce(
      (sum, area) => sum + area.approximateArea,
      0
    );
    const totalReferenceArea = allAreas.reduce(
      (sum, area) => sum + area.referenceArea,
      0
    );
    const availableAreas = allAreas.filter(
      (area) => area.occupancyStatus === 'AVAILABLE'
    );
    const readyAreas = allAreas.filter(
      (area) => area.investmentReadiness === 'READY'
    );
    const polygonAreas = allAreas.filter((area) => area.hasPolygon);
    const approvedAreaGeometry = allAreas.filter(
      (area) => area.geometryApprovalStatus === 'APPROVED'
    );
    const surveyedAreas = allAreas.filter(
      (area) => area.surveyedArea > 0
    );
    const proposedUseAreas = allAreas.filter(
      (area) => hasText(area.proposedUse)
    );
    const candidates = allAreas.filter(
      (area) => area.opportunityCandidate
    );

    const linkedSites = siteSummaries.filter(
      (site) => site.deedLinked
    );
    const siteBoundarySites = siteSummaries.filter(
      (site) => site.siteHasBoundary
    );
    const approvedSiteBoundaries = siteSummaries.filter(
      (site) => site.siteBoundaryApproved
    );

    const totalAreaChecks = allAreas.length * 9;
    const passedAreaChecks = allAreas.reduce(
      (sum, area) => sum + Math.max(0, 9 - area.blockerCount),
      0
    );

    const operationalCompletionPercent =
      totalAreaChecks > 0
        ? Number(
            ((passedAreaChecks / totalAreaChecks) * 100).toFixed(1)
          )
        : 0;

    const readinessDistribution = countBy(
      allAreas,
      (area) => area.investmentReadiness
    );
    const occupancyDistribution = countBy(
      allAreas,
      (area) => area.occupancyStatus
    );
    const geometryApprovalDistribution = countBy(
      allAreas,
      (area) => area.geometryApprovalStatus
    );

    const blockers = Object.entries(blockerCounts)
      .map(([code, count]) => ({
        code,
        count,
        label: blockerDefinitions[code].label,
        severity: blockerDefinitions[code].severity,
      }))
      .filter((item) => item.count > 0)
      .sort((a, b) => b.count - a.count);

    const siteRanking = [...siteSummaries].sort((a, b) => {
      if (b.candidateCount !== a.candidateCount) {
        return b.candidateCount - a.candidateCount;
      }

      if (b.completionPercent !== a.completionPercent) {
        return b.completionPercent - a.completionPercent;
      }

      if (b.totalReferenceArea !== a.totalReferenceArea) {
        return b.totalReferenceArea - a.totalReferenceArea;
      }

      return a.name.localeCompare(b.name, 'ar');
    });

    const closestToOpportunity = allAreas
      .filter((area) => !area.opportunityCandidate)
      .sort((a, b) => {
        if (a.blockerCount !== b.blockerCount) {
          return a.blockerCount - b.blockerCount;
        }

        if (b.referenceArea !== a.referenceArea) {
          return b.referenceArea - a.referenceArea;
        }

        return a.areaCode.localeCompare(b.areaCode);
      })
      .slice(0, 12);

    res.json({
      generatedAt: new Date().toISOString(),
      methodology: {
        name: 'operational_opportunity_readiness_v1',
        description:
          'مؤشر تشغيلي داخلي يقيس اكتمال البيانات اللازمة لتحويل المساحة إلى فرصة استثمارية داخل المنصة، ولا يمثل تقييمًا ماليًا أو قرارًا استثماريًا أو اعتمادًا نظاميًا.',
        requiredChecks: [
          'MISSING_DEED',
          'MISSING_SITE_BOUNDARY',
          'SITE_BOUNDARY_NOT_APPROVED',
          'AREA_NOT_AVAILABLE',
          'READINESS_NOT_READY',
          'MISSING_AREA_BOUNDARY',
          'AREA_BOUNDARY_NOT_APPROVED',
          'MISSING_SURVEYED_AREA',
          'MISSING_PROPOSED_USE',
        ],
      },
      kpis: {
        siteCount: sites.length,
        areaCount: allAreas.length,
        totalApproximateArea,
        totalReferenceArea,
        availableAreaCount: availableAreas.length,
        availableReferenceArea: availableAreas.reduce(
          (sum, area) => sum + area.referenceArea,
          0
        ),
        readyAreaCount: readyAreas.length,
        readyReferenceArea: readyAreas.reduce(
          (sum, area) => sum + area.referenceArea,
          0
        ),
        opportunityCandidateCount: candidates.length,
        opportunityCandidateArea: candidates.reduce(
          (sum, area) => sum + area.referenceArea,
          0
        ),
        blockedAreaCount: allAreas.length - candidates.length,
        deedLinkedSiteCount: linkedSites.length,
        siteBoundaryCount: siteBoundarySites.length,
        approvedSiteBoundaryCount: approvedSiteBoundaries.length,
        areaPolygonCount: polygonAreas.length,
        approvedAreaGeometryCount: approvedAreaGeometry.length,
        surveyedAreaCount: surveyedAreas.length,
        proposedUseCount: proposedUseAreas.length,
        operationalCompletionPercent,
      },
      distributions: {
        readiness: Object.entries(readinessLabels).map(
          ([status, label]) => ({
            status,
            label,
            count: readinessDistribution[status] || 0,
          })
        ),
        occupancy: Object.entries(occupancyLabels).map(
          ([status, label]) => ({
            status,
            label,
            count: occupancyDistribution[status] || 0,
          })
        ),
        geometryApproval: Object.entries(
          geometryApprovalLabels
        ).map(([status, label]) => ({
          status,
          label,
          count: geometryApprovalDistribution[status] || 0,
        })),
      },
      blockers,
      siteRanking,
      closestToOpportunity,
      candidates,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
