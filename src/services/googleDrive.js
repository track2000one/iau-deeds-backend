import { google } from 'googleapis';
import { Readable } from 'node:stream';

const DRIVE_SCOPE = ['https://www.googleapis.com/auth/drive'];

function getServiceAccountCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      return {
        client_email: parsed.client_email,
        private_key: parsed.private_key,
      };
    } catch (error) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.');
    }
  }

  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    throw new Error(
      'Google Drive credentials are missing. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY.'
    );
  }

  return {
    client_email: clientEmail,
    private_key: privateKey.replace(/\\n/g, '\n'),
  };
}

function getDriveClient() {
  const credentials = getServiceAccountCredentials();

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: DRIVE_SCOPE,
  });

  return google.drive({ version: 'v3', auth });
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
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!folderId) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID is missing.');
  }

  if (!file?.buffer) {
    throw new Error('No file buffer received for upload.');
  }

  const drive = getDriveClient();
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
    supportsAllDrives: true,
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
      supportsAllDrives: true,
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

  const drive = getDriveClient();

  await drive.files.delete({
    fileId,
    supportsAllDrives: true,
  });

  return true;
}
