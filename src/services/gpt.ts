import { getFreeBusy } from './calendar';
import axios from 'axios';

/**
 * Get 3 optimal meeting times by combining freeBusy data + OpenAI reasoning
 */
export async function getOptimalMeetingTimes(
  email: string,
  duration: string,
  details: string,
  startDate: Date,
  endDate: Date,
  preferredTime: string,
  room: string
): Promise<string[]> {
  const timezone = 'Asia/Bangkok';
  const freeBusyPrompt = `
  You are a smart meeting scheduler.
  Given:
  - Preferred time: ${preferredTime}
  - Room: ${room}
  - Timezone: ${timezone}
  - Email: ${email}
  - Duration: ${duration}
  - Details: ${details}
  
  Suggest 3 optimal free 30-minute meeting slots between ${startDate} and ${endDate}, in ISO 8601 format.
  Do not overlap busy slots. Prefer ${preferredTime}.
  `;

  // 1️⃣ Fetch busy slots from Google Calendar
  const { response } = await getFreeBusy(freeBusyPrompt, timezone);

  console.log('Busy slots:', response);

  const prompt = `
  You are a smart meeting scheduler.
  Given:
  - Busy slots for ${email}:
  ${response}
  - Preferred time: ${preferredTime}
  - Room: ${room}
  - Timezone: ${timezone}
  - Email: ${email}
  - Duration: ${duration}
  - Details: ${details}

  Suggest 3 optimal free 30-minute meeting slots between ${startDate} and ${endDate}, in ISO 8601 format.
  Do not overlap busy slots. Prefer ${preferredTime}.
  `;

  // 3️⃣ Call OpenAI to suggest

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You help users schedule meetings efficiently.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      top_p: 0.5,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const text = res.data.choices[0].message.content.trim();
  return text
    .split('\n')
    .map((line: any) => line.trim())
    .filter((line: any) => line);
}
