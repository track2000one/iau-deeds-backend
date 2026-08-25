import fs from 'node:fs';

const file = 'src/routes/mosques.routes.js';
let source = fs.readFileSync(file, 'utf8');

const schemaOld = "  images: z.array(z.string()).optional().default([]),";
const schemaNew = `  images: z.union([\n    z.array(z.string()),\n    z.object({\n      photos: z.array(z.object({\n        url: z.string().url(),\n        fileId: z.string().optional().nullable(),\n        fileName: z.string().optional().nullable(),\n        mimeType: z.string().optional().nullable(),\n        category: z.enum(['site_image', 'mosque_image']).optional().default('mosque_image'),\n      })).optional().default([]),\n      documents: z.array(z.object({\n        url: z.string().url(),\n        fileId: z.string().optional().nullable(),\n        fileName: z.string().optional().nullable(),\n        mimeType: z.string().optional().nullable(),\n      })).optional().default([]),\n    }),\n  ]).optional().default({ photos: [], documents: [] }),`;
if (!source.includes(schemaOld)) throw new Error('site images schema anchor not found');
source = source.replace(schemaOld, schemaNew);

const galleryOld = `    const siteItems = sites.flatMap((site) => {\n      const images = Array.isArray(site.images) ? site.images : [];\n      return images.map((imageUrl, index) => ({\n        id: \`site-\${site.id}-\${index + 1}\`,\n        title: site.name,\n        imageUrl: normalizeGalleryImageUrl(imageUrl),\n        sourcePage: null,\n        source: 'site',\n      })).filter((item) => /^https?:\\/\\//i.test(item.imageUrl));\n    });`;
const galleryNew = `    const siteItems = sites.flatMap((site) => {\n      const legacyPhotos = Array.isArray(site.images) ? site.images : [];\n      const structuredPhotos = !Array.isArray(site.images) && site.images && Array.isArray(site.images.photos)\n        ? site.images.photos\n        : [];\n      const photos = [\n        ...legacyPhotos.map((url) => ({ url })),\n        ...structuredPhotos,\n      ];\n      return photos.map((photo, index) => ({\n        id: \`site-\${site.id}-\${index + 1}\`,\n        title: site.name,\n        imageUrl: normalizeGalleryImageUrl(photo?.url || ''),\n        sourcePage: null,\n        source: 'site',\n      })).filter((item) => /^https?:\\/\\//i.test(item.imageUrl));\n    });`;
if (!source.includes(galleryOld)) throw new Error('gallery anchor not found');
source = source.replace(galleryOld, galleryNew);

fs.writeFileSync(file, source);
console.log('Applied mosque site media schema and gallery compatibility.');
