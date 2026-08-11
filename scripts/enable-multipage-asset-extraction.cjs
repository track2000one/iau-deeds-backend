const fs = require('fs');

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Patch target not found: ${label}`);
  return source.replace(before, after);
}

const path = 'src/routes/assets.routes.js';
let src = fs.readFileSync(path, 'utf8');

src = replaceOnce(src,
`router.post('/extract-data', smartExtractionUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'اختر صورة أو ملف PDF لاستخراج بيانات الأصل.' });`,
`router.post('/extract-data', smartExtractionUpload.fields([{ name: 'files', maxCount: 8 }, { name: 'file', maxCount: 1 }]), async (req, res, next) => {
  try {
    const smartFiles = [
      ...((req.files?.files || [])),
      ...((req.files?.file || [])),
    ].slice(0, 8);
    if (!smartFiles.length) return res.status(400).json({ message: 'اختر صورة أو ملف PDF واحدًا على الأقل لاستخراج بيانات الأصل.' });
    const totalSize = smartFiles.reduce((sum, file) => sum + Number(file.size || file.buffer?.length || 0), 0);
    if (totalSize > 40 * 1024 * 1024) return res.status(400).json({ message: 'إجمالي ملفات القراءة يتجاوز 40MB. قلّل عدد الصفحات أو أحجام الملفات.' });`,
'multipart files handler');

src = replaceOnce(src,
`    const mimeType = req.file.mimetype || (/\\.pdf$/i.test(req.file.originalname || '') ? 'application/pdf' : 'image/jpeg');
    const base64 = req.file.buffer.toString('base64');
    const fileInput = mimeType === 'application/pdf'
      ? { type: 'input_file', filename: req.file.originalname || 'asset-document.pdf', file_data: base64 }
      : { type: 'input_image', image_url: \`data:\${mimeType};base64,\${base64}\`, detail: 'high' };`,
`    const fileInputs = smartFiles.map((file, index) => {
      const mimeType = file.mimetype || (/\\.pdf$/i.test(file.originalname || '') ? 'application/pdf' : 'image/jpeg');
      const base64 = file.buffer.toString('base64');
      return mimeType === 'application/pdf'
        ? { type: 'input_file', filename: file.originalname || \`asset-document-\${index + 1}.pdf\`, file_data: base64 }
        : { type: 'input_image', image_url: \`data:\${mimeType};base64,\${base64}\`, detail: 'high' };
    });`,
'multiple OpenAI inputs');

src = replaceOnce(src,
`      'اقرأ الصورة أو المستند المرفق بدقة واستخرج فقط المعلومات الظاهرة أو المدعومة بوضوح. لا تخمّن أرقاماً أو قيماً غير موجودة.',`,
`      'اقرأ جميع الصور والمستندات المرفقة بدقة باعتبارها صفحات أو مستندات مرتبطة بنفس عملية إدخال الأصل. اربط المعلومات المتكاملة بين الصفحات، واستخرج فقط المعلومات الظاهرة أو المدعومة بوضوح. لا تخمّن أرقاماً أو قيماً غير موجودة.',`,
'multipage prompt');

src = replaceOnce(src,
`        input: [{ role: 'user', content: [{ type: 'input_text', text: extractionPrompt }, fileInput] }],`,
`        input: [{ role: 'user', content: [{ type: 'input_text', text: extractionPrompt }, ...fileInputs] }],`,
'multiple response content');

src = replaceOnce(src,
`      source: {
        fileName: req.file.originalname || 'asset-document',
        mimeType,
        size: req.file.size || req.file.buffer.length,
      },`,
`      source: {
        fileName: smartFiles.length === 1 ? (smartFiles[0].originalname || 'asset-document') : \`\${smartFiles.length} files\`,
        mimeType: smartFiles.length === 1 ? (smartFiles[0].mimetype || null) : 'multipart/mixed',
        size: totalSize,
        files: smartFiles.map((file) => ({
          fileName: file.originalname || 'asset-document',
          mimeType: file.mimetype || null,
          size: file.size || file.buffer.length,
        })),
      },`,
'multi source response');

fs.writeFileSync(path, src);
console.log('Multipage asset extraction backend applied.');
