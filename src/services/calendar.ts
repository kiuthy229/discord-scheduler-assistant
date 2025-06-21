import axios from 'axios';

/**
 * Query Google Calendar FreeBusy API for given email and time range
 */
export async function getFreeBusy(
  question: string,
  timezone: string
): Promise<any> {
  try {
    const response = await fetch('http://localhost:8000/calendar/ai-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: question.trim(),
        timezone,
      }),
    });

    const data = await response.json();

    if (response.ok) {
      console.log('AI analysis completed!', 'success');
      return data;
    } else {
      throw new Error(data.error || 'Failed to get AI analysis');
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'An unknown error occurred.';
    console.error(`Error: ${errorMessage}`, 'danger');
  }
}
