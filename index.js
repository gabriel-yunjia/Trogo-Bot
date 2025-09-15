require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const { DateTime, Duration } = require('luxon');

const TZ = process.env.TIMEZONE || 'America/Los_Angeles'; // change if you like

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---- Your weekly class schedule (edit here) ----
// weekday: 1=Mon ... 7=Sun
const SCHEDULE = [
  { name: 'CTIN 534 Lecture', weekday: 1, start: { h: 11, m: 30 }, end: { h: 13, m: 50 } }, // Mon 11:30–1:50
  { name: 'CTIN 541 Lecture', weekday: 1, start: { h: 14, m:  0 }, end: { h: 16, m: 50 } }, // Mon 2:00–4:50
  { name: 'CTIN 541 Lab',     weekday: 2, start: { h: 10, m:  0 }, end: { h: 12, m: 50 } }, // Tue 10:00–12:50
  { name: 'CTIN 534 Lab',     weekday: 5, start: { h: 11, m: 30 }, end: { h: 13, m: 50 } }, // Fri 11:30–1:50
];

// Helpers
function classDateTime(base, weekday, { h, m }) {
  // Given a DateTime base (now), return DateTime for this week's 'weekday h:m' in TZ
  let dt = base.set({ weekday, hour: h, minute: m, second: 0, millisecond: 0 });
  // If setting weekday wrapped to next/prev week, normalize:
  if (dt.weekday !== weekday || dt < base.minus({ weeks: 1 })) {
    dt = dt.plus({ weeks: 1 }).set({ weekday, hour: h, minute: m, second: 0, millisecond: 0 });
  }
  return dt;
}

function nextStart(now, entry) {
  const startThis = classDateTime(now.startOf('week'), entry.weekday, entry.start);
  if (now <= startThis) return startThis;
  return startThis.plus({ weeks: 1 });
}

function rangeFor(now, entry) {
  const start = classDateTime(now.startOf('week'), entry.weekday, entry.start);
  const end = classDateTime(now.startOf('week'), entry.weekday, entry.end);
  const endFixed = end < start ? end.plus({ days: 1 }) : end;
  const startFixed = start;
  // If both already passed this week, shift to next week:
  if (now > endFixed) {
    return {
      start: startFixed.plus({ weeks: 1 }),
      end: endFixed.plus({ weeks: 1 }),
    };
  }
  return { start: startFixed, end: endFixed };
}

function human(diff) {
  const d = Duration.fromMillis(diff).shiftTo('days', 'hours', 'minutes');
  const parts = [];
  if (d.days) parts.push(`${d.days}d`);
  if (d.hours) parts.push(`${d.hours}h`);
  if (d.minutes || parts.length === 0) parts.push(`${Math.max(0, Math.round(d.minutes))}m`);
  return parts.join(' ');
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Register guild commands (instant). Set GUILD_ID in env vars.
  const commands = [
    new SlashCommandBuilder()
      .setName('bongotime')
      .setDescription('Replies with BONGOTIME!')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('nextclass')
      .setDescription('How long until the next class (or time left if already in one)')
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    console.log('⚡ Registering guild commands...');
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Commands registered to guild:', process.env.GUILD_ID);
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'bongotime') {
    return interaction.reply('🥁 BONGOTIME!');
  }

  if (interaction.commandName === 'nextclass') {
    const now = DateTime.now().setZone(TZ);

    // Check if currently in a class
    let current = null;
    for (const entry of SCHEDULE) {
      const { start, end } = rangeFor(now, entry);
      if (now >= start && now <= end) {
        current = { entry, start, end };
        break;
      }
    }

    if (current) {
      const left = current.end.diff(now).toMillis();
      const endsAt = current.end.toFormat('ccc, h:mm a');
      const startedAt = current.start.toFormat('h:mm a');
      return interaction.reply(
        `📚 You’re **in class right now**: **${current.entry.name}**\n` +
        `🕒 ${startedAt} → ${endsAt} (${TZ})\n` +
        `⏳ **Time remaining:** ${human(left)}`
      );
    }

    // Otherwise find the next upcoming class start
    const nexts = SCHEDULE.map(entry => {
      const start = nextStart(now, entry);
      return { entry, start };
    });
    nexts.sort((a, b) => a.start - b.start);
    const next = nexts[0];
    const diff = next.start.diff(now).toMillis();

    const startStr = next.start.toFormat('ccc, h:mm a');
    return interaction.reply(
      `🎓 **Next class:** **${next.entry.name}**\n` +
      `🗓️ **Starts:** ${startStr} (${TZ})\n` +
      `⏳ **In:** ${human(diff)}`
    );
  }
});

client.login(process.env.BOT_TOKEN);
