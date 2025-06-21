import axios from 'axios';

/**
 * Get 3 optimal meeting times by combining freeBusy data + OpenAI reasoning
 */
export async function getMeetingTimesByVoice(
  transcript: string,
  conversationContext?: { transcript: string; meetingTimes: string[] },
  userId?: string
): Promise<string[]> {
  const timezone = 'Asia/Bangkok';

  // Check if user has schedule data in global variable
  let scheduleData = '';
  if (userId) {
    // Import the global schedule variable
    const { currentUserSchedule } = await import('./whisper');
    scheduleData = currentUserSchedule.get(userId) || '';
  }

  // If no schedule data available, ask user to provide it
  if (!scheduleData) {
    return [
      'SCHEDULE_REQUIRED: Please upload your schedule image or provide your availability so I can suggest appropriate meeting times.',
      'You can upload a calendar screenshot or tell me your available days and times.'
    ];
  }

  // Extract schedule data from conversation context as backup
  if (!scheduleData && conversationContext?.transcript) {
    const scheduleMatch = conversationContext.transcript.match(/\[SCHEDULE DATA\]: (.+?)(?=\n|$)/s);
    if (scheduleMatch) {
      scheduleData = scheduleMatch[1];
    }
  }

  // Check conversation length to determine if we should provide follow-up questions
  const conversationLength = conversationContext?.transcript.split('\n').length || 0;
  const hasMeetingTimes = conversationContext?.meetingTimes.length || 0 > 0;

  let prompt = '';
  if (scheduleData) {
    if (conversationLength >= 3 && hasMeetingTimes) {
      // Provide final summary with schedule data
      prompt = `You are a smart meeting scheduler with access to the user's schedule.
Given transcript: ${transcript}
Schedule data: ${scheduleData}
Previous meeting suggestions: ${conversationContext?.meetingTimes.join(', ')}
Conversation length: ${conversationLength}
Timezone: ${timezone}

The user has provided enough information. Provide a final summary of the meeting details and confirm the scheduling. Include the confirmed meeting time, participants, and any other relevant details.`;
    } else {
      // Generate follow-up questions with schedule data
      prompt = `You are a smart meeting scheduler with access to the user's schedule.
Given transcript: ${transcript}
Schedule data: ${scheduleData}
Previous context: ${conversationContext?.transcript || 'None'}
Timezone: ${timezone}

Based on the user's schedule and previous conversation, suggest 3 optimal meeting times AND generate 1-2 follow-up questions to gather more information. Format as:
1. [ISO 8601 time]
2. [ISO 8601 time] 
3. [ISO 8601 time]
Follow-up: [Your questions]`;
    }
  } else {
    if (conversationLength >= 3 && hasMeetingTimes) {
      // Provide final summary without schedule data
      prompt = `You are a smart meeting scheduler.
Given transcript: ${transcript}
Previous meeting suggestions: ${conversationContext?.meetingTimes.join(', ')}
Conversation length: ${conversationLength}
Timezone: ${timezone}

The user has provided enough information. Provide a final summary of the meeting details and confirm the scheduling. Include the confirmed meeting time, participants, and any other relevant details.`;
    } else {
      // Generate follow-up questions without schedule data
      prompt = `You are a smart meeting scheduler.
Given transcript: ${transcript}
Previous context: ${conversationContext?.transcript || 'None'}
Timezone: ${timezone}

Suggest 3 optimal free 30-minute meeting slots AND generate 1-2 follow-up questions to gather more information. Format as:
1. [ISO 8601 time]
2. [ISO 8601 time]
3. [ISO 8601 time]
Follow-up: [Your questions]`;
    }
  }

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You help users schedule meetings efficiently.',
        },
        {
          role: 'user',
          content: prompt,
        },
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
