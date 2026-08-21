require('dotenv').config();

const { REST, Routes } = require('discord.js');
const { connect, getDb } = require('./mongo');

async function main() {
  await connect();
  const db = getDb();
  const users = db.collection('users');

  const candidates = await users
    .find({ status: { $exists: false } }, { projection: { userId: 1 } })
    .toArray();
  console.log(`Checking ${candidates.length} user doc(s) without an application...`);

  const rest = new REST().setToken(process.env.TOKEN);
  let botDocs = 0;
  let unknownAccounts = 0;

  for (const doc of candidates) {
    const user = await rest.get(Routes.user(doc.userId)).catch((err) => {
      if (err && err.status === 404) return null;
      console.warn(`Lookup failed for ${doc.userId}: ${err.message}`);
      return undefined;
    });

    if (user === undefined) continue;
    if (user === null) {
      unknownAccounts++;
      continue;
    }
    if (user.bot) {
      await users.deleteOne({ _id: doc._id });
      botDocs++;
      console.log(`Deleted bot doc: ${user.username} (${doc.userId})`);
    }
  }

  const stale = await users.updateMany(
    { inviterId: { $ne: null }, status: { $exists: false } },
    { $unset: { inviterId: '', inviterName: '' } }
  );

  console.log('\nCleanup complete.');
  console.log(`Bot docs deleted: ${botDocs}`);
  console.log(`Unknown/deleted accounts skipped: ${unknownAccounts}`);
  console.log(`Stale inviter credits cleared: ${stale.modifiedCount}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
