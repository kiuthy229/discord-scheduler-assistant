import {
  joinVoiceChannel,
  VoiceReceiver,
  EndBehaviorType,
} from '@discordjs/voice';
import { VoiceState } from 'discord.js';
import fs from 'fs';
import { spawn } from 'child_process';
import prism from 'prism-media';
import OpenAI from 'openai';

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
const minDurationMs = 5000; // Collect at least 5 seconds

function startRecording(receiver: VoiceReceiver, userId: string) {
  if (!userAudioBuffers.has(userId)) {
    userAudioBuffers.set(userId, []);
  }

  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });

  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });

  opusStream.pipe(decoder);

  decoder.on('data', (chunk) => {
    const existing = userAudioBuffers.get(userId) || [];
    existing.push(chunk);
    userAudioBuffers.set(userId, existing);

    const totalLength = existing.reduce((sum, buf) => sum + buf.length, 0);
    const durationMs = (totalLength / (48000 * 2 * 2)) * 1000; // 48kHz, 2 channels, 2 bytes

    if (durationMs >= minDurationMs) {
      saveAndTranscribe(userId, Buffer.concat(existing));
      userAudioBuffers.set(userId, []); // reset buffer
    }
  });
}

function saveAndTranscribe(userId: string, buffer: Buffer) {
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

  ffmpeg.stdin.write(buffer);
  ffmpeg.stdin.end();

  ffmpeg.on('close', async (code) => {
    if (code === 0) {
      console.log(`✅ Saved: ${filename}`);
      try {
        const transcript = await transcribeAudio(filename);
        console.log(`📝 Transcription: ${transcript}`);
      } catch (e) {
        console.error(`❌ Failed to transcribe ${filename}`, e);
      }
    } else {
      console.error(`❌ FFmpeg failed for ${filename}`);
    }
  });
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
      console.log(`🎙️ User ${userId} started speaking`);
      startRecording(connection.receiver, userId);
    });
  }
}
