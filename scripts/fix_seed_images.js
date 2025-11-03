// Script pour remplacer les photoUrl du seed JSON par des illustrations locales
// Usage: node scripts/fix_seed_images.js

const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../prisma/data/immeubles_seed.json');
if (!fs.existsSync(file)) {
  console.error('Fichier introuvable:', file);
  process.exit(1);
}

const raw = fs.readFileSync(file, 'utf-8');
let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error('JSON invalide:', e.message);
  process.exit(1);
}

function illustrationForType(t) {
  const key = String(t || '').toLowerCase();
  if (key.includes('duplex')) return '/images/props/duplex.svg';
  if (key.includes('triplex')) return '/images/props/triplex.svg';
  return '/images/props/maison.svg';
}

let changed = 0;
for (const im of data) {
  const next = illustrationForType(im.type);
  if (im.photoUrl !== next) {
    im.photoUrl = next;
    changed++;
  }
}

fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
console.log(`Mise à jour terminée: ${changed} entrées modifiées.`);
