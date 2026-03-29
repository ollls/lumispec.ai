export default {
  group: 'core',
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
  },
};
