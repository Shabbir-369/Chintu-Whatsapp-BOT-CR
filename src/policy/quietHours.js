/**
 * src/policy/quietHours.js
 * Quiet hours enforcement. §8.5, §9.2.
 */
import { isQuietHours } from '../util/time.js';
import { config } from '../config.js';

/**
 * Returns true if currently in quiet hours.
 */
export function inQuietHours() {
  return isQuietHours(config.QUIET_START, config.QUIET_END);
}

/**
 * Delay range for replies during quiet hours (20-90 seconds).
 */
export function quietHoursReplyDelay() {
  return 20000 + Math.floor(Math.random() * 70000);
}
