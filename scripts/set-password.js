#!/usr/bin/env node
// Script utilitaire pour forcer (ou créer) un mot de passe utilisateur.
// Usage:
//   node scripts/set-password.js user@example.com "NouveauMot2Passe!"
// Optionnel: ajouter "--admin" comme 3e argument pour transformer l'utilisateur en admin.

require('dotenv').config({ path: __dirname + '/.env' });
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

async function main() {
  const emailArg = process.argv[2];
  const password = process.argv[3];
  const makeAdmin = process.argv.includes('--admin');

  if (!emailArg || !password) {
    console.error('❌ Usage: node scripts/set-password.js <email> <nouveauMotDePasse> [--admin]');
    process.exit(1);
  }

  const email = String(emailArg).trim();
  const emailNorm = email.toLowerCase();
  const prisma = new PrismaClient();

  try {
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });

    const passwordHash = await bcrypt.hash(password, 10);

    if (user) {
      const updated = await prisma.user.update({
        where: { id: user.id },
        data: {
          email: emailNorm,
          passwordHash,
          emailVerified: true,
          ...(makeAdmin ? { isAdmin: true } : {}),
        },
      });
      console.log('✅ Mot de passe mis à jour pour', updated.email);
      if (makeAdmin) console.log('⚙️  Ce compte est maintenant administrateur.');
    } else {
      const created = await prisma.user.create({
        data: {
          email: emailNorm,
          passwordHash,
          emailVerified: true,
          isAdmin: makeAdmin,
        },
      });
      console.log('✅ Compte créé pour', created.email);
      if (makeAdmin) console.log('⚙️  Compte créé avec privilèges admin.');
    }
  } catch (err) {
    console.error('❌ Impossible de définir le mot de passe:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
