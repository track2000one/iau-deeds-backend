const fs = require('fs');

const schemaPath = 'prisma/schema.prisma';
const appPath = 'src/app.js';

let schema = fs.readFileSync(schemaPath, 'utf8');
const marker = 'model MosqueSite {';

if (!schema.includes(marker)) {
  schema += `

// ============================================================
// University Mosques & Prayer Rooms Care Unit
// ============================================================
model MosqueSite {
  id               String   @id @default(cuid())
  publicToken      String   @unique @default(uuid())
  name             String
  siteType         String   @default("mosque")
  city             String?
  district         String?
  campusLocation   String?
  area             Float?
  capacity         Int?
  latitude         Float?
  longitude        Float?
  mapUrl           String?
  status           String   @default("active")
  imamName         String?
  muezzinName      String?
  khateebName      String?
  contactPhone     String?
  notes            String?
  images           Json?
  supervisorUserId String?
  createdBy        String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  personnel   MosquePersonnel[]
  requests    MosqueRequest[]
  tickets     MosqueTicket[]
  leaves      MosqueLeave[]
  assignments MosqueUserAssignment[]

  @@index([siteType])
  @@index([city])
  @@index([district])
  @@index([status])
  @@index([supervisorUserId])
}

model MosquePersonnel {
  id        String   @id @default(cuid())
  siteId    String
  userId    String?
  name      String
  role      String   @default("collaborator")
  mobile    String?
  email     String?
  notes     String?
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  site   MosqueSite   @relation(fields: [siteId], references: [id], onDelete: Cascade)
  leaves MosqueLeave[]

  @@index([siteId])
  @@index([userId])
  @@index([role])
  @@index([active])
}

model MosqueRequest {
  id                    String    @id @default(cuid())
  requestNumber         String    @unique
  siteId                String
  requestType           String
  description           String
  priority              String    @default("medium")
  status                String    @default("new")
  attachments           Json?
  notes                 String?
  submittedBy           String?
  assignedTo            String?
  rejectionReason       String?
  returnReason          String?
  completionEvidenceUrl String?
  closedAt              DateTime?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  site MosqueSite @relation(fields: [siteId], references: [id], onDelete: Restrict)

  @@index([siteId])
  @@index([requestType])
  @@index([priority])
  @@index([status])
  @@index([submittedBy])
  @@index([assignedTo])
  @@index([createdAt])
}

model MosqueTicket {
  id                 String    @id @default(cuid())
  ticketNumber       String    @unique
  trackingToken      String    @unique @default(uuid())
  siteId             String
  ticketType         String
  description        String
  reporterName       String?
  reporterPhone      String?
  reporterEmail      String?
  attachmentUrl      String?
  status             String    @default("new")
  assignedTo         String?
  convertedRequestId String?
  rejectionReason    String?
  resolutionNote     String?
  notes              String?
  closedAt           DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  site MosqueSite @relation(fields: [siteId], references: [id], onDelete: Restrict)

  @@index([siteId])
  @@index([ticketType])
  @@index([status])
  @@index([assignedTo])
  @@index([createdAt])
}

model MosqueLeave {
  id                String    @id @default(cuid())
  leaveNumber       String    @unique
  siteId            String
  personnelId       String?
  applicantUserId   String?
  requestType       String
  startDate         DateTime
  endDate           DateTime
  reason            String
  replacementName   String
  replacementUserId String?
  attachmentUrl     String?
  status            String    @default("pending")
  notes             String?
  reviewerNote      String?
  rejectionReason   String?
  returnReason      String?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  site      MosqueSite       @relation(fields: [siteId], references: [id], onDelete: Restrict)
  personnel MosquePersonnel? @relation(fields: [personnelId], references: [id], onDelete: SetNull)

  @@index([siteId])
  @@index([personnelId])
  @@index([applicantUserId])
  @@index([replacementUserId])
  @@index([status])
  @@index([startDate])
  @@index([endDate])
}

model MosqueJobApplication {
  id                String    @id @default(cuid())
  applicationNumber String    @unique
  trackingToken     String    @unique @default(uuid())
  fullName          String
  nationalId        String
  phone             String
  email             String
  qualification     String
  experience        String?
  jobType           String
  preferredLocation String?
  cvUrl             String?
  attachments       Json?
  status            String    @default("new")
  internalNotes     String?
  interviewAt       DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  @@index([nationalId])
  @@index([email])
  @@index([jobType])
  @@index([status])
  @@index([createdAt])
}

model MosqueUserAssignment {
  id            String   @id @default(cuid())
  userId        String   @unique
  role          String   @default("viewer")
  siteId        String?
  personnelRole String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  site MosqueSite? @relation(fields: [siteId], references: [id], onDelete: SetNull)

  @@index([role])
  @@index([siteId])
}

model MosqueNotification {
  id         String   @id @default(cuid())
  userId     String?
  roleTarget String?
  siteId     String?
  title      String
  message    String
  entityType String?
  entityId   String?
  isRead     Boolean  @default(false)
  createdAt  DateTime @default(now())

  @@index([userId])
  @@index([roleTarget])
  @@index([siteId])
  @@index([isRead])
  @@index([createdAt])
}
`;
  fs.writeFileSync(schemaPath, schema, 'utf8');
}

let app = fs.readFileSync(appPath, 'utf8');
const importLine = "import mosquesRoutes, { mosquesPublicRoutes } from './routes/mosques.routes.js';";
if (!app.includes(importLine)) {
  const anchor = "import contractsFollowUpRoutes from './routes/contracts-followup.routes.js';";
  if (!app.includes(anchor)) throw new Error('Unable to find app import anchor');
  app = app.replace(anchor, `${anchor}\n${importLine}`);
}

const publicMount = "app.use('/api/mosques/public', mosquesPublicRoutes);";
if (!app.includes(publicMount)) {
  const anchor = "app.use('/api/auth', authRoutes);";
  if (!app.includes(anchor)) throw new Error('Unable to find public mount anchor');
  app = app.replace(anchor, `${anchor}\n${publicMount}`);
}

const protectedMount = `app.use(\n  '/api/mosques',\n  requireAuth,\n  auditTrail('mosques'),\n  requirePermission('mosques'),\n  mosquesRoutes\n);`;
if (!app.includes("'/api/mosques',")) {
  const anchor = 'app.use(notFound);';
  if (!app.includes(anchor)) throw new Error('Unable to find protected mount anchor');
  app = app.replace(anchor, `${protectedMount}\n\n${anchor}`);
}

fs.writeFileSync(appPath, app, 'utf8');
console.log('Mosques unit schema and API mounts applied.');
