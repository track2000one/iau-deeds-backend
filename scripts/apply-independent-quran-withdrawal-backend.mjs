import fs from 'node:fs';

const routePath = 'src/routes/mosques.routes.js';
let source = fs.readFileSync(routePath, 'utf8');

const coupledBlock = `    const totalCount = input.largeCount + input.mediumCount + input.smallCount;\n    if (input.recommendedWithdrawalCount > totalCount) {\n      return res.status(400).json({ message: 'عدد المصاحف الموصى بسحبها لا يمكن أن يتجاوز إجمالي المصاحف الموجودة في الموقع' });\n    }\n\n    const countedAt = input.countedAt || new Date();`;

const independentBlock = `    const totalCount = input.largeCount + input.mediumCount + input.smallCount;\n    // العدد الموصى بسحبه / استبداله ملاحظة ميدانية مستقلة عن إجمالي المصاحف حسب الأحجام.\n    // لا تتم مقارنته بإجمالي المصاحف الكبيرة + المتوسطة + الصغيرة.\n    const countedAt = input.countedAt || new Date();`;

if (source.includes(coupledBlock)) {
  source = source.replace(coupledBlock, independentBlock);
  fs.writeFileSync(routePath, source);
  console.log('Removed backend Quran withdrawal-to-size-total coupling.');
} else if (source.includes('العدد الموصى بسحبه / استبداله ملاحظة ميدانية مستقلة')) {
  console.log('Backend Quran withdrawal count is already independent.');
} else {
  throw new Error('Expected Quran withdrawal coupling block was not found.');
}
