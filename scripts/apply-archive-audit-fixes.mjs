import fs from 'node:fs';

const replaceOnce = (source, before, after, label) => {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  return source.replace(before, after);
};

const file = 'src/routes/archive.routes.js';
let src = fs.readFileSync(file, 'utf8');

src = replaceOnce(
  src,
  "import express from 'express';\nimport { PrismaClient } from '@prisma/client';\n\nconst router = express.Router();\nconst prisma = new PrismaClient();",
  "import express from 'express';\nimport { prisma } from '../prisma.js';\n\nconst router = express.Router();",
  'shared prisma client',
);

src = replaceOnce(
  src,
  "  driveUrl: cleanString(body.driveUrl),\n  driveFileId: cleanString(body.driveFileId),\n  createdBy: cleanString(body.createdBy),\n});",
  "  driveUrl: cleanString(body.driveUrl),\n  driveFileId: cleanString(body.driveFileId),\n});",
  'remove client-controlled createdBy',
);

src = replaceOnce(
  src,
  "    const document = await prisma.archiveDocument.create({ data });",
  "    const document = await prisma.archiveDocument.create({\n      data: {\n        ...data,\n        createdBy: req.authUser?.username || req.authUser?.email || null,\n      },\n    });",
  'trusted archive creator identity',
);

fs.writeFileSync(file, src);
console.log('Archive backend audit fixes applied.');
