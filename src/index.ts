import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from 'dotenv';
import { getVoiceConnection } from '@discordjs/voice';
import { handleVoiceStateUpdate } from './services/whisper';
import ffmpeg from 'fluent-ffmpeg';
import { getOptimalMeetingTimes } from './services/gpt';

// Set the path to the ffmpeg binary
ffmpeg.setFfmpegPath('/opt/homebrew/bin/ffmpeg');

config(); // Load .env variables

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers, // Ensure this intent is enabled in the Discord Developer Portal
  ],
});

client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user?.tag}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (message.content.toLowerCase().startsWith('#schedule')) {
    const filter = (m: any) => m.author.id === message.author.id;

    try {
      await message.channel.send('📧 Please provide the invitee email:');
      const emailCollected = await message.channel.awaitMessages({
        filter,
        max: 1,
        time: 30000,
      });
      const email = emailCollected.first()?.content;

      await message.channel.send(
        '📅 Please provide preferred date/time or range (e.g., "next week", "2025-06-21 afternoon"):'
      );
      const timeCollected = await message.channel.awaitMessages({
        filter,
        max: 1,
        time: 30000,
      });
      const preferredTime = timeCollected.first()?.content;

      await message.channel.send('🏢 Please provide meeting room name:');
      const roomCollected = await message.channel.awaitMessages({
        filter,
        max: 1,
        time: 30000,
      });
      const room = roomCollected.first()?.content;

      await message.channel.send('🏢 Please provide meeting meeting details:');
      const detailsCollected = await message.channel.awaitMessages({
        filter,
        max: 1,
        time: 30000,
      });
      const details = detailsCollected.first()?.content;

      await message.channel.send('🏢 Please provide meeting duration:');
      const durationCollected = await message.channel.awaitMessages({
        filter,
        max: 1,
        time: 30000,
      });
      const duration = durationCollected.first()?.content;

      await message.channel.send('🏢 Please provide meeting days range from:');
      const startDateCollected = await message.channel.awaitMessages({
        filter,
        max: 1,
        time: 30000,
      });
      const startDateString = startDateCollected.first()?.content;
      const startDate: Date | undefined = startDateString ? new Date(startDateString) : undefined;

      await message.channel.send('🏢 Please provide meeting days range to:');
      const endDateCollected = await message.channel.awaitMessages({
        filter,
        max: 1,
        time: 30000,
      });
      const endDateString = endDateCollected.first()?.content;
      const endDate: Date | undefined = endDateString ? new Date(endDateString) : undefined;

      await message.channel.send(`⏳ Finding optimal times for ${email}...`);

      // 👉 Call your scheduling logic
      const suggestions = await getOptimalMeetingTimes(
        email as string,
        duration as string,
        details as string,
        startDate as Date,
        endDate as Date,
        preferredTime as string,
        room as string
      );

      if (suggestions.length > 0) {
        await message.channel.send(
          `✅ Here are 3 suggested time slots:\n${suggestions.join('\n')}`
        );
      } else {
        await message.channel.send(`⚠️ Could not find available slots.`);
      }
    } catch (err) {
      console.error(err);
      await message.channel.send(
        '⚠️ Timeout or error occurred. Please try again.'
      );
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const botId = client.user?.id;

  // Automatically join the voice channel when a user joins
  handleVoiceStateUpdate(oldState, newState);

  // Automatically leave the voice channel when it's empty
  if (
    oldState.channel &&
    oldState.channel.members.size === 1 &&
    oldState.channel.members.has(botId!)
  ) {
    const connection = getVoiceConnection(oldState.guild.id);
    if (connection) {
      connection.destroy();
      console.log(`🤖 Bot left voice channel: ${oldState.channel.name}`);
    }
  }
});
