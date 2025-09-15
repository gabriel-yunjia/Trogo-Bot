require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder 
} = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// 1️⃣ Register the /bongotime command
client.on('ready', async () => {
  const commands = [
    new SlashCommandBuilder()
      .setName('bongotime')
      .setDescription('Replies with BONGOTIME!')
      .toJSON()
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

  try {
    console.log('⚡ Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('✅ /bongotime registered');
  } catch (error) {
    console.error(error);
  }
});

// 2️⃣ Handle /bongotime when used
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === 'bongotime') {
    await interaction.reply('🥁 BONGOTIME!');
  }
});

client.login(process.env.BOT_TOKEN);
