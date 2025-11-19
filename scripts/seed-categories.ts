
import { generateTwentyPerCategory } from '../src/services/aiQuestions';
import { prisma } from '../src/prisma';

async function main() {
  console.log('🌱 Seeding categories with at least 20 questions each...');
  try {
    // Check if OPENAI_API_KEY is set
    if (!process.env.OPENAI_API_KEY) {
      console.warn('⚠️ OPENAI_API_KEY is not set. AI generation will be skipped.');
      console.warn('   Only static fallback questions (logic/iq/anatomy) might be generated if missing.');
    }

    const count = await generateTwentyPerCategory();
    console.log(`✅ Seeding complete. ${count} questions created.`);
  } catch (error) {
    console.error('❌ Error seeding categories:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
