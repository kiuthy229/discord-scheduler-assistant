import {
  joinVoiceChannel,
  VoiceReceiver,
  EndBehaviorType,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
} from '@discordjs/voice';
import { VoiceState, TextChannel, Client } from 'discord.js';
import fs from 'fs';
import { spawn } from 'child_process';
import prism from 'prism-media';
import OpenAI from 'openai';
import { getMeetingTimesByVoice } from './gpt-voice-completions';

// Global client reference for sending messages
let discordClient: Client | null = null;

// Function to set the Discord client reference
export function setDiscordClient(client: Client) {
  discordClient = client;
}

// Transcribe function
export async function transcribeAudio(audioFile: string): Promise<string> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let attempts = 0;
  const maxAttempts = 2;

  while (attempts < maxAttempts) {
    try {
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(audioFile),
        model: 'whisper-1',
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
      });
      if (transcription.text) {
        return transcription.text;
      } else {
        throw new Error('No transcription text found');
      }
    } catch (error: any) {
      if (error.response?.status === 429) {
        attempts++;
        const delay = Math.pow(2, attempts) * 1000;
        console.warn(
          `Rate limited. Retrying in ${
            delay / 1000
          }s... (${attempts}/${maxAttempts})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        console.error(
          '❌ Transcription failed:',
          error.response?.data || error.message
        );
        throw error;
      }
    }
  }

  throw new Error(
    'Failed to transcribe after multiple attempts due to rate limiting.'
  );
}

const userAudioBuffers: Map<string, Buffer[]> = new Map();
const userRecordingSessions: Map<
  string,
  { startTime: number; isRecording: boolean; lastProcessedTime: number }
> = new Map();
const minDurationMs = 300; // Reduced to 10 seconds for faster processing

// Store conversation context for each user
const userConversations: Map<
  string,
  { transcript: string; meetingTimes: string[] }
> = new Map();

// Global variable to store current user schedules
export const currentUserSchedule: Map<string, string> = new Map();

// Cooldown period to prevent repeated processing (5 seconds)
const PROCESSING_COOLDOWN_MS = 5000;

function startRecording(
  receiver: VoiceReceiver,
  userId: string,
  guildId?: string
) {
  if (!userAudioBuffers.has(userId)) {
    userAudioBuffers.set(userId, []);
  }

  // Initialize recording session
  userRecordingSessions.set(userId, {
    startTime: Date.now(),
    isRecording: true,
    lastProcessedTime: 0,
  });

  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterInactivity, duration: 2000 }, // Reduced to 1 second
  });

  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });

  opusStream.pipe(decoder);

  let isCollecting = false;
  let silenceStartTime = 0;
  const silenceThreshold = 2000; // 2 seconds of silence to stop recording
  let processingInProgress = false; // Flag to prevent multiple simultaneous processing

  decoder.on('data', async (chunk) => {
    // Skip if we're currently processing to avoid conflicts
    if (processingInProgress) return;

    const existing = userAudioBuffers.get(userId) || [];

    // Check if this chunk contains actual audio (not silence)
    const hasAudio = hasSignificantAudio(chunk);

    if (hasAudio) {
      // User is speaking
      isCollecting = true;
      silenceStartTime = 0;
      existing.push(chunk);
      userAudioBuffers.set(userId, existing);
    } else if (isCollecting) {
      // User stopped speaking, start silence timer
      if (silenceStartTime === 0) {
        silenceStartTime = Date.now();
      }

      // If silence continues for threshold, process the current buffer
      if (Date.now() - silenceStartTime > silenceThreshold) {
        isCollecting = false;

        // Only process if we have enough audio and not already processing
        const totalLength = existing.reduce((sum, buf) => sum + buf.length, 0);
        const durationMs = (totalLength / (48000 * 2 * 2)) * 1000;

        // Check cooldown period
        const session = userRecordingSessions.get(userId);
        const timeSinceLastProcessed =
          Date.now() - (session?.lastProcessedTime || 0);

        if (
          durationMs >= minDurationMs &&
          !processingInProgress &&
          timeSinceLastProcessed > PROCESSING_COOLDOWN_MS
        ) {
          processingInProgress = true;
          await finalizeRecording(userId, existing, guildId);
          processingInProgress = false;

          // Reset buffer but keep the session active for continuous recording
          userAudioBuffers.set(userId, []);
        }
        return;
      }

      // Still within silence threshold, keep the chunk
      existing.push(chunk);
      userAudioBuffers.set(userId, existing);
    }
  });

  // Handle when user leaves voice channel
  opusStream.on('end', async () => {
    const existing = userAudioBuffers.get(userId) || [];

    // Check cooldown period
    const session = userRecordingSessions.get(userId);
    const timeSinceLastProcessed =
      Date.now() - (session?.lastProcessedTime || 0);

    if (
      existing.length > 0 &&
      !processingInProgress &&
      timeSinceLastProcessed > PROCESSING_COOLDOWN_MS
    ) {
      processingInProgress = true;
      await finalizeRecording(userId, existing, guildId);
      processingInProgress = false;
    }
  });
}

// Check if audio chunk contains significant audio (not just silence)
function hasSignificantAudio(chunk: Buffer): boolean {
  const threshold = 100; // Adjust this value as needed
  let sum = 0;

  for (let i = 0; i < chunk.length; i += 2) {
    const sample = chunk.readInt16LE(i);
    sum += Math.abs(sample);
  }

  const average = sum / (chunk.length / 2);
  return average > threshold;
}

// Finalize recording when user stops speaking
async function finalizeRecording(
  userId: string,
  buffer: Buffer[],
  guildId?: string
): Promise<void> {
  const session = userRecordingSessions.get(userId);
  if (session && session.isRecording) {
    // Don't set isRecording to false - keep the session active for continuous recording

    const totalLength = buffer.reduce((sum, buf) => sum + buf.length, 0);
    const durationMs = (totalLength / (48000 * 2 * 2)) * 100;

    console.log(`durationMs: ${durationMs}`);

    if (durationMs >= minDurationMs) {
      console.log(
        `🎙️ Processing ${Math.round(durationMs / 1000)}s of audio for ${userId}`
      );

      // Update last processed time to prevent repeated processing
      session.lastProcessedTime = Date.now();
      userRecordingSessions.set(userId, session);

      await processAndTranscribe(userId, Buffer.concat(buffer), guildId);

      // Don't delete the session - keep it active for continuous recording
      // userRecordingSessions.delete(userId); // REMOVED - keep session active
    }

    // Reset buffer but keep the session active
    userAudioBuffers.set(userId, []);
  }
}

async function processAndTranscribe(
  userId: string,
  buffer: Buffer,
  guildId?: string
): Promise<void> {
  // Trim silence from the buffer before processing
  const trimmedBuffer = trimSilence(buffer);

  const filename = `./audio/${userId}-${Date.now()}.mp3`;
  const ffmpeg = spawn('ffmpeg', [
    '-f',
    's16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-i',
    'pipe:0',
    '-acodec',
    'libmp3lame',
    '-b:a',
    '128k',
    filename,
  ]);

  ffmpeg.stdin.write(trimmedBuffer);
  ffmpeg.stdin.end();

  return new Promise((resolve, reject) => {
    ffmpeg.on('close', async (code) => {
      if (code === 0) {
        console.log(`✅ Saved: ${filename}`);
        try {
          const transcript = await transcribeAudio(filename);
          console.log(`📝 Transcription: ${transcript}`);

          // Get existing conversation context
          const existingContext = userConversations.get(userId) || {
            transcript: '',
            meetingTimes: [],
          };

          // Process meeting times with context (including schedule data)
          const meetingTimes = await getMeetingTimesByVoice(transcript, existingContext, userId);

          // Check if schedule is required
          if (meetingTimes.length > 0 && meetingTimes[0].startsWith('SCHEDULE_REQUIRED:')) {
            const scheduleMessage = meetingTimes.join('\n');
            
            // Send schedule requirement message to text channel
            if (guildId) {
              await sendToTextChannel(
                guildId,
                `📅 **Schedule Required:**\n\n${scheduleMessage.replace('SCHEDULE_REQUIRED:', '').trim()}\n\nPlease upload your schedule image or provide your availability.`
              );
            }

            // Convert to speech and play it
            if (guildId) {
              try {
                const audioFile = await textToSpeech(scheduleMessage.replace('SCHEDULE_REQUIRED:', '').trim());
                await playAudioInChannel(audioFile, guildId);
              } catch (error) {
                console.error('Error playing schedule requirement audio:', error);
              }
            }
            
            return; // Stop processing until schedule is provided
          }

          // Store updated conversation context - accumulate all previous inputs
          const updatedContext = {
            transcript: existingContext.transcript
              ? existingContext.transcript + '\n' + transcript
              : transcript,
            meetingTimes: [...existingContext.meetingTimes, ...meetingTimes],
          };

          userConversations.set(userId, updatedContext);

          console.log(
            `💬 Updated conversation context for ${userId}:`,
            updatedContext
          );

          // Check if conversation should end
          const conversationLength =
            updatedContext.transcript.split('\n').length;
          const hasMeetingTimes = updatedContext.meetingTimes.length > 0;
          const isConversationComplete =
            conversationLength >= 3 && hasMeetingTimes;

          console.log(
            `isConversationComplete: ${isConversationComplete}, conversationLength: ${conversationLength}, hasMeetingTimes: ${hasMeetingTimes}`
          );

          // Send transcript to text channel
          if (guildId) {
            const statusEmoji = isConversationComplete ? '✅' : '🔄';
            await sendToTextChannel(
              guildId,
              `${statusEmoji} **Voice Input:** ${transcript}\n\n📅 **Meeting Suggestions:**\n${meetingTimes.join(
                '\n'
              )}\n\n ${meetingTimes.join('\n')}\n\n📚 **Full Context:** ${
                updatedContext.transcript
              }`
            );
          }

          // Convert follow-up question to speech and play it
          if (guildId) {
            try {
              const audioFile = await textToSpeech(meetingTimes.join('\n'));
              await playAudioInChannel(audioFile, guildId);

              if (!isConversationComplete) {
                // Continue listening after bot response - recording session remains active
                setTimeout(() => {
                  console.log(
                    `🔄 Continuing to listen for ${userId}... (Context accumulated: ${
                      updatedContext.transcript.split('\n').length
                    } inputs)`
                  );
                  // The recording session continues automatically - no need to restart
                }, 3000); // Wait 3 seconds after bot finishes speaking
              }
            } catch (error) {
              console.error('Error playing audio response:', error);
            }
          }

          resolve();
        } catch (e) {
          console.error(`❌ Failed to transcribe ${filename}`, e);
          reject(e);
        }
      } else {
        console.error(`❌ FFmpeg failed for ${filename}`);
        reject(new Error('FFmpeg failed'));
      }
    });
  });
}

// Function to trim silence from the beginning and end of audio buffer
function trimSilence(buffer: Buffer): Buffer {
  const sampleRate = 48000;
  const channels = 2;
  const bytesPerSample = 2; // 16-bit audio
  const samplesPerFrame = channels * bytesPerSample;

  // Convert buffer to 16-bit samples
  const samples: number[] = [];
  for (let i = 0; i < buffer.length; i += 2) {
    samples.push(buffer.readInt16LE(i));
  }

  // Calculate RMS (Root Mean Square) for each frame to detect silence
  const frameSize = 960; // 20ms at 48kHz
  const silenceThreshold = 500; // Adjust this value based on your needs
  const frames: number[] = [];

  for (let i = 0; i < samples.length; i += frameSize) {
    const frame = samples.slice(i, i + frameSize);
    const rms = Math.sqrt(
      frame.reduce((sum, sample) => sum + sample * sample, 0) / frame.length
    );
    frames.push(rms);
  }

  // Find start and end of speech
  let speechStart = 0;
  let speechEnd = frames.length - 1;

  // Find start of speech (first frame above threshold)
  for (let i = 0; i < frames.length; i++) {
    if (frames[i] > silenceThreshold) {
      speechStart = i;
      break;
    }
  }

  // Find end of speech (last frame above threshold)
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i] > silenceThreshold) {
      speechEnd = i;
      break;
    }
  }

  // Add a small buffer (0.5 seconds) around the speech
  const bufferFrames = Math.floor((0.5 * sampleRate) / frameSize);
  speechStart = Math.max(0, speechStart - bufferFrames);
  speechEnd = Math.min(frames.length - 1, speechEnd + bufferFrames);

  // Convert frame indices back to sample indices
  const startSample = speechStart * frameSize;
  const endSample = (speechEnd + 1) * frameSize;

  // Extract the trimmed audio
  const trimmedSamples = samples.slice(startSample, endSample);

  // Convert back to buffer
  const trimmedBuffer = Buffer.alloc(trimmedSamples.length * 2);
  for (let i = 0; i < trimmedSamples.length; i++) {
    trimmedBuffer.writeInt16LE(trimmedSamples[i], i * 2);
  }

  console.log(
    `🎵 Trimmed audio: ${Math.round(
      (trimmedBuffer.length / (sampleRate * channels * bytesPerSample)) * 1000
    )}ms (was ${Math.round(
      (buffer.length / (sampleRate * channels * bytesPerSample)) * 1000
    )}ms)`
  );

  return trimmedBuffer;
}

export function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState
) {
  if (newState.channelId && !oldState.channelId) {
    const connection = joinVoiceChannel({
      channelId: newState.channelId,
      guildId: newState.guild.id,
      adapterCreator: newState.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    connection.receiver.speaking.on('start', (userId) => {
      console.log(
        `🎙️ User ${userId} started speaking, Guild ID: ${newState.guild.id}`
      );
      startRecording(connection.receiver, userId, newState.guild.id);
    });
  }
}

// Function to convert text to speech using OpenAI TTS
async function textToSpeech(text: string): Promise<string> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: text,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    const filename = `./audio/bot-response-${Date.now()}.mp3`;
    fs.writeFileSync(filename, buffer);

    return filename;
  } catch (error) {
    console.error('Error converting text to speech:', error);
    throw error;
  }
}

// Function to play audio in voice channel
async function playAudioInChannel(
  audioFile: string,
  guildId: string
): Promise<void> {
  try {
    const connection = getVoiceConnection(guildId);
    if (!connection) {
      console.log('No voice connection found');
      return;
    }

    const player = createAudioPlayer();
    const resource = createAudioResource(audioFile);

    connection.subscribe(player);
    player.play(resource);

    return new Promise((resolve, reject) => {
      player.on(AudioPlayerStatus.Idle, () => {
        console.log('✅ Finished playing audio response');
        resolve();
      });

      player.on('error', (error) => {
        console.error('❌ Error playing audio:', error);
        reject(error);
      });
    });
  } catch (error) {
    console.error('Error playing audio:', error);
    throw error;
  }
}

// Function to send message to text channel
async function sendToTextChannel(
  guildId: string,
  message: string
): Promise<void> {
  if (!discordClient) {
    console.log('Discord client not available');
    return;
  }

  try {
    const guild = discordClient.guilds.cache.get(guildId);
    if (!guild) {
      console.log('Guild not found');
      return;
    }

    // Find the first text channel (you can modify this to target a specific channel)
    const textChannel = guild.channels.cache.find(
      (channel) => channel.type === 0 && channel.isTextBased() // 0 is GUILD_TEXT
    ) as TextChannel;

    if (textChannel) {
      await textChannel.send(message);
      console.log(`✅ Sent message to text channel: ${textChannel.name}`);
    } else {
      console.log('No text channel found');
    }
  } catch (error) {
    console.error('Error sending message to text channel:', error);
  }
}

// Function to handle text message input and integrate with voice conversation
export async function handleTextMessage(
  userId: string,
  message: string,
  guildId?: string
): Promise<void> {
  try {
    console.log(`📝 Text message from ${userId}: ${message}`);

    // Get existing conversation context
    const existingContext = userConversations.get(userId) || {
      transcript: '',
      meetingTimes: [],
    };

    // Process the text message as if it were voice input (with context)
    const meetingTimes = await getMeetingTimesByVoice(message, existingContext, userId);

    // Store updated conversation context
    userConversations.set(userId, {
      transcript: existingContext.transcript + '\n[Text]: ' + message,
      meetingTimes: [...existingContext.meetingTimes, ...meetingTimes],
    });

    // Send response to text channel
    if (guildId) {
      await sendToTextChannel(
        guildId,
        `💬 **Text Input:** ${message}\n\n📅 **Meeting Suggestions:**\n${meetingTimes.join(
          '\n'
        )}\n\n❓`
      );
    }

    // Convert follow-up question to speech and play it
    if (guildId) {
      try {
        const audioFile = await textToSpeech(meetingTimes.join('\n'));
        await playAudioInChannel(audioFile, guildId);
      } catch (error) {
        console.error('Error playing audio response:', error);
      }
    }
  } catch (error) {
    console.error('Error handling text message:', error);
  }
}

// Function to get conversation context for a user
export function getConversationContext(userId: string) {
  return userConversations.get(userId);
}

// Function to clear conversation context for a user
export function clearConversationContext(userId: string) {
  userConversations.delete(userId);
  currentUserSchedule.delete(userId); // Also clear schedule data
  console.log(`🧹 Cleared conversation context and schedule for ${userId}`);
}

// Function to end conversation session
function endConversationSession(userId: string): void {
  // Clear conversation context
  userConversations.delete(userId);

  // End recording session
  userRecordingSessions.delete(userId);

  // Clear audio buffer
  userAudioBuffers.delete(userId);

  console.log(`🏁 Session ended for ${userId}. Conversation complete.`);
}

// Function to process schedule images and extract available days
export async function processScheduleImage(userId: string, imageUrl: string, guildId?: string) {
  try {
    console.log(`📸 Processing schedule image for ${userId}`);
    
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    
    // Download the image from Discord URL
    const response = await fetch(imageUrl);
    const imageBuffer = await response.arrayBuffer();
    
    // Convert to base64 for OpenAI API
    const base64Image = Buffer.from(imageBuffer).toString('base64');
    
    // Use OpenAI Vision API to analyze the schedule
    const visionResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful meeting scheduling assistant. Analyze this schedule image and extract the available days and times. Focus on identifying free time slots and busy periods. Return the information in a clear, structured format that can be used for scheduling meetings.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Please analyze this schedule image and extract available meeting times. Format the response as: "Available: [days and times], Busy: [days and times], Best slots: [recommended times]"',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
              },
            },
          ],
        },
      ],
      max_tokens: 300,
    });
    
    const scheduleAnalysis = visionResponse.choices[0].message.content || 'Could not analyze the schedule image.';
    console.log(`📅 Schedule analysis for ${userId}:`, scheduleAnalysis);
    
    // Update global schedule variable
    currentUserSchedule.set(userId, scheduleAnalysis);
    console.log(`📊 Updated global schedule for ${userId}:`, scheduleAnalysis);
    
    // Get existing conversation context
    const existingContext = userConversations.get(userId) || {
      transcript: '',
      meetingTimes: [],
    };
    
    // Add schedule information to context with a clear identifier
    const scheduleInfo = `[SCHEDULE DATA]: ${scheduleAnalysis}`;
    
    // Check if schedule data already exists in context and update it, otherwise add new
    let updatedTranscript = existingContext.transcript;
    if (existingContext.transcript.includes('[SCHEDULE DATA]:')) {
      // Replace existing schedule data with new analysis
      updatedTranscript = existingContext.transcript.replace(
        /\[SCHEDULE DATA\]:.*?(?=\n|$)/s,
        scheduleInfo
      );
    } else {
      // Add new schedule data to existing context
      updatedTranscript = existingContext.transcript
        ? existingContext.transcript + '\n' + scheduleInfo
        : scheduleInfo;
    }
    
    const updatedContext = {
      transcript: updatedTranscript,
      meetingTimes: [...existingContext.meetingTimes],
    };
    
    userConversations.set(userId, updatedContext);
    
    console.log(`📚 Updated context with schedule data for ${userId}:`, updatedContext);
    console.log(`📊 Context length: ${updatedContext.transcript.split('\n').length} entries`);
    
    // Send analysis to text channel
    if (guildId) {
      await sendToTextChannel(
        guildId,
        `📸 **Schedule Image Analysis:**\n\n${scheduleAnalysis}\n\n📚 **Context Updated:** Schedule data has been ${existingContext.transcript.includes('[SCHEDULE DATA]:') ? 'updated' : 'added'} to your conversation context and will be used for meeting scheduling.\n\n📊 **Total Context Entries:** ${updatedContext.transcript.split('\n').length}`
      );
    }
    
    // Convert analysis to speech and play it
    if (guildId) {
      try {
        const audioFile = await textToSpeech(`I've analyzed your schedule. ${scheduleAnalysis}`);
        await playAudioInChannel(audioFile, guildId);
      } catch (error) {
        console.error('Error playing schedule analysis audio:', error);
      }
    }

    return updatedContext;
    
  } catch (error) {
    console.error('Error processing schedule image:', error);
    // Send error message to text channel
    if (guildId) {
      await sendToTextChannel(
        guildId,
        `❌ **Error processing schedule image:** Could not analyze the image. Please make sure it's a clear schedule or calendar image.`
      );
    }
    return null;
  }
}

// Function to get current user schedule
export function getCurrentUserSchedule(userId: string): string | undefined {
  return currentUserSchedule.get(userId);
}

// Function to set current user schedule
export function setCurrentUserSchedule(userId: string, schedule: string): void {
  currentUserSchedule.set(userId, schedule);
  console.log(`📅 Set schedule for ${userId}:`, schedule);
}
