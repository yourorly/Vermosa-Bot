require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');
const crypto = require('node:crypto');

const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
} = require('discord.js');

const {
  connect,
  ensureUser,
  getUser,
  assignCode,
  applyReferralCode,
  creditUser,
  markVerified,
  markLeft,
  lookupServerRecord,
  getLeaderboard,
  recruitStats,
  createReferLink,
  findReferLink,
  markReferLinkUsed,
  getReferLinksByOwner,
  deleteReferLinksByOwner,
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
} = require('./mongo');

const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const VERIFIED_ROLE_IDS = (process.env.VERIFIED_ROLE_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const UNVERIFIED_ROLE_ID = process.env.UNVERIFIED_ROLE_ID || null;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID || null;
const REFER_CHANNEL_ID = process.env.REFER_CHANNEL_ID || null;
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const WEBSITE_URL = process.env.WEBSITE_URL || 'http://localhost:3000';

const THIRD_LEG_ID = '1529774509555453962';
const BNF_ID = '1457082648349507759';
const HERMOSA_ID = '1411416629379600587';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
  ],
});

const inviteCache = new Map();

async function refreshInvites(guild) {
  let invites;
  try {
    invites = await guild.invites.fetch();
  } catch {
    inviteCache.set(guild.id, new Map());
    return;
  }
  const map = new Map();
  for (const invite of invites.values()) {
    map.set(invite.code, { inviterId: invite.inviterId, uses: invite.uses });
  }
  inviteCache.set(guild.id, map);
}

async function getLogChannel(guild) {
  if (!LOG_CHANNEL_ID) return null;
  return guild.channels.cache.get(LOG_CHANNEL_ID) ||
    (await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null));
}

async function findUsedInvite(guild, oldCache) {
  let invites;
  try {
    invites = await guild.invites.fetch();
  } catch {
    return null;
  }

  for (const invite of invites.values()) {
    const old = oldCache.get(invite.code);
    if (!old && invite.uses > 0) return invite;
    if (old && invite.uses > old.uses) return invite;
  }

  try {
    await guild.fetchVanityData();
  } catch {}

  return null;
}

async function handleMemberJoin(member) {
  const guild = member.guild;
  const oldCache = inviteCache.get(guild.id) || new Map();

  const used = await findUsedInvite(guild, oldCache);
  let inviterId = used ? used.inviterId : null;

  let viaReferLink = null;

  if (inviterId) {
    const inviterUser = await client.users.fetch(inviterId).catch(() => null);
    if (inviterUser && inviterUser.bot) {
      inviterId = null;
    }
  }
  if (used) {
    viaReferLink = await findReferLink(used.code);
    if (viaReferLink) {
      if (!viaReferLink.used) {
        await markReferLinkUsed(used.code, member.id);
      }
    }
  }

  await ensureUser({
    userId: member.id,
    username: member.user.username,
  });

  await refreshInvites(guild);

  const logChannel = await getLogChannel(guild);
  if (logChannel && logChannel.isSendable()) {
    const desc = [
      `**${member.user.tag}** (<@${member.id}>) joined the server.`,
      viaReferLink ? `Joined via referral link: **${viaReferLink.code}**` : null,
      `No credit given — must be approved in dashboard.`,
    ].filter(Boolean).join('\n');
    logChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Member Joined')
          .setColor(0x2ecc71)
          .setDescription(desc)
          .setTimestamp(),
      ],
    }).catch(() => {});
  }
}

async function handleMemberRemove(member) {
  await markLeft(member.id);

  const guild = member.guild;
  const logChannel = await getLogChannel(guild);
  if (logChannel && logChannel.isSendable()) {
    logChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Member Left')
          .setColor(0xe74c3c)
          .setDescription(`**${member.user.tag}** (<@${member.id}>) left the server.`)
          .setTimestamp(),
      ],
    }).catch(() => {});
  }
}

function buildVerifyEmbed() {
  return new EmbedBuilder()
    .setTitle('Server Verification')
    .setColor(0x5865f2)
    .setDescription(
      'Welcome to the server!\n\n' +
      'Click the **Verify** button below to start the verification process.\n' +
      'You will be redirected to a website to complete your application.'
    );
}

function verifyRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('verify_open')
      .setLabel('Verify')
      .setStyle(ButtonStyle.Primary)
  );
}

async function handleVerifyButton(interaction) {
  const token = await createVerifyToken(interaction.user.id);
  const url = `${WEBSITE_URL}/verify/${token}`;

  await interaction.reply({
    content: `Click the link below to start verification:\n${url}\n\nThis link expires in **15 minutes**.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleLeaderboard(interaction) {
  const limit = Math.min(Math.max(interaction.options.getInteger('limit') ?? 10, 1), 25);

  const rows = await getLeaderboard(limit);
  if (!rows.length) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Recruiter Leaderboard')
          .setColor(0x5865f2)
          .setDescription('No recruits tracked yet. Once members join via invites they will appear here.'),
      ],
    });
    return;
  }

  const medal = ['🥇', '🥈', '🥉'];
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const user = await client.users.fetch(row._id).catch(() => null);
    const name = user ? user.username : `Unknown (${row._id})`;
    lines.push(
      `${medal[i] || `${i + 1}.`} **${name}** — ${row.total} recruit(s)` +
      ` (${row.verified ?? 0} verified)`
    );
  }

  const embed = new EmbedBuilder()
    .setTitle('Recruiter Leaderboard')
    .setDescription(lines.join('\n'))
    .setColor(0x5865f2)
    .setFooter({ text: `Top ${rows.length} recruiters in ${interaction.guild.name}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleInvites(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;

  const stats = await recruitStats(target.id);
  const members = await interaction.guild.members.fetch().catch(() => null);

  const names = await Promise.all(
    stats.users.slice(0, 15).map(async (r) => {
      const m = members ? members.get(r.userId) : null;
      if (m) return m.user.username;
      const u = await client.users.fetch(r.userId).catch(() => null);
      return u ? u.username : `Unknown (${r.userId})`;
    })
  );

  const embed = new EmbedBuilder()
    .setTitle(`Recruitment Stats — ${target.username}`)
    .setColor(0x5865f2)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'Total recruited', value: String(stats.total), inline: true },
      { name: 'Verified', value: String(stats.verified), inline: true }
    );

  embed.addFields(
    names.length
      ? { name: 'Their recruits', value: names.map((n, i) => `${i + 1}. ${n}`).join('\n') }
      : { name: 'Their recruits', value: 'None yet.' }
  );

  await interaction.reply({ embeds: [embed] });
}

async function handleSetup(interaction) {
  const targetChannel = VERIFY_CHANNEL_ID
    ? interaction.guild.channels.cache.get(VERIFY_CHANNEL_ID) ||
      (await interaction.guild.channels.fetch(VERIFY_CHANNEL_ID).catch(() => null))
    : interaction.channel;

  if (!targetChannel || !targetChannel.isSendable()) {
    await interaction.reply({ content: 'Verification channel is invalid.', flags: MessageFlags.Ephemeral });
    return;
  }

  await targetChannel.send({ embeds: [buildVerifyEmbed()], components: [verifyRow()] });
  await interaction.reply({
    content: `Verification popup posted in <#${targetChannel.id}>.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleReferral(interaction) {
  await ensureUser({
    userId: interaction.user.id,
    username: interaction.user.username,
  });

  let active = await getActiveRefCodes(interaction.user.id);
  if (active.length === 0) {
    const generated = await generateRefCodes(interaction.user.id, 3);
    active = generated.map(c => ({ code: c }));
  }

  const codeList = active.map(c => `\`${c.code}\``).join('\n');
  const inviterDoc = await getUser(interaction.user.id);
  const inviterRef = inviterDoc?.inviterId ? `Referred by: <@${inviterDoc.inviterId}>` : 'Referred by: no one yet';

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Your Referral Codes')
        .setColor(0x9b59b6)
        .setDescription(
          `Your active referral codes:\n\n${codeList}\n\n` +
          `These codes are **single-use**. When someone uses one, a new code is automatically generated for you.\n` +
          `Share them so new members can enter one during verification.\n\n${inviterRef}`
        )
        .setFooter({ text: `${active.length} active code(s)` })
        .setTimestamp(),
    ],
  });
}

async function handleRefer(interaction) {
  const guild = interaction.guild;

  const channel = REFER_CHANNEL_ID
    ? guild.channels.cache.get(REFER_CHANNEL_ID) ||
      (await guild.channels.fetch(REFER_CHANNEL_ID).catch(() => null))
    : guild.systemChannel ||
      guild.channels.cache.find((c) =>
        (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
        c.permissionsFor(guild.members.me).has('CreateInstantInvite')
      );

  if (!channel || !channel.isSendable()) {
    await interaction.reply({ content: 'Could not find a channel to create the invite in. Check REFER_CHANNEL_ID.', flags: MessageFlags.Ephemeral });
    return;
  }

  const prevLinks = await getReferLinksByOwner(interaction.user.id);
  let invite = null;
  for (const link of prevLinks) {
    invite = await guild.invites.fetch(link.code).catch(() => null);
    if (invite) break;
  }

  if (!invite) {
    invite = await channel.createInvite({
      maxUses: 0,
      maxAge: 0,
      reason: `Static referral invite for ${interaction.user.tag}`,
    });
    await deleteReferLinksByOwner(interaction.user.id);
    await createReferLink(interaction.user.id, invite.code);
  }

  await ensureUser({
    userId: interaction.user.id,
    username: interaction.user.username,
  });

  let active = await getActiveRefCodes(interaction.user.id);
  if (active.length === 0) {
    const generated = await generateRefCodes(interaction.user.id, 3);
    active = generated.map(c => ({ code: c }));
  }

  const codeList = active.map(c => `\`${c.code}\``).join('\n');

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Your Referral Invite')
        .setColor(0x2ecc71)
        .setDescription(
          `Your server invite link:\n\n${invite.url}\n\n` +
          `This link is **permanent**, has **unlimited uses**, and **never changes**. ` +
          `Share it to recruit members.\n\n` +
          `**Your active referral codes:**\n${codeList}\n\n` +
          `These codes are **single-use**. When someone uses one, a new code is auto-generated.`
        )
        .setFooter({ text: `${active.length} active code(s)` })
        .setTimestamp(),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCreditUser(interaction) {
  if (!ADMIN_USER_IDS.length || !ADMIN_USER_IDS.includes(interaction.user.id)) {
    await interaction.reply({
      content: 'You do not have permission to use this command.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const referer = interaction.options.getUser('referer');
  const invited = interaction.options.getUser('user');

  if (referer.id === invited.id) {
    await interaction.reply({
      content: 'A user cannot be credited to themselves.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const inviterName = (await client.users.fetch(referer.id).catch(() => null))?.username ?? referer.username;
  const member = await interaction.guild.members.fetch(invited.id).catch(() => null);
  const inServer = Boolean(member);

  const result = await creditUser(invited.id, referer.id, inviterName, inServer);

  if (!result.ok) {
    await interaction.reply({
      content: `**${invited.username}** is already credited to <@${result.inviterId}>. Credit is only given once per user.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const logChannel = await getLogChannel(interaction.guild);
  if (logChannel && logChannel.isSendable()) {
    logChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Manual Credit')
          .setColor(0xf1c40f)
          .setDescription(
            `<@${referer.id}> (${inviterName}) credited for **${invited.username}** (<@${invited.id}>) ` +
            `by <@${interaction.user.id}>.`
          )
          .setTimestamp(),
      ],
    }).catch(() => {});
  }

  await interaction.reply({
    content: `Credited **${referer.username}** for **${invited.username}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleReferCode(interaction) {
  const amount = interaction.options.getInteger('amount') || 3;

  await ensureUser({
    userId: interaction.user.id,
    username: interaction.user.username,
  });

  const generated = await generateRefCodes(interaction.user.id, amount);

  const codeList = generated.map(c => `\`${c}\``).join('\n');

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Referral Codes Generated')
        .setColor(0x2ecc71)
        .setDescription(
          `Generated **${amount}** referral code(s):\n\n${codeList}\n\n` +
          `These codes are **single-use**. When someone uses one during verification, ` +
          `a new code is automatically generated for you.\n` +
          `Share them with people you want to invite!`
        )
        .setFooter({ text: interaction.user.username })
        .setTimestamp(),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleReport(interaction) {
  const REPORT_CHANNEL_ID = '1537907968140382350';
  const ADMIN_ID = '1394914695600934932';

  const reported = interaction.options.getUser('user');
  const category = interaction.options.getString('category');
  const description = interaction.options.getString('description');
  const image = interaction.options.getAttachment('image');

  if (reported.id === interaction.user.id) {
    await interaction.reply({ content: 'You cannot report yourself.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (reported.bot) {
    await interaction.reply({ content: 'You cannot report a bot.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = interaction.guild.channels.cache.get(REPORT_CHANNEL_ID) ||
    (await interaction.guild.channels.fetch(REPORT_CHANNEL_ID).catch(() => null));

  if (!channel) {
    await interaction.editReply({ content: 'Report channel not found. Contact an admin.' });
    return;
  }

  let thread;
  try {
    thread = await channel.threads.create({
      name: `report-${reported.username}`,
      type: ChannelType.PrivateThread,
      reason: `Report by ${interaction.user.tag} against ${reported.tag}`,
    });
  } catch (err) {
    console.error('Failed to create report thread:', err);
    await interaction.editReply({ content: 'Failed to create report thread. Make sure I have Manage Threads permission.' });
    return;
  }

  await thread.members.add(interaction.user.id).catch(() => {});
  await thread.members.add(ADMIN_ID).catch(() => {});

  const embed = new EmbedBuilder()
    .setTitle('User Report')
    .setColor(0xe74c3c)
    .addFields(
      { name: 'Reported By', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: true },
      { name: 'Reported User', value: `${reported.tag} (<@${reported.id}>)`, inline: true },
      { name: 'Category', value: category, inline: true },
      { name: 'Description', value: description },
    )
    .setTimestamp()
    .setFooter({ text: `Report from ${interaction.guild.name}` });

  if (image) {
    embed.setImage(image.url);
  }

  await thread.send({ embeds: [embed] });

  await interaction.editReply({
    content: `✅ Report submitted. A staff member will review it in <#${thread.id}>.`,
  });
}

const SERVERCHECK_GUILD_ID = '1529774509555453962';

async function handleServerCheck(interaction) {
  const target = interaction.options.getUser('user') || interaction.user;
  await interaction.deferReply();

  try {
    const doc = await lookupServerRecord(target.id, SERVERCHECK_GUILD_ID);
    if (!doc) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Server Check')
            .setColor(0xe74c3c)
            .setDescription(`<@${target.id}> has **no record** in the target server.`)
            .setTimestamp(),
        ],
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Server Check')
      .setColor(0x2ecc71)
      .setDescription(`<@${target.id}> **has a record** in the target server.`)
      .addFields(
        { name: 'Level', value: String(doc.level ?? 0), inline: true },
        { name: 'Total XP', value: String(doc.totalXp ?? 0), inline: true },
        { name: 'Voice XP', value: String(doc.voiceXp ?? 0), inline: true },
        { name: 'Voice Time', value: formatDuration(doc.voiceSeconds ?? 0), inline: true },
        { name: 'Messages', value: String(doc.messageCount ?? 0), inline: true },
      )
      .setTimestamp();

    if (doc.aboutMe) embed.addFields({ name: 'About Me', value: doc.aboutMe });
    if (doc.achievements?.length) {
      embed.addFields({
        name: 'Achievements',
        value: doc.achievements.map((a) => a.title).join(', '),
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('ServerCheck error:', err);
    await interaction.editReply({ content: 'Failed to look up server record.' });
  }
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function sendApprovalDM(userId, robloxUsername) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return false;
  try {
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Application Accepted')
          .setColor(0x2ecc71)
          .setDescription(
            `Welcome to the server${robloxUsername ? `, **${robloxUsername}**` : ''}!\n\n` +
            'Your application has been reviewed and **approved**.\n' +
            'You now have full access to the server.\n' +
            'If you have any questions, contact a staff member.'
          )
          .setTimestamp(),
      ],
    });
    return true;
  } catch {
    return false;
  }
}

async function sendRejectionDM(userId) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return false;
  try {
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Application Rejected')
          .setColor(0xe74c3c)
          .setDescription(
            'Your verification application was **not approved**.\n\n' +
            'If you believe this is an error, please contact a staff member.'
          )
          .setTimestamp(),
      ],
    });
    return true;
  } catch {
    return false;
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Post the verification button + popup message')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Show the top recruiters leaderboard')
      .addIntegerOption((o) =>
        o.setName('limit').setDescription('How many to show (default 10)').setMinValue(1).setMaxValue(25)
      ),
    new SlashCommandBuilder()
      .setName('invites')
      .setDescription('Show recruitment stats for you or another user')
      .addUserOption((o) => o.setName('user').setDescription('User to check (default: you)')),
    new SlashCommandBuilder()
      .setName('referral')
      .setDescription('Get your personal referral ID/code'),
    new SlashCommandBuilder()
      .setName('refer')
      .setDescription('Generate a one-time server invite link for referrals'),
    new SlashCommandBuilder()
      .setName('refercode')
      .setDescription('Generate referral codes to share')
      .addIntegerOption((o) => o.setName('amount').setDescription('Number of codes to generate (1-10)').setMinValue(1).setMaxValue(10)),
    new SlashCommandBuilder()
      .setName('credituser')
      .setDescription('Manually credit a referrer for an invited user (admin only)')
      .addUserOption((o) => o.setName('referer').setDescription('The referrer').setRequired(true))
      .addUserOption((o) => o.setName('user').setDescription('The invited user').setRequired(true)),
    new SlashCommandBuilder()
      .setName('servercheck')
      .setDescription('Check if a user has a record in the target server')
      .addUserOption((o) => o.setName('user').setDescription('User to check (default: you)')),
    new SlashCommandBuilder()
      .setName('report')
      .setDescription('Report a user to staff')
      .addUserOption((o) => o.setName('user').setDescription('The user to report').setRequired(true))
      .addStringOption((o) =>
        o.setName('category')
          .setDescription('Report reason')
          .setRequired(true)
          .addChoices(
            { name: 'Breaking the rules', value: 'Breaking the rules' },
            { name: 'Advertising', value: 'Advertising' },
            { name: 'Spamming', value: 'Spamming' },
            { name: 'Spy', value: 'Spy' },
            { name: 'Malicious Mischief', value: 'Malicious Mischief' },
            { name: 'Hacking/Doxing', value: 'Hacking/Doxing' },
          ))
      .addStringOption((o) => o.setName('description').setDescription('Describe the issue').setRequired(true))
      .addAttachmentOption((o) => o.setName('image').setDescription('Optional screenshot or evidence')),
  ];

  if (GUILD_ID) {
    await client.application.commands.set([]);
    const guild = client.guilds.cache.get(GUILD_ID) || (await client.guilds.fetch(GUILD_ID));
    await guild.commands.set(commands);
    console.log(`Registered ${commands.length} commands in guild ${guild.name}`);
    for (const g of client.guilds.cache.values()) {
      await refreshInvites(g).catch(() => {});
    }
  } else {
    await client.application.commands.set(commands);
    console.log('Registered commands globally');
  }
});

client.on(Events.GuildInviteCreate, async (invite) => {
  if (invite.guild) await refreshInvites(invite.guild).catch(() => {});
});

client.on(Events.GuildInviteDelete, async (invite) => {
  if (!invite.guild) return;
  inviteCache.delete(invite.guild.id);
  await refreshInvites(invite.guild).catch(() => {});
});

client.on(Events.GuildMemberAdd, handleMemberJoin);
client.on(Events.GuildMemberRemove, handleMemberRemove);

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup') return handleSetup(interaction);
      if (interaction.commandName === 'leaderboard') return handleLeaderboard(interaction);
      if (interaction.commandName === 'invites') return handleInvites(interaction);
      if (interaction.commandName === 'referral') return handleReferral(interaction);
      if (interaction.commandName === 'refer') return handleRefer(interaction);
      if (interaction.commandName === 'refercode') return handleReferCode(interaction);
      if (interaction.commandName === 'credituser') return handleCreditUser(interaction);
      if (interaction.commandName === 'servercheck') return handleServerCheck(interaction);
      if (interaction.commandName === 'report') return handleReport(interaction);
    }

    if (interaction.isButton() && interaction.customId === 'verify_open') {
      return handleVerifyButton(interaction);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Something went wrong. Please try again.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    } else {
      await interaction.followUp({
        content: 'Something went wrong. Please try again.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function generatePage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#1a1a2e;color:#e0e0e0;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}
.container{background:#16213e;border-radius:16px;padding:40px;max-width:600px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.3)}
h1{color:#5865f2;margin-bottom:8px;font-size:1.8em}
h2{color:#5865f2;margin-bottom:16px;font-size:1.4em}
p{color:#b0b0b0;margin-bottom:16px;line-height:1.6}
.btn{display:inline-block;padding:12px 24px;border-radius:8px;border:none;font-size:16px;font-weight:600;cursor:pointer;text-decoration:none;transition:all .2s}
.btn-discord{background:#5865f2;color:#fff}.btn-discord:hover{background:#4752c4}
.btn-primary{background:#5865f2;color:#fff}.btn-primary:hover{background:#4752c4}
.btn-success{background:#2ecc71;color:#fff}.btn-success:hover{background:#27ae60}
.btn-danger{background:#e74c3c;color:#fff}.btn-danger:hover{background:#c0392b}
.btn-no{background:#95a5a6;color:#fff}.btn-no:hover{background:#7f8c8d}
.btn-sm{padding:8px 16px;font-size:13px}
input[type=text],textarea{width:100%;padding:12px;border-radius:8px;border:1px solid #2a2a4a;background:#0f3460;color:#e0e0e0;font-size:14px;margin-bottom:12px;font-family:inherit}
input[type=text]:focus,textarea:focus{outline:none;border-color:#5865f2}
textarea{min-height:80px;resize:vertical}
label{display:block;color:#b0b0b0;margin-bottom:6px;font-size:14px}
.info-card{background:#0f3460;border-radius:12px;padding:16px;margin-bottom:16px}
.info-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #1a1a3e}
.info-row:last-child{border-bottom:none}
.check{color:#2ecc71;font-weight:bold}.cross{color:#e74c3c;font-weight:bold}
.warning{color:#f39c12}
.avatar{width:64px;height:64px;border-radius:50%;margin-bottom:12px}
.pending-box{text-align:center;padding:40px}
.pending-box h1{font-size:2em;margin-bottom:12px}
.status-badge{display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600}
.badge-pending{background:#f39c12;color:#000}
.badge-approved{background:#2ecc71;color:#fff}
.badge-rejected{background:#e74c3c;color:#fff}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 8px;color:#5865f2;border-bottom:2px solid #2a2a4a}
td{padding:8px;border-bottom:1px solid #1a1a3e;vertical-align:top}
tr:hover{background:#1a1a3e}
.search{margin-bottom:16px}
.stats-bar{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.stat-card{background:#0f3460;border-radius:8px;padding:12px 16px;text-align:center;flex:1;min-width:100px}
.stat-num{font-size:1.5em;font-weight:bold;color:#5865f2}
.stat-label{font-size:11px;color:#888;margin-top:4px}
.app-row{cursor:pointer}
.app-row:hover{background:#1a1a3e}
.detail-panel{background:#0f3460;border-radius:12px;padding:20px;margin-top:16px}
</style>
</head>
<body>${body}</body>
</html>`;
}

app.get('/', (req, res) => {
  res.send('OK');
});

app.get('/verify/:token', async (req, res) => {
  const { token } = req.params;
  const doc = await getVerifyToken(token);

  if (!doc || doc.completed) {
    res.status(400).send(generatePage('Invalid Link', `
      <div class="container" style="text-align:center">
        <h1>Link Invalid or Expired</h1>
        <p>This verification link is no longer valid. Please go back to Discord and click the Verify button again to get a new link.</p>
      </div>
    `));
    return;
  }

  const created = new Date(doc.createdAt).getTime();
  if (Date.now() - created > 15 * 60 * 1000) {
    res.status(400).send(generatePage('Link Expired', `
      <div class="container" style="text-align:center">
        <h1>Link Expired</h1>
        <p>This verification link has expired (15 minute limit). Please go back to Discord and click the Verify button again.</p>
      </div>
    `));
    return;
  }

  const user = await client.users.fetch(doc.userId).catch(() => null);
  if (!user) {
    res.status(400).send(generatePage('Error', `
      <div class="container" style="text-align:center">
        <h1>User Not Found</h1>
        <p>Could not find your Discord account. Please try again.</p>
      </div>
    `));
    return;
  }

  let inMainServer = false;
  try {
    const memberCheck = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${doc.userId}`, {
      headers: { Authorization: `Bot ${TOKEN}` },
    });
    inMainServer = memberCheck.ok;
  } catch {}

  if (!inMainServer) {
    res.status(403).send(generatePage('Error 67', `
      <div class="container" style="text-align:center">
        <div style="font-size:48px;margin-bottom:16px">🚫</div>
        <h1>Error 67</h1>
        <p>You are not in the server.</p>
        <p style="color:#888;margin-top:24px;font-size:13px">Join the server first, then try again.</p>
      </div>
    `));
    return;
  }

  let inThirdLeg = false;
  let inBnf = false;
  let inHermosa = false;

  if (req.query.checked === 'true') {
    inThirdLeg = req.query.thirdLeg === 'true';
    inBnf = req.query.bnf === 'true';
    inHermosa = req.query.hermosa === 'true';
  }

  const avatarUrl = user.displayAvatarURL({ size: 128 });
  const accountAge = Math.floor((Date.now() - user.createdTimestamp) / (1000 * 60 * 60 * 24));
  const hasAvatar = user.avatar !== null;
  const ageWarning = accountAge < 7;

  if (req.query.checked !== 'true') {
    const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(WEBSITE_URL + '/verify/servercheck/callback')}&response_type=code&scope=identify+guilds&state=${token}`;
    res.send(generatePage('Server Verification', `
      <div class="container" style="text-align:center;max-width:450px">
        <div style="font-size:48px;margin-bottom:16px">🔐</div>
        <h1>Verify</h1>
        <p>Click the button below to authorize with Discord so we can verify you in the server</p>
        <a href="${authUrl}" class="btn btn-discord" style="display:inline-block;margin-top:16px;text-decoration:none">
          <svg style="width:20px;height:20px;vertical-align:middle;margin-right:8px" viewBox="0 0 24 24" fill="white"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
          Verify
        </a>
        <p style="color:#888;margin-top:24px;font-size:12px">For Server Security Purposes</p>
      </div>
    `));
    return;
  }

  if (ageWarning || !hasAvatar) {
    res.status(403).send(generatePage('Error 69', `
      <div class="container" style="text-align:center">
        <div style="font-size:48px;margin-bottom:16px">⚠️</div>
        <h1>Error 69</h1>
        <p>Alt Detected.</p>
        <p style="color:#888;margin-top:24px;font-size:13px">Your account appears to be too new or incomplete.</p>
      </div>
      <script>
        try {
          var ctx = new (window.AudioContext || window.webkitAudioContext)();
          function playAlarm(freq, startTime, dur) {
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.type = 'square';
            osc.frequency.value = freq;
            gain.gain.value = 0.5;
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(startTime);
            osc.stop(startTime + dur);
          }
          for (var i = 0; i < 5; i++) {
            playAlarm(880, i * 0.2, 0.1);
            playAlarm(660, i * 0.2 + 0.1, 0.1);
          }
          setTimeout(function() { ctx.close(); }, 2000);
        } catch(e) {}
      </script>
    `));
    return;
  }

  res.send(generatePage('Server Verification', `
    <div class="container" style="max-width:500px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:32px;margin-bottom:8px">📋</div>
        <h1 style="font-size:1.5em">Application</h1>
        <div style="margin-top:12px;display:flex;gap:6px;justify-content:center" id="progress">
          <div class="prog-dot active" id="dot0"></div>
          <div class="prog-dot" id="dot1"></div>
          <div class="prog-dot" id="dot2"></div>
          <div class="prog-dot" id="dot3"></div>
        </div>
      </div>

      <form method="POST" action="/verify/submit" id="appForm">
        <input type="hidden" name="token" value="${token}">
        <input type="hidden" name="noRoblox" id="noRobloxField" value="false">
        <input type="hidden" name="inThirdLeg" value="${inThirdLeg}">
        <input type="hidden" name="inBnf" value="${inBnf}">
        <input type="hidden" name="inHermosa" value="${inHermosa}">

        <div class="step active" id="step0">
          <div class="step-inner">
            <h2 style="text-align:center;margin-bottom:4px">Roblox Username</h2>
            <p style="text-align:center;margin-bottom:20px;font-size:13px">Enter your Roblox username below.</p>
            <input type="text" name="roblox" id="robloxInput" placeholder="Enter your Roblox username" maxlength="32" style="text-align:center;font-size:16px">
            <button type="button" class="btn btn-no" style="width:100%;margin-top:8px;font-size:13px" id="noRobloxBtn">I don't have a Roblox account</button>
            <div id="noRobloxMsg" style="display:none;text-align:center;margin-top:12px;padding:12px;background:#0f3460;border-radius:8px">
              <span style="color:#f39c12;font-weight:600">✓ No Roblox account</span>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:16px">
            <button type="button" class="btn btn-primary" style="flex:1" onclick="nextStep()">Next →</button>
          </div>
        </div>

        <div class="step" id="step1">
          <div class="step-inner">
            <h2 style="text-align:center;margin-bottom:4px">Referral Code</h2>
            <p style="text-align:center;margin-bottom:20px;font-size:13px">Enter the referral code from the person who invited you.</p>
            <input type="text" name="referral" id="referralInput" placeholder="e.g. VMS-XXXXXX" maxlength="16" required style="text-align:center;font-size:16px">
          </div>
          <div style="display:flex;gap:8px;margin-top:16px">
            <button type="button" class="btn btn-no" style="flex:0.4" onclick="prevStep()">← Back</button>
            <button type="button" class="btn btn-primary" style="flex:1" onclick="nextStep()">Next →</button>
          </div>
        </div>

        <div class="step" id="step2">
          <div class="step-inner">
            <h2 style="text-align:center;margin-bottom:4px">Why do you want to join?</h2>
            <p style="text-align:center;margin-bottom:20px;font-size:13px">Tell us why you'd like to be part of this community.</p>
            <textarea name="whyJoin" id="whyJoinInput" placeholder="Type your answer here..." required maxlength="500" style="min-height:120px;text-align:center"></textarea>
          </div>
          <div style="display:flex;gap:8px;margin-top:16px">
            <button type="button" class="btn btn-no" style="flex:0.4" onclick="prevStep()">← Back</button>
            <button type="button" class="btn btn-primary" style="flex:1" onclick="nextStep()">Next →</button>
          </div>
        </div>

        <div class="step" id="step3">
          <div class="step-inner">
            <h2 style="text-align:center;margin-bottom:4px">How did you find us?</h2>
            <p style="text-align:center;margin-bottom:20px;font-size:13px">How did you discover this server?</p>
            <textarea name="howFound" id="howFoundInput" placeholder="Type your answer here..." required maxlength="500" style="min-height:120px;text-align:center"></textarea>
          </div>
          <div style="display:flex;gap:8px;margin-top:16px">
            <button type="button" class="btn btn-no" style="flex:0.4" onclick="prevStep()">← Back</button>
            <button type="submit" class="btn btn-success" style="flex:1">Submit Application</button>
          </div>
        </div>
      </form>
    </div>

    <style>
      .prog-dot{width:40px;height:4px;border-radius:4px;background:#2a2a4a;transition:all .3s}
      .prog-dot.active{background:#5865f2}
      .prog-dot.done{background:#2ecc71}
      .step{display:none;animation:fadeSlide .4s ease}
      .step.active{display:block}
      .step-inner{min-height:180px}
      @keyframes fadeSlide{from{opacity:0;transform:translateX(30px)}to{opacity:1;transform:translateX(0)}}
    </style>

    <script>
      var current = 0;
      var total = 4;
      var noRoblox = false;

      document.getElementById('noRobloxBtn').addEventListener('click', function() {
        noRoblox = !noRoblox;
        var inp = document.getElementById('robloxInput');
        var msg = document.getElementById('noRobloxMsg');
        var field = document.getElementById('noRobloxField');
        if (noRoblox) {
          inp.value = '';
          inp.disabled = true;
          inp.style.opacity = '0.3';
          msg.style.display = 'block';
          field.value = 'true';
          this.textContent = 'Have a Roblox account';
          this.className = 'btn btn-primary';
        } else {
          inp.disabled = false;
          inp.style.opacity = '1';
          msg.style.display = 'none';
          field.value = 'false';
          this.textContent = "I don't have a Roblox account";
          this.className = 'btn btn-no';
        }
      });

      function updateDots() {
        for (var i = 0; i < total; i++) {
          var d = document.getElementById('dot' + i);
          d.className = 'prog-dot';
          if (i < current) d.className = 'prog-dot done';
          if (i === current) d.className = 'prog-dot active';
        }
      }

      function showStep(n) {
        for (var i = 0; i < total; i++) {
          document.getElementById('step' + i).className = 'step';
        }
        var el = document.getElementById('step' + n);
        el.className = 'step active';
        el.style.animation = 'none';
        el.offsetHeight;
        el.style.animation = '';
        updateDots();
      }

      function nextStep() {
        var curr = document.getElementById('step' + current);
        var required = curr.querySelector('[required]');
        if (required && !required.value.trim()) {
          required.style.borderColor = '#e74c3c';
          required.focus();
          setTimeout(function(){ required.style.borderColor = '#2a2a4a'; }, 1500);
          return;
        }
        if (current === 0 && !noRoblox) {
          var ri = document.getElementById('robloxInput');
          if (!ri.value.trim()) {
            ri.style.borderColor = '#e74c3c';
            ri.focus();
            setTimeout(function(){ ri.style.borderColor = '#2a2a4a'; }, 1500);
            return;
          }
        }
        if (current < total - 1) {
          current++;
          showStep(current);
        }
      }

      function prevStep() {
        if (current > 0) {
          current--;
          showStep(current);
        }
      }
    </script>
  `));
});

app.get('/verify/servercheck/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state) {
    res.status(400).send(generatePage('Error', '<div class="container"><h1>Missing Parameters</h1><p>Please try again from Discord.</p></div>'));
    return;
  }

  const tokenDoc = await getVerifyToken(state);
  if (!tokenDoc || tokenDoc.completed) {
    res.status(400).send(generatePage('Error', '<div class="container"><h1>Invalid Session</h1><p>Please go back to Discord and get a new link.</p></div>'));
    return;
  }

  try {
    const tokenResp = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${WEBSITE_URL}/verify/servercheck/callback`,
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
      }),
    });

    if (!tokenResp.ok) {
      res.status(400).send(generatePage('Error', '<div class="container"><h1>OAuth Failed</h1><p>Could not authenticate. Please try again.</p></div>'));
      return;
    }

    const tokenData = await tokenResp.json();

    const guildsResp = await fetch('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    let inThirdLeg = false;
    let inBnf = false;
    let inHermosa = false;

    if (guildsResp.ok) {
      const guilds = await guildsResp.json();
      inThirdLeg = guilds.some(g => g.id === THIRD_LEG_ID);
      inBnf = guilds.some(g => g.id === BNF_ID);
      inHermosa = guilds.some(g => g.id === HERMOSA_ID);
    }

    res.redirect(`/verify/${state}?checked=true&thirdLeg=${inThirdLeg}&bnf=${inBnf}&hermosa=${inHermosa}`);
  } catch (err) {
    console.error('Server check OAuth error:', err);
    res.status(500).send(generatePage('Error', '<div class="container"><h1>Server Error</h1><p>Something went wrong. Please try again.</p></div>'));
  }
});

app.post('/verify/submit', async (req, res) => {
  const { token, roblox, noRoblox, referral, whyJoin, howFound, inThirdLeg, inBnf, inHermosa } = req.body;

  const doc = await getVerifyToken(token);
  if (!doc || doc.completed) {
    res.status(400).send(generatePage('Error', '<div class="container"><h1>Invalid Request</h1><p>Please start over from Discord.</p></div>'));
    return;
  }

  const user = await client.users.fetch(doc.userId).catch(() => null);
  if (!user) {
    res.status(400).send(generatePage('Error', '<div class="container"><h1>User Not Found</h1><p>Please try again.</p></div>'));
    return;
  }

  if (!referral || !referral.trim()) {
    res.status(400).send(generatePage('Error', '<div class="container" style="text-align:center"><h1>Referral Code Required</h1><p>You must enter a referral code to continue. Go back and try again.</p></div>'));
    return;
  }

  let robloxValid = false;
  let robloxData = null;
  if (roblox && roblox.trim()) {
    try {
      const resp = await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: [roblox.trim()] }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.data && data.data.length > 0) {
          robloxValid = true;
          robloxData = data.data[0];
        }
      }
    } catch {}
  }

  let referralInfo = null;
  const referralResult = await applyReferralCode(doc.userId, referral.trim());
  if (!referralResult.ok) {
    let reason;
    if (referralResult.reason === 'not_found') {
      reason = `Referral code **${referral.trim().toUpperCase()}** is not valid.`;
    } else if (referralResult.reason === 'self') {
      reason = 'You cannot use your own referral code.';
    } else if (referralResult.reason === 'already_recruited') {
      reason = 'You have already been credited by another referrer.';
    } else {
      reason = 'Invalid referral code.';
    }
    res.status(400).send(generatePage('Invalid Referral', `
      <div class="container" style="text-align:center">
        <div style="font-size:48px;margin-bottom:16px">❌</div>
        <h1>Invalid Referral Code</h1>
        <p>${reason}</p>
        <p style="color:#888;margin-top:24px;font-size:13px">Go back to Discord and try again with a valid code.</p>
      </div>
    `));
    return;
  }
  referralInfo = referralResult.owner;

  const accountAge = Math.floor((Date.now() - user.createdTimestamp) / (1000 * 60 * 60 * 24));
  const hasAvatar = user.avatar !== null;

  await saveApplication(doc.userId, {
    robloxUsername: robloxValid ? robloxData.name : (noRoblox === 'true' ? null : (roblox ? roblox.trim() : null)),
    noRoblox: noRoblox === 'true',
    referralCodeUsed: referral && referral.trim() ? referral.trim().toUpperCase() : null,
    referralOwnerId: referralInfo ? referralInfo.userId : null,
    referralOwnerName: referralInfo ? referralInfo.username : null,
    whyJoin: whyJoin || null,
    howFound: howFound || null,
    discordCreatedAt: user.createdAt.toISOString(),
    hasAvatar,
    serverChecks: { ThirdLeg: inThirdLeg === 'true', Bnf: inBnf === 'true', Hermosa: inHermosa === 'true' },
  });

  await markVerifyTokenUsed(token);

  let robloxMsg = 'None';
  if (noRoblox === 'true') {
    robloxMsg = 'No Roblox account';
  } else if (robloxValid) {
    robloxMsg = robloxData.name;
  } else if (roblox) {
    robloxMsg = `${roblox.trim()} (not found)`;
  }

  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) {
    const logChannel = await getLogChannel(guild);
    if (logChannel && logChannel.isSendable()) {
      logChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('New Application Submitted')
            .setColor(0xf39c12)
            .setDescription([
              `**${user.tag}** (<@${user.id}>) submitted an application.`,
              `Roblox: **${robloxMsg}**`,
              `Account Age: **${accountAge} days** ${accountAge < 7 ? '⚠️' : ''}`,
              `Avatar: ${hasAvatar ? '✅' : '⚠️ None'}`,
              `Third Leg: ${inThirdLeg ? '✅' : '❌'}`,
              `Bnf: ${inBnf ? '✅' : '❌'}`,
              `Hermosa: ${inHermosa ? '✅' : '❌'}`,
              referralInfo ? `Referral Code: **${referral.trim().toUpperCase()}** from <@${referralInfo.userId}> (${referralInfo.username})` : null,
              `Why Join: ${whyJoin || '—'}`,
              `How Found: ${howFound || '—'}`,
            ].filter(Boolean).join('\n'))
            .setTimestamp(),
        ],
      }).catch(() => {});
    }
  }

  res.send(generatePage('Application Submitted', `
    <div class="container pending-box">
      <div style="font-size:48px;margin-bottom:16px">✅</div>
      <h1>Application Submitted!</h1>
      <p>Your application is now <strong>pending review</strong> by an admin.</p>
      <p>You will receive a DM on Discord once a decision has been made.</p>
      <p style="color:#888;margin-top:24px;font-size:13px">You can close this page now.</p>
    </div>
  `));
});

app.get('/admin/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: `${WEBSITE_URL}/admin/callback`,
    response_type: 'code',
    scope: 'identify',
    state,
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/admin/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    res.status(400).send(generatePage('Error', '<div class="container"><h1>Authorization Failed</h1><p>No code provided.</p></div>'));
    return;
  }

  try {
    const resp = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${WEBSITE_URL}/admin/callback`,
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
      }),
    });

    if (!resp.ok) {
      res.status(400).send(generatePage('Error', '<div class="container"><h1>Token Exchange Failed</h1><p>Please try again.</p></div>'));
      return;
    }

    const tokenData = await resp.json();
    const userResp = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userResp.ok) {
      res.status(400).send(generatePage('Error', '<div class="container"><h1>Failed to get user info</h1></div>'));
      return;
    }

    const userData = await userResp.json();

    if (!ADMIN_USER_IDS.includes(userData.id)) {
      res.status(403).send(generatePage('Access Denied', `
        <div class="container" style="text-align:center">
          <h1>Access Denied</h1>
          <p>You are not authorized to access the admin dashboard.</p>
          <p style="color:#888">Your ID: ${userData.id}</p>
        </div>
      `));
      return;
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const db = require('./mongo').getDb();
    await db.collection('admin_sessions').insertOne({
      token: sessionToken,
      userId: userData.id,
      username: userData.username,
      createdAt: new Date(),
    });

    res.cookie('admin_session', sessionToken, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    });

    res.redirect('/admin');
  } catch (err) {
    console.error('Admin OAuth error:', err);
    res.status(500).send(generatePage('Error', '<div class="container"><h1>Server Error</h1><p>Please try again.</p></div>'));
  }
});

async function requireAdmin(req, res, next) {
  const sessionToken = req.cookies?.admin_session;
  if (!sessionToken) {
    res.redirect('/admin/login');
    return;
  }
  const db = require('./mongo').getDb();
  const session = await db.collection('admin_sessions').findOne({ token: sessionToken });
  if (!session || !ADMIN_USER_IDS.includes(session.userId)) {
    res.redirect('/admin/login');
    return;
  }
  req.adminUser = { userId: session.userId, username: session.username };
  next();
}

app.get('/admin', requireAdmin, async (req, res) => {
  const apps = await getAllApplications();

  const pending = apps.filter(a => a.status === 'pending');
  const approved = apps.filter(a => a.status === 'approved');
  const rejected = apps.filter(a => a.status === 'rejected');

  const appRows = apps.map(a => {
    const age = a.discordCreatedAt ? Math.floor((Date.now() - new Date(a.discordCreatedAt).getTime()) / (1000 * 60 * 60 * 24)) : '?';
    const ageWarn = typeof age === 'number' && age < 7 ? '<span class="warning">⚠️</span>' : '✅';
    const avatarCheck = a.hasAvatar ? '✅' : '<span class="warning">⚠️</span>';
    const tlCheck = a.serverChecks?.ThirdLeg ? '<span class="check">✅</span>' : '<span class="cross">❌</span>';
    const bnfCheck = a.serverChecks?.Bnf ? '<span class="check">✅</span>' : '<span class="cross">❌</span>';
    const hermosaCheck = a.serverChecks?.Hermosa ? '<span class="check">✅</span>' : '<span class="cross">❌</span>';

    let statusBadge = '';
    if (a.status === 'pending') statusBadge = '<span class="status-badge badge-pending">⏳ Pending</span>';
    else if (a.status === 'approved') statusBadge = '<span class="status-badge badge-approved">✅ Approved</span>';
    else if (a.status === 'rejected') statusBadge = '<span class="status-badge badge-rejected">❌ Rejected</span>';
    else statusBadge = '—';

    const referralDisplay = a.referralCodeUsed
      ? `${a.referralCodeUsed}<br><span style="color:#888;font-size:11px">${a.referralOwnerName || '?'}</span>`
      : '—';

    const actions = a.status === 'pending'
      ? `<button class="btn btn-success btn-sm" onclick="event.stopPropagation();approveUser('${a.userId}')">✅ Approve</button>
         <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();rejectUser('${a.userId}')">❌ Reject</button>`
      : '';

    return `<tr class="app-row" onclick="showDetail('${a.userId}')">
      <td><strong>${a.username || 'Unknown'}</strong><br><span style="color:#888;font-size:11px">${a.userId}</span></td>
      <td>${age}d ${ageWarn}</td>
      <td>${avatarCheck}</td>
      <td>${tlCheck}</td>
      <td>${bnfCheck}</td>
      <td>${hermosaCheck}</td>
      <td>${a.robloxUsername || (a.noRoblox ? '<em>None</em>' : '—')}</td>
      <td>${referralDisplay}</td>
      <td>${statusBadge}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');

  const detailPanels = apps.map(a => {
    return `<div id="detail-${a.userId}" style="display:none" class="detail-panel">
      <h3 style="margin-bottom:12px">${a.username || 'Unknown'} — Application Details</h3>
      <div class="info-row"><span>Discord ID</span><span>${a.userId}</span></div>
      <div class="info-row"><span>Roblox</span><span>${a.robloxUsername || (a.noRoblox ? 'No account' : '—')}</span></div>
      <div class="info-row"><span>Referral Code Used</span><span>${a.referralCodeUsed || '—'}</span></div>
      <div class="info-row"><span>Referral Owner</span><span>${a.referralOwnerName ? `${a.referralOwnerName} (${a.referralOwnerId})` : '—'}</span></div>
      <div class="info-row"><span>Account Age</span><span>${a.discordCreatedAt ? Math.floor((Date.now() - new Date(a.discordCreatedAt).getTime()) / (1000 * 60 * 60 * 24)) : '?'} days</span></div>
      <div class="info-row"><span>Has Avatar</span><span>${a.hasAvatar ? 'Yes' : 'No'}</span></div>
      <div class="info-row"><span>Third Leg</span><span>${a.serverChecks?.ThirdLeg ? '✅ Yes' : '❌ No'}</span></div>
      <div class="info-row"><span>Bnf</span><span>${a.serverChecks?.Bnf ? '✅ Yes' : '❌ No'}</span></div>
      <div class="info-row"><span>Hermosa</span><span>${a.serverChecks?.Hermosa ? '✅ Yes' : '❌ No'}</span></div>
      <div style="margin-top:12px"><strong>Why Join:</strong><br><div style="background:#1a1a2e;padding:12px;border-radius:8px;margin-top:4px">${a.whyJoin || '—'}</div></div>
      <div style="margin-top:12px"><strong>How Found:</strong><br><div style="background:#1a1a2e;padding:12px;border-radius:8px;margin-top:4px">${a.howFound || '—'}</div></div>
      ${a.verifiedBy ? `<div class="info-row" style="margin-top:12px"><span>Verified By</span><span>${a.verifiedBy}</span></div>` : ''}
    </div>`;
  }).join('');

  res.send(generatePage('Admin Dashboard', `
    <div class="container" style="max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <h1>Admin Dashboard</h1>
        <span style="color:#888">Logged in as ${req.adminUser.username}</span>
      </div>

      <div class="stats-bar">
        <div class="stat-card"><div class="stat-num">${apps.length}</div><div class="stat-label">Total</div></div>
        <div class="stat-card"><div class="stat-num" style="color:#f39c12">${pending.length}</div><div class="stat-label">Pending</div></div>
        <div class="stat-card"><div class="stat-num" style="color:#2ecc71">${approved.length}</div><div class="stat-label">Approved</div></div>
        <div class="stat-card"><div class="stat-num" style="color:#e74c3c">${rejected.length}</div><div class="stat-label">Rejected</div></div>
      </div>

      <input type="text" class="search" placeholder="Search by username, Roblox, referral code..." oninput="filterTable(this.value)">

      <div style="overflow-x:auto">
        <table id="appTable">
          <thead>
            <tr>
              <th>Discord</th>
              <th>Age</th>
              <th>Avatar</th>
              <th>Third Leg</th>
              <th>Bnf</th>
              <th>Hermosa</th>
              <th>Roblox</th>
              <th>Referral</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${appRows}</tbody>
        </table>
      </div>

      ${detailPanels}

      <script>
        function filterTable(q) {
          q = q.toLowerCase();
          document.querySelectorAll('#appTable tbody tr').forEach(r => {
            r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
          });
        }
        function showDetail(userId) {
          document.querySelectorAll('.detail-panel').forEach(p => p.style.display = 'none');
          const panel = document.getElementById('detail-' + userId);
          if (panel) panel.style.display = 'block';
        }
        async function approveUser(userId) {
          if (!confirm('Approve this user?')) return;
          const resp = await fetch('/admin/api/approve/' + userId, { method: 'POST' });
          if (resp.ok) location.reload();
          else alert('Failed to approve user.');
        }
        async function rejectUser(userId) {
          if (!confirm('Reject this user?')) return;
          const resp = await fetch('/admin/api/reject/' + userId, { method: 'POST' });
          if (resp.ok) location.reload();
          else alert('Failed to reject user.');
        }
      </script>
    </div>
  `));
});

app.post('/admin/api/approve/:userId', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const appDoc = await getApplication(userId);
  if (!appDoc) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  await approveApplication(userId, req.adminUser.userId);

  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) {
      for (const roleId of VERIFIED_ROLE_IDS) {
        await member.roles.add(roleId).catch(() => {});
      }
      if (UNVERIFIED_ROLE_ID) {
        await member.roles.remove(UNVERIFIED_ROLE_ID).catch(() => {});
      }
    }
  }

  const dmSent = await sendApprovalDM(userId, appDoc.robloxUsername);

  const logChannel = await getLogChannel(guild);
  if (logChannel && logChannel.isSendable()) {
    logChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('User Approved')
          .setColor(0x2ecc71)
          .setDescription([
            `**${appDoc.username || 'Unknown'}** (<@${userId}>) approved.`,
            `Roblox: **${appDoc.robloxUsername || (appDoc.noRoblox ? 'No account' : '—')}**`,
            `Referral Code: **${appDoc.referralCodeUsed || '—'}** ${appDoc.referralOwnerName ? `from <@${appDoc.referralOwnerId}> (${appDoc.referralOwnerName})` : ''}`,
            `Third Leg: ${appDoc.serverChecks?.ThirdLeg ? '✅' : '❌'}`,
            `Bnf: ${appDoc.serverChecks?.Bnf ? '✅' : '❌'}`,
            `Hermosa: ${appDoc.serverChecks?.Hermosa ? '✅' : '❌'}`,
            `Approved by: <@${req.adminUser.userId}>`,
            `DM sent: ${dmSent ? '✅' : '⚠️ Could not send DM'}`,
          ].filter(Boolean).join('\n'))
          .setTimestamp(),
      ],
    }).catch(() => {});
  }

  res.json({ ok: true });
});

app.post('/admin/api/reject/:userId', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const appDoc = await getApplication(userId);
  if (!appDoc) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  await rejectApplication(userId, req.adminUser.userId);

  const dmSent = await sendRejectionDM(userId);

  const logChannel = await getLogChannel(client.guilds.cache.get(GUILD_ID));
  if (logChannel && logChannel.isSendable()) {
    logChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('User Rejected')
          .setColor(0xe74c3c)
          .setDescription([
            `**${appDoc.username || 'Unknown'}** (<@${userId}>) rejected.`,
            `Roblox: **${appDoc.robloxUsername || (appDoc.noRoblox ? 'No account' : '—')}**`,
            `Referral Code: **${appDoc.referralCodeUsed || '—'}** ${appDoc.referralOwnerName ? `from <@${appDoc.referralOwnerId}> (${appDoc.referralOwnerName})` : ''}`,
            `Rejected by: <@${req.adminUser.userId}>`,
            `DM sent: ${dmSent ? '✅' : '⚠️ Could not send DM'}`,
          ].filter(Boolean).join('\n'))
          .setTimestamp(),
      ],
    }).catch(() => {});
  }

  res.json({ ok: true });
});

function startServer() {
  const port = process.env.PORT || 3000;
  http.createServer(app).listen(port, () => {
    console.log(`Express listening on port ${port}`);
  });
}

async function main() {
  startServer();
  await connect();
  client.login(TOKEN);
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
