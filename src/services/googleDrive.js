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
  const folderId = options.folderId || requireEnv('GOOGLE_DRIVE_FOLDER_ID');

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

  if (options.makePublic !== false) {
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
  }

  return {
    fileName: response.data.name || fileName,
    driveUrl: response.data.webViewLink || `https://drive.google.com/file/d/${driveFileId}/view`,
    driveFileId,
    mimeType: response.data.mimeType || mimeType,
  };
}

export async function ensureGoogleDriveFolder(name, parentId = null) {
  const rootFolderId = parentId || requireEnv('GOOGLE_DRIVE_FOLDER_ID');
  const drive = getOAuthDriveClient();
  const escapedName = String(name).replace(/'/g, "\\'");
  const existing = await drive.files.list({
    q: `'${rootFolderId}' in parents and name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name,webViewLink)',
    pageSize: 10,
  });

  const found = existing.data.files?.[0];
  if (found?.id) {
    return {
      id: found.id,
      name: found.name || name,
      webViewLink: found.webViewLink || `https://drive.google.com/drive/folders/${found.id}`,
    };
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootFolderId],
    },
    fields: 'id,name,webViewLink',
  });

  if (!created.data.id) throw new Error('Google Drive did not return a folder ID.');
  return {
    id: created.data.id,
    name: created.data.name || name,
    webViewLink: created.data.webViewLink || `https://drive.google.com/drive/folders/${created.data.id}`,
  };
}

export async function copyGoogleDriveFile(fileId, targetFolderId, fileName = null) {
  if (!fileId) throw new Error('Google Drive source file ID is required.');
  if (!targetFolderId) throw new Error('Google Drive target folder ID is required.');
  const drive = getOAuthDriveClient();

  const response = await drive.files.copy({
    fileId,
    requestBody: {
      ...(fileName ? { name: fileName } : {}),
      parents: [targetFolderId],
    },
    fields: 'id,name,mimeType,webViewLink,webContentLink',
  });

  if (!response.data.id) throw new Error('Google Drive did not return a copied file ID.');
  return {
    id: response.data.id,
    name: response.data.name || fileName || 'attachment',
    mimeType: response.data.mimeType || 'application/octet-stream',
    webViewLink: response.data.webViewLink || `https://drive.google.com/file/d/${response.data.id}/view`,
  };
}

export async function listGoogleDriveFolderFiles(folderId) {
  if (!folderId) throw new Error('Google Drive folder ID is required.');
  const drive = getOAuthDriveClient();
  const files = [];
  let pageToken;

  do {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,size,webViewLink,parents)',
      pageSize: 1000,
      pageToken,
    });
    files.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return files.map((file) => ({
    id: file.id,
    name: file.name || '',
    mimeType: file.mimeType || '',
    size: file.size ? Number(file.size) : null,
    webViewLink: file.webViewLink || null,
    parents: file.parents || [],
  }));
}

export async function listGoogleDriveFolderFilesRecursive(folderId) {
  const files = [];
  const stack = [folderId];

  while (stack.length) {
    const currentFolderId = stack.pop();
    const children = await listGoogleDriveFolderFiles(currentFolderId);
    for (const child of children) {
      if (child.mimeType === 'application/vnd.google-apps.folder') {
        stack.push(child.id);
      } else {
        files.push(child);
      }
    }
  }

  return files;
}

export async function deleteGoogleDriveFolder(folderId) {
  if (!folderId) return false;
  const drive = getOAuthDriveClient();
  await drive.files.delete({ fileId: folderId });
  return true;
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


export async function downloadGoogleDriveFile(fileId) {
  if (!fileId) throw new Error('Google Drive file ID is required.');
  const drive = getOAuthDriveClient();
  const metadata = await drive.files.get({ fileId, fields: 'id,name,mimeType,size' });
  const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return {
    buffer: Buffer.from(response.data),
    fileName: metadata.data.name || 'asset-template.xlsx',
    mimeType: metadata.data.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: metadata.data.size ? Number(metadata.data.size) : null,
  };
}
