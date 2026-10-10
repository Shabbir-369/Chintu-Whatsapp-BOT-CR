/**
 * src/skills/pod/client.js
 * Medicaps Pod API client. §12.1, §12.2, §12.3, §12.5.
 * Logs in like a real student. One session per user. Rate-safe.
 *
 * Hosts and headers exactly per §12.1:
 *   Accounts/v4  https://api.pod.ai/v4/api          Authorization: Token <auth_token>
 *   ERP          https://arp-api.pod.ai/v1           Authorization: Bearer <jwt>
 *   Grades       https://asv-api.pod.ai/v1           Authorization: Bearer <jwt>
 *   Reporting    https://reporting-api.pod.ai/...    Token + jwt header
 */
import { getPodSession, savePodSession, deletePodSession, getPodCredentials, recordPodAttempt } from '../../db/repos/pod.js';
import { decrypt } from '../../util/crypto.js';
import { config } from '../../config.js';
import { getLogger } from '../../logger.js';
import { sleep } from '../../util/time.js';

const log = getLogger('skills/pod/client');

// Global concurrency limiter: at most 3 users at once (§12.5)
let activeRequests = 0;

// Base headers common to every request (§12.1)
const BASE_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'content-type': 'application/json;charset=utf-8',
  'origin': config.POD_ORIGIN,
  'referer': config.POD_ORIGIN + '/',
  'x-college-id': config.POD_COLLEGE_ID,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'accept-language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
};

/**
 * Low-level HTTP request to a Pod API.
 * Handles timeout, retries on 429/5xx (once), throws on 401/403.
 */
async function podRequest(url, opts = {}, authToken = null, jwt = null) {
  const headers = { ...BASE_HEADERS };

  // Auth headers per §12.1:
  //   v4 api  → Authorization: Token <auth_token>
  //   ERP/grade → Authorization: Bearer <jwt>
  if (authToken) headers['authorization'] = `Token ${authToken}`;
  if (jwt) headers['authorization'] = `Bearer ${jwt}`;  // jwt takes precedence for ERP calls
  // Reporting API also needs both — handled by callers who pass both
  if (opts._reportingMode && authToken && jwt) {
    headers['authorization'] = `Token ${authToken}`;
    headers['jwt'] = jwt;
  }

  const { _reportingMode, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.POD_TIMEOUT_MS);

  const doFetch = async () => {
    const resp = await fetch(url, {
      ...fetchOpts,
      headers: { ...headers, ...(fetchOpts.headers || {}) },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const err = new Error(`Pod API ${resp.status}: ${url}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  };

  try {
    return await doFetch();
  } catch (err) {
    clearTimeout(timeout);
    // Retry once on timeout, 429, 5xx (§12.5)
    if (!err.status || err.status === 429 || err.status >= 500 || err.name === 'AbortError') {
      await sleep(1000 + Math.random() * 800);
      return doFetch();
    }
    throw err;
  }
}

/**
 * Login flow §12.2 — exact 5-step sequence returning a session object.
 * @param {{ email: string, password: string }} credentials
 * @returns {Promise<object>} session
 */
export async function podLogin(credentials) {
  const { email, password } = credentials;

  // Step 1: POST accounts/login — try POD_LOGIN_FIELD first, fall back to the other
  let authToken, communities, communityToken;
  const loginBody1 = { [config.POD_LOGIN_FIELD]: email, password };

  let loginResp;
  try {
    loginResp = await podRequest(
      `${config.POD_V4_BASE}/accounts/login/?subdomain=${config.POD_SUBDOMAIN}`,
      { method: 'POST', body: JSON.stringify(loginBody1) }
    );
  } catch (err) {
    // If 400/401/403, try alternate field name (§12.2 open item)
    if (err.status === 400 || err.status === 401 || err.status === 403) {
      const altField = config.POD_LOGIN_FIELD === 'username' ? 'email' : 'username';
      const loginBody2 = { [altField]: email, password };
      loginResp = await podRequest(
        `${config.POD_V4_BASE}/accounts/login/?subdomain=${config.POD_SUBDOMAIN}`,
        { method: 'POST', body: JSON.stringify(loginBody2) }
      );
    } else {
      throw err;
    }
  }

  authToken = loginResp?.auth_token || loginResp?.data?.auth_token || loginResp?.token;
  if (!authToken) throw new Error('No authToken in login response');

  communities = loginResp?.communities || loginResp?.data?.communities || [];
  // Pick the medicaps community, else first
  const community = communities.find(c => c.sub_domain === config.POD_SUBDOMAIN) || communities[0];
  communityToken = community?.token || community?.community_token || null;

  // Step 2: POST community/{communityToken}/get-jwt-auth-token/
  let jwt;
  try {
    const jwtResp = await podRequest(
      `${config.POD_V4_BASE}/community/${communityToken}/get-jwt-auth-token/`,
      { method: 'POST', body: '{}' },
      authToken
    );
    jwt = jwtResp?.token || jwtResp?.data?.token || jwtResp?.jwt;
  } catch (err) {
    log.warn({ err }, 'JWT exchange failed, trying alternate endpoint');
    throw err;
  }
  if (!jwt) throw new Error('No JWT in token response');

  // Decode JWT payload (no verification needed — §12.2)
  let jwtPayload = {};
  try {
    const b64 = jwt.split('.')[1];
    jwtPayload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    try {
      const b64 = jwt.split('.')[1];
      jwtPayload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } catch { }
  }

  const expiresAt = jwtPayload.exp
    ? jwtPayload.exp * 1000
    : Date.now() + 20 * 60 * 1000;

  // Step 3: GET students/base/ → studentToken
  let studentToken = jwtPayload.student_token || null;
  try {
    const stuResp = await podRequest(
      `${config.POD_V4_BASE}/students/base/`,
      { method: 'GET' },
      authToken
    );
    studentToken = stuResp?.data?.token || stuResp?.token || stuResp?.student_token || studentToken;
  } catch (err) {
    log.warn({ err }, 'students/base/ failed, using JWT student_token fallback');
  }

  // Step 4: programToken from env or JWT
  const programToken = config.POD_PROGRAM_TOKEN
    || (jwtPayload.program_tokens && jwtPayload.program_tokens[0])
    || null;

  // Step 5: GET programs/{programToken} → activeSchoolTermToken (optional, non-fatal)
  let activeSchoolTermToken = null;
  if (studentToken && programToken) {
    try {
      const termResp = await podRequest(
        `${config.POD_ERP_BASE}/students/${studentToken}/programs/${programToken}/`,
        { method: 'GET' },
        null, jwt
      );
      activeSchoolTermToken = termResp?.active_school_term_token
        || termResp?.data?.active_school_term_token
        || null;
    } catch (err) {
      log.warn({ err }, 'active school term fetch failed (non-fatal)');
    }
  }

  return {
    authToken,
    jwt,
    communityToken,
    studentToken,
    programToken,
    activeSchoolTermToken,
    expiresAt,
  };
}

/**
 * Get a valid session for a person. Reuses existing if valid, re-logins otherwise.
 * @param {string} personId
 * @returns {Promise<object>} session
 */
export async function getSession(personId) {
  // Check existing session — reuse until 60s before expiry (§12.6)
  const session = await getPodSession(personId);
  if (session && session.expiresAt > Date.now() + 60000) {
    return session;
  }

  // Need to login
  const credentials = await getPodCredentials(personId);
  if (!credentials) throw new Error('No credentials for person');

  // Respect global concurrency limit (§12.5)
  let waited = 0;
  while (activeRequests >= 3) {
    await sleep(1000 + Math.random() * 2000);
    waited += 1000;
    if (waited > 30000) throw new Error('Pod concurrency timeout');
  }
  activeRequests++;
  try {
    const newSession = await podLogin(credentials);
    await savePodSession(personId, newSession);
    await recordPodAttempt(personId, true);
    return newSession;
  } catch (err) {
    await recordPodAttempt(personId, false);
    throw err;
  } finally {
    activeRequests--;
  }
}

/**
 * Make an authenticated Pod API call for a person.
 * Handles 401/403: re-login once (§12.5).
 * Adds random 200-600ms sequential gap between calls.
 */
export async function podCall(personId, url, opts = {}) {
  // Sequential gap (§12.5): 200-600ms between calls
  await sleep(200 + Math.random() * 400);
  const session = await getSession(personId);

  // Determine auth style from URL
  const isErpOrGrade = url.includes('arp-api.pod.ai') || url.includes('asv-api.pod.ai');
  const isReporting = url.includes('reporting-api.pod.ai');

  const authToken = isErpOrGrade ? null : session.authToken;
  const jwt = isErpOrGrade || isReporting ? session.jwt : null;
  const reportingMode = isReporting ? true : false;

  try {
    if (reportingMode) {
      return await podRequest(url, { ...opts, _reportingMode: true }, session.authToken, session.jwt);
    }
    return await podRequest(url, opts, authToken, jwt);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      // Re-login once (§12.5)
      log.warn({ personId, url }, 'Session expired, re-logging in...');
      await deletePodSession(personId);
      const newSession = await getSession(personId);
      if (reportingMode) {
        return podRequest(url, { ...opts, _reportingMode: true }, newSession.authToken, newSession.jwt);
      }
      return podRequest(url, opts,
        isErpOrGrade ? null : newSession.authToken,
        isErpOrGrade || isReporting ? newSession.jwt : null
      );
    }
    throw err;
  }
}

// ─── Named data endpoints (§12.3) ────────────────────────────────

/**
 * Get courses with attendance & marks for this term (§12.3 row 1).
 * GET {erp}/students/{student}/programs/{program}/academic-terms/{term}/courses/
 */
export async function getCoursesWithAttendance(personId) {
  const session = await getSession(personId);
  if (!session.studentToken || !session.programToken) {
    throw new Error('Missing student/program token for courses endpoint');
  }
  const termToken = session.activeSchoolTermToken;
  if (!termToken) throw new Error('No active school term token');

  return podCall(
    personId,
    `${config.POD_ERP_BASE}/students/${session.studentToken}/programs/${session.programToken}/academic-terms/${termToken}/courses/`
  );
}

/**
 * Get past completed classes (paginated) — §12.3 row 2.
 * Loops pages until last_page_number (cap 100 pages).
 */
export async function getPastClasses(personId) {
  const allResults = [];
  let page = 1;
  let lastPage = 1;

  do {
    const resp = await podCall(
      personId,
      `${config.POD_V4_BASE}/classrooms/student-activity/classes/index-list/?activity_status=past_completed&class_group_type=1&include_status_stats=true&page=${page}&page_size=100`
    );
    const results = resp?.results || resp?.data?.results || [];
    allResults.push(...results);
    lastPage = resp?.pagination?.last_page_number || resp?.last_page_number || 1;
    page++;
    if (page > 1) await sleep(200 + Math.random() * 400); // gap between pages
  } while (page <= Math.min(lastPage, 100));

  return allResults;
}

/**
 * Get grades/marks (§12.3 row 4).
 */
export async function getGrades(personId) {
  const session = await getSession(personId);
  if (!session.programToken) throw new Error('No programToken');
  return podCall(
    personId,
    `${config.POD_GRADE_BASE}/grades/programs/${session.programToken}/`
  );
}

/**
 * Get personal notifications (§12.3 row 5).
 */
export async function getNotifications(personId) {
  return podCall(
    personId,
    `${config.POD_V4_BASE}/notifications/all/?is_archived=false&limit=${config.POD_NOTIFICATION_LIMIT}&page=1`
  );
}

/**
 * Get general dashboard feed (§12.3 row 6).
 */
export async function getDashboardFeed(personId) {
  return podCall(personId, `${config.POD_V4_BASE}/dashboard/timeline/?discover=true`);
}
