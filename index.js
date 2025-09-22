require('dotenv').config();
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType, PermissionsBitField
} = require('discord.js');
const { DateTime, Duration } = require('luxon');
const fs = require('fs');
const path = require('path');

/* ========= PERSISTENT STORAGE (Volume-friendly) ========= */
const STORE_PATH = process.env.BIRTHDAY_STORE || path.join(__dirname, 'birthdays.json');
fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); }
  catch { return { guilds: {} }; }
}
function saveStore(data) {
  const tmp = STORE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}
let store = loadStore();
console.log('Birthday store path:', STORE_PATH);

/* ========= CONFIG ========= */
const TZ = process.env.TIMEZONE || 'America/Los_Angeles';
const GUILD_ID = process.env.GUILD_ID;
const FALLBACK_CHANNEL = process.env.BIRTHDAY_CHANNEL_ID || null;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* ========= CLASS SCHEDULE (/nextclass) ========= */
// weekday: 1=Mon ... 7=Sun
const SCHEDULE = [
  { name: 'CTIN 534 Lecture', weekday: 1, start: { h: 11, m: 30 }, end: { h: 13, m: 50 } },
  { name: 'CTIN 541 Lecture', weekday: 1, start: { h: 14, m:  0 }, end: { h: 16, m: 50 } },
  { name: 'CTIN 541 Lab',     weekday: 2, start: { h: 10, m:  0 }, end: { h: 12, m: 50 } },
  { name: 'CTIN 534 Lab',     weekday: 5, start: { h: 11, m: 30 }, end: { h: 13, m: 50 } },
];

function classDateTime(base, weekday, { h, m }) {
  let dt = base.set({ weekday, hour: h, minute: m, second: 0, millisecond: 0 }).setZone(TZ, { keepLocalTime: true });
  if (dt.weekday !== weekday) dt = dt.plus({ weeks: 1 }).set({ weekday, hour: h, minute: m, second: 0, millisecond: 0 });
  return dt;
}
function rangeFor(now, entry) {
  const start = classDateTime(now.startOf('week'), entry.weekday, entry.start);
  const end   = classDateTime(now.startOf('week'), entry.weekday, entry.end);
  const endFixed = end < start ? end.plus({ days: 1 }) : end;
  if (now > endFixed) return { start: start.plus({ weeks: 1 }), end: endFixed.plus({ weeks: 1 }) };
  return { start, end: endFixed };
}
function nextStart(now, entry) {
  const { start } = rangeFor(now, entry);
  return now <= start ? start : start.plus({ weeks: 1 });
}
function human(ms) {
  const d = Duration.fromMillis(ms).shiftTo('days', 'hours', 'minutes');
  const parts = [];
  if (d.days) parts.push(`${d.days}d`);
  if (d.hours) parts.push(`${d.hours}h`);
  parts.push(`${Math.max(0, Math.round(d.minutes))}m`);
  return parts.join(' ');
}

/* ========= BIRTHDAYS ========= */
function guildStore(gid) {
  if (!store.guilds[gid]) store.guilds[gid] = { channelId: FALLBACK_CHANNEL, entries: [], announcedOn: null };
  return store.guilds[gid];
}
function isValidDate(month, day) {
  // Use a leap year so 2/29 is allowed. Put zone in the second arg.
  return DateTime.fromObject({ year: 2024, month, day }, { zone: TZ }).isValid;
}
function monthDayKey(month, day) {
  return String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

/* ========= COMMAND REGISTRATION (guild = instant) ========= */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder().setName('bongotime').setDescription('Replies with BONGOTIME!'),
    new SlashCommandBuilder().setName('nextclass').setDescription('Time until next class (or time left if in one)'),
    new SlashCommandBuilder()
      .setName('addbirthday').setDescription('Save a birthday')
      .addStringOption(o => o.setName('name').setDescription('Person name').setRequired(true))
      .addIntegerOption(o => o.setName('month').setDescription('Month (1-12)').setMinValue(1).setMaxValue(12).setRequired(true))
      .addIntegerOption(o => o.setName('day').setDescription('Day (1-31)').setMinValue(1).setMaxValue(31).setRequired(true)),
    new SlashCommandBuilder()
      .setName('setbirthdaychannel').setDescription('Set the channel for birthday announcements')
      .addChannelOption(o => o.setName('channel').setDescription('Text channel').addChannelTypes(ChannelType.GuildText).setRequired(true)),
    new SlashCommandBuilder().setName('listbirthdays').setDescription('List saved birthdays'),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, GUILD_ID),
    { body: commands }
  );
  console.log('✅ Commands registered to guild:', GUILD_ID);

  runBirthdayLoop();
});

/* ========= COMMAND HANDLERS ========= */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const now = DateTime.now().setZone(TZ);

  // Ensure guild store exists
  const g = guildStore(interaction.guildId);

  if (interaction.commandName === 'bongotime') {
    return interaction.reply('🥁 BONGOTIME!');
  }

  if (interaction.commandName === 'nextclass') {
    for (const entry of SCHEDULE) {
      const { start, end } = rangeFor(now, entry);
      if (now >= start && now <= end) {
        const left = end.diff(now).toMillis();
        return interaction.reply(
          `📚 You’re **in class**: **${entry.name}**\n` +
          `🕒 ${start.toFormat('ccc, h:mm a')} → ${end.toFormat('h:mm a')} (${TZ})\n` +
          `⏳ **Time remaining:** ${human(left)}`
        );
      }
    }
    const nexts = SCHEDULE.map(e => ({ e, at: nextStart(now, e) })).sort((a,b)=>a.at-b.at);
    const { e, at } = nexts[0];
    return interaction.reply(
      `🎓 **Next class:** **${e.name}**\n` +
      `🗓️ **Starts:** ${at.toFormat('ccc, h:mm a')} (${TZ})\n` +
      `⏳ **In:** ${human(at.diff(now).toMillis())}`
    );
  }

  if (interaction.commandName === 'addbirthday') {
    const name = interaction.options.getString('name', true).trim();
    const month = interaction.options.getInteger('month', true);
    const day = interaction.options.getInteger('day', true);

    if (!isValidDate(month, day)) {
      return interaction.reply({ content: '❌ That month/day combo isn’t valid. Try again.', ephemeral: true });
    }

    g.entries.push({ name, month, day, addedBy: interaction.user.id, md: monthDayKey(month, day) });
    saveStore(store);

    // If the birthday is TODAY, announce immediately
    const todayMD = now.toFormat('MM-dd');
    if (monthDayKey(month, day) === todayMD) {
      const channelId = g.channelId || FALLBACK_CHANNEL;
      if (channelId) {
        try {
          const channel = await client.channels.fetch(channelId);
          await channel.send(`🎉🎂 Happy Birthday **${name}** (${month}/${day})!`);
          g.announcedOn = now.toISODate();
          saveStore(store);
        } catch (e) {
          console.error('Immediate birthday send failed:', e);
        }
      }
    }

    return interaction.reply({ content: `🎉 Saved **${name}** → ${month}/${day}. I’ll announce it on their birthday!`, ephemeral: true });
  }

  if (interaction.commandName === 'setbirthdaychannel') {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: '❌ You need **Manage Server** to set the birthday channel.', ephemeral: true });
    }
    const channel = interaction.options.getChannel('channel', true);
    g.channelId = channel.id;
    saveStore(store);
    return interaction.reply({ content: `✅ Birthday announcements will go to ${channel}.` });
  }

  if (interaction.commandName === 'listbirthdays') {
    if (g.entries.length === 0) {
      return interaction.reply({ content: '📭 No birthdays saved yet. Add one with `/addbirthday`.', ephemeral: true });
    }
    const lines = g.entries
      .sort((a,b)=>a.month-b.month || a.day-b.day || a.name.localeCompare(b.name))
      .map(e => `• **${e.name}** — ${e.month}/${e.day}`);
    return interaction.reply({ content: `📅 **Birthdays:**\n${lines.join('\n')}` });
  }
});

/* ========= DAILY ANNOUNCER ========= */
async function announceTodayForGuild(guildId) {
  const g = guildStore(guildId);
  const today = DateTime.now().setZone(TZ);

  // If we've already announced today, skip
  if (g.announcedOn === today.toISODate()) return;

  let todays = g.entries.filter(e => e.md === today.toFormat('MM-dd'));

  // Optional: celebrate Feb 29 people on Feb 28 in non-leap years
  if (!today.isInLeapYear && today.month === 2 && today.day === 28) {
    todays = todays.concat(g.entries.filter(e => e.md === '02-29'));
  }

  if (todays.length === 0) {
    // Do NOT mark announcedOn; allows same-day additions to be picked up later
    return;
  }

  const channelId = g.channelId || FALLBACK_CHANNEL;
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    const names = todays.map(e => `**${e.name}** (${e.month}/${e.day})`).join(', ');
    await channel.send(`🎉🎂 Happy Birthday ${names}! Have an amazing day!`);
    g.announcedOn = today.toISODate();
    saveStore(store);
  } catch (err) {
    console.error('[birthdays] Failed to send announcement:', err);
  }
}
function runBirthdayLoop() {
  // announce on boot (in case mid-day restarts), then every minute
  for (const [gid] of client.guilds.cache) announceTodayForGu
