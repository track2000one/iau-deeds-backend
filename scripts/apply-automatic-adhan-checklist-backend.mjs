import fs from 'node:fs';

const path = 'src/routes/mosques.routes.js';
let source = fs.readFileSync(path, 'utf8');

const anchor = "  ['الصوتيات', 'سلامة الميكروفونات والسماعات وأجهزة الأذان'],\n";
const replacement = `${anchor}  ['الصوت والأذان', 'توفر وجاهزية جهاز الأذان التلقائي'],\n`;
if (!source.includes(anchor)) throw new Error('Checklist anchor not found');
if (!source.includes("'توفر وجاهزية جهاز الأذان التلقائي'")) source = source.replace(anchor, replacement);

fs.writeFileSync(path, source);
console.log('Added automatic adhan item to field visit checklist template.');
