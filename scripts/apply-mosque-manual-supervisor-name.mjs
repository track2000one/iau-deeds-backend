import fs from 'node:fs';

const replaceOnce = (source, before, after, label) => {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`);
  return source.replace(before, after);
};

const schemaFile = 'prisma/schema.prisma';
let schema = fs.readFileSync(schemaFile, 'utf8');
schema = replaceOnce(
  schema,
  "  coordinatorName  String?\n  contactPhone     String?\n",
  "  coordinatorName  String?\n  supervisorName   String?\n  contactPhone     String?\n",
  'MosqueSite supervisorName schema',
);
fs.writeFileSync(schemaFile, schema);

const routeFile = 'src/routes/mosques.routes.js';
let routes = fs.readFileSync(routeFile, 'utf8');
routes = replaceOnce(
  routes,
  "  coordinatorName: z.string().trim().optional().nullable(),\n  contactPhone: z.string().trim().optional().nullable(),\n",
  "  coordinatorName: z.string().trim().optional().nullable(),\n  supervisorName: z.string().trim().optional().nullable(),\n  contactPhone: z.string().trim().optional().nullable(),\n",
  'siteSchema supervisorName',
);
fs.writeFileSync(routeFile, routes);
console.log('Backend manual supervisor name patch applied successfully.');
