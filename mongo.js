const { MongoClient } = require('mongodb');
const dns = require('node:dns');

const URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'vermosabot';

let client = null;
let db = null;

async function connect() {
  if (!URI) {
    console.error('Missing MONGODB_URI in .env');
    process.exit(1);
  }
  client = new MongoClient(URI);
  try {
    await client.connect();
  } catch (err) {
    if (String(err.message).includes('querySrv')) {
      console.warn('Default DNS failed for MongoDB SRV lookup, retrying with public DNS...');
      await client.close().catch(() => {});
      dns.setServers(['8.8.8.8', '1.1.1.1']);
      client = new MongoClient(URI);
      await client.connect();
    } else {
      throw err;
    }
  }
  db = client.db(DB_NAME);
  await db.collection('users').createIndex({ referralCode: 1 }, { unique: true, sparse: true });
  await db.collection('referlinks').createIndex({ ownerId: 1 });
  console.log(`Connected to MongoDB (${DB_NAME})`);
  return db;
}

function getDb() {
  return db;
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'VMS-';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function assignCode(userId) {
  const users = db.collection('users');
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateCode();
    const res = await users.updateOne({ userId, $or: [{ referralCode: null }, { referralCode: { $exists: false } }] }, { $set: { referralCode: code } });
    if (res.modifiedCount === 1) return code;
    const doc = await users.findOne({ userId });
    if (doc && doc.referralCode) return doc.referralCode;
  }
  const doc = await users.findOne({ userId });
  return doc ? doc.referralCode : null;
}

async function ensureUser({ userId, username, inviterId = null, inviterName = null }) {
  const users = db.collection('users');
  const doc = await users.findOne({ userId });
  if (!doc) {
    const newDoc = {
      userId,
      username,
      referralCode: generateCode(),
      inviterId,
      inviterName,
      robloxUsername: null,
      verified: false,
      inServer: true,
      joinCount: 1,
      lastJoinedAt: new Date(),
      createdAt: new Date(),
    };
    try {
      await users.insertOne(newDoc);
      return newDoc;
    } catch (e) {
      if (e.code === 11000) {
        newDoc.referralCode = await assignCode(userId);
        return newDoc;
      }
      throw e;
    }
  }

  const $set = {
    username,
    inServer: true,
    lastJoinedAt: new Date(),
  };
  if (!doc.inviterId && inviterId) {
    $set.inviterId = inviterId;
    $set.inviterName = inviterName;
  }
  if (!doc.referralCode) {
    $set.referralCode = generateCode();
    try {
      await users.updateOne({ userId }, { $set, $inc: { joinCount: 1 } });
    } catch (e) {
      if (e.code === 11000) {
        $set.referralCode = await assignCode(userId);
      } else {
        throw e;
      }
    }
  } else {
    await users.updateOne({ userId }, { $set, $inc: { joinCount: 1 } });
  }
  return { ...doc, ...$set };
}

async function getUser(userId) {
  return db.collection('users').findOne({ userId });
}

async function applyReferralCode(userId, rawCode) {
  if (!rawCode) return { ok: false, reason: 'none' };
  const normalized = rawCode.toUpperCase().replace(/\s+/g, '');
  const candidates = [normalized];
  if (normalized.startsWith('VMS-')) candidates.push(normalized.slice(4));
  else candidates.push(`VMS-${normalized}`);

  let owner = null;
  for (const c of candidates) {
    owner = await db.collection('users').findOne({ referralCode: c });
    if (owner) break;
  }
  if (!owner) return { ok: false, reason: 'not_found' };
  if (owner.userId === userId) return { ok: false, reason: 'self' };

  const doc = await db.collection('users').findOne({ userId });
  if (doc && doc.inviterId) return { ok: false, reason: 'already_recruited' };

  await db.collection('users').updateOne(
    { userId },
    { $set: { inviterId: owner.userId, inviterName: owner.username } }
  );
  return { ok: true, owner };
}

async function creditUser(invitedUserId, inviterId, inviterName, inServer) {
  const users = db.collection('users');
  const doc = await users.findOne({ userId: invitedUserId });
  if (doc && doc.inviterId) {
    return { ok: false, reason: 'already_credited', inviterId: doc.inviterId };
  }

  if (!doc) {
    const newDoc = {
      userId: invitedUserId,
      username: null,
      referralCode: generateCode(),
      inviterId,
      inviterName,
      robloxUsername: null,
      verified: false,
      inServer,
      joinCount: 1,
      lastJoinedAt: new Date(),
      createdAt: new Date(),
    };
    try {
      await users.insertOne(newDoc);
    } catch (e) {
      if (e.code === 11000) {
        const existing = await users.findOne({ userId: invitedUserId });
        if (existing && existing.inviterId) {
          return { ok: false, reason: 'already_credited', inviterId: existing.inviterId };
        }
        newDoc.referralCode = await assignCode(invitedUserId);
        await users.updateOne(
          { userId: invitedUserId },
          { $set: { inviterId, inviterName, inServer, username: newDoc.username, referralCode: newDoc.referralCode } }
        );
      } else {
        throw e;
      }
    }
    return { ok: true };
  }

  await users.updateOne({ userId: invitedUserId }, { $set: { inviterId, inviterName, inServer } });
  return { ok: true };
}

async function markVerified(userId, robloxUsername) {
  return db.collection('users').updateOne({ userId }, { $set: { verified: true, robloxUsername, verifiedAt: new Date() } });
}

async function markLeft(userId) {
  return db.collection('users').updateOne({ userId }, { $set: { inServer: false } });
}

async function getLeaderboard(limit) {
  return db.collection('users').aggregate([
    { $match: { inviterId: { $ne: null }, inServer: true } },
    {
      $group: {
        _id: '$inviterId',
        total: { $sum: 1 },
        verified: { $sum: { $cond: [{ $eq: ['$verified', true] }, 1, 0] } },
      },
    },
    { $sort: { total: -1 } },
    { $limit: limit },
  ]).toArray();
}

async function recruitStats(inviterId) {
  const cur = db.collection('users').find({ inviterId, inServer: true });
  const all = await cur.toArray();
  return {
    total: all.length,
    verified: all.filter((u) => u.verified).length,
    users: all,
  };
}

async function createReferLink(ownerId, code) {
  return db.collection('referlinks').insertOne({ ownerId, code, used: false, usedBy: null, createdAt: new Date() });
}

async function findReferLink(code) {
  return db.collection('referlinks').findOne({ code });
}

async function markReferLinkUsed(code, usedBy) {
  return db.collection('referlinks').updateOne({ code }, { $set: { used: true, usedBy } });
}

async function getReferLinksByOwner(ownerId) {
  return db.collection('referlinks').find({ ownerId }).toArray();
}

async function deleteReferLinksByOwner(ownerId) {
  return db.collection('referlinks').deleteMany({ ownerId });
}

let externalDb = null;

async function getExternalDb() {
  if (externalDb) return externalDb;
  const extClient = new MongoClient(process.env.SERVERCHECK_MONGODB_URI);
  try {
    await extClient.connect();
  } catch (err) {
    if (String(err.message).includes('querySrv')) {
      await extClient.close().catch(() => {});
      dns.setServers(['8.8.8.8', '1.1.1.1']);
      const retry = new MongoClient(process.env.SERVERCHECK_MONGODB_URI);
      await retry.connect();
      externalDb = retry.db(process.env.SERVERCHECK_MONGODB_DB || 'test');
    } else {
      throw err;
    }
  }
  if (!externalDb) externalDb = extClient.db(process.env.SERVERCHECK_MONGODB_DB || 'test');
  return externalDb;
}

async function lookupServerRecord(userId, guildId) {
  const db = await getExternalDb();
  const col = db.collection('memberdatas');
  const doc = await col.findOne({ userId, guildId });
  return doc;
}

module.exports = {
  connect,
  getDb,
  ensureUser,
  getUser,
  assignCode,
  applyReferralCode,
  creditUser,
  markVerified,
  markLeft,
  getLeaderboard,
  recruitStats,
  createReferLink,
  findReferLink,
  markReferLinkUsed,
  getReferLinksByOwner,
  deleteReferLinksByOwner,
  lookupServerRecord,
};
