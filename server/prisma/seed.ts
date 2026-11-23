import 'dotenv/config';
import { PrismaClient, Role, AdminLevel } from '@prisma/client';
import bcrypt from 'bcryptjs';
const prisma = new PrismaClient();
async function main() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) { console.log('Admin seed skipped: set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD.'); return; }
  if (password.length < 14) throw new Error('Seed admin password must be at least 14 characters.');
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.upsert({ where: { email }, update: { role: Role.ADMIN, adminLevel: AdminLevel.SUPER_ADMIN }, create: { name: 'Sham Haven Admin', email, passwordHash, role: Role.ADMIN, adminLevel: AdminLevel.SUPER_ADMIN } });
  console.log(`Admin account ensured for ${email}`);
}
main().finally(() => prisma.$disconnect());
