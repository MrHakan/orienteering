// Seasonal Easter egg configuration. The project had no publishing timezone
// or event-date setting, so it lives here.
//
// Easter eggs are decorative: they never touch the terrain, seed, options,
// answer or any saved data. They exist only in exported frames.

export const EASTER_CONFIG = {
  /**
   * IANA zone that decides which calendar day it is, e.g. 'Europe/Istanbul'.
   * null = the local zone of whoever is rendering.
   */
  timeZone: null,

  winter: {
    // Inclusive [month, day]; a window that wraps the new year is fine.
    start: [12, 21],
    end: [1, 6],
    // Days on which Santa's sleigh also flies past.
    santaDays: [[12, 24], [12, 25]],
  },

  may4: { days: [[5, 4]] },
};

/** Render length the choreography is written for (seconds). */
export const EGG_DURATION = 15;
