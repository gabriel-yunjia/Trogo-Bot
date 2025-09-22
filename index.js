require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType
} = require('discord.js');
const { DateTime } = require('luxon');
const fs = require('fs');
const path = require('path');

const TZ = process.env.TIMEZONE || 'America/Los_Angeles';
const GUILD_ID = process.env.GUILD_ID;
const FALLBACK_CHANNEL = process.env.BIRTHDAY_CHANNEL_ID || null;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------- Simple JSON storage ----------
const STORE_PATH = path.join(__dirname, 'birthdays.json');
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return { // per-guild storage, keyed by guild id
      guilds: {}
    };
  }
}
function saveStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}
let store = loadStore();
function guildStore(gid) {
  if (!store.guilds[gid]) store.guilds[gid] = { channelId: FALLBACK_CHANNEL, entries: [], announcedOn: null };
  return store.guilds[gid];
}

// ---------- Helpers ----------
function isValidDate(month, day) {
  // Validate using Luxon with a leap year (2024) so 2/29 is allowed.
  return DateTime.fromObject({ year: 2024, month, day, zone: TZ }).isValid;
}
function todayKey() {
  return DateTime.now().setZone(TZ).toISODate(); // YYYY-MM-DD
}
function monthDayKey(month, day) {
  return String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

// ---------- Register commands (guild = instant) ----------
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('bongotime')
      .setDescription('Replies with BONGOTIME!'),
    new SlashCommandBuilder()
      .setName('addbirthday')
      .setDescription('Save a birthday')
      .addStringOption(o => o.setName('name').setDescription('Person name').setRequired(true))
      .addIntegerOption(o => o.setName('month').setDescription('Month (1-12)').setRequired(true).setMinValue(1).setMaxValue(12))
      .addIntegerOption(o => o.setName('day').setDescription('Day (1-31)').setRequired(true).setMinValue(1).setMaxValue(31)),
    new SlashCommandBuilder()
      .setName('setbirthdaychannel')
      .setDescription('Set the channel for birthday announcements')
      .addChannelOption(o => o
        .setName('channel')
        .setDescription('Pick a text channel')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('listbirthdays')
      .setDescription('List saved birthdays'),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, GUILD_ID),
    { body: commands }
  );
  console.log('✅ Commands registered to guild:', GUILD_ID);

  // Start the daily checker (runs every 60s; announces once/day)
  runBirthdayLoop();
});

// ---------- Command handler ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const g = guildStore(interaction.guildId);

  if (interaction.commandName === 'bongotime') {
    return interaction.reply('🥁 BONGOTIME!');
  }

  if (interaction.commandName === 'addbirthday') {
    const name = interaction.options.getString('name', true).trim();
    const month = interaction.options.getInteger('month', true);
    const day = interaction.options.getInteger('day', true);

    if (!isValidDate(month, day)) {
      return interaction.reply({ content: '❌ That month/day combo isn’t valid. Try again.', ephemeral: true });
    }

    g.entries.push({
      name,
      month,
      day,
      addedBy: interaction.user.id,
      md: monthDayKey(month, day)
    });
    saveStore(store);

    return interaction.reply({ content: `🎉 Saved **${name}** → ${month}/${day}. I’ll announce it on their birthday!`, ephemeral: true });
  }

  if (interaction.commandName === 'setbirthdaychannel') {
    // Allow only users with Manage Guild to change this
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!member.permissions.has('ManageGuild')) {
      return interaction.reply({ content: '❌ You need **Manage Server** to set the birthday channel.', ephemeral: true });
    }

    const channel = interaction.options.getChannel('channel', true);
    g.channelId = channel.id;
    saveStore(store);

    return interaction.reply({ content: `✅ Birthday announcements will go to ${channel}.`, ephemeral: false });
  }

  if (interaction.commandName === 'listbirthdays') {
    if (g.entries.length === 0) {
      return interaction.reply({ content: '📭 No birthdays saved yet. Add one with `/addbirthday`.', ephemeral: true });
    }
    const lines = g.entries
      .sort((a,b) => a.month - b.month || a.day - b.day || a.name.localeCompare(b.name))
      .map(e => `• **${e.name}** — ${e.month}/${e.day}`);
    return interaction.reply({ content: `📅 **Birthdays:**\n${lines.join('\n')}`, ephemeral: false });
  }
});

// ---------- Daily announcer ----------
async function announceTodayForGuild(guildId) {
  const g = guildStore(guildId);
  const today = DateTime.now().setZone(TZ);
  const todayMD = today.toFormat('MM-dd');

  // Avoid duplicate announcements in the same day
  if (g.announcedOn === today.toISODate()) return;

  const todays = g.entries.filter(e => e.md === todayMD);
  if (todays.length === 0) {
    g.announcedOn = today.toISODate();
    saveStore(store);
    return;
  }

  const channelId = g.channelId || FALLBACK_CHANNEL;
  if (!channelId) {
    console.log(`[birthdays] No channel set for guild ${guildId}; skipping announcement.`);
    g.announcedOn = today.toISODate();
    saveStore(store);
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    const names = todays.map(e => `**${e.name}** (${e.month}/${e.day})`).join(', ');
    await channel.send(`🎉🎂 Happy Birthday ${names}! Hope you have an amazing day!`);
    g.announcedOn = today.toISODate();
    saveStore(store);
  } catch (err) {
    console.error('[birthdays] Failed to send announcement:', err);
  }
}

function runBirthdayLoop() {
  // Kick off immediately on boot (in case of mid-day restarts)
  for (const [gid] of client.guilds.cache) {
    announceTodayForGuild(gid);
  }
  // Then check every minute
  setInterval(() => {
    for (const [gid] of client.guilds.cache) {
      announceTodayForGuild(gid);
    }
  }, 60 * 1000);
}

client.login(process.env.BOT_TOKEN);
