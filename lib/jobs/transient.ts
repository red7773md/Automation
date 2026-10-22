// Which step errors are worth trying again later. A temporary problem (a slow or busy image server, a timeout,
// an empty reply) waits and is tried again. A problem that the same request would always hit (a missing setting,
// expired cookies, a piece of the job that is gone) stops the job at once, because repeating it cannot help.
// Pure functions with no I/O, so the rules can be tested.

/** Temporary problems in a row before the job stops. With the waits below, about seven hours. */
export const MAX_TRANSIENT_TRIES = 12;

const PERMANENT: RegExp[] = [
  /longer than \d+ characters/i, // a prompt the tool will never accept
  /not set|must be set/i, // a server URL or cookie that is not configured
  /expired|not signed in|sign in|unauthori[sz]ed|forbidden|HTTP 40[13]/i, // needs a person to renew access
  /No [\w ]+ stored|not in the plan|is not defined|Invalid job id/i, // part of the job is missing
  /did not finish within/i, // deep research ran past its limit
];

/** True when the same step could succeed later. Anything not known to be permanent is treated as temporary. */
export function isTransient(message: string): boolean {
  return !PERMANENT.some((re) => re.test(message));
}

/** Minutes to wait before try number `tries` (1 = the first retry): 1, 2, 4, 8, 16, then 60 each time. */
export function retryMinutes(tries: number): number {
  return Math.min(60, 2 ** Math.max(0, tries - 1));
}
