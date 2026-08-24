import fs from 'node:fs';
const path = 'src/routes/accounting-transformation.routes.js';
let source = fs.readFileSync(path, 'utf8');
const oldBlock = `const attachmentSchema = z.object({\n  title: z.string().trim().min(1),\n  driveUrl: z.string().trim().min(1),\n  driveFileId: z.string().trim().nullable().optional(),\n  mimeType: z.string().trim().nullable().optional(),\n  notes: z.string().trim().nullable().optional(),\n});`;
const newBlock = `const attachmentSchema = z.object({\n  title: z.string().trim().min(1),\n  driveUrl: z.string().trim().min(1),\n  driveFileId: z.string().trim().nullable().optional(),\n  mimeType: z.string().trim().nullable().optional(),\n  notes: z.string().trim().nullable().optional(),\n  documentPurpose: z.enum(['ownership_acquisition', 'maintenance', 'valuation', 'asset_image', 'other']).nullable().optional(),\n  documentType: z.string().trim().nullable().optional(),\n  documentNumber: z.string().trim().nullable().optional(),\n  archiveNumber: z.string().trim().nullable().optional(),\n});`;
if (source.includes(oldBlock)) source = source.replace(oldBlock, newBlock);
else if (!source.includes("documentPurpose: z.enum(['ownership_acquisition'")) throw new Error('Attachment schema anchor not found');
fs.writeFileSync(path, source);
console.log('Backend attachment metadata schema patched.');
