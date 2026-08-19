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
  await db.collection('refcodes').createIndex({ code: 1 }, { unique: true });
  await db.collection('refcodes').createIndex({ ownerId: 1 });
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

async function generateRefCodes(userId, amount) {
  const codes = db.collection('refcodes');
  const generated = [];
  for (let i = 0; i < amount; i++) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = generateCode();
      try {
        await codes.insertOne({ code, ownerId: userId, used: false, usedBy: null, createdAt: new Date() });
        generated.push(code);
        break;
      } catch (e) {
        if (e.code !== 11000) throw e;
      }
    }
  }
  return generated;
}

async function getActiveRefCodes(userId) {
  return db.collection('refcodes').find({ ownerId: userId, used: false }).toArray();
}

async function useRefCode(code, usedBy) {
  const normalized = code.toUpperCase().replace(/\s+/g, '');
  const candidates = [normalized];
  if (normalized.startsWith('VMS-')) candidates.push(normalized.slice(4));
  else candidates.push(`VMS-${normalized}`);

  const codes = db.collection('refcodes');
  let doc = null;
  for (const c of candidates) {
    doc = await codes.findOne({ code: c, used: false });
    if (doc) break;
  }
  if (!doc) return { ok: false, reason: 'not_found' };
  if (doc.ownerId === usedBy) return { ok: false, reason: 'self' };

  const alreadyUsed = await db.collection('users').findOne({ userId: usedBy, inviterId: { $ne: null } });
  if (alreadyUsed) return { ok: false, reason: 'already_recruited' };

  await codes.updateOne({ _id: doc._id }, { $set: { used: true, usedBy } });
  await db.collection('users').updateOne(
    { userId: usedBy },
    { $set: { inviterId: doc.ownerId, inviterName: (await db.collection('users').findOne({ userId: doc.ownerId }))?.username || null } }
  );

  const remaining = await codes.countDocuments({ ownerId: doc.ownerId, used: false });
  if (remaining === 0) {
    await generateRefCodes(doc.ownerId, 1);
  }

  const owner = await db.collection('users').findOne({ userId: doc.ownerId });
  return { ok: true, owner };
}

async function refillRefCodes(userId) {
  const active = await getActiveRefCodes(userId);
  if (active.length === 0) {
    return generateRefCodes(userId, 3);
  }
  return active.map(c => c.code);
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
  return useRefCode(rawCode, userId);
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

const crypto = require('node:crypto');

async function createVerifyToken(userId) {
  const tokens = db.collection('verify_tokens');
  const token = crypto.randomBytes(32).toString('hex');
  await tokens.insertOne({
    token,
    userId,
    createdAt: new Date(),
    completed: false,
  });
  return token;
}

async function getVerifyToken(token) {
  return db.collection('verify_tokens').findOne({ token });
}

async function markVerifyTokenUsed(token) {
  return db.collection('verify_tokens').updateOne({ token }, { $set: { completed: true } });
}

async function saveApplication(userId, data) {
  const users = db.collection('users');
  const $set = {
    status: 'pending',
    robloxUsername: data.robloxUsername || null,
    noRoblox: data.noRoblox || false,
    age: data.age || null,
    referralCodeUsed: data.referralCodeUsed || null,
    referralOwnerId: data.referralOwnerId || null,
    referralOwnerName: data.referralOwnerName || null,
    whyJoin: data.whyJoin || null,
    howFound: data.howFound || null,
    discordCreatedAt: data.discordCreatedAt || null,
    hasAvatar: data.hasAvatar || false,
    serverChecks: data.serverChecks || { ThirdLeg: false, Bnf: false, Hermosa: false },
  };
  await users.updateOne({ userId }, { $set });
}

async function getApplication(userId) {
  return db.collection('users').findOne({ userId });
}

async function getAllApplications() {
  return db.collection('users').find({}).sort({ createdAt: -1 }).toArray();
}

async function approveApplication(userId, adminId) {
  return db.collection('users').updateOne(
    { userId },
    { $set: { status: 'approved', verifiedBy: `admin:${adminId}`, verifiedAt: new Date(), verified: true } }
  );
}

async function rejectApplication(userId, adminId) {
  return db.collection('users').updateOne(
    { userId },
    { $set: { status: 'rejected', flagged: true, verifiedBy: `rejected:${adminId}` } }
  );
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
  createVerifyToken,
  getVerifyToken,
  markVerifyTokenUsed,
  saveApplication,
  getApplication,
  getAllApplications,
  approveApplication,
  rejectApplication,
  generateRefCodes,
  getActiveRefCodes,
  useRefCode,
  refillRefCodes,
};
