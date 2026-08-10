import fs from 'node:fs';

const schemaPath = 'prisma/schema.prisma';
let schema = fs.readFileSync(schemaPath, 'utf8');

const replacement = `model Asset {
  id                    String    @id @default(cuid())
  assetNumber           String?   @unique
  itemNumber            String?   @unique
  barcode               String?   @unique
  name                  String
  category              String
  brand                 String?
  model                 String?
  serialNumber          String?   @unique
  status                String    @default("available")
  technicalCondition    String?
  department            String?
  building              String?
  floor                 String?
  room                  String?
  custodian              String?
  entityName            String?
  entityCode            String?
  assetDescription      String?
  cardNumber            String?
  responsibleDepartment String?
  region                String?
  city                  String?
  buildingNumber        String?
  coordinates           String?
  classification1       String?
  classification2       String?
  classification3       String?
  classification4       String?
  classification5       String?
  classification6       String?
  accountingGroup       String?
  accountingGroupCode   String?
  assetCode             String?
  remainingLife         Float?
  usefulLife            Float?
  purchaseDate          DateTime?
  purchaseDateType      String?   @default("gregorian")
  purchaseValue         Float?
  serviceDate           DateTime?
  serviceDateType       String?   @default("gregorian")
  acquisitionCost       Float?
  supportingCostDocument String?
  archiveDocumentNumber String?
  manufacturer          String?
  lastInventoryDate     DateTime?
  lastInventoryDateType String?   @default("gregorian")
  unitOfMeasure         String?
  quantity              Float?    @default(1)
  excelPayload          Json?
  notes                 String?
  createdBy             String?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  movements       AssetMovement[]
  lossCases       AssetLossCase[]
  inventoryEvents AssetInventoryEvent[]

  @@index([itemNumber])
  @@index([barcode])
  @@index([category])
  @@index([status])
  @@index([technicalCondition])
  @@index([department])
  @@index([building])
  @@index([createdAt])
}

model AssetMovement {
  id             String   @id @default(cuid())
  assetId        String
  movementType   String   @default("transfer")
  fromDepartment String?
  fromBuilding   String?
  fromFloor      String?
  fromRoom       String?
  toDepartment   String?
  toBuilding     String?
  toFloor        String?
  toRoom         String?
  reason         String?
  notes          String?
  movedBy        String?
  movedAt        DateTime @default(now())
  createdAt      DateTime @default(now())

  asset Asset @relation(fields: [assetId], references: [id], onDelete: Cascade)

  @@index([assetId])
  @@index([movedAt])
}

model AssetLossCase {
  id              String   @id @default(cuid())
  caseNumber      String   @unique
  assetId         String
  minutesNumber   String?
  minutesDate     DateTime?
  minutesDateType String?  @default("gregorian")
  department      String?
  reason          String?
  assetValue      Float?
  actionTaken     String?
  notes           String?
  createdBy       String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  asset Asset @relation(fields: [assetId], references: [id], onDelete: Cascade)

  @@index([assetId])
  @@index([createdAt])
}

model AssetInventoryEvent {
  id             String   @id @default(cuid())
  assetId        String
  method         String
  scannedBarcode String?
  result         String   @default("matched")
  department     String?
  building       String?
  floor          String?
  room           String?
  notes          String?
  scannedBy      String?
  scannedAt      DateTime @default(now())

  asset Asset @relation(fields: [assetId], references: [id], onDelete: Cascade)

  @@index([assetId])
  @@index([method])
  @@index([scannedAt])
}

model Attachment {`;

const assetBlock = /model Asset \{[\s\S]*?\n\}\n\nmodel Attachment \{/m;
if (!assetBlock.test(schema)) throw new Error('Asset model block not found');
schema = schema.replace(assetBlock, replacement);
fs.writeFileSync(schemaPath, schema, 'utf8');
console.log('Asset schema foundation upgraded.');
// validated rerun 2026-08-10
