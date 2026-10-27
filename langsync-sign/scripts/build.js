// Vercel build step: copy the PDF.js browser bundle next to the static files.
const fs = require('fs');
const path = require('path');

const from = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build');
const to = path.join(__dirname, '..', 'public', 'vendor', 'pdfjs');
fs.mkdirSync(to, { recursive: true });
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) fs.copyFileSync(path.join(from, file), path.join(to, file));
console.log('Copied PDF.js to public/vendor/pdfjs');
