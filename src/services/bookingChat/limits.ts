/**
 * Abuse limits and fixed strings for the website booking chat (plan 2026-10-30-website-booking-chat,
 * U2; CLAUDE.md security baseline). One place, so a limit is changed once and tested once.
 */

export const BOOKING_PHONE = "(615) 625-2163";

export const MAX_TEXT_CHARS = 1000;
export const MAX_MESSAGES_PER_CHAT = 60;
export const MAX_AI_CALLS_PER_CHAT = 120;
export const MAX_PHOTOS_PER_CHAT = 15;
export const MAX_CHATS_PER_IP_PER_DAY = 5;
export const MAX_TOOL_ROUNDS_PER_TURN = 6;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
/** Idle minutes before the sweep emails Kyle about a chat that never finished. */
export const IDLE_MINUTES = 30;

/** The fixed 2-hour scheduling blocks (CT) — the same four getAvailability() offers. */
export const FIXED_BLOCK_STARTS = ["08:00", "10:00", "12:00", "14:00"] as const;

export const PHONE_REPLY = `Please call us at ${BOOKING_PHONE} and we'll get you taken care of.`;
export const FALLBACK_REPLY = `Sorry, I'm having trouble right now. ${PHONE_REPLY}`;
export const CLOSED_REPLY = `This conversation has ended. For anything else, please call us at ${BOOKING_PHONE}.`;
export const TOO_LONG_REPLY = `That message is too long for me to handle here. Please shorten it, or call us at ${BOOKING_PHONE}.`;
export const CHAT_LIMIT_REPLY = `We've reached the limit for this chat. Please call us at ${BOOKING_PHONE} and we'll finish getting you scheduled.`;
export const START_LIMIT_REPLY = `We can't start another chat from this connection right now. Please call us at ${BOOKING_PHONE}.`;
export const PHOTO_LIMIT_REPLY = `We've reached the photo limit for this chat. You can show our technician the rest at the visit, or call us at ${BOOKING_PHONE}.`;
