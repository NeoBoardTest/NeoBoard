const repository = process.env.GITHUB_REPOSITORY || '';
const token = process.env.EXPIRY_BOT_TOKEN || '';
const dryRun = /^true$/i.test(String(process.env.DRY_RUN || 'false'));
const nowOverride = String(process.env.NOW_OVERRIDE || '').trim();

if (!repository.includes('/')) {
  throw new Error('GITHUB_REPOSITORY is missing or invalid.');
}

if (!token) {
  throw new Error('EXPIRY_BOT_TOKEN is not set. Add it as a repository secret before enabling this workflow.');
}

const [owner, repo] = repository.split('/');
const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
const graphqlEndpoint = 'https://api.github.com/graphql';
const now = nowOverride ? new Date(nowOverride) : new Date();

if (Number.isNaN(now.getTime())) {
  throw new Error(`NOW_OVERRIDE is not a valid ISO timestamp: ${nowOverride}`);
}

const summaryLines = [];

function writeSummary(line = '') {
  console.log(line);
  summaryLines.push(line);
}

async function request(method, url, body = null, extraHeaders = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return null;

  const text = await res.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { message: text };
    }
  }

  if (!res.ok) {
    const message = data && data.message ? data.message : text || `${res.status}`;
    throw new Error(`${method} ${url} failed: ${message}`);
  }

  return data;
}

async function gql(query, variables = {}) {
  const data = await request('POST', graphqlEndpoint, { query, variables });
  if (data.errors && data.errors.length) {
    throw new Error(data.errors.map((entry) => entry.message).join('; '));
  }
  return data.data;
}

async function paginate(urlFactory, itemName) {
  const items = [];
  let page = 1;

  while (true) {
    const batch = await request('GET', urlFactory(page));
    if (!Array.isArray(batch)) {
      throw new Error(`Expected an array when listing ${itemName}.`);
    }

    items.push(...batch);
    if (batch.length < 100) break;

    page += 1;
    if (page > 1000) {
      throw new Error(`Pagination safety limit reached while listing ${itemName}.`);
    }
  }

  return items;
}

function parseMetaFields(raw) {
  const normalized = String(raw || '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/\n\n---\n([\s\S]*)$/);
  if (!match) return {};

  const fields = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    fields[key] = value;
  }

  return fields;
}

function parseExpiresAt(raw) {
  const fields = parseMetaFields(raw);
  if (!fields.expiresAt) return null;

  const ts = Date.parse(fields.expiresAt);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts);
}

function issueNumberFromComment(comment) {
  const match = String(comment.issue_url || '').match(/\/issues\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function expiredNote(kind, expiresAt, nowIso) {
  const expiresText = expiresAt ? expiresAt.toISOString() : 'an unknown time';
  return [
    `[expired ${kind} removed by cleanup]`,
    '',
    `This ${kind} was automatically expired.`,
    `Expired at: ${expiresText}`,
    `Processed at: ${nowIso}`,
  ].join('\n');
}

async function listIssues() {
  const issues = await paginate(
    (page) => `${apiBase}/issues?state=all&per_page=100&page=${page}&sort=created&direction=asc`,
    'issues'
  );
  return issues.filter((issue) => !issue.pull_request);
}

async function listComments() {
  return paginate(
    (page) => `${apiBase}/issues/comments?per_page=100&page=${page}&sort=created&direction=asc`,
    'issue comments'
  );
}

async function hardDeleteIssue(issue) {
  await gql(
    `mutation DeleteIssue($issueId: ID!) {
      deleteIssue(input: { issueId: $issueId }) {
        clientMutationId
      }
    }`,
    { issueId: issue.node_id }
  );
}

async function softDeleteIssue(issue, expiresAt) {
  const nextTitle = `[expired] ${String(issue.title || '').trim() || `Thread #${issue.number}`}`.slice(0, 240);
  await request('PATCH', `${apiBase}/issues/${issue.number}`, {
    title: nextTitle,
    body: expiredNote('thread', expiresAt, now.toISOString()),
    state: 'closed',
  });
}

async function softDeleteComment(comment, expiresAt) {
  await request('PATCH', `${apiBase}/issues/comments/${comment.id}`, {
    body: expiredNote('reply', expiresAt, now.toISOString()),
  });
}

async function deleteExpiredIssue(issue, expiresAt) {
  if (dryRun) {
    writeSummary(`DRY RUN: would delete thread #${issue.number} (expired ${expiresAt.toISOString()})`);
    return 'dry-run';
  }

  try {
    await hardDeleteIssue(issue);
    writeSummary(`Deleted thread #${issue.number}`);
    return 'deleted';
  } catch (error) {
    writeSummary(`Hard delete failed for thread #${issue.number}; falling back to close+scrub. ${error.message}`);
    await softDeleteIssue(issue, expiresAt);
    writeSummary(`Soft-deleted thread #${issue.number}`);
    return 'soft-deleted';
  }
}

async function deleteExpiredComment(comment, expiresAt) {
  if (dryRun) {
    writeSummary(`DRY RUN: would delete reply #${comment.id} (expired ${expiresAt.toISOString()})`);
    return 'dry-run';
  }

  try {
    await request('DELETE', `${apiBase}/issues/comments/${comment.id}`);
    writeSummary(`Deleted reply #${comment.id}`);
    return 'deleted';
  } catch (error) {
    writeSummary(`Hard delete failed for reply #${comment.id}; falling back to scrub. ${error.message}`);
    await softDeleteComment(comment, expiresAt);
    writeSummary(`Soft-deleted reply #${comment.id}`);
    return 'soft-deleted';
  }
}

const issues = await listIssues();
const comments = await listComments();

const expiredIssues = issues
  .map((issue) => ({ issue, expiresAt: parseExpiresAt(issue.body) }))
  .filter((entry) => entry.expiresAt && entry.expiresAt.getTime() <= now.getTime())
  .sort((a, b) => a.expiresAt - b.expiresAt);

const expiredIssueNumbers = new Set(expiredIssues.map((entry) => entry.issue.number));

const expiredComments = comments
  .map((comment) => ({ comment, expiresAt: parseExpiresAt(comment.body) }))
  .filter((entry) => entry.expiresAt && entry.expiresAt.getTime() <= now.getTime())
  .filter((entry) => !expiredIssueNumbers.has(issueNumberFromComment(entry.comment)))
  .sort((a, b) => a.expiresAt - b.expiresAt);

writeSummary(`# Expire Posts`);
writeSummary('');
writeSummary(`Now: ${now.toISOString()}`);
writeSummary(`Dry run: ${dryRun ? 'yes' : 'no'}`);
writeSummary(`Expired threads found: ${expiredIssues.length}`);
writeSummary(`Expired replies found: ${expiredComments.length}`);
writeSummary('');

const counts = {
  deletedThreads: 0,
  softDeletedThreads: 0,
  deletedReplies: 0,
  softDeletedReplies: 0,
};

for (const { issue, expiresAt } of expiredIssues) {
  const result = await deleteExpiredIssue(issue, expiresAt);
  if (result === 'deleted') counts.deletedThreads += 1;
  if (result === 'soft-deleted') counts.softDeletedThreads += 1;
}

for (const { comment, expiresAt } of expiredComments) {
  const result = await deleteExpiredComment(comment, expiresAt);
  if (result === 'deleted') counts.deletedReplies += 1;
  if (result === 'soft-deleted') counts.softDeletedReplies += 1;
}

writeSummary('');
writeSummary('## Result');
writeSummary(`Threads hard-deleted: ${counts.deletedThreads}`);
writeSummary(`Threads soft-deleted: ${counts.softDeletedThreads}`);
writeSummary(`Replies hard-deleted: ${counts.deletedReplies}`);
writeSummary(`Replies soft-deleted: ${counts.softDeletedReplies}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(process.env.GITHUB_STEP_SUMMARY, `${summaryLines.join('\n')}\n`, 'utf8')
  );
}
