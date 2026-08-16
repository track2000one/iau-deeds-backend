import crypto from 'node:crypto';
import { prisma } from '../prisma.js';

const DEFAULT_UNITS = [
  {
    id: 'org-ast',
    code: 'AST',
    nameAr: 'وحدة/إدارة الأصول',
    nameEn: 'Assets Unit',
    unitType: 'assets_unit',
    isBeneficiary: false,
    responsibility: 'إنشاء رقم الأصل والسجل المركزي والتفعيل والعهدة والنقل ومتابعة حالة الأصل وإغلاق دورة حياته.',
  },
  {
    id: 'org-pur',
    code: 'PUR',
    nameAr: 'الإدارة العامة للمشتريات والمناقصات',
    nameEn: 'Procurement and Tenders',
    unitType: 'procurement',
    isBeneficiary: false,
    responsibility: 'بيانات الشراء والعقود والتوريد والإجراءات التعاقدية المرتبطة بالأصول.',
  },
  {
    id: 'org-whs',
    code: 'WHS',
    nameAr: 'إدارة المستودعات',
    nameEn: 'Warehouses Department',
    unitType: 'warehouses',
    isBeneficiary: false,
    responsibility: 'الاستلام الفعلي والتخزين والصرف والإرجاع والتسليم.',
  },
  {
    id: 'org-inv',
    code: 'INV',
    nameAr: 'إدارة مراقبة المخزون',
    nameEn: 'Inventory Control Department',
    unitType: 'inventory_control',
    isBeneficiary: false,
    responsibility: 'المطابقة والرقابة والتدقيق والجرد والتحقق من الموجودات.',
  },
  {
    id: 'org-eqp',
    code: 'EQP',
    nameAr: 'الإدارة العامة للتجهيزات',
    nameEn: 'General Department of Equipment',
    unitType: 'equipment',
    isBeneficiary: false,
    responsibility: 'الفحص الفني للأثاث والتجهيزات وتقييم صلاحيتها ومطابقتها.',
  },
  {
    id: 'org-ict',
    code: 'ICT',
    nameAr: 'مركز الاتصالات وتقنية المعلومات',
    nameEn: 'Communication and Information Technology Center',
    unitType: 'ict',
    isBeneficiary: false,
    responsibility: 'الفحص والتقييم الفني للأجهزة والأنظمة التقنية.',
  },
  {
    id: 'org-ben',
    code: 'BEN',
    nameAr: 'الجهات المستفيدة',
    nameEn: 'Beneficiary Entities',
    unitType: 'beneficiary',
    isBeneficiary: true,
    responsibility: 'تصنيف رئيسي تندرج تحته الكليات والعمادات والإدارات والمراكز المستفيدة من الأصول.',
  },
];

const mapUnit = (row) => ({
  id: row.id,
  code: row.code,
  nameAr: row.name_ar,
  nameEn: row.name_en,
  unitType: row.unit_type,
  parentId: row.parent_id,
  isBeneficiary: row.is_beneficiary,
  isActive: row.is_active,
  responsibility: row.responsibility,
  userCount: Number(row.user_count || 0),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapAssignment = (row) => {
  if (!row) return null;

  return {
    organizationUnitId: row.organization_unit_id,
    organizationRole: row.organization_role,
    permissionScope: row.permission_scope || 'department',
    organizationUnit: row.organization_unit_id
      ? {
          id: row.organization_unit_id,
          code: row.code,
          nameAr: row.name_ar,
          nameEn: row.name_en,
          unitType: row.unit_type,
          parentId: row.parent_id,
          isBeneficiary: row.is_beneficiary,
          isActive: row.is_active,
        }
      : null,
  };
};

export const ensureOrganizationStorage = async () => {
  await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS iau_org');

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS iau_org.organization_units (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      unit_type TEXT NOT NULL,
      parent_id TEXT REFERENCES iau_org.organization_units(id) ON DELETE SET NULL,
      is_beneficiary BOOLEAN NOT NULL DEFAULT FALSE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      responsibility TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS iau_org.user_assignments (
      user_id TEXT PRIMARY KEY,
      organization_unit_id TEXT REFERENCES iau_org.organization_units(id) ON DELETE SET NULL,
      organization_role TEXT,
      permission_scope TEXT NOT NULL DEFAULT 'department',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_org_units_parent
      ON iau_org.organization_units(parent_id)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_org_units_type
      ON iau_org.organization_units(unit_type)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS idx_org_assignments_unit
      ON iau_org.user_assignments(organization_unit_id)
  `);

  for (const unit of DEFAULT_UNITS) {
    await prisma.$executeRawUnsafe(
      `
        INSERT INTO iau_org.organization_units
          (id, code, name_ar, name_en, unit_type, is_beneficiary, responsibility)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (code) DO UPDATE SET
          name_ar = EXCLUDED.name_ar,
          name_en = EXCLUDED.name_en,
          unit_type = EXCLUDED.unit_type,
          is_beneficiary = EXCLUDED.is_beneficiary,
          responsibility = EXCLUDED.responsibility,
          updated_at = NOW()
      `,
      unit.id,
      unit.code,
      unit.nameAr,
      unit.nameEn,
      unit.unitType,
      unit.isBeneficiary,
      unit.responsibility
    );
  }
};

export const listOrganizationUnits = async () => {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT
      u.*,
      COUNT(a.user_id)::int AS user_count
    FROM iau_org.organization_units u
    LEFT JOIN iau_org.user_assignments a
      ON a.organization_unit_id = u.id
    GROUP BY u.id
    ORDER BY
      CASE u.code
        WHEN 'AST' THEN 1
        WHEN 'PUR' THEN 2
        WHEN 'WHS' THEN 3
        WHEN 'INV' THEN 4
        WHEN 'EQP' THEN 5
        WHEN 'ICT' THEN 6
        WHEN 'BEN' THEN 7
        ELSE 8
      END,
      u.name_ar ASC
  `);

  return rows.map(mapUnit);
};

export const getOrganizationUnit = async (id) => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM iau_org.organization_units WHERE id = $1 LIMIT 1`,
    id
  );

  return rows[0] ? mapUnit(rows[0]) : null;
};

export const createOrganizationUnit = async (input) => {
  const id = crypto.randomUUID();

  await prisma.$executeRawUnsafe(
    `
      INSERT INTO iau_org.organization_units
        (id, code, name_ar, name_en, unit_type, parent_id, is_beneficiary, is_active, responsibility)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    id,
    input.code.trim().toUpperCase(),
    input.nameAr.trim(),
    input.nameEn?.trim() || null,
    input.unitType,
    input.parentId || null,
    Boolean(input.isBeneficiary),
    input.isActive !== false,
    input.responsibility?.trim() || null
  );

  return getOrganizationUnit(id);
};

export const updateOrganizationUnit = async (id, input) => {
  await prisma.$executeRawUnsafe(
    `
      UPDATE iau_org.organization_units
      SET
        code = $2,
        name_ar = $3,
        name_en = $4,
        unit_type = $5,
        parent_id = $6,
        is_beneficiary = $7,
        is_active = $8,
        responsibility = $9,
        updated_at = NOW()
      WHERE id = $1
    `,
    id,
    input.code.trim().toUpperCase(),
    input.nameAr.trim(),
    input.nameEn?.trim() || null,
    input.unitType,
    input.parentId || null,
    Boolean(input.isBeneficiary),
    input.isActive !== false,
    input.responsibility?.trim() || null
  );

  return getOrganizationUnit(id);
};

export const getUserOrganizationAssignment = async (userId) => {
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT
        a.user_id,
        a.organization_unit_id,
        a.organization_role,
        a.permission_scope,
        u.code,
        u.name_ar,
        u.name_en,
        u.unit_type,
        u.parent_id,
        u.is_beneficiary,
        u.is_active
      FROM iau_org.user_assignments a
      LEFT JOIN iau_org.organization_units u
        ON u.id = a.organization_unit_id
      WHERE a.user_id = $1
      LIMIT 1
    `,
    userId
  );

  return mapAssignment(rows[0]);
};

export const listUserOrganizationAssignments = async () => {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT
      a.user_id,
      a.organization_unit_id,
      a.organization_role,
      a.permission_scope,
      u.code,
      u.name_ar,
      u.name_en,
      u.unit_type,
      u.parent_id,
      u.is_beneficiary,
      u.is_active
    FROM iau_org.user_assignments a
    LEFT JOIN iau_org.organization_units u
      ON u.id = a.organization_unit_id
  `);

  return new Map(rows.map((row) => [row.user_id, mapAssignment(row)]));
};

export const upsertUserOrganizationAssignment = async (
  userId,
  { organizationUnitId = null, organizationRole = null, permissionScope = 'department' } = {}
) => {
  if (!organizationUnitId && !organizationRole) {
    await removeUserOrganizationAssignment(userId);
    return null;
  }

  await prisma.$executeRawUnsafe(
    `
      INSERT INTO iau_org.user_assignments
        (user_id, organization_unit_id, organization_role, permission_scope)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id) DO UPDATE SET
        organization_unit_id = EXCLUDED.organization_unit_id,
        organization_role = EXCLUDED.organization_role,
        permission_scope = EXCLUDED.permission_scope,
        updated_at = NOW()
    `,
    userId,
    organizationUnitId || null,
    organizationRole?.trim() || null,
    permissionScope || 'department'
  );

  return getUserOrganizationAssignment(userId);
};

export const removeUserOrganizationAssignment = async (userId) => {
  await prisma.$executeRawUnsafe(
    `DELETE FROM iau_org.user_assignments WHERE user_id = $1`,
    userId
  );
};
