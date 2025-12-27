// src/chat/feature-flags.ts

export const FF = {
  THREADS: process.env.FF_THREADS === '1',
  PINS: process.env.FF_PINS === '1',
  STARS: process.env.FF_STARS === '1',
  SEARCH: process.env.FF_SEARCH === '1',
  PUSH: process.env.FF_PUSH === '1',
  MODERATION: process.env.FF_MODERATION === '1',
  CALL_STATE: process.env.FF_CALL_STATE === '1',
  OBSERVABILITY: process.env.FF_OBSERVABILITY === '1',
} as const;
