import conversations from '../services/conversations.js';
import { readConversationPart } from '../services/conversationRead.js';

export default {
  group: 'core',
  routing: [
    '- User reports a problem with an earlier answer or applet in this conversation (blank, broken, error, wrong data) → use "conversation_read" to see what you actually wrote BEFORE fixing it',
  ],
  tools: {
    current_datetime: {
      description: 'Returns the current date and time in UTC and local time with timezone. Takes no arguments.',
      parameters: {},
      execute: () => {
        const now = new Date();
        return {
          utc: now.toISOString(),
          local: now.toString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          offset: now.getTimezoneOffset(),
        };
      },
    },
    // Earlier applets reach the model as a one-line placeholder (appletPlaceholder()) and tool rounds are not
    // replayed, so without this it fixes a broken applet from memory of the request.
    conversation_read: {
      description: 'Read back what you produced earlier in THIS conversation and can no longer see: the full source of an applet (history shows only a one-line "[An applet (…) was displayed here…]" note), the tool results of a turn, or its reasoning. For troubleshooting only. what: "applet" (default) | "tools" | "reasoning". Optional: message (index of the answer; omit it unless you were given one — the default is the newest answer that has it), applet (index, when an answer holds several), tool (index of one tool result, returned in full — the "tools" list cuts each to 3,000 chars).',
      parameters: { what: 'string', message: 'number', applet: 'number', tool: 'number' },
      execute: (args = {}, context = {}) => {
        if (!context.conversationId) return { error: 'No conversation in this context.' };
        return readConversationPart(conversations.get(context.conversationId), {
          what: args.what || 'applet',
          message: args.message,
          applet: args.applet,
          tool: args.tool,
        });
      },
    },
  },
};
