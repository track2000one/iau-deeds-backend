const fs = require('fs');

const schemaPath = 'prisma/schema.prisma';
const appPath = 'src/app.js';

let schema = fs.readFileSync(schemaPath, 'utf8');
if (!schema.includes('model AccountingTransformationRecord')) {
  schema += `\n\n// ============================================================\n// Accounting Transformation Requirements Follow-up Committee\n// ============================================================\nmodel AccountingTransformationRecord {\n  id                   String   @id @default(cuid())\n  recordNumber         String   @unique\n  recordType           String\n  ownershipMode        String   @default("owned")\n  committeeStatus      String   @default("not_reviewed")\n  entityName           String?\n  entityCode           String?\n  mofAssetNumber       String?\n  entityAssetNumber    String?\n  linkedAsset          String?\n  assetDescription     String?\n  accountingGroup      String?\n  accountingGroupCode  String?\n  accountingAssetCode  String?\n  region               String?\n  city                 String?\n  censusProgress       Int      @default(0)\n  inventoryProgress    Int      @default(0)\n  valuationProgress    Int      @default(0)\n  overallProgress      Int      @default(0)\n  readinessStatus      String   @default("needs_data")\n  sourceFingerprint    String?  @unique\n  payload              Json\n  attachments          Json?\n  notes                String?\n  createdBy            String?\n  updatedBy            String?\n  createdAt            DateTime @default(now())\n  updatedAt            DateTime @updatedAt\n\n  @@index([recordType])\n  @@index([committeeStatus])\n  @@index([readinessStatus])\n  @@index([entityName])\n  @@index([entityAssetNumber])\n  @@index([mofAssetNumber])\n  @@index([linkedAsset])\n  @@index([accountingAssetCode])\n  @@index([city])\n  @@index([overallProgress])\n  @@index([updatedAt])\n}\n`;
  fs.writeFileSync(schemaPath, schema, 'utf8');
}

let app = fs.readFileSync(appPath, 'utf8');
if (!app.includes("accountingTransformationRoutes")) {
  app = app.replace(
    "import mosquesRoutes, { mosquesPublicRoutes } from './routes/mosques.routes.js';",
    "import mosquesRoutes, { mosquesPublicRoutes } from './routes/mosques.routes.js';\nimport accountingTransformationRoutes from './routes/accounting-transformation.routes.js';"
  );
  app = app.replace(
    "app.use(notFound);",
    "app.use(\n  '/api/accounting-transformation',\n  requireAuth,\n  auditTrail('accounting_transformation'),\n  requirePermission('accounting_transformation'),\n  accountingTransformationRoutes\n);\n\napp.use(notFound);"
  );
  fs.writeFileSync(appPath, app, 'utf8');
}

console.log('Accounting transformation backend integration applied.');
