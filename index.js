require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
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
  getLeaderboard,
  recruitStats,
  createReferLink,
  findReferLink,
  markReferLinkUsed,
  getReferLinksByOwner,
  deleteReferLinksByOwner,
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
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || null;

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
  const inviterId = used ? used.inviterId : null;

  let inviterName = null;
  let refCode = null;
  let viaReferLink = null;

  if (inviterId) {
    const inviterUser = await client.users.fetch(inviterId).catch(() => null);
    inviterName = inviterUser ? inviterUser.username : String(inviterId);
    const inviterDoc = await getUser(inviterId);
    refCode = inviterDoc ? inviterDoc.referralCode : null;
  }
  if (used) {
    viaReferLink = await findReferLink(used.code);
    if (viaReferLink && !viaReferLink.used) {
      await markReferLinkUsed(used.code, member.id);
    }
  }

  await ensureUser({
    userId: member.id,
    username: member.user.username,
    inviterId,
    inviterName,
  });

  await refreshInvites(guild);

  const logChannel = await getLogChannel(guild);
  if (logChannel && logChannel.isSendable()) {
    const refText = inviterId ? `<@${inviterId}> (${inviterName})` : 'No invite detected';
    const desc = [
      `**${member.user.tag}** (<@${member.id}>) joined the server.`,
      `Referred by: ${refText}`,
      refCode ? `Referral ID: **${refCode}**` : null,
      viaReferLink ? `Used referral link: **${viaReferLink.code}**` : null,
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

  if (UNVERIFIED_ROLE_ID) {
    await member.roles.add(UNVERIFIED_ROLE_ID).catch(() => {});
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
      'Please click the **Verify** button below and complete the popup to gain access.'
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

async function openVerificationModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('verify_modal')
    .setTitle('Server Verification');

  const robloxInput = new TextInputBuilder()
    .setCustomId('roblox')
    .setLabel('Your Roblox username')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. Roblox_user123')
    .setMaxLength(32);

  const referralInput = new TextInputBuilder()
    .setCustomId('referral_code')
    .setLabel('Referral code (optional)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. VMS-XXXXXX')
    .setRequired(false)
    .setMaxLength(16);

  const agreeInput = new TextInputBuilder()
    .setCustomId('agree')
    .setLabel('Type "I agree" to accept the server rules')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('I agree')
    .setMaxLength(32);

  modal.addComponents(
    new ActionRowBuilder().addComponents(robloxInput),
    new ActionRowBuilder().addComponents(referralInput),
    new ActionRowBuilder().addComponents(agreeInput)
  );

  await interaction.showModal(modal);
}

async function handleVerificationSubmit(interaction) {
  const roblox = interaction.fields.getTextInputValue('roblox').trim();
  const agree = interaction.fields.getTextInputValue('agree').trim().toLowerCase();
  const referralRaw = interaction.fields.getTextInputValue('referral_code').trim();

  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

  if (agree !== 'yes' && agree !== 'agree' && agree !== 'i agree') {
    await interaction.followUp({
      content: 'You must type "I agree" to accept the rules to be verified.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!roblox) {
    await interaction.followUp({
      content: 'Please enter your Roblox username.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member;
  if (!member) return;

  const added = [];
  for (const roleId of VERIFIED_ROLE_IDS) {
    const ok = await member.roles.add(roleId).then(() => true).catch(() => false);
    if (ok) added.push(roleId);
  }

  if (UNVERIFIED_ROLE_ID) {
    await member.roles.remove(UNVERIFIED_ROLE_ID).catch(() => {});
  }

  await markVerified(interaction.user.id, roblox);

  const referral = await applyReferralCode(interaction.user.id, referralRaw);

  const logChannel = await getLogChannel(interaction.guild);
  if (logChannel && logChannel.isSendable()) {
    const desc = [
      `**${interaction.user.tag}** (<@${interaction.user.id}>) verified.`,
      `Roblox username: **${roblox}**`,
      `Discord ID: \`${interaction.user.id}\``,
      referral.ok ? `Referred via code **${referralRaw.toUpperCase()}** from <@${referral.owner.userId}> (${referral.owner.username})` : null,
    ].filter(Boolean).join('\n');
    logChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('User Verified')
          .setColor(0x3498db)
          .setDescription(desc)
          .setTimestamp(),
      ],
    }).catch(() => {});
  }

  const confirmDesc = [
    `Welcome, **${roblox}**!`,
    `You have been verified and granted access.`,
  ];
  if (referral.ok) {
    confirmDesc.push(`Referred by <@${referral.owner.userId}> (${referral.owner.username}).`);
  } else if (referralRaw && referral.reason === 'not_found') {
    confirmDesc.push(`Could not find a user with referral code **${referralRaw.toUpperCase()}**.`);
  } else if (referralRaw && referral.reason === 'self') {
    confirmDesc.push('You cannot use your own referral code.');
  }

  if (added.length) {
    await interaction.followUp({
      embeds: [
        new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle('Verification Complete')
          .setDescription(confirmDesc.join('\n')),
      ],
      flags: MessageFlags.Ephemeral,
    });
  } else {
    await interaction.followUp({
      content: 'Verification recorded, but I could not assign roles. ' +
        'Please contact a staff member (check the bot has Manage Roles permission and the role is below the bot).',
      flags: MessageFlags.Ephemeral,
    });
  }
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
  const doc = await ensureUser({
    userId: interaction.user.id,
    username: interaction.user.username,
  });

  let code = doc.referralCode;
  if (!code) code = await assignCode(interaction.user.id);

  const inviterRef = doc.inviterId ? `Referred by: <@${doc.inviterId}>` : 'Referred by: no one yet';

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Your Referral ID')
        .setColor(0x9b59b6)
        .setDescription(
          `Your personal referral code is:\n\n` +
          `**\`${code}\`**\n\n` +
          `This code is **permanent** and never changes. ` +
          `Share it so it gets logged when new members join. ` +
          `You can also use **/refer** to get a invite link.\n\n${inviterRef}`
        )
        .setFooter({ text: interaction.user.username })
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
      guild.channels.cache.find((c) => c.isTextBased() && c.permissionsFor(guild.members.me).has('CreateInstantInvite'));

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

  const doc = await ensureUser({
    userId: interaction.user.id,
    username: interaction.user.username,
  });
  const code = doc.referralCode || (await assignCode(interaction.user.id));

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Your Referral Invite')
        .setColor(0x2ecc71)
        .setDescription(
          `Your server invite link:\n\n${invite.url}\n\n` +
          `This link is **permanent**, has **unlimited uses**, and **never changes**. ` +
          `Share it to recruit members.\n\n` +
          `Your Referral ID **\`${code}\`** is also permanent and never changes.`
        )
        .setTimestamp(),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCreditUser(interaction) {
  if (!ADMIN_USER_ID || interaction.user.id !== ADMIN_USER_ID) {
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
      .setName('credituser')
      .setDescription('Manually credit a referrer for an invited user (admin only)')
      .addUserOption((o) => o.setName('referer').setDescription('The referrer').setRequired(true))
      .addUserOption((o) => o.setName('user').setDescription('The invited user').setRequired(true)),
  ];

  if (GUILD_ID) {
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
      if (interaction.commandName === 'credituser') return handleCreditUser(interaction);
    }

    if (interaction.isButton() && interaction.customId === 'verify_open') {
      return openVerificationModal(interaction);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'verify_modal') {
      return handleVerificationSubmit(interaction);
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

async function main() {
  await connect();
  client.login(TOKEN);
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
