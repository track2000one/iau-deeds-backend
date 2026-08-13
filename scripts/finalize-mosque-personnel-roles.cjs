const fs = require('fs');
const path = 'src/routes/mosques.routes.js';
let s = fs.readFileSync(path, 'utf8');
const oldLine = "    res.json({ role: context.role, siteId: context.siteId, userId: req.authUser.id, isAdmin: req.authUser.role === 'admin' });";
if (!s.includes(oldLine)) throw new Error('mosques /me response anchor missing');
const newLine = "    res.json({ role: context.role, siteId: context.siteId, personnelRole: context.assignment?.personnelRole || null, userId: req.authUser.id, isAdmin: req.authUser.role === 'admin' });";
s = s.replace(oldLine, newLine);
fs.writeFileSync(path, s);
console.log('Added exact personnel role to mosque /me endpoint');
