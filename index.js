require('dotenv').config();
const {
  Client, GatewayIntentBits, Collection, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, ChannelType,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const cron = require('node-cron');
const fs   = require('fs');
const path = require('path');
const { fromZonedTime } = require('date-fns-tz');

// ══════════════════════════════════════════════════════════════════════════════
// BASE DE DONNEES
// ══════════════════════════════════════════════════════════════════════════════
const DB_PATH = path.join('./data', 'db.json');
const DEFAULT_DB = { matches: {}, bets: {}, users: {}, scheduled: {} };

function dbLoad() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
    }
    const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!raw.scheduled) raw.scheduled = {};
    return raw;
  } catch (e) {
    console.error('[DB] Erreur lecture:', e);
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

function dbSave(data) {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[DB] Erreur ecriture:', e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// LOGS STAFF
// ══════════════════════════════════════════════════════════════════════════════
async function logStaff(client, message) {
  try {
    const ch = await client.channels.fetch(process.env.STAFF_CHANNEL_ID);
    await ch.send(message);
  } catch (e) {
    console.error('[logStaff]', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// EMBED ET BOUTONS
// ══════════════════════════════════════════════════════════════════════════════
const LEVEL_ICONS  = { chill: '🤙', joueur: '⚡', vraiment: '🔥' };
const LEVEL_LABELS = { chill: 'Chill', joueur: 'Joueur', vraiment: 'Vraiiiment joueur' };
const BASE_POINTS  = { chill: 2, joueur: 4, vraiment: 8 };
const LEVEL_ORDER  = ['chill', 'joueur', 'vraiment'];

function buildMatchEmbed(match) {
  const isOpen = match.status === 'open';
  const embed  = new EmbedBuilder()
    .setColor(isOpen ? 0x1D428A : 0xC8102E)
    .setTitle(`🏀 ${match.title} (${isOpen ? 'Ouvert' : 'Ferme'})`)
    .setDescription(`Fin des mises : **${match.closingTimeLabel}**\n​`);

  const sorted = [...match.choices].sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
  for (const c of sorted) {
    embed.addFields({
      name: `${LEVEL_ICONS[c.level]} ${c.label}`,
      value: `Cote : *${c.odds}* · **+${BASE_POINTS[c.level]} pts** si correct\n​`,
      inline: false,
    });
  }
  if (match.imageUrl) embed.setImage(match.imageUrl);
  embed.setFooter({ text: 'BetClic NBA · Matchday' });
  return embed;
}

function buildButtons(matchId, choices, isOpen) {
  const STYLE  = { chill: ButtonStyle.Secondary, joueur: ButtonStyle.Primary, vraiment: ButtonStyle.Danger };
  const sorted = [...choices].sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
  const rows   = [];
  for (let i = 0; i < sorted.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      sorted.slice(i, i + 5).map(c =>
        new ButtonBuilder()
          .setCustomId(`bet_${matchId}_${c.id}`)
          .setLabel(`${LEVEL_ICONS[c.level]} ${c.label} (+${BASE_POINTS[c.level]} pts)`)
          .setStyle(STYLE[c.level])
          .setDisabled(!isOpen)
      )
    ));
  }
  return rows;
}

// ══════════════════════════════════════════════════════════════════════════════
// UTILITAIRES DATE
// ══════════════════════════════════════════════════════════════════════════════
const TZ = 'Europe/Paris';

function parseDateTime(str) {
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const dt = fromZonedTime(new Date(`${y}-${mo}-${d}T${h}:${mi}:00`), TZ);
  return isNaN(dt.getTime()) ? null : dt;
}

function dateLabel(str) {
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) return str;
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMANDES
// ══════════════════════════════════════════════════════════════════════════════
const MAX_COTES = 10;

// /create-matchday
const createBuilder = new SlashCommandBuilder()
  .setName('create-matchday')
  .setDescription('Creer un Matchday NBA avec jusqu\'a 10 cotes')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(o => o.setName('titre').setDescription('Titre du matchday').setRequired(true))
  .addStringOption(o => o.setName('fermeture').setDescription('Fermeture YYYY-MM-DD HH:MM (Paris)').setRequired(true));

for (let i = 1; i <= MAX_COTES; i++) {
  const req = i === 1;
  createBuilder
    .addStringOption(o => o.setName(`cote${i}_label`).setDescription(`Cote ${i} : libelle`).setRequired(req))
    .addStringOption(o => o.setName(`cote${i}_odds`).setDescription(`Cote ${i} : valeur ex 1.85`).setRequired(req))
    .addStringOption(o => o.setName(`cote${i}_level`).setDescription(`Cote ${i} : niveau`).setRequired(req)
      .addChoices(
        { name: '🤙 Chill (+2 pts)',             value: 'chill'    },
        { name: '⚡ Joueur (+4 pts)',             value: 'joueur'   },
        { name: '🔥 Vraiiiment joueur (+8 pts)', value: 'vraiment' },
      ));
}
createBuilder
  .addStringOption(o => o.setName('publier_le').setDescription('Programmer publication YYYY-MM-DD HH:MM (Paris)').setRequired(false))
  .addStringOption(o => o.setName('image').setDescription('URL image').setRequired(false))
  .addChannelOption(o => o.setName('channel').setDescription('Channel cible').addChannelTypes(ChannelType.GuildText).setRequired(false));

async function executeCreateMatchday(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const titre      = interaction.options.getString('titre');
  const fermeture  = interaction.options.getString('fermeture');
  const imageUrl   = interaction.options.getString('image') || null;
  const publishStr = interaction.options.getString('publier_le') || null;
  const targetCh   = interaction.options.getChannel('channel') || interaction.channel;

  const closingUTC = parseDateTime(fermeture);
  if (!closingUTC) return interaction.editReply('Erreur : format fermeture invalide. Utilise YYYY-MM-DD HH:MM');

  let publishUTC = null;
  if (publishStr) {
    publishUTC = parseDateTime(publishStr);
    if (!publishUTC) return interaction.editReply('Erreur : format publier_le invalide. Utilise YYYY-MM-DD HH:MM');
    if (publishUTC >= closingUTC) return interaction.editReply('Erreur : la date de publication doit etre avant la fermeture.');
  }

  const choices = [];
  for (let i = 1; i <= MAX_COTES; i++) {
    const label = interaction.options.getString(`cote${i}_label`);
    const odds  = interaction.options.getString(`cote${i}_odds`);
    const level = interaction.options.getString(`cote${i}_level`);
    if (!label || !odds || !level) break;
    choices.push({ id: `c${i}`, label, odds, level });
  }
  if (choices.length === 0) return interaction.editReply('Erreur : ajoute au moins une cote.');

  const matchId   = 'nba_' + Date.now();
  const matchData = {
    id: matchId, title: titre,
    status: publishUTC ? 'scheduled' : 'open',
    closingTimeUTC: closingUTC.toISOString(),
    closingTimeLabel: dateLabel(fermeture),
    choices, imageUrl,
    channelId: targetCh.id,
    messageId: null,
    publishAt: publishUTC ? publishUTC.toISOString() : null,
  };

  const db = dbLoad();
  db.bets[matchId] = {};

  if (publishUTC) {
    db.scheduled[matchId] = { publishAt: publishUTC.toISOString(), matchData };
    dbSave(db);
    await logStaff(interaction.client, `📅 Matchday programme | ID : \`${matchId}\` | **${titre}** | Publication : ${dateLabel(publishStr)} | Fermeture : ${dateLabel(fermeture)}`);
    return interaction.editReply(`Matchday **${titre}** programme !\nID : \`${matchId}\`\nPublication : **${dateLabel(publishStr)}**\nFermeture : **${dateLabel(fermeture)}**`);
  }

  const msg = await targetCh.send({ embeds: [buildMatchEmbed(matchData)], components: buildButtons(matchId, choices, true) });
  matchData.messageId = msg.id;
  db.matches[matchId] = matchData;
  dbSave(db);

  await logStaff(interaction.client, `🏀 Matchday publie | ID : \`${matchId}\` | **${titre}** | Fermeture : ${dateLabel(fermeture)} | ${choices.length} cote(s)`);
  await interaction.editReply(`Matchday **${titre}** publie !\nID : \`${matchId}\`\nFermeture : **${dateLabel(fermeture)}**`);
}

// /edit-matchday
const editBuilder = new SlashCommandBuilder()
  .setName('edit-matchday')
  .setDescription('Modifier un matchday programme ou publie')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(o => o.setName('match_id').setDescription('ID du matchday').setRequired(true))
  .addStringOption(o => o.setName('titre').setDescription('Nouveau titre').setRequired(false))
  .addStringOption(o => o.setName('fermeture').setDescription('Nouvelle fermeture YYYY-MM-DD HH:MM').setRequired(false))
  .addStringOption(o => o.setName('publier_le').setDescription('Nouvelle date de publication YYYY-MM-DD HH:MM').setRequired(false))
  .addStringOption(o => o.setName('image').setDescription('Nouvelle URL image').setRequired(false));

for (let i = 1; i <= MAX_COTES; i++) {
  editBuilder
    .addStringOption(o => o.setName(`cote${i}_label`).setDescription(`Cote ${i} : nouveau libelle`).setRequired(false))
    .addStringOption(o => o.setName(`cote${i}_odds`).setDescription(`Cote ${i} : nouvelle valeur`).setRequired(false))
    .addStringOption(o => o.setName(`cote${i}_level`).setDescription(`Cote ${i} : nouveau niveau`).setRequired(false)
      .addChoices(
        { name: '🤙 Chill (+2 pts)',             value: 'chill'    },
        { name: '⚡ Joueur (+4 pts)',             value: 'joueur'   },
        { name: '🔥 Vraiiiment joueur (+8 pts)', value: 'vraiment' },
      ));
}

async function executeEditMatchday(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const matchId = interaction.options.getString('match_id');
  const db = dbLoad();

  const isScheduled = !!db.scheduled[matchId];
  let matchData = isScheduled ? db.scheduled[matchId].matchData : db.matches[matchId];
  if (!matchData) return interaction.editReply('Matchday introuvable.');

  const changes = [];

  const newTitre = interaction.options.getString('titre');
  if (newTitre) { matchData.title = newTitre; changes.push('titre'); }

  const newImage = interaction.options.getString('image');
  if (newImage !== null) { matchData.imageUrl = newImage || null; changes.push('image'); }

  const newFermeture = interaction.options.getString('fermeture');
  if (newFermeture) {
    const dt = parseDateTime(newFermeture);
    if (!dt) return interaction.editReply('Format fermeture invalide.');
    matchData.closingTimeUTC   = dt.toISOString();
    matchData.closingTimeLabel = dateLabel(newFermeture);
    changes.push('fermeture');
  }

  const newPublishStr = interaction.options.getString('publier_le');
  if (newPublishStr) {
    if (!isScheduled) return interaction.editReply('Ce matchday est deja publie, impossible de changer la date de publication.');
    const dt = parseDateTime(newPublishStr);
    if (!dt) return interaction.editReply('Format publier_le invalide.');
    db.scheduled[matchId].publishAt = dt.toISOString();
    matchData.publishAt = dt.toISOString();
    changes.push(`publication -> ${dateLabel(newPublishStr)}`);
  }

  for (let i = 1; i <= MAX_COTES; i++) {
    const label = interaction.options.getString(`cote${i}_label`);
    const odds  = interaction.options.getString(`cote${i}_odds`);
    const level = interaction.options.getString(`cote${i}_level`);
    if (!label && !odds && !level) continue;
    const coteId = `c${i}`;
    let cote = matchData.choices.find(c => c.id === coteId);
    if (!cote) {
      if (!label || !odds || !level) return interaction.editReply(`Pour ajouter la cote ${i}, fournis label + odds + level.`);
      matchData.choices.push({ id: coteId, label, odds, level });
      changes.push(`cote ${i} ajoutee`);
    } else {
      if (label) { cote.label = label; changes.push(`cote ${i} label`); }
      if (odds)  { cote.odds  = odds;  changes.push(`cote ${i} cote`);  }
      if (level) { cote.level = level; changes.push(`cote ${i} niveau`); }
    }
  }

  if (changes.length === 0) return interaction.editReply('Aucune modification fournie.');

  if (isScheduled) db.scheduled[matchId].matchData = matchData;
  else db.matches[matchId] = matchData;
  dbSave(db);

  if (!isScheduled && matchData.messageId) {
    try {
      const ch  = await interaction.guild.channels.fetch(matchData.channelId);
      const msg = await ch.messages.fetch(matchData.messageId);
      await msg.edit({ embeds: [buildMatchEmbed(matchData)], components: buildButtons(matchId, matchData.choices, matchData.status === 'open') });
    } catch (e) { console.error('[edit-matchday]', e.message); }
  }

  await logStaff(interaction.client, `✏️ Matchday modifie | ID : \`${matchId}\` | ${changes.join(', ')}`);
  await interaction.editReply(`Matchday \`${matchId}\` modifie : **${changes.join(', ')}**`);
}

// /close-match
const closeBuilder = new SlashCommandBuilder()
  .setName('close-match')
  .setDescription('Fermer manuellement un matchday')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(o => o.setName('match_id').setDescription('ID du matchday').setRequired(true));

async function executeCloseMatch(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const matchId = interaction.options.getString('match_id');
  const db = dbLoad();
  const match = db.matches[matchId];
  if (!match) return interaction.editReply('Match introuvable.');
  if (match.status === 'closed') return interaction.editReply('Ce match est deja ferme.');

  match.status = 'closed';
  dbSave(db);

  try {
    const ch  = await interaction.guild.channels.fetch(match.channelId);
    const msg = await ch.messages.fetch(match.messageId);
    await msg.edit({ embeds: [buildMatchEmbed(match)], components: buildButtons(matchId, match.choices, false) });
  } catch (e) { console.error('[close-match]', e.message); }

  await logStaff(interaction.client, `🔒 Matchday ferme manuellement | ID : \`${matchId}\` | **${match.title}**`);
  await interaction.editReply(`Matchday \`${matchId}\` ferme.`);
}

// /set-result
const resultBuilder = new SlashCommandBuilder()
  .setName('set-result')
  .setDescription('Definir les cotes gagnantes et attribuer les points')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(o => o.setName('match_id').setDescription('ID du matchday').setRequired(true))
  .addStringOption(o => o.setName('gagnants').setDescription('IDs des cotes gagnantes : c1,c3 (ou aucun)').setRequired(true));

async function executeSetResult(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const matchId     = interaction.options.getString('match_id');
  const gagnantsRaw = interaction.options.getString('gagnants').trim().toLowerCase();

  const db = dbLoad();
  const match = db.matches[matchId];
  if (!match) return interaction.editReply('Match introuvable.');
  if (match.result !== undefined) return interaction.editReply('Ce match a deja un resultat.');

  const winningIds = gagnantsRaw === 'aucun' ? [] : gagnantsRaw.split(',').map(s => s.trim());
  match.result = winningIds;
  match.status = 'closed';

  const bets = db.bets[matchId] || {};
  let winners = 0;

  for (const [userId, bet] of Object.entries(bets)) {
    if (winningIds.includes(bet.choiceId)) {
      const cote = match.choices.find(c => c.id === bet.choiceId);
      const pts  = cote ? (bet.boosted ? BASE_POINTS[cote.level] * 2 : BASE_POINTS[cote.level]) : 0;
      if (!db.users[userId]) db.users[userId] = { totalPoints: 0, username: bet.username || userId };
      db.users[userId].totalPoints = (db.users[userId].totalPoints || 0) + pts;
      bet.points = pts;
      winners++;
    }
  }
  dbSave(db);

  try {
    const ch  = await interaction.guild.channels.fetch(match.channelId);
    const msg = await ch.messages.fetch(match.messageId);
    await msg.edit({ embeds: [buildMatchEmbed(match)], components: buildButtons(matchId, match.choices, false) });
  } catch (e) { console.error('[set-result]', e.message); }

  const labels = winningIds.length
    ? winningIds.map(id => { const c = match.choices.find(x => x.id === id); return c ? `${c.label} (+${BASE_POINTS[c.level]} pts)` : id; }).join(', ')
    : 'Aucune cote gagnante';

  await logStaff(interaction.client, `🏆 Resultat | ID : \`${matchId}\` | **${match.title}** | Gagnant(s) : ${labels} | ${winners} membre(s) credite(s)`);
  await interaction.editReply(`Resultat enregistre.\nGagnant(s) : **${labels}**\n${winners} membre(s) credite(s).`);
}

// /classement
const classementBuilder = new SlashCommandBuilder()
  .setName('classement')
  .setDescription('Affiche le classement general NBA Matchday');

async function executeClassement(interaction) {
  await interaction.deferReply();
  const db = dbLoad();
  const sorted = Object.entries(db.users || {})
    .map(([id, u]) => ({ id, pts: u.totalPoints || 0, username: u.username || id, first: u.firstBetAt || Infinity }))
    .sort((a, b) => b.pts - a.pts || a.first - b.first)
    .slice(0, 20);

  if (!sorted.length) return interaction.editReply('Aucun point pour le moment.');

  const medals = ['🥇', '🥈', '🥉'];
  const embed = new EmbedBuilder()
    .setColor(0x1D428A)
    .setTitle('🏀 Classement General NBA Matchday')
    .setDescription(sorted.map((u, i) => `${medals[i] || `**${i + 1}.**`} <@${u.id}> — **${u.pts} pts**`).join('\n'))
    .setTimestamp()
    .setFooter({ text: 'BetClic NBA · Classement general' });

  await interaction.editReply({ embeds: [embed] });
}

// /reset-scores
const resetBuilder = new SlashCommandBuilder()
  .setName('reset-scores')
  .setDescription('[ADMIN] Reinitialiser tous les points NBA Matchday')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function executeResetScores(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const db = dbLoad();
  Object.keys(db.users).forEach(id => {
    db.users[id].totalPoints    = 0;
    db.users[id].boostUsedToday = null;
    db.users[id].firstBetAt     = null;
  });
  Object.keys(db.bets).forEach(mid => { db.bets[mid] = {}; });
  db.matches   = {};
  db.scheduled = {};
  dbSave(db);
  await logStaff(interaction.client, `🔄 Reset complet du classement NBA Matchday par <@${interaction.user.id}>`);
  await interaction.editReply('Classement NBA Matchday reinitialise.');
}

// ══════════════════════════════════════════════════════════════════════════════
// REGISTRE
// ══════════════════════════════════════════════════════════════════════════════
const COMMANDS = [
  { data: createBuilder,     execute: executeCreateMatchday },
  { data: editBuilder,       execute: executeEditMatchday   },
  { data: closeBuilder,      execute: executeCloseMatch     },
  { data: resultBuilder,     execute: executeSetResult      },
  { data: classementBuilder, execute: executeClassement     },
  { data: resetBuilder,      execute: executeResetScores    },
];

// ══════════════════════════════════════════════════════════════════════════════
// DEPLOIEMENT SLASH COMMANDS
// ══════════════════════════════════════════════════════════════════════════════
async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log(`Deploiement de ${COMMANDS.length} commandes...`);
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body: COMMANDS.map(c => c.data.toJSON()) }
    );
    console.log('Commandes deploiees.');
  } catch (e) {
    console.error('[deployCommands]', e);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CLIENT
// ══════════════════════════════════════════════════════════════════════════════
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
process.on('uncaughtException',  err => console.error('[uncaughtException]',  err));

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
client.on('error', err => console.error('[client error]', err));
client.on('warn',  msg => console.warn('[client warn]',  msg));

const cmdMap = new Collection();
for (const cmd of COMMANDS) cmdMap.set(cmd.data.name, cmd);

client.once('ready', async () => {
  console.log(`Bot NBA connecte : ${client.user.tag}`);
  if (process.env.DEPLOY_COMMANDS === 'true') await deployCommands();
  startAutoCloseJob();
  startScheduledPublishJob();
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = cmdMap.get(interaction.commandName);
      if (!cmd) return;
      try { await cmd.execute(interaction); }
      catch (e) {
        console.error(e);
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content: 'Erreur.' });
        else await interaction.reply({ content: 'Erreur.', flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (!interaction.isButton()) return;
    const customId = interaction.customId;

    // bet_<matchId>_<choiceId>
    if (customId.startsWith('bet_')) {
      const parts    = customId.split('_');
      const choiceId = parts[parts.length - 1];
      const matchId  = parts.slice(1, -1).join('_');

      const db    = dbLoad();
      const match = db.matches[matchId];
      if (!match) return interaction.reply({ content: 'Match introuvable.', flags: MessageFlags.Ephemeral });
      if (match.status !== 'open') return interaction.reply({ content: 'Les mises sont fermees.', flags: MessageFlags.Ephemeral });

      const userId   = interaction.user.id;
      const username = interaction.user.username;

      if (db.bets[matchId]?.[userId]) {
        const cote = match.choices.find(c => c.id === db.bets[matchId][userId].choiceId);
        return interaction.reply({
          embeds: [{ color: 0xC8102E, title: 'Pari deja enregistre',
            description: `Tu as deja mise sur **${cote?.label || db.bets[matchId][userId].choiceId}**. Impossible de changer.` }],
          flags: MessageFlags.Ephemeral,
        });
      }

      const cote = match.choices.find(c => c.id === choiceId);
      if (!cote) return interaction.reply({ content: 'Cote introuvable.', flags: MessageFlags.Ephemeral });

      if (!db.users[userId]) db.users[userId] = { totalPoints: 0, boostUsedToday: null, username };
      db.users[userId].username = username;

      const todayStr       = new Date().toISOString().slice(0, 10);
      const boostAvailable = db.users[userId].boostUsedToday !== todayStr;
      const basePoints     = BASE_POINTS[cote.level];

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirm_${matchId}_${choiceId}_0`).setLabel('Confirmer').setStyle(ButtonStyle.Success),
        ...(boostAvailable
          ? [new ButtonBuilder().setCustomId(`confirm_${matchId}_${choiceId}_1`).setLabel('⚡ Confirmer + Boost x2').setStyle(ButtonStyle.Primary)]
          : []),
        new ButtonBuilder().setCustomId('cancel_bet').setLabel('Annuler').setStyle(ButtonStyle.Secondary),
      );

      await logStaff(client, `🎲 Pari initie | **${match.title}** | <@${userId}> -> ${cote.label} (${LEVEL_LABELS[cote.level]}) | Boost dispo : ${boostAvailable ? 'oui' : 'non'}`);

      return interaction.reply({
        embeds: [{
          color: 0x1D428A,
          title: `Confirmer ton pari - ${match.title}`,
          description: `Tu as choisi : **${cote.label}**\n**Points potentiels : ${basePoints} pts**\n\n` +
            (boostAvailable
              ? '⚡ **Boost disponible !** Double tes points. (1 boost/jour, irrevocable)'
              : 'Boost deja utilise aujourd\'hui.'),
          footer: { text: 'Une fois confirme, ton pari ne peut plus etre change.' },
        }],
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }

    // confirm_<matchId>_<choiceId>_<boost>
    if (customId.startsWith('confirm_')) {
      const parts    = customId.split('_');
      const boost    = parts[parts.length - 1] === '1';
      const choiceId = parts[parts.length - 2];
      const matchId  = parts.slice(1, -2).join('_');

      const db    = dbLoad();
      const match = db.matches[matchId];
      if (!match || match.status !== 'open') return interaction.update({ content: 'Match ferme.', embeds: [], components: [] });

      const userId   = interaction.user.id;
      const username = interaction.user.username;
      const todayStr = new Date().toISOString().slice(0, 10);

      if (!db.users[userId]) db.users[userId] = { totalPoints: 0, boostUsedToday: null, username };
      if (db.bets[matchId]?.[userId]) return interaction.update({ content: 'Pari deja enregistre.', embeds: [], components: [] });
      if (boost && db.users[userId].boostUsedToday === todayStr) return interaction.update({ content: 'Boost deja utilise.', embeds: [], components: [] });

      const cote = match.choices.find(c => c.id === choiceId);
      if (!cote) return interaction.update({ content: 'Cote introuvable.', embeds: [], components: [] });

      if (!db.bets[matchId]) db.bets[matchId] = {};
      db.bets[matchId][userId] = { choiceId, boosted: boost, username, points: null, placedAt: Date.now() };
      if (boost) db.users[userId].boostUsedToday = todayStr;
      if (!db.users[userId].firstBetAt) db.users[userId].firstBetAt = Date.now();
      db.users[userId].username = username;
      dbSave(db);

      const finalPoints = boost ? BASE_POINTS[cote.level] * 2 : BASE_POINTS[cote.level];

      await logStaff(client, `✅ Pari confirme | **${match.title}** | <@${userId}> -> **${cote.label}** | ${finalPoints} pts potentiels${boost ? ' (boost x2)' : ''}`);

      return interaction.update({
        embeds: [{
          color: 0x00C853,
          title: 'Pari enregistre !',
          description: `**Match :** ${match.title}\n**Choix :** ${cote.label}\n**Points potentiels :** ${finalPoints} pts${boost ? ' ⚡ (boost x2)' : ''}`,
          footer: { text: 'Bonne chance !' },
        }],
        components: [],
      });
    }

    if (customId === 'cancel_bet') return interaction.update({ content: 'Pari annule.', embeds: [], components: [] });

  } catch (e) {
    console.error('[interactionCreate]', e);
    try {
      if (!interaction.replied && !interaction.deferred && interaction.isRepliable?.())
        await interaction.reply({ content: 'Une erreur est survenue.', flags: MessageFlags.Ephemeral });
    } catch (_) {}
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CRON JOBS
// ══════════════════════════════════════════════════════════════════════════════
function startAutoCloseJob() {
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const db  = dbLoad();
    let changed = false;

    for (const [matchId, match] of Object.entries(db.matches)) {
      if (match.status !== 'open') continue;
      if (now >= new Date(match.closingTimeUTC)) {
        match.status = 'closed';
        changed = true;
        try {
          const g   = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
          const ch  = await g.channels.fetch(match.channelId);
          const msg = await ch.messages.fetch(match.messageId);
          await msg.edit({ embeds: [buildMatchEmbed(match)], components: buildButtons(matchId, match.choices, false) });
        } catch (e) { console.error('[AutoClose]', e.message); }
        await logStaff(client, `🔒 Fermeture auto | ID : \`${matchId}\` | **${match.title}**`);
      }
    }
    if (changed) dbSave(db);
  });
}

function startScheduledPublishJob() {
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const db  = dbLoad();
    let changed = false;

    for (const [matchId, entry] of Object.entries(db.scheduled || {})) {
      if (now < new Date(entry.publishAt)) continue;
      const matchData = entry.matchData;
      matchData.status = 'open';
      try {
        const g   = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
        const ch  = await g.channels.fetch(matchData.channelId);
        const msg = await ch.send({ embeds: [buildMatchEmbed(matchData)], components: buildButtons(matchId, matchData.choices, true) });
        matchData.messageId = msg.id;
      } catch (e) { console.error('[ScheduledPublish]', e.message); continue; }

      db.matches[matchId] = matchData;
      db.bets[matchId]    = db.bets[matchId] || {};
      delete db.scheduled[matchId];
      changed = true;

      await logStaff(client, `📢 Publication automatique | ID : \`${matchId}\` | **${matchData.title}**`);
      console.log(`[ScheduledPublish] Matchday ${matchId} publie.`);
    }
    if (changed) dbSave(db);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════════
client.login(process.env.DISCORD_TOKEN);
