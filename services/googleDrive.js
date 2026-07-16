import { google } from 'googleapis';
import { Readable } from 'node:stream';

const REQUIRED_VARIABLES = [
  'GOOGLE_DRIVE_FOLDER_ID',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
];

function assertGoogleDriveConfig() {
  const missing = REQUIRED_VARIABLES.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Google Drive configuration is missing: ${missing.join(', ')}`);
  }
}

function getPrivateKey() {
  return process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
}

function getDriveClient() {
  assertGoogleDriveConfig();

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: getPrivateKey(),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  return google.drive({
    version: 'v3',
    auth,
  });
}

function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

export async function uploadBufferToGoogleDrive(file, options = {}) {
  if (!file) {
    throw new Error('لم يتم إرسال أي ملف للرفع.');
  }

  const drive = getDriveClient();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  const safeOriginalName = file.originalname || 'uploaded-file';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = options.fileName || `${timestamp}-${safeOriginalName}`;

  const createResponse = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      mimeType: file.mimetype,
    },
    media: {
      mimeType: file.mimetype,
      body: bufferToStream(file.buffer),
    },
    fields: 'id, name, mimeType, size, webViewLink, webContentLink',
    supportsAllDrives: true,
  });

  const uploadedFile = createResponse.data;

  await drive.permissions.create({
    fileId: uploadedFile.id,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
    supportsAllDrives: true,
  });

  const finalFile = await drive.files.get({
    fileId: uploadedFile.id,
    fields: 'id, name, mimeType, size, webViewLink, webContentLink',
    supportsAllDrives: true,
  });

  return {
    driveFileId: finalFile.data.id,
    fileName: finalFile.data.name,
    mimeType: finalFile.data.mimeType,
    size: Number(finalFile.data.size || file.size || 0),
    driveUrl: finalFile.data.webViewLink || `https://drive.google.com/file/d/${finalFile.data.id}/view`,
    downloadUrl: finalFile.data.webContentLink || null,
  };
}

export async function deleteGoogleDriveFile(fileId) {
  if (!fileId) return false;

  const drive = getDriveClient();

  await drive.files.delete({
    fileId,
    supportsAllDrives: true,
  });

  return true;
}
