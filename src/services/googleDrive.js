import { google } from 'googleapis';
import { Readable } from 'node:stream';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is missing.`);
  }
  return value;
}

function getOAuthDriveClient() {
  const clientId = requireEnv('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = requireEnv('GOOGLE_OAUTH_CLIENT_SECRET');
  const refreshToken = requireEnv('GOOGLE_OAUTH_REFRESH_TOKEN');

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return google.drive({ version: 'v3', auth: oauth2Client });
}

function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

function buildSafeFileName(originalName = 'attachment') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  const safeName = String(originalName)
    .replace(/[^\w.\-\u0600-\u06FF\s]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 180);

  return `${timestamp}-${safeName || 'attachment'}`;
}

export async function uploadBufferToGoogleDrive(file, options = {}) {
  const folderId = requireEnv('GOOGLE_DRIVE_FOLDER_ID');

  if (!file?.buffer) {
    throw new Error('No file buffer received for upload.');
  }

  const drive = getOAuthDriveClient();

  const fileName = buildSafeFileName(options.fileName || file.originalname);
  const mimeType = file.mimetype || options.mimeType || 'application/octet-stream';

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      mimeType,
    },
    media: {
      mimeType,
      body: bufferToStream(file.buffer),
    },
    fields: 'id,name,mimeType,webViewLink,webContentLink',
  });

  const driveFileId = response.data.id;

  if (!driveFileId) {
    throw new Error('Google Drive did not return a file ID.');
  }

  try {
    await drive.permissions.create({
      fileId: driveFileId,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });
  } catch (error) {
    console.warn('Could not make uploaded file public:', error?.message || error);
  }

  return {
    fileName: response.data.name || fileName,
    driveUrl: response.data.webViewLink || `https://drive.google.com/file/d/${driveFileId}/view`,
    driveFileId,
    mimeType: response.data.mimeType || mimeType,
  };
}

export async function deleteGoogleDriveFile(fileId) {
  if (!fileId) {
    return false;
  }

  const drive = getOAuthDriveClient();

  await drive.files.delete({
    fileId,
  });

  return true;
}
