/**
 * CodeGraph Pro beta opt-in — the installer's one-time offer to join the
 * beta-access waitlist (the same list the getcodegraph.com homepage form
 * feeds). Strictly opt-in: the user must answer yes AND type their email;
 * nothing is ever sent otherwise, and `--yes` / non-interactive runs never
 * see the prompt.
 *
 * The choice (subscribed or declined) is stored once in the user-level
 * state dir (~/.codegraph) so re-installs and upgrades never re-ask —
 * mirroring the telemetry consent pattern. A failed submit stores nothing,
 * so a later install can offer again.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** JSON waitlist endpoint on the landing page (see its /api/waitlist route). */
export const BETA_SIGNUP_ENDPOINT = 'https://getcodegraph.com/api/waitlist';

/** Same shape the landing-page form validates against. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SUBMIT_TIMEOUT_MS = 8_000;

interface BetaSignupChoiceFile {
  status: 'subscribed' | 'declined';
  updated_at: string;
}

export interface BetaSignupDeps {
  /** Global state dir; defaults to ~/.codegraph. Tests inject a temp dir. */
  dir?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Where the signup came from, recorded with the email. */
  source?: 'cli-install' | 'cli-upgrade';
  /** TTY probes; default to the real process streams. Tests inject. */
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

function choicePath(deps: BetaSignupDeps = {}): string {
  return path.join(deps.dir ?? path.join(os.homedir(), '.codegraph'), 'beta-signup.json');
}

/** True once the user has answered (either way) on this machine. */
export function hasBetaSignupChoice(deps: BetaSignupDeps = {}): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(choicePath(deps), 'utf8')) as BetaSignupChoiceFile;
    return raw.status === 'subscribed' || raw.status === 'declined';
  } catch {
    return false;
  }
}

/** Persist the answer so no future install re-asks. Fail silent. */
export function recordBetaSignupChoice(
  subscribed: boolean,
  deps: BetaSignupDeps = {},
): void {
  try {
    const file = choicePath(deps);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const choice: BetaSignupChoiceFile = {
      status: subscribed ? 'subscribed' : 'declined',
      updated_at: (deps.now?.() ?? new Date()).toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(choice, null, 2) + '\n');
  } catch {
    /* a full disk must not break the installer */
  }
}

/**
 * Submit one email to the beta waitlist. Returns true on success, false on
 * any failure (bad response, offline, timeout) — never throws, never retries.
 */
export async function submitBetaSignup(
  email: string,
  deps: BetaSignupDeps = {},
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchImpl(BETA_SIGNUP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, source: deps.source ?? 'cli-install' }),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The one gate every ask site shares: offer only on a real terminal, and
 * never once ANY prior ask (install or upgrade) has been answered on this
 * machine. Exported separately so the no-spam rule is unit-testable.
 */
export function shouldOfferBetaSignup(deps: BetaSignupDeps = {}): boolean {
  const stdinTTY = deps.stdinIsTTY ?? process.stdin.isTTY;
  const stdoutTTY = deps.stdoutIsTTY ?? process.stdout.isTTY;
  if (!stdinTTY || !stdoutTTY) return false;
  return !hasBetaSignupChoice(deps);
}

/**
 * The fork never offers the waitlist: it feeds upstream's CodeGraph Pro list,
 * which a fork user did not sign up for. Kept as a no-op so the install and
 * upgrade call sites stay identical to upstream.
 */
export async function maybeOfferBetaSignup(_deps: BetaSignupDeps = {}): Promise<void> {}
