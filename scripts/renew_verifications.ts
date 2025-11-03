import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { env } from '../src/env';
import { sendMail } from '../src/services/mailer';

const prisma = new PrismaClient();

async function main() {
  console.log('[renew:verifications] Début — régénération des tokens de vérification (non-admin)');

  // Récupérer tous les utilisateurs non admin
  const users = await prisma.user.findMany({ where: { isAdmin: false } });
  let updated = 0;
  for (const u of users) {
    // Remettre emailVerified à false et supprimer anciens tokens
    await prisma.$transaction([
      prisma.user.update({ where: { id: u.id }, data: { emailVerified: false } }),
      prisma.emailVerificationToken.deleteMany({ where: { userId: u.id } }),
    ]);

    const token = nanoid();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24); // 24h
    await prisma.emailVerificationToken.create({ data: { userId: u.id, token, expiresAt } });

    const link = `${env.APP_ORIGIN.replace(/\/$/, '')}/verify?token=${encodeURIComponent(token)}`;

    try {
      await sendMail({ to: u.email, subject: 'Vérifiez votre adresse email', html: `<p><a href="${link}">${link}</a></p>` });
      console.log(`[renew:verifications] Email envoyé à ${u.email}`);
    } catch (e) {
      console.warn(`[renew:verifications] Envoi email impossible pour ${u.email}. Lien: ${link}`);
    }
    updated++;
  }

  console.log(`[renew:verifications] Terminé — ${updated} utilisateur(s) traités.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
