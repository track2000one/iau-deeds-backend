import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';

const router = Router();

const approvalStatusSchema = z.enum([
  'DRAFT',
  'REVIEWED',
  'APPROVED',
  'CHANGE_REQUESTED',
]);

const querySchema = z.object({
  status: z.union([approvalStatusSchema, z.literal('ALL')]).default('ALL'),
  entityType: z
    .enum(['ALL', 'investment_site', 'investment_area'])
    .default('ALL'),
  siteId: z.string().trim().optional(),
  search: z.string().trim().max(160).optional(),
  geometry: z.enum(['with', 'without', 'all']).default('with'),
  sort: z
    .enum(['priority', 'updated_desc', 'approved_desc'])
    .default('priority'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const normalize = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();

const hasGeometry = (value) => {
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

const statusPriority = {
  REVIEWED: 0,
  CHANGE_REQUESTED: 1,
  DRAFT: 2,
  APPROVED: 3,
};

const toTimestamp = (value) => {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const sortItems = (items, sort) => {
  const copy = [...items];

  if (sort === 'approved_desc') {
    return copy.sort((a, b) => {
      const approved =
        toTimestamp(b.geometryApprovedAt) -
        toTimestamp(a.geometryApprovedAt);

      return approved || toTimestamp(b.updatedAt) - toTimestamp(a.updatedAt);
    });
  }

  if (sort === 'updated_desc') {
    return copy.sort(
      (a, b) => toTimestamp(b.updatedAt) - toTimestamp(a.updatedAt)
    );
  }

  return copy.sort((a, b) => {
    const priority =
      (statusPriority[a.geometryApprovalStatus] ?? 99) -
      (statusPriority[b.geometryApprovalStatus] ?? 99);

    return priority || toTimestamp(b.updatedAt) - toTimestamp(a.updatedAt);
  });
};

const buildStats = (items) => {
  const counts = {
    total: items.length,
    draft: 0,
    reviewed: 0,
    approved: 0,
    changeRequested: 0,
    sites: 0,
    areas: 0,
  };

  for (const item of items) {
    if (item.entityType === 'investment_site') counts.sites += 1;
    if (item.entityType === 'investment_area') counts.areas += 1;

    if (item.geometryApprovalStatus === 'DRAFT') counts.draft += 1;
    if (item.geometryApprovalStatus === 'REVIEWED') counts.reviewed += 1;
    if (item.geometryApprovalStatus === 'APPROVED') counts.approved += 1;
    if (item.geometryApprovalStatus === 'CHANGE_REQUESTED') {
      counts.changeRequested += 1;
    }
  }

  return {
    ...counts,
    pendingReview: counts.draft,
    pendingApproval: counts.reviewed,
    actionRequired: counts.reviewed + counts.changeRequested,
    approvedPercent:
      counts.total > 0
        ? Number(((counts.approved / counts.total) * 100).toFixed(1))
        : 0,
  };
};

router.get('/', async (req, res, next) => {
  try {
    const query = querySchema.parse(req.query);

    const [sites, areas] = await Promise.all([
      prisma.investmentSite.findMany({
        where: { isActive: true },
        select: {
          id: true,
          code: true,
          name: true,
          geoJson: true,
          geometryAccuracy: true,
          geometryApprovalStatus: true,
          geometryReviewedById: true,
          geometryReviewedByName: true,
          geometryReviewedAt: true,
          geometryApprovedById: true,
          geometryApprovedByName: true,
          geometryApprovedAt: true,
          geometryReferenceAttachmentId: true,
          geometryWorkflowNote: true,
          updatedAt: true,
          _count: {
            select: {
              areas: { where: { isActive: true } },
            },
          },
        },
      }),
      prisma.investmentArea.findMany({
        where: { isActive: true },
        select: {
          id: true,
          siteId: true,
          areaCode: true,
          areaNumber: true,
          name: true,
          geoJson: true,
          geometryAccuracy: true,
          geometryApprovalStatus: true,
          geometryReviewedById: true,
          geometryReviewedByName: true,
          geometryReviewedAt: true,
          geometryApprovedById: true,
          geometryApprovedByName: true,
          geometryApprovedAt: true,
          geometryReferenceAttachmentId: true,
          geometryWorkflowNote: true,
          updatedAt: true,
          site: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
        },
      }),
    ]);

    const siteItems = sites.map((site) => ({
      entityType: 'investment_site',
      id: site.id,
      code: site.code,
      name: site.name,
      siteId: site.id,
      parentSite: null,
      childAreaCount: site._count?.areas || 0,
      hasGeometry: hasGeometry(site.geoJson),
      geometryAccuracy: site.geometryAccuracy,
      geometryApprovalStatus: site.geometryApprovalStatus,
      geometryReviewedById: site.geometryReviewedById,
      geometryReviewedByName: site.geometryReviewedByName,
      geometryReviewedAt: site.geometryReviewedAt,
      geometryApprovedById: site.geometryApprovedById,
      geometryApprovedByName: site.geometryApprovedByName,
      geometryApprovedAt: site.geometryApprovedAt,
      geometryReferenceAttachmentId:
        site.geometryReferenceAttachmentId,
      geometryWorkflowNote: site.geometryWorkflowNote,
      updatedAt: site.updatedAt,
    }));

    const areaItems = areas.map((area) => ({
      entityType: 'investment_area',
      id: area.id,
      code: area.areaCode,
      name: area.name || `الموقع ${area.areaNumber}`,
      siteId: area.siteId,
      parentSite: area.site,
      childAreaCount: null,
      hasGeometry: hasGeometry(area.geoJson),
      geometryAccuracy: area.geometryAccuracy,
      geometryApprovalStatus: area.geometryApprovalStatus,
      geometryReviewedById: area.geometryReviewedById,
      geometryReviewedByName: area.geometryReviewedByName,
      geometryReviewedAt: area.geometryReviewedAt,
      geometryApprovedById: area.geometryApprovedById,
      geometryApprovedByName: area.geometryApprovedByName,
      geometryApprovedAt: area.geometryApprovedAt,
      geometryReferenceAttachmentId:
        area.geometryReferenceAttachmentId,
      geometryWorkflowNote: area.geometryWorkflowNote,
      updatedAt: area.updatedAt,
    }));

    let baseItems = [...siteItems, ...areaItems];

    if (query.entityType !== 'ALL') {
      baseItems = baseItems.filter(
        (item) => item.entityType === query.entityType
      );
    }

    if (query.siteId) {
      baseItems = baseItems.filter(
        (item) => item.siteId === query.siteId
      );
    }

    if (query.geometry === 'with') {
      baseItems = baseItems.filter((item) => item.hasGeometry);
    } else if (query.geometry === 'without') {
      baseItems = baseItems.filter((item) => !item.hasGeometry);
    }

    if (query.search) {
      const term = normalize(query.search);

      baseItems = baseItems.filter((item) =>
        [
          item.code,
          item.name,
          item.parentSite?.code,
          item.parentSite?.name,
          item.geometryReviewedByName,
          item.geometryApprovedByName,
          item.geometryWorkflowNote,
        ].some((value) => normalize(value).includes(term))
      );
    }

    const stats = buildStats(baseItems);

    let filteredItems = baseItems;
    if (query.status !== 'ALL') {
      filteredItems = filteredItems.filter(
        (item) => item.geometryApprovalStatus === query.status
      );
    }

    const sortedItems = sortItems(filteredItems, query.sort);
    const total = sortedItems.length;
    const pages = Math.max(1, Math.ceil(total / query.limit));
    const safePage = Math.min(query.page, pages);
    const start = (safePage - 1) * query.limit;
    const pageItems = sortedItems.slice(start, start + query.limit);

    const attachmentIds = [
      ...new Set(
        pageItems
          .map((item) => item.geometryReferenceAttachmentId)
          .filter(Boolean)
      ),
    ];

    const attachments = attachmentIds.length
      ? await prisma.attachment.findMany({
          where: {
            id: { in: attachmentIds },
          },
          select: {
            id: true,
            title: true,
            driveUrl: true,
            attachmentType: true,
          },
        })
      : [];

    const attachmentsById = new Map(
      attachments.map((attachment) => [attachment.id, attachment])
    );

    res.json({
      items: pageItems.map((item) => ({
        ...item,
        referenceAttachment:
          item.geometryReferenceAttachmentId
            ? attachmentsById.get(item.geometryReferenceAttachmentId) || null
            : null,
      })),
      stats,
      pagination: {
        page: safePage,
        limit: query.limit,
        total,
        pages,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
